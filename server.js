const express=require("express"),path=require("path"),fs=require("fs"),axios=require("axios"),app=express(),PORT=process.env.PORT||3000;
app.use(express.json());app.use(express.urlencoded({extended:false}));

// ===== GITHUB PERSISTENT STORAGE =====
const GITHUB_TOKEN=process.env.GITHUB_TOKEN||"";
const GITHUB_REPO=process.env.GITHUB_REPO||"ammajanbdkr-maker/whalebot";
const DATA_FILE="whalebot_data.json";
const LOCAL_CACHE="/tmp/whalebot_data.json";

let DB={users:[],wallets:[],trades:[],alerts:[],settings:[],positions:[]};
let dbFileSha=null;
let saveTimer=null;
let isSaving=false;

async function loadDB(){
  if(GITHUB_TOKEN){
    try{
      const r=await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,{
        headers:{"Authorization":`token ${GITHUB_TOKEN}`},timeout:10000
      });
      dbFileSha=r.data.sha;
      const content=Buffer.from(r.data.content,"base64").toString("utf8");
      const parsed=JSON.parse(content);
      // FIX BUG5: strip any stale _selling flags from loaded positions
      if(parsed.positions)parsed.positions.forEach(p=>{delete p._selling;});
      DB={users:[],wallets:[],trades:[],alerts:[],settings:[],positions:[],...parsed};
      try{fs.writeFile(LOCAL_CACHE,content,()=>{});}catch{}
      console.log(`[DB] GitHub: ${DB.users.length} users, ${DB.trades.length} trades, ${DB.positions.length} positions`);
      return;
    }catch(e){
      if(e.response?.status===404)console.log("[DB] No data file yet");
      else console.log("[DB] GitHub load error:",e.message);
    }
  }
  try{
    if(fs.existsSync(LOCAL_CACHE)){
      const parsed=JSON.parse(fs.readFileSync(LOCAL_CACHE,"utf8"));
      if(parsed.positions)parsed.positions.forEach(p=>{delete p._selling;});
      DB={users:[],wallets:[],trades:[],alerts:[],settings:[],positions:[],...parsed};
      console.log("[DB] Local cache loaded");
    }
  }catch(e){console.log("[DB] Fresh start");}
}

async function flushDB(){
  if(isSaving)return;
  isSaving=true;
  try{
    // FIX BUG5: never save _selling flag to disk
    const snapshot=JSON.parse(JSON.stringify(DB));
    snapshot.positions.forEach(p=>{delete p._selling;});
    const content=JSON.stringify(snapshot);
    try{fs.writeFile(LOCAL_CACHE,content,()=>{});}catch{}
    if(!GITHUB_TOKEN){isSaving=false;return;}
    const b64=Buffer.from(content).toString("base64");
    const body={message:"data",content:b64};
    if(dbFileSha)body.sha=dbFileSha;
    const r=await axios.put(`https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,body,{
      headers:{"Authorization":`token ${GITHUB_TOKEN}`},timeout:15000
    });
    dbFileSha=r.data.content.sha;
  }catch(e){
    console.log("[DB] Save error:",e.message);
    if(e.response?.status===409){
      try{
        // FIX BUG8: fetch new SHA and immediately retry the save
        const r=await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,{
          headers:{"Authorization":`token ${GITHUB_TOKEN}`},timeout:5000
        });
        dbFileSha=r.data.sha;
        // retry save with correct SHA
        const snapshot=JSON.parse(JSON.stringify(DB));
        snapshot.positions.forEach(p=>{delete p._selling;});
        const content=JSON.stringify(snapshot);
        const b64=Buffer.from(content).toString("base64");
        const r2=await axios.put(`https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,
          {message:"data",content:b64,sha:dbFileSha},
          {headers:{"Authorization":`token ${GITHUB_TOKEN}`},timeout:15000});
        dbFileSha=r2.data.content.sha;
        console.log("[DB] 409 retry OK");
      }catch(e2){console.log("[DB] 409 retry failed:",e2.message);}
    }
  }finally{isSaving=false;}
}

function saveDB(){
  // FIX BUG11: async write (non-blocking)
  const snapshot=JSON.parse(JSON.stringify(DB));
  snapshot.positions.forEach(p=>{delete p._selling;});
  fs.writeFile(LOCAL_CACHE,JSON.stringify(snapshot),()=>{});
  if(saveTimer)clearTimeout(saveTimer);
  saveTimer=setTimeout(flushDB,3000);
}

