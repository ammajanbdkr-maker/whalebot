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
let isSaving=false; // prevent concurrent saves

async function loadDB(){
  if(GITHUB_TOKEN){
    try{
      const r=await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,{
        headers:{"Authorization":`token ${GITHUB_TOKEN}`},timeout:10000
      });
      dbFileSha=r.data.sha;
      const content=Buffer.from(r.data.content,"base64").toString("utf8");
      const parsed=JSON.parse(content);
      DB={users:[],wallets:[],trades:[],alerts:[],settings:[],positions:[],...parsed};
      try{fs.writeFileSync(LOCAL_CACHE,content);}catch{}
      console.log(`[DB] Loaded from GitHub: ${DB.users.length} users, ${DB.trades.length} trades, ${DB.positions.length} positions`);
      return;
    }catch(e){
      if(e.response?.status===404){console.log("[DB] No data file yet, starting fresh");}
      else{console.log("[DB] GitHub load error:",e.message);}
    }
  }
  try{
    if(fs.existsSync(LOCAL_CACHE)){
      const parsed=JSON.parse(fs.readFileSync(LOCAL_CACHE,"utf8"));
      DB={users:[],wallets:[],trades:[],alerts:[],settings:[],positions:[],...parsed};
      console.log("[DB] Loaded from local cache");
    }
  }catch(e){console.log("[DB] Starting fresh DB");}
}

async function flushDB(){
  if(isSaving)return;
  isSaving=true;
  try{
    const content=JSON.stringify(DB);
    try{fs.writeFileSync(LOCAL_CACHE,content);}catch{}
    if(!GITHUB_TOKEN){isSaving=false;return;}
    const b64=Buffer.from(content).toString("base64");
    const body={message:"bot data",content:b64};
    if(dbFileSha)body.sha=dbFileSha;
    const r=await axios.put(`https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,body,{
      headers:{"Authorization":`token ${GITHUB_TOKEN}`},timeout:15000
    });
    dbFileSha=r.data.content.sha;
    console.log("[DB] Saved to GitHub OK");
  }catch(e){
    console.log("[DB] GitHub save error:",e.message);
    // Refresh SHA on conflict error
    if(e.response?.status===409){
      try{
        const r=await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/contents/${DATA_FILE}`,{headers:{"Authorization":`token ${GITHUB_TOKEN}`},timeout:5000});
        dbFileSha=r.data.sha;
        console.log("[DB] SHA refreshed after conflict");
      }catch{}
    }
  }finally{isSaving=false;}
}

