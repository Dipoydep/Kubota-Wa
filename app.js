import {initializeApp} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {getAuth,createUserWithEmailAndPassword,signInWithEmailAndPassword,onAuthStateChanged,signOut} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {getFirestore,doc,getDoc,setDoc,updateDoc,collection,query,where,orderBy,onSnapshot,serverTimestamp,arrayUnion,arrayRemove,writeBatch} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {firebaseConfig} from "./firebase-config.js";

const app=initializeApp(firebaseConfig),auth=getAuth(app),db=getFirestore(app);
const $=s=>document.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const svg=p=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const I={
  add:svg('<circle cx="10" cy="8" r="4"/><path d="M2 21c0-4 3.5-7 8-7"/><path d="M19 8v6M16 11h6"/>'),
  me:svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>'),
  back:svg('<path d="M15 5l-7 7 7 7"/>'),
  plus:svg('<path d="M12 5v14M5 12h14"/>'),
  x:svg('<path d="M6 6l12 12M18 6L6 18"/>')
};
const CODE_CHARS="ABCDEFGHJKMNPQRSTUVWXYZ23456789";

let me=null,reqOut=[],reqIn=[],chats=[],roomId=null,roomFallback=null,msgs=[],registering=false,mode="login",sheetKind=null;
let unsubs=[],unsubMsgs=null,toastT;
const users=new Map();
const LS={
  get(k,d){try{const v=localStorage.getItem("kw:"+k);return v==null?d:JSON.parse(v)}catch{return d}},
  set(k,v){try{localStorage.setItem("kw:"+k,JSON.stringify(v))}catch{}},
  del(k){try{localStorage.removeItem("kw:"+k)}catch{}}
};
let claiming=false;
async function newPid(){
  for(let i=0;i<8;i++){
    const p=String(Math.floor(1e7+Math.random()*9e7));
    if(!(await getDoc(doc(db,"ids",p))).exists())return p;
  }
  throw new Error("pid");
}
async function claimPid(){
  if(claiming||!me)return;claiming=true;
  try{const p=await newPid(),b=writeBatch(db);b.update(doc(db,"users",me.uid),{pid:p});b.set(doc(db,"ids",p),{uid:me.uid});await b.commit()}catch{}
  claiming=false;
}
function saveCache(){
  if(!me)return;
  const keep=new Set([me.uid,...chats.flatMap(c=>c.members||[]),...contacts().map(c=>c.uid)]);
  LS.set("cache:"+me.uid,{me,chats,reqOut,reqIn,users:[...users.values()].filter(u=>keep.has(u.uid))});
}
function markRead(id){
  if(!me||!id)return;
  const r=LS.get("read:"+me.uid,{});r[id]=Date.now();LS.set("read:"+me.uid,r);
}