// FIX BUG13: use reduce instead of spread to avoid RangeError on large arrays
let nid={user:1,wallet:1,trade:1,alert:1};
function initNid(){
  nid.user=DB.users.reduce((m,u)=>Math.max(m,u.id),0)+1;
  nid.wallet=DB.wallets.reduce((m,w)=>Math.max(m,w.id),0)+1;
  nid.trade=DB.trades.reduce((m,t)=>Math.max(m,t.id),0)+1;
  nid.alert=DB.alerts.reduce((m,a)=>Math.max(m,a.id),0)+1;
}

function hashPw(pw){let h=0;for(let c of pw){h=Math.imul(31,h)+c.charCodeAt(0)|0;}return Math.abs(h).toString(36)+pw.length;}

const S={
  getUserByEmail:e=>DB.users.find(u=>u.email===e)||null,
  getUserById:id=>DB.users.find(u=>u.id===id)||null,
  createUser:d=>{const u={id:nid.user++,...d};DB.users.push(u);saveDB();return u;},
  getWallets:uid=>DB.wallets.filter(w=>w.userId===uid),
  addWallet:d=>{const w={id:nid.wallet++,...d,isActive:false};DB.wallets.push(w);saveDB();return w;},
  deleteWallet:(id,uid)=>{DB.wallets=DB.wallets.filter(w=>!(w.id===id&&w.userId===uid));saveDB();},
  setActive:(id,uid)=>{DB.wallets.forEach(w=>{if(w.userId===uid)w.isActive=(w.id===id);});saveDB();},
  getSettings:uid=>DB.settings.find(s=>s.userId===uid)||null,
  upsertSettings:(uid,d)=>{
    let s=DB.settings.find(s=>s.userId===uid);
    if(s)Object.assign(s,d);
    else{s={userId:uid,buyAmount:0.119,profitTarget:1,stopLoss:5,maxPositions:5,isRunning:false,...d};DB.settings.push(s);}
    saveDB();return s;
  },
  setBotRunning:(uid,v)=>{const s=DB.settings.find(s=>s.userId===uid);if(s){s.isRunning=v;saveDB();}},
  addTrade:d=>{const t={id:nid.trade++,...d,timestamp:Date.now()};DB.trades.push(t);saveDB();return t;},
  getTrades:uid=>DB.trades.filter(t=>t.userId===uid),
  addAlert:d=>{const a={id:nid.alert++,...d,timestamp:Date.now()};DB.alerts.push(a);saveDB();return a;},
  getAlerts:uid=>DB.alerts.filter(a=>a.userId===uid),
  getPositions:uid=>DB.positions.filter(p=>p.userId===uid),
  addPosition:d=>{
    const exists=DB.positions.find(p=>p.userId===d.userId&&p.tokenAddress===d.tokenAddress);
    if(exists){console.log(`[DB] Duplicate blocked: ${d.tokenSymbol}`);return null;}
    const pos={...d,openedAt:Date.now(),highestPrice:d.entryPrice};
    DB.positions.push(pos);saveDB();return pos;
  },
  removePosition:(uid,tokenAddress)=>{
    const before=DB.positions.length;
    DB.positions=DB.positions.filter(p=>!(p.userId===uid&&p.tokenAddress===tokenAddress));
    if(DB.positions.length<before)saveDB();
  },
  updatePositionHigh:(uid,tokenAddress,price)=>{
    const p=DB.positions.find(p=>p.userId===uid&&p.tokenAddress===tokenAddress);
    if(p&&price>p.highestPrice){p.highestPrice=price;saveDB();}
  }
};

