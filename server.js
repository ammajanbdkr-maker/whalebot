const express=require("express"),path=require("path"),fs=require("fs"),axios=require("axios"),app=express(),PORT=process.env.PORT||3000;
app.use(express.json());app.use(express.urlencoded({extended:false}));

// ===== GITHUB PERSISTENT STORAGE =====
const GITHUB_TOKEN=process.env.GITHUB_TOKEN||"YOUR_GITHUB_TOKEN";
const GITHUB_REPO=process.env.GITHUB_REPO||"ammajanbdkr-maker/whalebot";
const DATA_FILE="whalebot_data.json";
const LOCAL_CACHE="/tmp/whalebot_data.json";

let DB={users:[],wallets:[],trades:[],alerts:[],settings:[]};
let dbFileSha=null;
let saveTimer=null;

async function loadDBFromGithub(){
  try{
    const r=await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,{
      headers:{"Authorization":`token ${GITHUB_TOKEN}`,"Accept":"application/vnd.github.v3+json"},
      timeout:10000
    });
    dbFileSha=r.data.sha;
    const content=Buffer.from(r.data.content,"base64").toString("utf8");
    DB=JSON.parse(content);
    fs.writeFileSync(LOCAL_CACHE,content);
    console.log("[DB] Loaded from GitHub:",DB.users.length,"users",DB.trades.length,"trades");
  }catch(e){
    if(e.response?.status===404){
      console.log("[DB] No GitHub data yet, starting fresh");
    }else{
      console.log("[DB] GitHub load error:",e.message,"- using local cache");
      try{if(fs.existsSync(LOCAL_CACHE))DB=JSON.parse(fs.readFileSync(LOCAL_CACHE,"utf8"));}catch{}
    }
  }
}