/* ---------- util ---------- */
function toast(t){const e=$("#toast");e.textContent=t;e.classList.add("on");clearTimeout(toastT);toastT=setTimeout(()=>e.classList.remove("on"),2600)}
const ms=t=>t?.toMillis?t.toMillis():(t||Date.now());
function clock(t){return new Date(ms(t)).toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit"}).replace(".",":")}
function whenShort(t){const d=new Date(ms(t)),n=new Date();return d.toDateString()===n.toDateString()?clock(t):d.toLocaleDateString("id-ID",{day:"numeric",month:"short"})}
async function loadUsers(ids){
  const need=[...new Set(ids)].filter(i=>!users.has(i));
  await Promise.all(need.map(async i=>{
    try{const s=await getDoc(doc(db,"users",i));users.set(i,s.exists()?{uid:i,...s.data()}:{uid:i,name:"Pengguna",tag:"?"})}
    catch{users.set(i,{uid:i,name:"Pengguna",tag:"?"})}
  }));
  return need.length>0;
}
function av(u,cls=""){
  if(u?.photo)return `<img class="av ${cls}" src="${esc(u.photo)}" alt="">`;
  return `<span class="av ${cls}">${esc((u?.name||"?").trim().charAt(0).toUpperCase())}</span>`;
}
const gav=(name,cls="")=>`<span class="av sq ${cls}">${esc((name||"G").trim().charAt(0).toUpperCase())}</span>`;
function contacts(){
  const m=new Map();
  reqOut.filter(r=>r.status==="accepted").forEach(r=>m.set(r.to,{uid:r.to,tag:r.toTag}));
  reqIn.filter(r=>r.status==="accepted").forEach(r=>m.set(r.from,{uid:r.from,tag:r.fromTag}));
  return [...m.values()];
}
const dmId=(a,b)=>[a,b].sort().join("_");
const otherOf=c=>c.members.find(x=>x!==me.uid);

/* ---------- auth ---------- */
function setMode(m){
  mode=m;
  $("#tabLogin").classList.toggle("on",m==="login");
  $("#tabReg").classList.toggle("on",m==="register");
  $("#nameField").hidden=m==="login";
  $("#authBtn").textContent=m==="login"?"Masuk":"Buat akun";
}
$("#fTag").value=LS.get("lastTag","");
$("#tabLogin").onclick=()=>setMode("login");
$("#tabReg").onclick=()=>setMode("register");
function authError(e){
  const c=e.code||"";
  if(c.includes("email-already-in-use"))return "Gamertag sudah dipakai, coba yang lain";
  if(c.includes("invalid-credential")||c.includes("user-not-found")||c.includes("wrong-password"))return "Gamertag atau kata sandi salah";
  if(c.includes("network"))return "Tidak ada koneksi internet";
  if(c.includes("operation-not-allowed"))return "Aktifkan Email/Password di Firebase Authentication";
  return "Gagal: "+(c||e.message);
}
$("#authForm").onsubmit=async e=>{
  e.preventDefault();
  const tag=$("#fTag").value.trim().toLowerCase().replace(/^@/,""),pw=$("#fPass").value;
  if(!/^[a-z0-9_]{3,20}$/.test(tag))return toast("Gamertag 3-20 karakter: huruf kecil, angka, garis bawah");
  if(pw.length<6)return toast("Kata sandi minimal 6 karakter");
  const email=tag+"@kubota.chat",btn=$("#authBtn");LS.set("lastTag",tag);
  btn.disabled=true;
  try{
    if(mode==="login"){await signInWithEmailAndPassword(auth,email,pw)}
    else{
      registering=true;
      const c=await createUserWithEmailAndPassword(auth,email,pw);
      const pid=await newPid(),b=writeBatch(db);
      b.set(doc(db,"users",c.user.uid),{tag,name:$("#fName").value.trim()||tag,photo:"",pid});
      b.set(doc(db,"ids",pid),{uid:c.user.uid});
      b.set(doc(db,"gamertags",tag),{uid:c.user.uid});
      await b.commit();
      registering=false;
      boot(c.user.uid);
    }
  }catch(err){registering=false;toast(authError(err))}
  btn.disabled=false;
};
onAuthStateChanged(auth,u=>{
  if(registering)return;
  if(u)boot(u.uid);else{teardown();show("auth")}
});
function show(v){["auth","home"].forEach(x=>$("#"+x).classList.toggle("hidden",x!==v))}
function teardown(){
  unsubs.forEach(f=>f());unsubs=[];
  if(unsubMsgs){unsubMsgs();unsubMsgs=null}
  me=null;reqOut=[];reqIn=[];chats=[];roomId=null;
  $("#room").classList.remove("on");closeSheet();
}

/* ---------- data ---------- */
function boot(uid){
  teardown();
  show("home");
  const cache=LS.get("cache:"+uid,null);
  if(cache&&cache.me){
    me=cache.me;(cache.users||[]).forEach(u=>users.set(u.uid,u));users.set(uid,me);
    reqOut=cache.reqOut||[];reqIn=cache.reqIn||[];chats=cache.chats||[];
    renderHome();afterReqs();
  }
  unsubs.push(onSnapshot(doc(db,"users",uid),s=>{
    if(!s.exists())return;
    me={uid,...s.data()};users.set(uid,me);renderHome();saveCache();if(!me.pid)claimPid();
  }));
  unsubs.push(onSnapshot(query(collection(db,"requests"),where("from","==",uid)),s=>{
    reqOut=s.docs.map(d=>({id:d.id,...d.data()}));afterReqs();
  },()=>toast("Gagal membaca permintaan teman")));
  unsubs.push(onSnapshot(query(collection(db,"requests"),where("to","==",uid)),s=>{
    reqIn=s.docs.map(d=>({id:d.id,...d.data()}));afterReqs();
  }));
  unsubs.push(onSnapshot(query(collection(db,"chats"),where("members","array-contains",uid)),s=>{
    chats=s.docs.map(d=>{const x=d.data({serverTimestamps:"estimate"});return {id:d.id,...x,lastAt:x.lastAt?ms(x.lastAt):0}});
    if(roomId)markRead(roomId);
    renderHome();saveCache();if(roomId)renderRoomHead();
  },()=>toast("Gagal membaca chat, cek rules Firestore")));
}
function afterReqs(){
  saveCache();
  const n=reqIn.filter(r=>r.status==="pending").length;
  $("#btnAdd").innerHTML=I.add+(n?`<span class="badge">${n}</span>`:"");
  if(sheetKind==="add")renderReqLists();
  if(sheetKind==="new")renderContactPick();
}

/* ---------- home ---------- */
$("#btnAdd").innerHTML=I.add;$("#btnMe").innerHTML=I.me;$("#fab").innerHTML=I.plus;$("#back").innerHTML=I.back;
async function renderHome(){
  if(!me)return;
  const q=($("#search").value||"").trim().toLowerCase().replace(/^[@#]/,"");
  let list=chats.filter(c=>c.type==="group"||c.lastText).sort((a,b)=>ms(b.lastAt)-ms(a.lastAt));
  if(await loadUsers(list.filter(c=>c.type==="dm").map(otherOf)))return renderHome();
  const uOf=c=>c.type==="dm"?users.get(otherOf(c)):null;
  if(q)list=list.filter(c=>{const u=uOf(c);return ((u?u.name+" "+u.tag+" "+(u.pid||""):c.name)+" "+(c.lastText||"")).toLowerCase().includes(q)});
  const read=LS.get("read:"+me.uid,{});
  let html=list.map(c=>{
    const dm=c.type==="dm",u=uOf(c);
    const unread=c.lastFrom&&c.lastFrom!==me.uid&&ms(c.lastAt)>(read[c.id]||0)&&c.id!==roomId;
    const sender=c.lastFrom===me.uid?"Kamu: ":"";
    return `<button class="item ${unread?"unread":""}" data-act="open" data-id="${c.id}">
      ${dm?av(u):gav(c.name)}
      <span class="grow"><b>${esc(dm?u.name:c.name)}</b><small>${esc(c.lastText?sender+c.lastText:"Grup baru")}</small></span>
      <span class="meta"><span class="when">${c.lastAt?whenShort(c.lastAt):""}</span>${unread?'<span class="dot"></span>':""}</span></button>`;
  }).join("");
  if(q){
    const shown=new Set(list.filter(c=>c.type==="dm").map(otherOf));
    const cs=contacts();await loadUsers(cs.map(c=>c.uid));
    const more=cs.filter(c=>!shown.has(c.uid)).filter(c=>{const u=users.get(c.uid);return (u.name+" "+u.tag+" "+(u.pid||"")).toLowerCase().includes(q)});
    if(more.length)html+=`<h3 class="sub">Kontak</h3>`+more.map(c=>{const u=users.get(c.uid);return `<button class="item" data-act="dm" data-id="${c.uid}">${av(u)}<span class="grow"><b>${esc(u.name)}</b><small>@${esc(u.tag)}</small></span></button>`}).join("");
  }
  $("#chatList").innerHTML=html||(q?`<div class="empty">Tidak ada hasil untuk "${esc(q)}".</div>`
    :`<div class="empty"><b>Belum ada chat.</b><br>Tambah teman lewat gamertag (ikon orang+ di atas), atau masuk grup pakai kode lewat tombol +.</div>`);
}
$("#search").oninput=()=>renderHome();

/* ---------- room ---------- */
function curChat(){return chats.find(c=>c.id===roomId)||roomFallback}
async function renderRoomHead(){
  const c=curChat();if(!c)return;
  if(c.type==="dm"){
    await loadUsers([otherOf(c)]);const u=users.get(otherOf(c));
    $("#roomAv").innerHTML=av(u,"xs");$("#roomTitle").textContent=u.name;$("#roomSub").textContent="@"+u.tag;
  }else{
    $("#roomAv").innerHTML=gav(c.name,"xs");$("#roomTitle").textContent=c.name||"Grup";
    $("#roomSub").textContent=(c.members?.length||0)+" anggota, ketuk untuk pengaturan";
  }
}
async function openRoom(id,fallback){
  roomId=id;roomFallback=fallback||null;markRead(id);renderHome();
  if(unsubMsgs)unsubMsgs();
  msgs=[];$("#msgs").innerHTML="";
  $("#room").classList.add("on");
  renderRoomHead();
  unsubMsgs=onSnapshot(query(collection(db,"chats",id,"messages"),orderBy("ts")),async s=>{
    msgs=s.docs.map(d=>({id:d.id,...d.data({serverTimestamps:"estimate"})}));
    await loadUsers(msgs.map(m=>m.from));renderMsgs();
  },()=>toast("Gagal membuka pesan"));
  setTimeout(()=>$("#msgInput").focus(),250);
}
function renderMsgs(){
  const c=curChat(),box=$("#msgs");
  const stick=box.scrollHeight-box.scrollTop-box.clientHeight<120||!box.children.length;
  let prev=null;
  box.innerHTML=msgs.map(m=>{
    const mine=m.from===me.uid;
    const who=c?.type==="group"&&!mine&&prev!==m.from?`<span class="who">${esc(users.get(m.from)?.name||"Pengguna")}</span>`:"";
    prev=m.from;
    return `<div class="msg ${mine?"mine":"their"}">${who}${esc(m.text)}<time>${clock(m.ts)}</time></div>`;
  }).join("");
  if(stick)box.scrollTop=box.scrollHeight;
}
function closeRoom(){
  markRead(roomId);
  $("#room").classList.remove("on");
  if(unsubMsgs){unsubMsgs();unsubMsgs=null}
  roomId=null;roomFallback=null;renderHome();
}
$("#back").onclick=closeRoom;
$("#roomHead").onclick=()=>{const c=curChat();if(c?.type==="group")openGroupSettings()};
$("#composer").onsubmit=async e=>{
  e.preventDefault();
  const inp=$("#msgInput"),text=inp.value.trim();
  if(!text||!roomId)return;
  inp.value="";
  try{
    const b=writeBatch(db);
    b.set(doc(collection(db,"chats",roomId,"messages")),{from:me.uid,text,ts:serverTimestamp()});
    b.update(doc(db,"chats",roomId),{lastText:text,lastAt:serverTimestamp(),lastFrom:me.uid});
    await b.commit();
  }catch{toast("Pesan gagal terkirim");inp.value=text}
};
async function openDM(uid){
  const id=dmId(me.uid,uid);
  closeSheet();
  if(!chats.find(c=>c.id===id)){
    try{await setDoc(doc(db,"chats",id),{type:"dm",members:[me.uid,uid],lastText:"",lastAt:serverTimestamp()})}
    catch{return toast("Tidak bisa membuka chat")}
  }
  openRoom(id,{id,type:"dm",members:[me.uid,uid]});
}

/* ---------- sheets ---------- */
function sheet(kind,title,body){
  sheetKind=kind;
  $("#sheetBody").innerHTML=`<div class="sh-head"><h2>${title}</h2><button class="ib sm" data-act="close" aria-label="Tutup">${I.x}</button></div>${body}`;
  $("#sheet").classList.remove("hidden");
}
function closeSheet(){sheetKind=null;$("#sheet").classList.add("hidden")}
$("#sheet").addEventListener("click",e=>{if(e.target.id==="sheet")closeSheet()});

$("#btnAdd").onclick=()=>{
  sheet("add","Tambah teman",`
    <label class="field">Gamertag atau ID teman
      <input id="fFriend" placeholder="@gamertag atau #12345678" maxlength="21" autocapitalize="none" autocorrect="off">
    </label>
    <button class="btn" data-act="sendReq">Kirim permintaan</button>
    <p class="note">Teman harus menerima dulu sebelum kalian bisa chat.</p>
    <div id="reqLists" class="center" style="align-items:stretch"></div>`);
  renderReqLists();
};
async function renderReqLists(){
  const box=$("#reqLists");if(!box)return;
  const inc=reqIn.filter(r=>r.status==="pending"),out=reqOut.filter(r=>r.status==="pending");
  await loadUsers(inc.map(r=>r.from));
  box.innerHTML=(inc.length?`<h3>Permintaan masuk</h3>`+inc.map(r=>`<div class="row">${av(users.get(r.from),"xs")}
    <span class="grow"><b>${esc(users.get(r.from)?.name)}</b><small>@${esc(r.fromTag)}</small></span>
    <button class="btn sm" data-act="accept" data-id="${r.id}">Terima</button>
    <button class="btn sm ghost" data-act="reject" data-id="${r.id}">Tolak</button></div>`).join(""):"")
  +(out.length?`<h3>Menunggu jawaban</h3>`+out.map(r=>`<div class="row"><span class="grow"><b>@${esc(r.toTag)}</b></span></div>`).join(""):"");
}
async function sendReq(){
  const raw=$("#fFriend").value.trim().toLowerCase();
  if(!raw)return toast("Isi gamertag atau ID dulu");
  try{
    let uid=null;
    const idm=raw.match(/^#?(\d{8})$/);
    if(idm){const g=await getDoc(doc(db,"ids",idm[1]));if(g.exists())uid=g.data().uid}
    if(!uid&&!raw.startsWith("#")){const g=await getDoc(doc(db,"gamertags",raw.replace(/^@/,"")));if(g.exists())uid=g.data().uid}
    if(!uid)return toast("Gamertag atau ID tidak ditemukan");
    if(uid===me.uid)return toast("Itu akun kamu sendiri");
    await loadUsers([uid]);const tag=users.get(uid).tag;
    if(contacts().some(c=>c.uid===uid))return toast("@"+tag+" sudah jadi kontak");
    if(reqOut.some(r=>r.to===uid&&r.status==="pending"))return toast("Permintaan sudah terkirim");
    if(reqIn.some(r=>r.from===uid&&r.status==="pending"))return toast("@"+tag+" sudah mengirim permintaan, terima di bawah");
    await setDoc(doc(db,"requests",me.uid+"_"+uid),{from:me.uid,to:uid,fromTag:me.tag,toTag:tag,status:"pending"});
    $("#fFriend").value="";toast("Permintaan terkirim ke @"+tag);
  }catch{toast("Permintaan gagal, mungkin pernah ditolak")}
}

$("#fab").onclick=()=>{
  sheet("new","Chat baru",`
    <button class="btn" data-act="newGroup">Buat grup</button>
    <button class="btn ghost" data-act="joinGroup">Masuk grup pakai kode</button>
    <h3>Kontak</h3><div id="contactPick" class="center" style="align-items:stretch"></div>`);
  renderContactPick();
};
async function renderContactPick(){
  const box=$("#contactPick");if(!box)return;
  const cs=contacts();await loadUsers(cs.map(c=>c.uid));
  box.innerHTML=cs.length?cs.map(c=>{const u=users.get(c.uid);return `<button class="item" data-act="dm" data-id="${c.uid}">${av(u,"xs")}<span class="grow"><b>${esc(u.name)}</b><small>@${esc(u.tag)}</small></span></button>`}).join("")
    :`<div class="empty">Belum ada kontak. Tambah teman lewat gamertag dulu.</div>`;
}
async function newGroupSheet(){
  const cs=contacts();await loadUsers(cs.map(c=>c.uid));
  sheet("group","Buat grup",`
    <label class="field">Nama grup<input id="gName" maxlength="40" placeholder="Nama grup"></label>
    <h3>Undang kontak (boleh kosong)</h3>
    ${cs.length?cs.map(c=>{const u=users.get(c.uid);return `<label class="row pick"><input type="checkbox" value="${c.uid}">${av(u,"xs")}<span class="grow"><b>${esc(u.name)}</b><small>@${esc(u.tag)}</small></span></label>`}).join(""):`<p class="note">Belum ada kontak. Teman lain bisa masuk lewat kode grup.</p>`}
    <button class="btn" data-act="createGroup">Buat grup</button>`);
}
async function createGroup(){
  const name=$("#gName").value.trim();
  if(!name)return toast("Isi nama grup");
  const picked=[...document.querySelectorAll("#sheetBody input[type=checkbox]:checked")].map(i=>i.value);
  try{
    let code,tries=0;
    do{code=Array.from({length:6},()=>CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)]).join("");tries++}
    while((await getDoc(doc(db,"codes",code))).exists()&&tries<5);
    const ref=doc(collection(db,"chats"));
    const b=writeBatch(db);
    b.set(ref,{type:"group",name,code,admin:me.uid,members:[me.uid,...picked],lastText:"",lastAt:serverTimestamp()});
    b.set(doc(db,"codes",code),{chatId:ref.id});
    await b.commit();
    closeSheet();openRoom(ref.id,{id:ref.id,type:"group",name,members:[me.uid,...picked],code});
  }catch{toast("Grup gagal dibuat")}
}
function joinSheet(){
  sheet("join","Masuk grup",`
    <label class="field">Kode grup<input id="jCode" maxlength="6" placeholder="6 huruf/angka" autocapitalize="characters" autocorrect="off" style="text-transform:uppercase;letter-spacing:.2em;font-weight:800"></label>
    <button class="btn" data-act="doJoin">Masuk</button>
    <p class="note">Minta kode ke anggota grup. Kode ada di pengaturan grup.</p>`);
}
async function doJoin(){
  const code=$("#jCode").value.trim().toUpperCase();
  if(code.length!==6)return toast("Kode terdiri dari 6 karakter");
  try{
    const s=await getDoc(doc(db,"codes",code));
    if(!s.exists())return toast("Kode tidak ditemukan");
    const id=s.data().chatId;
    await updateDoc(doc(db,"chats",id),{members:arrayUnion(me.uid)});
    closeSheet();toast("Berhasil masuk grup");
    openRoom(id,{id,type:"group",name:"Grup",members:[me.uid]});
  }catch{toast("Gagal masuk grup")}
}
async function openGroupSettings(){
  const c=curChat();if(!c)return;
  await loadUsers(c.members);
  sheet("gs","Pengaturan grup",`
    <div class="center">${gav(c.name,"lg")}<b style="font-size:20px">${esc(c.name)}</b></div>
    <h3>Kode grup</h3>
    <div class="codebox" id="codeBox">${esc(c.code||"-")}</div>
    <button class="btn" data-act="copyCode">Salin kode</button>
    <p class="note">Bagikan kode ini. Siapa pun yang memasukkannya bisa masuk grup.</p>
    <h3>${c.members.length} anggota</h3>
    ${c.members.map(id=>{const u=users.get(id);return `<div class="row">${av(u,"xs")}<span class="grow"><b>${esc(u.name)}${id===me.uid?" (kamu)":""}</b><small>@${esc(u.tag)}</small></span></div>`}).join("")}
    <button class="btn warn" data-act="leave">Keluar grup</button>`);
}
async function leaveGroup(){
  if(!confirm("Keluar dari grup ini?"))return;
  const id=roomId;
  try{await updateDoc(doc(db,"chats",id),{members:arrayRemove(me.uid)});closeSheet();closeRoom()}
  catch{toast("Gagal keluar grup")}
}

/* ---------- profile ---------- */
let tmpPhoto=null;
$("#btnMe").onclick=()=>{
  tmpPhoto=null;
  sheet("me","Profil",`
    <div class="center"><button class="photobtn" data-act="pickPhoto" aria-label="Ganti foto"><span id="mePhoto">${av(me,"lg")}</span></button>
    <button class="btn sm ghost" data-act="pickPhoto">Ganti foto</button></div>
    <div class="row"><span class="grow"><small>Gamertag</small><b>@${esc(me.tag)}</b></span></div>
    <div class="row"><span class="grow"><small>ID</small><b>#${esc(me.pid||"...")}</b></span><button class="btn sm" data-act="copyId">Salin</button></div>
    <p class="note">Teman bisa menemukan kamu lewat gamertag atau ID ini.</p>
    <label class="field">Nama tampilan<input id="pName" maxlength="30" value="${esc(me.name)}"></label>
    <button class="btn" data-act="saveProfile">Simpan</button>
    <button class="btn ghost" data-act="logout">Keluar akun</button>`);
};
$("#photoIn").onchange=e=>{
  const f=e.target.files[0];if(!f)return;
  const img=new Image();
  img.onload=()=>{
    const s=160,cv=document.createElement("canvas");cv.width=cv.height=s;
    const m=Math.min(img.width,img.height),ctx=cv.getContext("2d");
    ctx.drawImage(img,(img.width-m)/2,(img.height-m)/2,m,m,0,0,s,s);
    tmpPhoto=cv.toDataURL("image/jpeg",.72);
    $("#mePhoto").innerHTML=`<img class="av lg" src="${tmpPhoto}" alt="">`;
    updateDoc(doc(db,"users",me.uid),{photo:tmpPhoto}).then(()=>toast("Foto diganti")).catch(()=>toast("Foto gagal disimpan"));
    URL.revokeObjectURL(img.src);
  };
  img.src=URL.createObjectURL(f);e.target.value="";
};
async function saveProfile(){
  const name=$("#pName").value.trim();
  if(!name)return toast("Nama tidak boleh kosong");
  const data={name};if(tmpPhoto!==null)data.photo=tmpPhoto;
  try{await updateDoc(doc(db,"users",me.uid),data);users.delete(me.uid);closeSheet();toast("Profil disimpan")}
  catch{toast("Gagal menyimpan")}
}

/* ---------- actions ---------- */
document.addEventListener("click",async e=>{
  const t=e.target.closest("[data-act]");if(!t)return;
  const id=t.dataset.id;
  switch(t.dataset.act){
    case "close":closeSheet();break;
    case "open":openRoom(id);break;
    case "dm":openDM(id);break;
    case "sendReq":sendReq();break;
    case "accept":try{await updateDoc(doc(db,"requests",id),{status:"accepted"});toast("Kontak ditambahkan")}catch{toast("Gagal menerima")}break;
    case "reject":try{await updateDoc(doc(db,"requests",id),{status:"rejected"})}catch{toast("Gagal menolak")}break;
    case "newGroup":newGroupSheet();break;
    case "joinGroup":joinSheet();break;
    case "createGroup":createGroup();break;
    case "doJoin":doJoin();break;
    case "copyCode":
      try{await navigator.clipboard.writeText(curChat().code);toast("Kode disalin")}catch{toast("Tekan lama kode untuk menyalin")}break;
    case "copyId":
      try{await navigator.clipboard.writeText("#"+me.pid);toast("ID disalin")}catch{toast("Tekan lama ID untuk menyalin")}break;
    case "leave":leaveGroup();break;
    case "pickPhoto":$("#photoIn").click();break;
    case "saveProfile":saveProfile();break;
    case "logout":closeSheet();LS.del("cache:"+me.uid);signOut(auth);break;
  }
});