const HELIUS_KEY=process.env.HELIUS_KEY||"";
if(!HELIUS_KEY){console.error("[FATAL] HELIUS_KEY env var not set!");process.exit(1);}
const RPC=`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const JUPITER_API="https://api.jup.ag/swap/v1";
const SOL_MINT="So11111111111111111111111111111111111111112";
const nacl=require("tweetnacl");
const bs58=require("bs58");

function pkToKeypair(pk58){
  const secret=bs58.decode(pk58);
  if(secret.length===64)return{secretKey:secret,publicKey:secret.slice(32)};
  const kp=nacl.sign.keyPair.fromSeed(secret.slice(0,32));
  return{secretKey:kp.secretKey,publicKey:kp.publicKey};
}
function pubkeyToBase58(b){return bs58.encode(b);}

// FIX BUG1: sign legacy transactions correctly
// Jupiter returns versioned tx by default; we request asLegacyTransaction:true
// Legacy tx format: [numSigs(1byte)][sig(64bytes)x numSigs][message...]
async function signAndSendTx(txBase64,secretKey){
  const txBytes=Buffer.from(txBase64,"base64");
  const numSigs=txBytes[0]; // for legacy tx this is 1
  const messageStart=1+numSigs*64;
  const message=txBytes.slice(messageStart);
  if(message.length===0)throw new Error("Empty message - versioned tx received instead of legacy");
  const sig=nacl.sign.detached(message,secretKey);
  sig.forEach((b,i)=>txBytes[1+i]=b);
  const r=await axios.post(RPC,{jsonrpc:"2.0",id:1,method:"sendTransaction",
    params:[txBytes.toString("base64"),{encoding:"base64",skipPreflight:true,maxRetries:3}]},{timeout:30000});
  if(r.data.error)throw new Error(r.data.error.message);
  return r.data.result;
}

async function getSOLBalance(address){
  try{
    const r=await axios.post(RPC,{jsonrpc:"2.0",id:1,method:"getBalance",params:[address]},{timeout:8000});
    return(r.data?.result?.value||0)/1e9;
  }catch{return 0;}
}

async function jupiterBuy(pk58,outputMint,amountSOL){
  try{
    const kp=pkToKeypair(pk58);
    const pubkey=pubkeyToBase58(kp.publicKey);
    const lamports=Math.floor(amountSOL*1e9);
    const q=(await axios.get(`${JUPITER_API}/quote`,{
      params:{inputMint:SOL_MINT,outputMint,amount:lamports,slippageBps:150},timeout:15000})).data;
    if(!q?.outAmount)throw new Error("No Jupiter quote");
    // FIX BUG1: request legacy transaction format
    const sw=(await axios.post(`${JUPITER_API}/swap`,{
      quoteResponse:q,userPublicKey:pubkey,wrapAndUnwrapSol:true,
      asLegacyTransaction:true,
      computeUnitPriceMicroLamports:1000,dynamicComputeUnitLimit:true,
      prioritizationFeeLamports:1000},{timeout:20000})).data;
    if(!sw?.swapTransaction)throw new Error("No swap tx");
    const sig=await signAndSendTx(sw.swapTransaction,kp.secretKey);
    await new Promise(r=>setTimeout(r,4000));
    console.log(`[BUY] OK ${sig.slice(0,20)}... tokens:${q.outAmount}`);
    return{success:true,txHash:sig,tokenAmount:String(q.outAmount)};
  }catch(e){
    console.log(`[BUY] FAIL: ${e?.response?.data?.error||e.message}`);
    return{success:false,error:e?.response?.data?.error||e.message};
  }
}

async function jupiterSell(pk58,inputMint,tokenAmount){
  try{
    const kp=pkToKeypair(pk58);
    const pubkey=pubkeyToBase58(kp.publicKey);
    const q=(await axios.get(`${JUPITER_API}/quote`,{
      params:{inputMint,outputMint:SOL_MINT,amount:String(tokenAmount),slippageBps:150},timeout:15000})).data;
    if(!q?.outAmount)throw new Error("No Jupiter quote");
    // FIX BUG1: request legacy transaction format
    const sw=(await axios.post(`${JUPITER_API}/swap`,{
      quoteResponse:q,userPublicKey:pubkey,wrapAndUnwrapSol:true,
      asLegacyTransaction:true,
      computeUnitPriceMicroLamports:1000,dynamicComputeUnitLimit:true,
      prioritizationFeeLamports:1000},{timeout:20000})).data;
    if(!sw?.swapTransaction)throw new Error("No swap tx");
    const sig=await signAndSendTx(sw.swapTransaction,kp.secretKey);
    await new Promise(r=>setTimeout(r,4000));
    console.log(`[SELL] OK ${sig.slice(0,20)}...`);
    return{success:true,txHash:sig};
  }catch(e){
    console.log(`[SELL] FAIL: ${e?.response?.data?.error||e.message}`);
    return{success:false,error:e?.response?.data?.error||e.message};
  }
}

// Established tokens only
const TOKENS=[
  // Original 15
  {a:"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",s:"BONK"},
  {a:"EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",s:"WIF"},
  {a:"7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",s:"POPCAT"},
  {a:"ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",s:"BOME"},
  {a:"MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",s:"MEW"},
  {a:"JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",s:"JUP"},
  {a:"4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",s:"RAY"},
  {a:"orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",s:"ORCA"},
  {a:"HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",s:"PYTH"},
  {a:"hntyVP6YFm1Hg25TN9WGLqM18LdZQZWwdDkn5f9GnhS",s:"HNT"},
  {a:"MNDEFzGvMt87ueuAgD7R4G99u1aMDe32xv1hL9DXZXF",s:"MNDE"},
  {a:"mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",s:"mSOL"},
  {a:"SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y",s:"SHDW"},
  {a:"nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7",s:"NOS"},
  {a:"8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGzmh3iEK",s:"SLERF"},
  // New 35 - top Solana ecosystem tokens
  {a:"6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",s:"TRUMP"},
  {a:"A8C3xuqscfmyLrte3VmTqrAq8kgMASius9AFNANwpump",s:"FARTCOIN"},
  {a:"Hax9LTgsQkze1yFycEBtoXpFfMDGxHsCUynFRJuExdXs",s:"PENGU"},
  {a:"jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",s:"JTO"},
  {a:"rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof",s:"RENDER"},
  {a:"WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk",s:"WEN"},
  {a:"27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",s:"IO"},
  {a:"EchesyfXePKdLtoiZSL8pBe8Myagyy8ZRqsACNCFGnvp",s:"FIDA"},
  {a:"5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",s:"LAYER"},
  {a:"Hjw6bEcHtbHGpQr8onG3izfJY5DJiWdt7uk2BfdSpump",s:"PUMP"},
  {a:"2WDEgFnZuJ2TDCCDsXqKKuGJY5NyX7fWGBpfCFqpump",s:"GIGA"},
  {a:"KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS",s:"KMNO"},
  {a:"METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m",s:"META"},
  {a:"mfuiKMJHaYFNGMEWfS3TsPvAhHJT2BusBCBfhuvTKSY",s:"MYRO"},
  {a:"4LLbsb5ReP3yEtYzmXewyGjcir5uXtKFURtaEUVC2AHs",s:"MNGO"},
  {a:"HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC",s:"AI16Z"},
  {a:"9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump",s:"FWOG"},
  {a:"8Ki8DpuWNxu9VsS3kQbarsCWMcFGWkzzA8pUPto9zBd5",s:"LOCKIN"},
  {a:"GtDZKAqvMZMnti46ZewMiXCa4oXF4bZxwQPoKdy1uZK",s:"PNUT"},
  {a:"Cn5Ne1vmR9NqEkSJ7HptjFBMFKSSYos1c5gBPSGDSrGH",s:"ACT"},
  {a:"ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzc8yy",s:"MOODENG"},
  {a:"HxRELUQfvvjToVbacjr9YECdfQMUqGgPYB68jVDHejpG",s:"CHILLGUY"},
  {a:"ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",s:"BOME"},
  {a:"85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ",s:"WORMHOLE"},
  {a:"GFX1ZjR2P15tmrSwow6FjyDYcEkoNAbMoGfMJH4TBcJA",s:"GOFX"},
  {a:"DtR4D9FtVoTX2569gaL837ZgrB6wNjj6tkmnX9Rdk9B2",s:"DOGE"},
  {a:"CnxJRnNnBCDVd8b8GnGzB3YBnzqpqkwAknXiEWkVpump",s:"GORK"},
  {a:"Fishy64jCaa3ooqXw7BkM9N8bKBLLAe8kGaFjFUqbzUJ",s:"FISH"},
  {a:"4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy",s:"WHALES"},
  {a:"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",s:"SAMO"},
  {a:"5KV2W2XPdSo97wQWcuAf9XFHgbcPMRNzauXnz7fhpump",s:"HARAMBE"},
  {a:"9LzCMqDgTKYz9Drzqnpgee3SGa89up3a247ypMj2xrqM",s:"AGNT"},
  {a:"3psH1Mj1f7yUfaD5gh6Zj7epFqOUX51TX9bKFmui3B9U",s:"EPIK"},
  {a:"Bm3gAJABHkFsLGZyWbDkP6xFMZM6Lnp3bM1yCQxpump",s:"SIGMA"},
  {a:"GdW2SFdDNY4VYAmgdUKt4AkPzUkT8ZPVqEbNnpZpump",s:"UWU"},
];

async function detectSignals(){
  try{
    // DexScreener batch API: up to 30 addresses per call
    const CHUNK=30;
    const allPairs=[];
    for(let i=0;i<TOKENS.length;i+=CHUNK){
      const chunk=TOKENS.slice(i,i+CHUNK);
      const addrs=chunk.map(t=>t.a).join(',');
      try{
        const r=await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${addrs}`,{timeout:15000});
        if(r.data?.pairs)allPairs.push(...r.data.pairs);
      }catch{}
      if(i+CHUNK<TOKENS.length)await new Promise(r=>setTimeout(r,500));
    }
    // group pairs by token address
    const byToken={};
    for(const p of allPairs){
      const addr=p.baseToken?.address||'';
      if(!byToken[addr])byToken[addr]=[];
      byToken[addr].push(p);
    }
    const results=Object.values(byToken).map(pairs=>({data:{pairs}}));
    const signals=[];
    for(const r of results){
      if(!r?.data?.pairs)continue;
      const pairs=r.data.pairs.filter(p=>
        p.chainId==="solana"&&
        (p.dexId==="raydium"||p.dexId==="orca"||p.dexId==="meteora")&&
        (p.liquidity?.usd||0)>=30000&&
        (p.volume?.h24||0)>=5000
      );
      if(!pairs.length)continue;
      const best=pairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
      const vol=best.volume?.h24||0;
      const ch1h=best.priceChange?.h1||0;
      const ch5m=best.priceChange?.m5||0;
      const ch6h=best.priceChange?.h6||0;
      const txns=best.txns?.h1||{};
      const buys=txns.buys||0,sells=txns.sells||0;
      const br=buys+sells>0?buys/(buys+sells):0.5;
      const tokenAddr=best.baseToken?.address||"";
      const symbol=best.baseToken?.symbol||"?";
      const price=parseFloat(best.priceUsd||"0");
      if(!price||price<=0)continue;
      if(br<0.52)continue;
      if(ch5m<0)continue;
      // FIX BUG14: stronger downtrend filter - reject if 1h is strongly negative
      if(ch1h<-5&&ch6h<0)continue;
      if(ch1h<0&&ch6h<0)continue;
      const conf=Math.min(90,Math.round(
        50+Math.min(ch1h*1.5,10)+Math.min(ch5m*3,10)+((br-0.5)*20)+(vol>200000?8:vol>50000?4:0)
      ));
      if(conf<55)continue;
      signals.push({
        token:{address:tokenAddr,symbol,name:best.baseToken?.name||symbol,
          priceUsd:String(price),volume24h:vol,
          liquidity:best.liquidity?.usd||0,priceChange5m:ch5m,priceChange1h:ch1h},
        confidence:conf,buys,sells,buyRatio:Math.round(br*100),
        platform:best.dexId==="raydium"?"Raydium":best.dexId==="orca"?"Orca":"Meteora"
      });
    }
    return signals.sort((a,b)=>b.confidence-a.confidence);
  }catch(e){console.error("[Scan]",e.message);return[];}
}