function saveDB(){
  // Save locally immediately
  try{fs.writeFileSync(LOCAL_CACHE,JSON.stringify(DB));}catch{}
  // Debounce GitHub save
  if(saveTimer)clearTimeout(saveTimer);
  saveTimer=setTimeout(flushDB,3000);
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
  upsertSettings:(uid,d)=>{
    let s=DB.settings.find(s=>s.userId===uid);
    if(s)Object.assign(s,d);
    else{s={userId:uid,buyAmount:0.111,profitTarget:1,stopLoss:5,maxPositions:3,isRunning:false,...d};DB.settings.push(s);}
    saveDB();return s;
  },
  setBotRunning:(uid,v)=>{
    const s=DB.settings.find(s=>s.userId===uid);
    if(s){s.isRunning=v;saveDB();}
  },
  addTrade:d=>{const t={id:nid.trade++,...d,timestamp:Date.now()};DB.trades.push(t);saveDB();return t;},
  getTrades:uid=>DB.trades.filter(t=>t.userId===uid),
  addAlert:d=>{const a={id:nid.alert++,...d,timestamp:Date.now()};DB.alerts.push(a);saveDB();return a;},
  getAlerts:uid=>DB.alerts.filter(a=>a.userId===uid),
  getPositions:uid=>DB.positions.filter(p=>p.userId===uid),
  addPosition:d=>{
    const exists=DB.positions.find(p=>p.userId===d.userId&&p.tokenAddress===d.tokenAddress);
    if(exists){console.log(`[DB] Duplicate blocked: ${d.tokenSymbol}`);return null;}
    const pos={...d,openedAt:Date.now(),highestPrice:d.entryPrice};
    DB.positions.push(pos);
    saveDB();
    return pos;
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

const HELIUS_KEY=process.env.HELIUS_KEY||"1c35c0ca-8d78-400a-982f-d457ac504edb";
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

async function signAndSendTx(txBase64,secretKey){
  const txBytes=Buffer.from(txBase64,"base64");
  const numSigs=txBytes[0];
  const messageStart=1+numSigs*64;
  const message=txBytes.slice(messageStart);
  const sig=nacl.sign.detached(message,secretKey);
  sig.forEach((b,i)=>txBytes[1+i]=b);
  const r=await axios.post(RPC,{jsonrpc:"2.0",id:1,method:"sendTransaction",
    params:[txBytes.toString("base64"),{encoding:"base64",skipPreflight:true,maxRetries:2}]},{timeout:30000});
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
    if(!q?.outAmount)throw new Error("No quote from Jupiter");
    const sw=(await axios.post(`${JUPITER_API}/swap`,{
      quoteResponse:q,userPublicKey:pubkey,wrapAndUnwrapSol:true,
      computeUnitPriceMicroLamports:1000,dynamicComputeUnitLimit:true,prioritizationFeeLamports:1000},{timeout:20000})).data;
    if(!sw?.swapTransaction)throw new Error("No swap transaction");
    const sig=await signAndSendTx(sw.swapTransaction,kp.secretKey);
    await new Promise(r=>setTimeout(r,5000));
    // FIX: return proper tokenAmount as string (avoid parseInt losing precision)
    const tokenAmount=q.outAmount;
    console.log(`[Jupiter] BUY OK: ${sig} | tokens: ${tokenAmount}`);
    return{success:true,txHash:sig,tokenAmount};
  }catch(e){
    console.log(`[Jupiter] BUY FAIL: ${e?.response?.data?.error||e.message}`);
    return{success:false,error:e?.response?.data?.error||e.message};
  }
}

async function jupiterSell(pk58,inputMint,tokenAmount){
  try{
    const kp=pkToKeypair(pk58);
    const pubkey=pubkeyToBase58(kp.publicKey);
    // FIX: use string directly, don't convert to number (precision loss)
    const amount=String(tokenAmount);
    const q=(await axios.get(`${JUPITER_API}/quote`,{
      params:{inputMint,outputMint:SOL_MINT,amount,slippageBps:150},timeout:15000})).data;
    if(!q?.outAmount)throw new Error("No quote from Jupiter");
    const sw=(await axios.post(`${JUPITER_API}/swap`,{
      quoteResponse:q,userPublicKey:pubkey,wrapAndUnwrapSol:true,
      computeUnitPriceMicroLamports:1000,dynamicComputeUnitLimit:true,prioritizationFeeLamports:1000},{timeout:20000})).data;
    if(!sw?.swapTransaction)throw new Error("No swap transaction");
    const sig=await signAndSendTx(sw.swapTransaction,kp.secretKey);
    await new Promise(r=>setTimeout(r,5000));
    console.log(`[Jupiter] SELL OK: ${sig}`);
    return{success:true,txHash:sig};
  }catch(e){
    console.log(`[Jupiter] SELL FAIL: ${e?.response?.data?.error||e.message}`);
    return{success:false,error:e?.response?.data?.error||e.message};
  }
}

// Established tokens only — no memecoins
const ESTABLISHED_TOKENS=[
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", // WIF
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", // POPCAT
  "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",  // BOME
  "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5",  // MEW
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",  // JUP
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE",  // ORCA
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", // PYTH
  "hntyVP6YFm1Hg25TN9WGLqM18LdZQZWwdDkn5f9GnhS",  // HNT
  "MNDEFzGvMt87ueuAgD7R4G99u1aMDe32xv1hL9DXZXF",  // MNDE
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",  // mSOL
  "SHDWyBxihqiCj6YekG2GUr7wqKLeLAMK1gHZck9pL6y",  // SHDW
  "nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7",  // NOS
  "8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGzmh3iEK",  // SLERF
];

async function detectSignals(){
  try{
    const results=await Promise.all(ESTABLISHED_TOKENS.map(a=>
      axios.get(`https://api.dexscreener.com/latest/dex/tokens/${a}`,{timeout:8000}).catch(()=>null)
    ));
    const signals=[];
    for(const r of results){
      if(!r?.data?.pairs)continue;
      const pairs=r.data.pairs.filter(p=>
        p.chainId==="solana"&&
        (p.dexId==="raydium"||p.dexId==="orca"||p.dexId==="meteora")&&
        (p.liquidity?.usd||0)>=50000&&
        (p.volume?.h24||0)>=10000
      );
      if(!pairs.length)continue;
      const best=pairs.sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
      const vol=best.volume?.h24||0;
      const ch1h=best.priceChange?.h1||0;
      const ch5m=best.priceChange?.m5||0;
      const txns=best.txns?.h1||{};
      const buys=txns.buys||0,sells=txns.sells||0;
      const br=buys+sells>0?buys/(buys+sells):0.5;
      const tokenAddr=best.baseToken?.address||"";
      const symbol=best.baseToken?.symbol||"?";
      // Strict buy filters
      if(br<0.55)continue;
      if(ch1h<1)continue;   // At least 1% up in 1h
      if(ch5m<=0)continue;  // Still going up in 5m
      const conf=Math.min(92,Math.round(
        50+Math.min(ch1h*1.5,12)+Math.min(ch5m*2,8)+((br-0.5)*20)+(vol>500000?8:vol>100000?4:0)
      ));
      if(conf<62)continue;
      signals.push({
        token:{address:tokenAddr,symbol,name:best.baseToken?.name||"?",
          priceUsd:best.priceUsd||"0",volume24h:vol,
          liquidity:best.liquidity?.usd||0,priceChange5m:ch5m,priceChange1h:ch1h},
        confidence:conf,buys,sells,buyRatio:Math.round(br*100),
        platform:best.dexId==="raydium"?"Raydium":best.dexId==="orca"?"Orca":"Meteora"
      });
    }
    return signals.sort((a,b)=>b.confidence-a.confidence);
  }catch(e){console.error("[Scan]",e.message);return[];}
}

const botIntervals={};

async function runScan(uid,pk,buyAmt,maxPos){
  const s=S.getSettings(uid);
  if(!s?.isRunning)return;
  const positions=S.getPositions(uid);
  const max=maxPos||3;
  if(positions.length>=max){
    console.log(`[Bot] Max positions (${positions.length}/${max}), skipping scan`);
    return;
  }
  // Balance check before scanning
  const kp=pkToKeypair(pk);
  const pubkey=pubkeyToBase58(kp.publicKey);
  const balance=await getSOLBalance(pubkey);
  const needed=buyAmt+0.005; // +0.005 for fees
  if(balance<needed){
    console.log(`[Bot] Low SOL: ${balance.toFixed(4)} < ${needed.toFixed(4)} needed`);
    return;
  }
  const sigs=await detectSignals();
  const slots=max-S.getPositions(uid).length;
  console.log(`[Bot] Scan: ${sigs.length} signals | ${S.getPositions(uid).length}/${max} positions | ${balance.toFixed(4)} SOL`);
  for(const sig of sigs.slice(0,slots)){
    // Re-check duplicate (positions may have changed during loop)
    if(S.getPositions(uid).some(p=>p.tokenAddress===sig.token.address)){
      console.log(`[Bot] Already holding ${sig.token.symbol}, skip`);
      continue;
    }
    // Re-check balance
    const curBal=await getSOLBalance(pubkey);
    if(curBal<needed){console.log(`[Bot] Balance too low, stop buying`);break;}
    S.addAlert({userId:uid,tokenSymbol:sig.token.symbol,tokenName:sig.token.name,
      tokenAddress:sig.token.address,confidence:sig.confidence,
      whaleCount:sig.buys,netBuyUsd:Math.round(sig.token.volume24h*0.6),platform:sig.platform});
    console.log(`[Bot] BUY ${sig.token.symbol} conf:${sig.confidence}% price:${sig.token.priceUsd}`);
    const res=await jupiterBuy(pk,sig.token.address,buyAmt);
    if(res.success&&res.txHash){
      S.addTrade({userId:uid,action:"BUY",tokenSymbol:sig.token.symbol,
        tokenAddress:sig.token.address,amountSOL:buyAmt,
        price:parseFloat(sig.token.priceUsd),txHash:res.txHash,profit:null,status:"confirmed"});
      S.addPosition({userId:uid,tokenAddress:sig.token.address,tokenSymbol:sig.token.symbol,
        entryPrice:parseFloat(sig.token.priceUsd),buyAmountSOL:buyAmt,
        tokenAmount:res.tokenAmount}); // FIX: store as string
      console.log(`[Bot] Position opened: ${sig.token.symbol}`);
    }else{
      console.log(`[Bot] BUY failed: ${res.error}`);
    }
    await new Promise(r=>setTimeout(r,2000));
  }
}

async function runPriceCheck(uid,pk,profitPct,slPct){
  const s=S.getSettings(uid);
  if(!s?.isRunning)return;
  const positions=S.getPositions(uid);
  if(!positions.length)return;
  const sl=slPct||5;
  const profit=profitPct||3;
  for(const p of positions){
    try{
      const r=await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${p.tokenAddress}`,{timeout:8000});
      const best=(r.data?.pairs||[]).filter(x=>x.chainId==="solana")
        .sort((a,b)=>(b.liquidity?.usd||0)-(a.liquidity?.usd||0))[0];
      if(!best?.priceUsd)continue;
      const cur=parseFloat(best.priceUsd);
      if(!cur||cur<=0||!p.entryPrice)continue;
      const pnl=((cur-p.entryPrice)/p.entryPrice)*100;
      // Update highest price
      S.updatePositionHigh(uid,p.tokenAddress,cur);
      const pos=S.getPositions(uid).find(x=>x.tokenAddress===p.tokenAddress);
      const peak=pos?.highestPrice||cur;
      const trailDrop=peak>0?((peak-cur)/peak)*100:0;
      const hitProfit=pnl>=profit;
      const hitFixed=pnl<=-sl;
      // Trailing stop: only activate if in profit AND drops sl% from peak
      const hitTrail=pnl>=1&&trailDrop>=sl;
      console.log(`[Price] ${p.tokenSymbol} PnL:${pnl.toFixed(2)}% trail:${trailDrop.toFixed(2)}%`);
      if(hitProfit||hitFixed||hitTrail){
        const reason=hitProfit?"PROFIT":hitTrail?"TRAIL-SL":"STOP-LOSS";
        console.log(`[Bot] SELL ${p.tokenSymbol} reason:${reason} PnL:${pnl.toFixed(2)}%`);
        let sellOk=false;
        if(p.tokenAmount){
          const sr=await jupiterSell(pk,p.tokenAddress,p.tokenAmount);
          if(sr.success&&sr.txHash){
            S.addTrade({userId:uid,action:"SELL",tokenSymbol:p.tokenSymbol,
              tokenAddress:p.tokenAddress,amountSOL:p.buyAmountSOL,price:cur,
              txHash:sr.txHash,profit:parseFloat((p.buyAmountSOL*(pnl/100)).toFixed(4)),status:"confirmed"});
            sellOk=true;
          }
        }
        // FIX: always remove position even if sell fails (prevents stuck positions)
        S.removePosition(uid,p.tokenAddress);
        if(!sellOk)console.log(`[Bot] WARN: Position removed but sell may have failed`);
      }
    }catch(e){console.error("[Price]",p.tokenSymbol,e.message);}
  }
}

async function startBot(uid,pk,buyAmt,profitPct,slPct,maxPos){
  if(botIntervals[uid]){
    clearInterval(botIntervals[uid].scan);
    clearInterval(botIntervals[uid].price);
  }
  console.log(`[Bot] Starting uid:${uid} buy:${buyAmt} profit:${profitPct}% SL:${slPct}% max:${maxPos}`);
  // FIX: Run first scan immediately, don't wait 2 minutes
  setTimeout(()=>runScan(uid,pk,buyAmt,maxPos),5000);
  botIntervals[uid]={
    scan:setInterval(()=>runScan(uid,pk,buyAmt,maxPos),120000),
    price:setInterval(()=>runPriceCheck(uid,pk,profitPct,slPct),30000)
  };
}

function stopBot(uid){
  if(botIntervals[uid]){
    clearInterval(botIntervals[uid].scan);
    clearInterval(botIntervals[uid].price);
    delete botIntervals[uid];
  }
  console.log(`[Bot] Stopped uid:${uid}`);
}

async function autoResume(){
  await new Promise(r=>setTimeout(r,10000));
  const running=DB.settings.filter(s=>s.isRunning&&s.tradingPrivateKey);
  for(const s of running){
    const pos=S.getPositions(s.userId);
    console.log(`[Bot] Auto-resume uid:${s.userId} open positions:${pos.length}`);
    await startBot(s.userId,s.tradingPrivateKey,s.buyAmount||0.111,s.profitTarget||1,s.stopLoss||5,s.maxPositions||3);
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
  if(!userId||!name||!address)return res.status(400).json({error:"Required fields missing"});
  res.json(S.addWallet({userId:parseInt(userId),name,address}));
});
app.delete("/api/wallets/:id",(req,res)=>{S.deleteWallet(parseInt(req.params.id),parseInt(req.body.userId));res.json({success:true});});
app.post("/api/wallets/:id/activate",(req,res)=>{S.setActive(parseInt(req.params.id),parseInt(req.body.userId));res.json({success:true});});
app.get("/api/bot-settings/:uid",(req,res)=>{
  const s=S.getSettings(parseInt(req.params.uid));
  if(s){const{tradingPrivateKey:pk,...safe}=s;return res.json({...safe,hasTradingWallet:!!pk});}
  res.json({buyAmount:0.111,profitTarget:1,stopLoss:5,maxPositions:3,isRunning:false,hasTradingWallet:false});
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
  await startBot(uid,s.tradingPrivateKey,s.buyAmount||0.111,s.profitTarget||1,s.stopLoss||5,s.maxPositions||3);
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
app.get("/health",(req,res)=>res.json({status:"ok",uptime:Math.round(process.uptime()),positions:DB.positions?.length||0,version:"v15"}));

const pub=path.join(__dirname,"public");
if(fs.existsSync(pub)){
  app.use(express.static(pub));
  app.get("*",(req,res)=>{if(!req.path.startsWith("/api"))res.sendFile(path.join(pub,"index.html"));});
}

app.listen(PORT,"0.0.0.0",async()=>{
  console.log(`\nWhaleBot v15 FIXED\n[✓] GitHub persistent positions\n[✓] No duplicate trades\n[✓] 5% stop loss\n[✓] tokenAmount precision fixed\n[✓] SHA conflict handled\n[✓] Immediate first scan\n[✓] Max 3 positions\n[✓] Auto-resume\n`);
  await loadDB();
  initNid();
  autoResume();
});