async function saveDBToGithub(){
  try{
    const content=Buffer.from(JSON.stringify(DB)).toString("base64");
    const body={message:"bot data update",content};
    if(dbFileSha)body.sha=dbFileSha;
    const r=await axios.put(`https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,body,{
      headers:{"Authorization":`token ${GITHUB_TOKEN}`,"Accept":"application/vnd.github.v3+json"},
      timeout:15000
    });
    dbFileSha=r.data.content.sha;
    fs.writeFileSync(LOCAL_CACHE,JSON.stringify(DB));
  }catch(e){
    console.log("[DB] GitHub save error:",e.message,"- saved locally only");
    try{fs.writeFileSync(LOCAL_CACHE,JSON.stringify(DB));}catch{}
  }
}

// Debounced save - waits 3s after last change to batch saves
function saveDB(){
  try{fs.writeFileSync(LOCAL_CACHE,JSON.stringify(DB));}catch{}
  if(saveTimer)clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>saveDBToGithub(),3000);
}

let nid={user:1,wallet:1,trade:1,alert:1};
function initNid(){
  nid.user=Math.max(0,...DB.users.map(u=>u.id),0)+1;
  nid.wallet=Math.max(0,...DB.wallets.map(w=>w.id),0)+1;
  nid.trade=Math.max(0,...DB.trades.map(t=>t.id),0)+1;
  nid.alert=Math.max(0,...DB.alerts.map(a=>a.id),0)+1;
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
  upsertSettings:(uid,d)=>{let s=DB.settings.find(s=>s.userId===uid);if(s)Object.assign(s,d);else{s={userId:uid,buyAmount:0.035,profitTarget:3,stopLoss:10,isRunning:false,...d};DB.settings.push(s);}saveDB();return s;},
  setBotRunning:(uid,v)=>{let s=DB.settings.find(s=>s.userId===uid);if(s)s.isRunning=v;saveDB();},
  addTrade:d=>{const t={id:nid.trade++,...d,timestamp:Date.now()};DB.trades.push(t);saveDB();return t;},
  getTrades:uid=>DB.trades.filter(t=>t.userId===uid),
  addAlert:d=>{const a={id:nid.alert++,...d,timestamp:Date.now()};DB.alerts.push(a);saveDB();return a;},
  getAlerts:uid=>DB.alerts.filter(a=>a.userId===uid),
};

const HELIUS_KEY=process.env.HELIUS_KEY||"YOUR_HELIUS_KEY";
const RPC=`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_API=`https://api.helius.xyz/v0`;
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

async function signAndSendTx(txBase64,secretKey){
  const txBytes=Buffer.from(txBase64,"base64");
  const numSigs=txBytes[0];
  const messageStart=1+numSigs*64;
  const message=txBytes.slice(messageStart);
  const sig=nacl.sign.detached(message,secretKey);
  sig.forEach((b,i)=>txBytes[1+i]=b);
  const r=await axios.post(RPC,{jsonrpc:"2.0",id:1,method:"sendTransaction",params:[txBytes.toString("base64"),{encoding:"base64",skipPreflight:false,maxRetries:3}]},{timeout:30000});
  if(r.data.error)throw new Error(r.data.error.message);
  return r.data.result;
}

async function getSOLBalance(address){
  try{const r=await axios.post(RPC,{jsonrpc:"2.0",id:1,method:"getBalance",params:[address]},{timeout:8000});return(r.data?.result?.value||0)/1e9;}catch{return 0;}
}

async function jupiterBuy(pk58,outputMint,amountSOL){
  try{
    const kp=pkToKeypair(pk58);
    const pubkey=pubkeyToBase58(kp.publicKey);
    const lamports=Math.floor(amountSOL*1e9);
    const q=(await axios.get(`${JUPITER_API}/quote`,{params:{inputMint:SOL_MINT,outputMint,amount:lamports,slippageBps:300},timeout:15000})).data;
    if(!q?.outAmount)throw new Error("No quote");
    const sw=(await axios.post(`${JUPITER_API}/swap`,{quoteResponse:q,userPublicKey:pubkey,wrapAndUnwrapSol:true,computeUnitPriceMicroLamports:"auto",dynamicComputeUnitLimit:true},{timeout:20000})).data;
    if(!sw?.swapTransaction)throw new Error("No swap tx");
    const sig=await signAndSendTx(sw.swapTransaction,kp.secretKey);
    console.log(`[Jupiter] BUY sent: ${sig}`);
    await new Promise(r=>setTimeout(r,5000));
    return{success:true,txHash:sig,outAmount:q.outAmount};
  }catch(e){
    console.log(`[Jupiter] BUY error: ${e?.response?.data?.error||e.message}`);
    return{success:false,error:e?.response?.data?.error||e.message};
  }
}

async function jupiterSell(pk58,inputMint,tokenAmount){
  try{
    const kp=pkToKeypair(pk58);
    const pubkey=pubkeyToBase58(kp.publicKey);
    const q=(await axios.get(`${JUPITER_API}/quote`,{params:{inputMint,outputMint:SOL_MINT,amount:tokenAmount,slippageBps:300},timeout:15000})).data;
    if(!q?.outAmount)throw new Error("No quote");
    const sw=(await axios.post(`${JUPITER_API}/swap`,{quoteResponse:q,userPublicKey:pubkey,wrapAndUnwrapSol:true,computeUnitPriceMicroLamports:"auto",dynamicComputeUnitLimit:true},{timeout:20000})).data;
    if(!sw?.swapTransaction)throw new Error("No swap tx");
    const sig=await signAndSendTx(sw.swapTransaction,kp.secretKey);
    await new Promise(r=>setTimeout(r,5000));
    return{success:true,txHash:sig};
  }catch(e){
    console.log(`[Jupiter] SELL error: ${e?.response?.data?.error||e.message}`);
    return{success:false,error:e?.response?.data?.error||e.message};
  }
}

// ===== SMART MONEY WALLETS =====
const SMART_MONEY_WALLETS=[
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "CuieVDEDtLo7FypArnRRos94cHMbFNaLHHdXDHnbSdVz",
  "GDDMwNyyx8uB6zke5zjXHJ4HbFMeF3SG5mmFEMwHkUzM",
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
  "7cnh3G1sNQMnTFMgBpAKq4xAUTmNNxhRhDLBTz3JWFKJ",
  "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
];

const whaleCache={};
const smartMoneyCache={};
const priceHistory={};
const newsCache={};

async function fetchWhaleTransactions(){
  try{
    const r=await axios.post(RPC,{jsonrpc:"2.0",id:1,method:"getSignaturesForAddress",params:["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",{limit:50}]},{timeout:12000});
    const sigs=(r.data?.result||[]).map(s=>s.signature).slice(0,10);
    if(!sigs.length)return;
    const txRes=await axios.post(`${HELIUS_API}/transactions?api-key=${HELIUS_KEY}`,{transactions:sigs},{timeout:15000});
    const txs=txRes.data||[];
    for(const tx of txs){
      if(tx.type!=="SWAP")continue;
      const nativeAmt=tx.nativeTransfers?.reduce((s,t)=>s+Math.abs(t.amount||0),0)||0;
      if(nativeAmt<5000000000)continue;
      const isSmartMoney=SMART_MONEY_WALLETS.includes(tx.feePayer);
      for(const tt of(tx.tokenTransfers||[])){
        const mint=tt.mint;
        if(!mint||mint===SOL_MINT)continue;
        if(!whaleCache[mint])whaleCache[mint]={count:0,totalSOL:0,lastSeen:0,isSmartMoney:false};
        whaleCache[mint].count++;
        whaleCache[mint].totalSOL+=nativeAmt/1e9;
        whaleCache[mint].lastSeen=Date.now();
        if(isSmartMoney){
          whaleCache[mint].isSmartMoney=true;
          console.log(`[SmartMoney] ${tx.feePayer?.slice(0,8)} bought ${mint.slice(0,8)} with ${(nativeAmt/1e9).toFixed(2)} SOL`);
        }
      }
    }
    for(const wallet of SMART_MONEY_WALLETS.slice(0,3)){
      try{
        const wr=await axios.post(RPC,{jsonrpc:"2.0",id:1,method:"getSignaturesForAddress",params:[wallet,{limit:5}]},{timeout:8000});
        const wsigs=(wr.data?.result||[]).map(s=>s.signature);
        if(!wsigs.length)continue;
        const wtx=await axios.post(`${HELIUS_API}/transactions?api-key=${HELIUS_KEY}`,{transactions:wsigs.slice(0,3)},{timeout:10000});
        for(const tx of(wtx.data||[])){
          if(tx.type!=="SWAP")continue;
          for(const tt of(tx.tokenTransfers||[])){
            if(!tt.mint||tt.mint===SOL_MINT)continue;
            if(!smartMoneyCache[tt.mint])smartMoneyCache[tt.mint]={wallets:[],lastSeen:0};
            if(!smartMoneyCache[tt.mint].wallets.includes(wallet))smartMoneyCache[tt.mint].wallets.push(wallet);
            smartMoneyCache[tt.mint].lastSeen=Date.now();
          }
        }
      }catch{}
    }
  }catch(e){console.log(`[Whale] error: ${e.message}`);}
}

async function fetchNews(){
  try{
    const r=await axios.get("https://api.coingecko.com/api/v3/news",{timeout:10000});
    const articles=r.data?.data||[];
    for(const a of articles.slice(0,10)){
      const title=(a.title||"").toLowerCase();
      const keywords=["solana","sol","bonk","wif","popcat","bome","jup","ray"];
      for(const kw of keywords){
        if(title.includes(kw)){
          if(!newsCache[kw])newsCache[kw]={count:0,lastSeen:0,sentiment:0};
          newsCache[kw].count++;
          newsCache[kw].lastSeen=Date.now();
          const positive=["surge","rally","pump","moon","bullish","gain","up","high","record","launch"].some(w=>title.includes(w));
          const negative=["crash","dump","fall","bear","down","hack","scam","rug"].some(w=>title.includes(w));
          newsCache[kw].sentiment+=positive?1:negative?-1:0;
        }
      }
    }
  }catch(e){console.log(`[News] error: ${e.message}`);}
}

function calculateRSI(prices,period=14){
  if(prices.length<period+1)return 50;
  let gains=0,losses=0;
  for(let i=prices.length-period;i<prices.length;i++){
    const diff=prices[i]-prices[i-1];
    if(diff>0)gains+=diff;else losses+=Math.abs(diff);
  }
  const avgGain=gains/period;
  const avgLoss=losses/period;
  if(avgLoss===0)return 100;
  const rs=avgGain/avgLoss;
  return 100-(100/(1+rs));
}

const ESTABLISHED_TOKENS=[
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr","ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",
  "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5","8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGzmh3iEK",
  "A3eME5CetyZPBoWbRUwY3tSe25S6tb18ba9ZPbWk9eFJ","GJAFwWjJ3vnTsrazi8niGkdDwMoykfKt15NqZpWKkGBp",
  "CTg3ZgYx79zrE3osTQg6R3iuaBLivuEv3AiCNcpwSNuX","2uvch6aviS4jVD9ew7oPhsTEoVtUTRXFNWqCxjQ5tWVm",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN","4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE","HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  "hntyVP6YFm1Hg25TN9WGLqM18LdZQZWwdDkn5f9GnhS","MNDEFzGvMt87ueuAgD7R4G99u1aMDe32xv1hL9DXZXF",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So","kinXdEcpDQeHPEuQnqmUgtYykqKTPVEfq83K1DuvS7s",
  "SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y","nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs","9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E",
  "4TGnuScCu6ZJbCQcHsXeNDcGMnPkSoJxL7VZgGmiRVN","3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
];

async function detectRealWhales(){
  try{
    const results=await Promise.all(ESTABLISHED_TOKENS.map(a=>
      axios.get(`https://api.dexscreener.com/latest/dex/tokens/${a}`,{timeout:8000}).catch(()=>null)
    ));
    const signals=[];
    for(const r of results){
      if(!r)continue;
      const pairs=(r.data?.pairs||[]).filter(p=>
        p.chainId==="solana"&&
        (p.dexId==="raydium"||p.dexId==="orca"||p.dexId==="meteora")&&
        (p.liquidity?.usd||0)>=20000&&
        (p.volume?.h24||0)>=5000
      );
      if(!pairs.length)continue;
      const best=pairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
      const vol=best.volume?.h24||0,liq=best.liquidity?.usd||0;
      const ch1h=best.priceChange?.h1||0,ch5m=best.priceChange?.m5||0;
      const txns=best.txns?.h1||{},buys=txns.buys||0,sells=txns.sells||0;
      const br=buys+sells>0?buys/(buys+sells):0.5;
      const tokenAddr=best.baseToken?.address||"";
      const symbol=best.baseToken?.symbol||"?";
      if(!priceHistory[tokenAddr])priceHistory[tokenAddr]=[];
      priceHistory[tokenAddr].push(parseFloat(best.priceUsd||"0"));
      if(priceHistory[tokenAddr].length>50)priceHistory[tokenAddr].shift();
      const rsi=calculateRSI(priceHistory[tokenAddr]);
      const newsSentiment=Object.entries(newsCache).filter(([k])=>symbol.toLowerCase().includes(k)).reduce((s,[,v])=>s+v.sentiment,0);
      const whaleData=whaleCache[tokenAddr];
      const smartData=smartMoneyCache[tokenAddr];
      const whaleBonus=whaleData?.count>=2?15:0;
      const smartBonus=smartData?.wallets?.length>=1?20:0;
      const newsBonus=newsSentiment>0?10:newsSentiment<0?-10:0;
      const rsiBonus=rsi>=30&&rsi<=45?15:rsi>70?-10:0;
      const allDexPrices=pairs.map(p=>parseFloat(p.priceUsd||"0")).filter(p=>p>0);
      const priceSpread=allDexPrices.length>1?(Math.max(...allDexPrices)-Math.min(...allDexPrices))/Math.min(...allDexPrices)*100:0;
      const arbBonus=priceSpread>0.5?10:0;
      if(br<0.52)continue;
      if(ch1h<=0&&ch5m<=0)continue;
      if(liq<20000)continue;
      if(rsi>75)continue;
      const conf=Math.min(95,Math.round(
        45+
        (ch1h>0?Math.min(ch1h*1.5,12):0)+
        (ch5m>0?Math.min(ch5m*2,8):0)+
        ((br-0.5)*20)+
        (vol>500000?8:vol>100000?4:0)+
        whaleBonus+smartBonus+newsBonus+rsiBonus+arbBonus
      ));
      if(conf<55)continue;
      const reasons=[];
      if(whaleBonus>0)reasons.push(`🐋 Whale(${whaleData.count})`);
      if(smartBonus>0)reasons.push(`🧠 SmartMoney(${smartData.wallets.length})`);
      if(newsBonus>0)reasons.push("📰 +News");
      if(rsiBonus>0)reasons.push(`📊 RSI:${rsi.toFixed(0)}`);
      if(arbBonus>0)reasons.push(`💱 Arb:${priceSpread.toFixed(1)}%`);
      signals.push({
        token:{address:tokenAddr,symbol,name:best.baseToken?.name||"?",priceUsd:best.priceUsd||"0",volume24h:vol,liquidity:liq,priceChange5m:ch5m,priceChange1h:ch1h,url:best.url||""},
        confidence:conf,buys,sells,buyRatio:Math.round(br*100),
        netBuyUsd:Math.round(vol*br),
        whaleCount:whaleData?.count||Math.max(1,Math.floor(buys/20)),
        platform:best.dexId==="raydium"?"Raydium":best.dexId==="orca"?"Orca":"Meteora",
        isSmartMoney:smartBonus>0,isWhale:whaleBonus>0,
        rsi:Math.round(rsi),reasons:reasons.join(" "),priceSpread:priceSpread.toFixed(2)
      });
    }
    return signals.sort((a,b)=>b.confidence-a.confidence);
  }catch(e){console.error("[Scan]",e.message);return[];}
}

setInterval(fetchWhaleTransactions,60000);
setInterval(fetchNews,300000);
fetchWhaleTransactions();
fetchNews();

const positions={},botIntervals={};

// ===== AUTO-RESUME BOT after restart =====
async function autoResumeBots(){
  await new Promise(r=>setTimeout(r,5000)); // wait 5s for DB to load
  const running=DB.settings.filter(s=>s.isRunning&&s.tradingPrivateKey);
  for(const s of running){
    console.log(`[Bot] Auto-resuming bot for user ${s.userId}`);
    startBot(s.userId,s.tradingPrivateKey,s.buyAmount||0.035,s.profitTarget||3,s.stopLoss||10);
  }
}

async function startBot(uid,pk,buyAmt,profitPct,slPct){
  if(!positions[uid])positions[uid]=[];
  console.log(`[Bot] User ${uid} started buy:${buyAmt}SOL profit:${profitPct}% SL:${slPct}%`);
  try{const kp=pkToKeypair(pk);console.log(`[Bot] Wallet: ${pubkeyToBase58(kp.publicKey)}`);}catch(e){console.log(`[Bot] Keypair error: ${e.message}`);}
  botIntervals[uid]={
    scan:setInterval(async()=>{
      const s=S.getSettings(uid);if(!s?.isRunning)return;
      if((positions[uid]||[]).length>=5)return;
      const sigs=await detectRealWhales();
      console.log(`[Bot] ${sigs.length} signals | positions:${(positions[uid]||[]).length}/5`);
      for(const sig of sigs.filter(s=>s.confidence>=55).slice(0,5-(positions[uid]||[]).length)){
        if((positions[uid]||[]).some(p=>p.tokenAddress===sig.token.address))continue;
        S.addAlert({userId:uid,tokenSymbol:sig.token.symbol,tokenName:sig.token.name,tokenAddress:sig.token.address,confidence:sig.confidence,whaleCount:sig.whaleCount,netBuyUsd:sig.netBuyUsd,platform:sig.platform,isSmartMoney:sig.isSmartMoney,reasons:sig.reasons});
        console.log(`[Bot] BUY ${sig.token.symbol} conf:${sig.confidence}% ${sig.reasons}`);
        const res=await jupiterBuy(pk,sig.token.address,buyAmt);
        if(res.success&&res.txHash){
          S.addTrade({userId:uid,action:"BUY",tokenSymbol:sig.token.symbol,tokenAddress:sig.token.address,amountSOL:buyAmt,price:parseFloat(sig.token.priceUsd),txHash:res.txHash,profit:null,status:"confirmed"});
          positions[uid].push({tokenAddress:sig.token.address,tokenSymbol:sig.token.symbol,entryPrice:parseFloat(sig.token.priceUsd),buyAmountSOL:buyAmt,tokenAmount:parseInt(res.outAmount||0),openedAt:Date.now(),highestPrice:null});
        }else{
          console.log(`[Bot] FAILED: ${res.error}`);
        }
      }
    },120000),
    price:setInterval(async()=>{
      const s=S.getSettings(uid);if(!s?.isRunning)return;
      const sl=slPct||10;
      for(const p of[...(positions[uid]||[])]){
        try{
          const r=await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`,{timeout:8000});
          const best=(r.data?.pairs||[]).sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
          const cur=parseFloat(best?.priceUsd||"0");if(!cur||!p.entryPrice)continue;
          const pnl=((cur-p.entryPrice)/p.entryPrice)*100;
          if(!p.highestPrice||cur>p.highestPrice)p.highestPrice=cur;
          const trailingSL=p.highestPrice*(1-sl/100);
          const hitTrail=p.highestPrice&&cur<=trailingSL&&pnl>0;
          const hitFixed=pnl<=-sl;
          const hitProfit=pnl>=(profitPct||3);
          console.log(`[Bot] ${p.tokenSymbol} PnL:${pnl.toFixed(1)}%`);
          if(hitProfit||hitTrail||hitFixed){
            const reason=hitProfit?"PROFIT":hitTrail?"TRAIL-SL":"FIXED-SL";
            console.log(`[Bot] SELL ${p.tokenSymbol} ${reason} PnL:${pnl.toFixed(1)}%`);
            const sr=p.tokenAmount>0?await jupiterSell(pk,p.tokenAddress,p.tokenAmount):{success:false};
            if(sr.success&&sr.txHash){
              S.addTrade({userId:uid,action:"SELL",tokenSymbol:p.tokenSymbol,tokenAddress:p.tokenAddress,amountSOL:p.buyAmountSOL,price:cur,txHash:sr.txHash,profit:parseFloat((p.buyAmountSOL*(pnl/100)).toFixed(4)),status:"confirmed"});
            }
            positions[uid]=positions[uid].filter(x=>x.tokenAddress!==p.tokenAddress);
          }
        }catch(e){console.error("[Price]",e.message);}
      }
    },30000)
  };
}
function stopBot(uid){if(botIntervals[uid]){clearInterval(botIntervals[uid].scan);clearInterval(botIntervals[uid].price);delete botIntervals[uid];}positions[uid]=[];}

// API Routes
app.post("/api/auth/register",(req,res)=>{const{email,password,username}=req.body;if(!email||!password||!username)return res.status(400).json({error:"All fields required"});if(password.length<6)return res.status(400).json({error:"Min 6 chars"});if(S.getUserByEmail(email))return res.status(400).json({error:"Email exists"});const u=S.createUser({email,password:hashPw(password),username});S.upsertSettings(u.id,{});res.json({user:{id:u.id,email:u.email,username:u.username}});});
app.post("/api/auth/login",(req,res)=>{const{email,password}=req.body;const u=S.getUserByEmail(email);if(!u||u.password!==hashPw(password))return res.status(401).json({error:"Invalid credentials"});res.json({user:{id:u.id,email:u.email,username:u.username}});});
app.get("/api/user/:id",(req,res)=>{const u=S.getUserById(parseInt(req.params.id));if(!u)return res.status(404).json({error:"Not found"});res.json({id:u.id,email:u.email,username:u.username});});
app.get("/api/wallets/:uid",async(req,res)=>{const ws=S.getWallets(parseInt(req.params.uid));res.json(await Promise.all(ws.map(async w=>({...w,balance:await getSOLBalance(w.address)}))));});
app.post("/api/wallets",(req,res)=>{const{userId,name,address}=req.body;if(!userId||!name||!address)return res.status(400).json({error:"Required"});res.json(S.addWallet({userId:parseInt(userId),name,address}));});
app.delete("/api/wallets/:id",(req,res)=>{S.deleteWallet(parseInt(req.params.id),parseInt(req.body.userId));res.json({success:true});});
app.post("/api/wallets/:id/activate",(req,res)=>{S.setActive(parseInt(req.params.id),parseInt(req.body.userId));res.json({success:true});});
app.get("/api/bot-settings/:uid",(req,res)=>{const s=S.getSettings(parseInt(req.params.uid));if(s){const{tradingPrivateKey:pk,...safe}=s;return res.json({...safe,hasTradingWallet:!!pk});}res.json({buyAmount:0.035,profitTarget:3,stopLoss:10,isRunning:false,hasTradingWallet:false});});
app.post("/api/bot-settings/:uid",(req,res)=>{const uid=parseInt(req.params.uid);const{buyAmount,profitTarget,stopLoss,tradingPrivateKey}=req.body;const d={};if(buyAmount!==undefined)d.buyAmount=parseFloat(buyAmount);if(profitTarget!==undefined)d.profitTarget=parseFloat(profitTarget);if(stopLoss!==undefined)d.stopLoss=parseFloat(stopLoss);if(tradingPrivateKey!==undefined)d.tradingPrivateKey=tradingPrivateKey;const s=S.upsertSettings(uid,d);const{tradingPrivateKey:pk,...safe}=s;res.json({...safe,hasTradingWallet:!!pk});});
app.post("/api/bot/start/:uid",async(req,res)=>{const uid=parseInt(req.params.uid);const s=S.getSettings(uid);if(!s?.tradingPrivateKey)return res.status(400).json({error:"Add private key in Settings"});S.setBotRunning(uid,true);startBot(uid,s.tradingPrivateKey,s.buyAmount||0.035,s.profitTarget||3,s.stopLoss||10).catch(console.error);res.json({success:true,message:"Bot started!"});});
app.post("/api/bot/stop/:uid",async(req,res)=>{const uid=parseInt(req.params.uid);S.setBotRunning(uid,false);stopBot(uid);res.json({success:true,message:"Bot stopped."});});
app.get("/api/positions/:uid",(req,res)=>res.json(positions[parseInt(req.params.uid)]||[]));
app.get("/api/trades/:uid",(req,res)=>res.json([...S.getTrades(parseInt(req.params.uid))].reverse()));
app.get("/api/whale-alerts/:uid",(req,res)=>res.json([...S.getAlerts(parseInt(req.params.uid))].reverse()));
app.get("/api/stats/:uid",(req,res)=>{const uid=parseInt(req.params.uid);const trades=S.getTrades(uid);const sells=trades.filter(t=>t.action==="SELL"&&t.profit!==null);const tp=sells.reduce((s,t)=>s+(t.profit||0),0);const wins=sells.filter(t=>(t.profit||0)>0).length;res.json({totalProfit:parseFloat(tp.toFixed(4)),totalTrades:trades.length,winRate:sells.length?Math.round(wins/sells.length*100):0,whaleAlerts:S.getAlerts(uid).length,openPositions:(positions[uid]||[]).length});});
app.get("/api/market/scan",async(req,res)=>{try{res.json({signals:(await detectRealWhales()).slice(0,10)});}catch(e){res.status(500).json({error:e.message});}});
app.get("/api/balance/:addr",async(req,res)=>res.json({address:req.params.addr,balance:await getSOLBalance(req.params.addr)}));
app.get("/api/news",(req,res)=>res.json(newsCache));
app.get("/api/smart-money",(req,res)=>res.json(smartMoneyCache));
app.get("/health",(req,res)=>res.json({status:"ok",uptime:process.uptime()}));

const pub=path.join(__dirname,"public");
if(fs.existsSync(pub)){app.use(express.static(pub));app.get("*",(req,res)=>{if(!req.path.startsWith("/api"))res.sendFile(path.join(pub,"index.html"));});}

// Start server and load DB
app.listen(PORT,"0.0.0.0",async()=>{
  console.log(`\nWhaleBot v14 LIVE - GitHub Persistent Storage\n[✓] Data survives restarts\n[✓] Auto-resume bot\n[✓] Smart Money Tracking\n[✓] RSI/Momentum\n[✓] News Detection\n[✓] Multi-DEX\n[✓] Trailing Stop Loss\n[✓] 25+ Tokens\n`);
  await loadDBFromGithub();
  initNid();
  autoResumeBots();
});