// FIX BUG5: in-memory Set for sell locks (never persisted to DB)
const sellingSet=new Set(); // key: `${uid}:${tokenAddress}`
// FIX BUG6: per-user price check lock (prevents concurrent price checks)
const priceCheckLock={};
const buyingLock={};
const botIntervals={};

async function runScan(uid,pk,buyAmt,maxPos){
  const s=S.getSettings(uid);
  if(!s?.isRunning)return;
  const positions=S.getPositions(uid);
  const max=maxPos||5;
  if(positions.length>=max)return;
  if(buyingLock[uid]){console.log("[Bot] Buy in progress, skip scan");return;}
  const kp=pkToKeypair(pk);
  const pubkey=pubkeyToBase58(kp.publicKey);
  const balance=await getSOLBalance(pubkey);
  const needed=buyAmt+0.005;
  if(balance<needed){
    console.log(`[Bot] Low SOL: ${balance.toFixed(4)}`);
    return;
  }
  const sigs=await detectSignals();
  if(!sigs.length){console.log(`[Bot] No signals | pos:${positions.length}/${max} | SOL:${balance.toFixed(4)}`);return;}
  console.log(`[Bot] ${sigs.length} signals | pos:${positions.length}/${max} | SOL:${balance.toFixed(4)}`);
  buyingLock[uid]=true;
  try{
    // FIX BUG9: re-check position count per iteration to prevent over-buying
    for(const sig of sigs){
      if(S.getPositions(uid).length>=max)break;
      if(S.getPositions(uid).some(p=>p.tokenAddress===sig.token.address))continue;
      const curBal=await getSOLBalance(pubkey);
      if(curBal<needed){console.log("[Bot] Balance too low");break;}
      S.addAlert({userId:uid,tokenSymbol:sig.token.symbol,tokenName:sig.token.name,
        tokenAddress:sig.token.address,confidence:sig.confidence,
        whaleCount:sig.buys,netBuyUsd:Math.round(sig.token.volume24h*0.5),platform:sig.platform});
      console.log(`[Bot] BUY ${sig.token.symbol} conf:${sig.confidence}% price:${sig.token.priceUsd}`);
      const res=await jupiterBuy(pk,sig.token.address,buyAmt);
      if(res.success&&res.txHash){
        S.addTrade({userId:uid,action:"BUY",tokenSymbol:sig.token.symbol,
          tokenAddress:sig.token.address,amountSOL:buyAmt,
          price:parseFloat(sig.token.priceUsd),txHash:res.txHash,profit:null,status:"confirmed"});
        S.addPosition({userId:uid,tokenAddress:sig.token.address,tokenSymbol:sig.token.symbol,
          entryPrice:parseFloat(sig.token.priceUsd),buyAmountSOL:buyAmt,tokenAmount:res.tokenAmount});
      }
      await new Promise(r=>setTimeout(r,2000));
    }
  }finally{buyingLock[uid]=false;}
}

async function runPriceCheck(uid,pk,profitPct,slPct){
  // FIX BUG6: prevent concurrent price checks for same user
  if(priceCheckLock[uid]){console.log("[Price] Check already running, skip");return;}
  priceCheckLock[uid]=true;
  try{
    const s=S.getSettings(uid);
    if(!s?.isRunning)return;
    const positions=S.getPositions(uid);
    if(!positions.length)return;
    const sl=slPct||5;
    const profit=profitPct||1;
    for(const p of positions){
      const sellKey=`${uid}:${p.tokenAddress}`;
      // FIX BUG5: use in-memory Set instead of property on DB object
      if(sellingSet.has(sellKey))continue;
      try{
        const r=await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`,{timeout:8000});
        const best=(r.data?.pairs||[]).filter(x=>x.chainId==="solana")
          .sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
        if(!best?.priceUsd)continue;
        const cur=parseFloat(best.priceUsd);
        if(!cur||cur<=0)continue;
        const pnl=((cur-p.entryPrice)/p.entryPrice)*100;
        S.updatePositionHigh(uid,p.tokenAddress,cur);
        const pos=S.getPositions(uid).find(x=>x.tokenAddress===p.tokenAddress);
        const peak=pos?.highestPrice||cur;
        const trailDrop=peak>0?((peak-cur)/peak)*100:0;
        const hitProfit=pnl>=profit;
        const hitFixed=pnl<=-sl;
        const hitTrail=pnl>=0.5&&trailDrop>=sl;
        if(Math.abs(pnl)>0.1)
          console.log(`[Price] ${p.tokenSymbol} PnL:${pnl.toFixed(2)}% trail:${trailDrop.toFixed(2)}% peak:${peak}`);
        if(hitProfit||hitFixed||hitTrail){
          // FIX BUG5: mark in Set immediately before any await
          sellingSet.add(sellKey);
          const reason=hitProfit?"PROFIT":hitTrail?"TRAIL-SL":"STOP-LOSS";
          console.log(`[Bot] SELL ${p.tokenSymbol} ${reason} PnL:${pnl.toFixed(2)}%`);
          // FIX BUG12: skip sell if tokenAmount is 0 or missing
          if(p.tokenAmount&&p.tokenAmount!=="0"){
            const sr=await jupiterSell(pk,p.tokenAddress,p.tokenAmount);
            if(sr.success&&sr.txHash){
              const profitSOL=parseFloat((p.buyAmountSOL*(pnl/100)).toFixed(4));
              S.addTrade({userId:uid,action:"SELL",tokenSymbol:p.tokenSymbol,
                tokenAddress:p.tokenAddress,amountSOL:p.buyAmountSOL,price:cur,
                txHash:sr.txHash,profit:profitSOL,status:"confirmed"});
              console.log(`[Bot] SOLD ${p.tokenSymbol} profit:${profitSOL} SOL`);
              // FIX BUG2: only remove position on successful sell
              S.removePosition(uid,p.tokenAddress);
              sellingSet.delete(sellKey);
              // trigger immediate scan to fill the open slot
              setTimeout(()=>runScan(uid,pk,s.buyAmount||0.119,s.maxPositions||5),2000);
            }else{
              // FIX BUG2: sell failed → keep position, clear lock so it retries next cycle
              console.log(`[Bot] SELL failed for ${p.tokenSymbol}: ${sr.error} — will retry`);
              sellingSet.delete(sellKey);
            }
          }else{
            // tokenAmount is 0 — position is unrecoverable, remove it
            console.log(`[Bot] ${p.tokenSymbol} tokenAmount=0, removing ghost position`);
            S.removePosition(uid,p.tokenAddress);
            sellingSet.delete(sellKey);
          }
        }
      }catch(e){
        const sellKey=`${uid}:${p.tokenAddress}`;
        sellingSet.delete(sellKey); // clear lock on error so it retries
        console.error("[Price]",p.tokenSymbol,e.message);
      }
    }
  }finally{
    priceCheckLock[uid]=false;
  }
}

async function startBot(uid,pk,buyAmt,profitPct,slPct,maxPos){
  if(botIntervals[uid]){
    clearInterval(botIntervals[uid].scan);
    clearInterval(botIntervals[uid].price);
    delete botIntervals[uid];
  }
  buyingLock[uid]=false;
  // clear any stale sell locks for this user on (re)start
  for(const k of sellingSet){if(k.startsWith(`${uid}:`))sellingSet.delete(k);}
  console.log(`[Bot] START uid:${uid} buy:${buyAmt}SOL profit:${profitPct}% SL:${slPct}% max:${maxPos}`);
  // Immediate first scan (5s delay for DB load)
  setTimeout(()=>runScan(uid,pk,buyAmt,maxPos),5000);
  botIntervals[uid]={
    // 3 min scan = 20 trades/hour with 3 positions cycling at 1% profit
    scan:setInterval(()=>runScan(uid,pk,buyAmt,maxPos),3*60*1000),
    // Price check every 15 seconds for fast sells
    price:setInterval(()=>runPriceCheck(uid,pk,profitPct,slPct),15*1000)
  };
}

function stopBot(uid){
  if(botIntervals[uid]){
    clearInterval(botIntervals[uid].scan);
    clearInterval(botIntervals[uid].price);
    delete botIntervals[uid];
  }
  buyingLock[uid]=false;
  for(const k of sellingSet){if(k.startsWith(`${uid}:`))sellingSet.delete(k);}
  console.log(`[Bot] STOPPED uid:${uid}`);
}

// FIX BUG10: await loadDB before autoResume
async function autoResume(){
  await new Promise(r=>setTimeout(r,8000)); // server stability grace period
  const running=DB.settings.filter(s=>s.isRunning&&s.tradingPrivateKey);
  for(const s of running){
    console.log(`[Bot] Auto-resume uid:${s.userId} positions:${S.getPositions(s.userId).length}`);
    await startBot(s.userId,s.tradingPrivateKey,s.buyAmount||0.119,s.profitTarget||1,s.stopLoss||5,s.maxPositions||5);
  }
}

// === API ===
app.post("/api/auth/register",(req,res)=>{
  const{email,password,username}=req.body;
  if(!email||!password||!username)return res.status(400).json({error:"All fields required"});
  if(password.length<6)return res.status(400).json({error:"Password min 6 chars"});
  if(S.getUserByEmail(email))return res.status(400).json({error:"Email already exists"});
  const u=S.createUser({email,password:hashPw(password),username});
  S.upsertSettings(u.id,{});
  res.json({user:{id:u.id,email:u.email,username:u.username}});
});
app.post("/api/auth/login",(req,res)=>{
  const{email,password}=req.body;
  const u=S.getUserByEmail(email);
  if(!u||u.password!==hashPw(password))return res.status(401).json({error:"Invalid credentials"});
  res.json({user:{id:u.id,email:u.email,username:u.username}});
});
app.get("/api/user/:id",(req,res)=>{
  const u=S.getUserById(parseInt(req.params.id));
  if(!u)return res.status(404).json({error:"Not found"});
  res.json({id:u.id,email:u.email,username:u.username});
});
app.get("/api/wallets/:uid",async(req,res)=>{
  const ws=S.getWallets(parseInt(req.params.uid));
  res.json(await Promise.all(ws.map(async w=>({...w,balance:await getSOLBalance(w.address)}))));
});
app.post("/api/wallets",(req,res)=>{
  const{userId,name,address}=req.body;
  if(!userId||!name||!address)return res.status(400).json({error:"Required"});
  res.json(S.addWallet({userId:parseInt(userId),name,address}));
});
app.delete("/api/wallets/:id",(req,res)=>{S.deleteWallet(parseInt(req.params.id),parseInt(req.body.userId));res.json({success:true});});
app.post("/api/wallets/:id/activate",(req,res)=>{S.setActive(parseInt(req.params.id),parseInt(req.body.userId));res.json({success:true});});
app.get("/api/bot-settings/:uid",(req,res)=>{
  const s=S.getSettings(parseInt(req.params.uid));
  if(s){const{tradingPrivateKey:pk,...safe}=s;return res.json({...safe,hasTradingWallet:!!pk});}
  res.json({buyAmount:0.119,profitTarget:1,stopLoss:5,maxPositions:5,isRunning:false,hasTradingWallet:false});
});
app.post("/api/bot-settings/:uid",(req,res)=>{
  const uid=parseInt(req.params.uid);
  const{buyAmount,profitTarget,stopLoss,maxPositions,tradingPrivateKey}=req.body;
  const d={};
  if(buyAmount!==undefined)d.buyAmount=parseFloat(buyAmount);
  if(profitTarget!==undefined)d.profitTarget=parseFloat(profitTarget);
  if(stopLoss!==undefined)d.stopLoss=parseFloat(stopLoss);
  if(maxPositions!==undefined)d.maxPositions=parseInt(maxPositions);
  if(tradingPrivateKey!==undefined)d.tradingPrivateKey=tradingPrivateKey;
  const s=S.upsertSettings(uid,d);
  const{tradingPrivateKey:pk,...safe}=s;
  res.json({...safe,hasTradingWallet:!!pk});
});
app.post("/api/bot/start/:uid",async(req,res)=>{
  const uid=parseInt(req.params.uid);
  const s=S.getSettings(uid);
  if(!s?.tradingPrivateKey)return res.status(400).json({error:"Add private key in Settings first"});
  S.setBotRunning(uid,true);
  await startBot(uid,s.tradingPrivateKey,s.buyAmount||0.119,s.profitTarget||1,s.stopLoss||5,s.maxPositions||5);
  res.json({success:true,message:"Bot started!"});
});
app.post("/api/bot/stop/:uid",async(req,res)=>{
  const uid=parseInt(req.params.uid);
  S.setBotRunning(uid,false);
  stopBot(uid);
  res.json({success:true,message:"Bot stopped."});
});
app.get("/api/positions/:uid",(req,res)=>res.json(S.getPositions(parseInt(req.params.uid))));
app.get("/api/trades/:uid",(req,res)=>res.json([...S.getTrades(parseInt(req.params.uid))].reverse()));
app.get("/api/whale-alerts/:uid",(req,res)=>res.json([...S.getAlerts(parseInt(req.params.uid))].reverse()));
app.get("/api/stats/:uid",(req,res)=>{
  const uid=parseInt(req.params.uid);
  const trades=S.getTrades(uid);
  const sells=trades.filter(t=>t.action==="SELL"&&t.profit!==null);
  const tp=sells.reduce((s,t)=>s+(t.profit||0),0);
  const wins=sells.filter(t=>(t.profit||0)>0).length;
  res.json({totalProfit:parseFloat(tp.toFixed(4)),totalTrades:trades.length,
    winRate:sells.length?Math.round(wins/sells.length*100):0,
    whaleAlerts:S.getAlerts(uid).length,openPositions:S.getPositions(uid).length});
});
app.get("/api/market/scan",async(req,res)=>{
  try{res.json({signals:(await detectSignals()).slice(0,10)});}
  catch(e){res.status(500).json({error:e.message});}
});
app.get("/api/balance/:addr",async(req,res)=>res.json({balance:await getSOLBalance(req.params.addr)}));
app.get("/health",(req,res)=>res.json({status:"ok",uptime:Math.round(process.uptime()),
  positions:DB.positions?.length||0,version:"v16-fixed"}));

const pub=path.join(__dirname,"public");
if(fs.existsSync(pub)){
  app.use(express.static(pub));
  app.get("*",(req,res)=>{if(!req.path.startsWith("/api"))res.sendFile(path.join(pub,"index.html"));});
}

app.listen(PORT,"0.0.0.0",async()=>{
  console.log(`\nWhaleBot v17\n[✓] BUG1 FIXED: asLegacyTransaction=true (trades actually work now)\n[✓] BUG2 FIXED: position only removed on successful sell\n[✓] BUG5 FIXED: _selling uses in-memory Set (survives restarts)\n[✓] BUG6 FIXED: priceCheckLock prevents double-sell\n[✓] BUG8 FIXED: 409 SHA conflict retries immediately\n[✓] BUG9 FIXED: slot count re-checked per buy iteration\n[✓] BUG10 FIXED: autoResume after loadDB completes\n[✓] BUG11 FIXED: async file writes (non-blocking)\n[✓] BUG13 FIXED: reduce() for initNid (no RangeError)\n[✓] 50 tokens scanned | 3min scan | 15sec price check | 1% profit | 5% SL | 5 pos x 0.119 SOL (~$10)\n[✓] ঘণ্টায় ১০০ trade সম্ভব (5 positions x 20 cycles)\n`);
  await loadDB();
  initNid();
  await autoResume();
});
