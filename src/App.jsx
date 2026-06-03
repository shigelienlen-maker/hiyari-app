import { useState, useRef, useEffect } from "react";
import { initializeApp } from "firebase/app";
import {
  getFirestore, collection, addDoc, onSnapshot,
  orderBy, query, updateDoc, doc, arrayUnion, deleteDoc, setDoc
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAQdcQQn5C3XMCNed5yL1f4A8sITVmT-Yg",
  authDomain: "hiyari-report-7a989.firebaseapp.com",
  projectId: "hiyari-report-7a989",
  storageBucket: "hiyari-report-7a989.firebasestorage.app",
  messagingSenderId: "862461163208",
  appId: "1:862461163208:web:65c2c88346504362a9d7fd"
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

const GAS_URL = "https://script.google.com/macros/s/AKfycbwCxh5VPnifZpzWr35KBQPujYebZNCUHAyx13mCvZFG0w3p266QdPYZVFagwBTPdeJk/exec";

const DEFAULT_CATEGORIES = [
  { id: "fall",      label: "転倒・転落", icon: "🏃", color: "#E07B54" },
  { id: "collision", label: "衝突・接触", icon: "💥", color: "#C0625A" },
  { id: "machinery", label: "機械・設備", icon: "⚙️", color: "#5B8FA8" },
  { id: "chemical",  label: "薬品・化学", icon: "🧪", color: "#7E6FAB" },
  { id: "fire",      label: "火災・爆発", icon: "🔥", color: "#D98844" },
  { id: "electric",  label: "感電・電気", icon: "⚡", color: "#C4A84B" },
  { id: "health",    label: "体調・健康", icon: "🏥", color: "#4A9D8F" },
  { id: "other",     label: "その他",     icon: "📋", color: "#8A9BB0" },
];
const DEFAULT_LOCATIONS   = ["製造ライン A","製造ライン B","倉庫","事務所","駐車場","廊下・通路","屋外","その他"];
const DEFAULT_DEPARTMENTS = ["製造部","品質管理部","物流部","総務部","営業部","その他"];

const SEVERITY = [
  { id: "low",  label: "軽微",   color: "#4A9D8F", desc: "ヒヤリとした",     bg: "#E8F5F3" },
  { id: "mid",  label: "中程度", color: "#C4943A", desc: "ハッとした",       bg: "#FDF3E3" },
  { id: "high", label: "重大",   color: "#C0625A", desc: "大事になりかけた", bg: "#FAEAE9" },
];

const ADMIN_PASSWORD = "admin123";

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }

function timeAgo(d) {
  const m = Math.floor((Date.now() - new Date(d)) / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return m + "分前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "時間前";
  return Math.floor(h / 24) + "日前";
}

function avatarColor(name) {
  const hues = [200,160,30,280,340,20,180,60];
  return "hsl(" + hues[((name||"?").charCodeAt(0)) % hues.length] + ",45%,55%)";
}

async function sendToSheet(report, catLabel, sevLabel) {
  try {
    await fetch(GAS_URL, {
      method: "POST", mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: report.date, author: report.author,
        department: report.department || "", location: report.location,
        categoryLabel: catLabel, severityLabel: sevLabel,
        description: report.description, action: report.action || ""
      })
    });
  } catch (e) { console.warn("スプレッドシート送信エラー:", e); }
}

// 画像をリサイズしてBase64に変換（最大800px・品質60%）
function resizeImage(file) {
  return new Promise(function(resolve) {
    const reader = new FileReader();
    reader.onload = function(ev) {
      const img = new Image();
      img.onload = function() {
        const MAX = 800;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.6));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const [view, setView]           = useState("feed");
  const [reports, setReports]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [sel, setSel]             = useState(null);
  const [filterCat, setFilterCat] = useState("all");
  const [filterSev, setFilterSev] = useState("all");
  const [form, setForm]           = useState({ category:"", severity:"", location:"", description:"", action:"", author:"", department:"", imageFile:null, imagePreview:null });
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);
  const [newComment, setNewComment] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const fileRef = useRef();

  const [isAdmin, setIsAdmin]         = useState(false);
  const [adminPw, setAdminPw]         = useState("");
  const [adminErr, setAdminErr]       = useState("");
  const [categories, setCategories]   = useState(DEFAULT_CATEGORIES);
  const [locations, setLocations]     = useState(DEFAULT_LOCATIONS);
  const [departments, setDepartments] = useState(DEFAULT_DEPARTMENTS);
  const [adminTab, setAdminTab]       = useState("locations");
  const [newItem, setNewItem]         = useState("");
  const [editIdx, setEditIdx]         = useState(null);
  const [editVal, setEditVal]         = useState("");
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const catMap = Object.fromEntries(categories.map(function(c) { return [c.id, c]; }));
  const sevMap = Object.fromEntries(SEVERITY.map(function(s)   { return [s.id, s]; }));

  // 報告一覧をリアルタイム取得
  useEffect(function() {
    const q = query(collection(db, "reports"), orderBy("date", "desc"));
    return onSnapshot(q, function(snap) {
      setReports(snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data(), { liked: false }); }));
      setLoading(false);
    }, function(err) { console.error(err); setLoading(false); });
  }, []);

  // 管理者設定をリアルタイム取得
  useEffect(function() {
    return onSnapshot(doc(db, "settings", "master"), function(snap) {
      if (snap.exists()) {
        var data = snap.data();
        if (data.categories  && data.categories.length  > 0) setCategories(data.categories);
        if (data.locations   && data.locations.length   > 0) setLocations(data.locations);
        if (data.departments && data.departments.length > 0) setDepartments(data.departments);
      }
      setSettingsLoaded(true);
    }, function() { setSettingsLoaded(true); });
  }, []);

  async function saveSettings(cats, locs, depts) {
    try {
      await setDoc(doc(db, "settings", "master"), { categories: cats, locations: locs, departments: depts });
    } catch(e) { console.error("設定保存エラー:", e); }
  }

  const filtered = reports
    .filter(function(r) { return filterCat === "all" || r.category === filterCat; })
    .filter(function(r) { return filterSev === "all" || r.severity === filterSev; });

  const todayCount = reports.filter(function(r) { return new Date(r.date).toDateString() === new Date().toDateString(); }).length;
  const highCount  = reports.filter(function(r) { return r.severity === "high"; }).length;

  function handleImg(e) {
    var f = e.target.files[0];
    if (!f) return;
    setForm(function(p) { return Object.assign({}, p, { imageFile: f }); });
    var rd = new FileReader();
    rd.onload = function(ev) { setForm(function(p) { return Object.assign({}, p, { imagePreview: ev.target.result }); }); };
    rd.readAsDataURL(f);
  }

  async function handleSubmit() {
    if (!form.category || !form.severity || !form.location || !form.description || !form.author) return;
    setSubmitting(true);
    try {
      var cat = catMap[form.category];
      var sev = sevMap[form.severity];
      var imageData = null;
      if (form.imageFile) {
        imageData = await resizeImage(form.imageFile);
      }
      var report = {
        category: form.category, severity: form.severity,
        location: form.location, description: form.description,
        action: form.action || "", author: form.author,
        department: form.department || "",
        image: imageData,
        date: new Date().toISOString(),
        likes: 0, comments: [],
      };
      await addDoc(collection(db, "reports"), report);
      await sendToSheet(report, cat ? cat.label : "", sev ? sev.label : "");
      setSubmitted(true);
      setTimeout(function() {
        setSubmitted(false);
        setForm({ category:"", severity:"", location:"", description:"", action:"", author:"", department:"", imageFile:null, imagePreview:null });
        setView("feed");
      }, 2000);
    } catch(e) {
      alert("送信エラー: " + e.message);
    }
    setSubmitting(false);
  }

  async function handleLike(id) {
    var r = reports.find(function(r) { return r.id === id; });
    if (!r) return;
    var newLikes = (r.likes || 0) + (r.liked ? -1 : 1);
    await updateDoc(doc(db, "reports", id), { likes: newLikes });
    setReports(function(rs) { return rs.map(function(x) { return x.id === id ? Object.assign({}, x, { liked: !x.liked, likes: newLikes }) : x; }); });
    if (sel && sel.id === id) setSel(function(x) { return Object.assign({}, x, { liked: !x.liked, likes: newLikes }); });
  }

  async function addComment() {
    if (!newComment.trim() || !sel) return;
    await updateDoc(doc(db, "reports", sel.id), { comments: arrayUnion(newComment.trim()) });
    setSel(function(r) { return Object.assign({}, r, { comments: (r.comments||[]).concat([newComment.trim()]) }); });
    setNewComment("");
  }

  async function handleDelete(id) {
    try {
      await deleteDoc(doc(db, "reports", id));
      setDeleteConfirm(null); setSel(null); setView("feed");
    } catch(e) { alert("削除エラー: " + e.message); }
  }

  function adminLogin() {
    if (adminPw === ADMIN_PASSWORD) { setIsAdmin(true); setAdminErr(""); setAdminPw(""); setView("admin"); }
    else setAdminErr("パスワードが違います");
  }

  function addListItem(type) {
    if (!newItem.trim()) return;
    var nc = categories, nl = locations, nd = departments;
    if (type === "locations")        { nl = locations.concat([newItem.trim()]);    setLocations(nl); }
    else if (type === "departments") { nd = departments.concat([newItem.trim()]);  setDepartments(nd); }
    else { nc = categories.concat([{id:generateId(),label:newItem.trim(),icon:"📌",color:"#8A9BB0"}]); setCategories(nc); }
    setNewItem("");
    saveSettings(nc, nl, nd);
  }

  function deleteListItem(type, idx) {
    var nc = categories, nl = locations, nd = departments;
    if (type === "locations")        { nl = locations.filter(function(_,i){return i!==idx;});    setLocations(nl); }
    else if (type === "departments") { nd = departments.filter(function(_,i){return i!==idx;});  setDepartments(nd); }
    else                             { nc = categories.filter(function(_,i){return i!==idx;});   setCategories(nc); }
    saveSettings(nc, nl, nd);
  }

  function saveEdit(type, idx) {
    if (!editVal.trim()) return;
    var nc = categories, nl = locations, nd = departments;
    if (type === "locations")        { nl = locations.map(function(v,i){return i===idx?editVal.trim():v;});                              setLocations(nl); }
    else if (type === "departments") { nd = departments.map(function(v,i){return i===idx?editVal.trim():v;});                            setDepartments(nd); }
    else                             { nc = categories.map(function(v,i){return i===idx?Object.assign({},v,{label:editVal.trim()}):v;}); setCategories(nc); }
    setEditIdx(null); setEditVal("");
    saveSettings(nc, nl, nd);
  }

  var C = {
    bg:"#F7F4F0", border:"#EAE5DF", text:"#3D3530", sub:"#8A7F78",
    accent:"#D97B4F", accentLight:"#FDF0E8", green:"#4A9D8F", nav:"#FFFFFF",
  };

  var css = [
    "@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&display=swap');",
    "*{box-sizing:border-box;margin:0;padding:0;}",
    "body{background:#F7F4F0;}",
    ".card{background:#fff;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,0.06);border:1px solid #EAE5DF;overflow:hidden;}",
    ".btn{border:none;cursor:pointer;font-family:inherit;transition:all 0.15s;}",
    ".btn:active{transform:scale(0.97);}",
    ".pill{display:inline-flex;align-items:center;gap:4px;padding:4px 11px;border-radius:20px;font-size:11px;font-weight:700;}",
    "input,textarea,select{font-family:inherit;color:#3D3530;background:#FAFAF8;border:1.5px solid #DDD8D2;border-radius:12px;outline:none;width:100%;padding:12px 14px;font-size:15px;-webkit-appearance:none;}",
    "input:focus,textarea:focus,select:focus{border-color:#D97B4F;box-shadow:0 0 0 3px rgba(217,123,79,0.12);}",
    "select{background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238A7F78' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\");background-repeat:no-repeat;background-position:right 14px center;padding-right:36px;}",
    "textarea{resize:vertical;min-height:90px;line-height:1.6;}",
    "label{font-size:13px;font-weight:700;color:#8A7F78;display:block;margin-bottom:6px;}",
    "@keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}",
    "@keyframes popIn{0%{transform:scale(0.7);opacity:0}100%{transform:scale(1);opacity:1}}",
    "@keyframes fadeIn{from{opacity:0}to{opacity:1}}",
    "@keyframes spin{to{transform:rotate(360deg)}}",
    ".slide-up{animation:slideUp 0.28s ease forwards;}",
    ".pop-in{animation:popIn 0.45s cubic-bezier(0.34,1.56,0.64,1) forwards;}",
    ".fade-in{animation:fadeIn 0.2s ease forwards;}",
    ".scroll-x{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch;}",
    ".scroll-x::-webkit-scrollbar{display:none;}",
    ".spinner{width:22px;height:22px;border:3px solid #EAE5DF;border-top-color:#D97B4F;border-radius:50%;animation:spin 0.7s linear infinite;margin:0 auto;}",
    ".overlay{position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;padding:24px;}",
  ].join("");

  return (
    <div style={{fontFamily:"'Noto Sans JP','Hiragino Kaku Gothic ProN',sans-serif",background:C.bg,minHeight:"100vh",color:C.text,maxWidth:430,margin:"0 auto"}}>
      <style>{css}</style>

      {/* 削除確認モーダル */}
      {deleteConfirm && (
        <div className="overlay" onClick={function(){setDeleteConfirm(null);}}>
          <div className="card" style={{width:"100%",padding:24,background:"#fff"}} onClick={function(e){e.stopPropagation();}}>
            <div style={{fontSize:32,textAlign:"center",marginBottom:12}}>🗑️</div>
            <div style={{fontSize:16,fontWeight:900,textAlign:"center",marginBottom:8}}>この報告を削除しますか？</div>
            <div style={{fontSize:13,color:C.sub,textAlign:"center",marginBottom:24}}>削除すると元に戻せません</div>
            <div style={{display:"flex",gap:10}}>
              <button className="btn" onClick={function(){setDeleteConfirm(null);}}
                style={{flex:1,padding:14,borderRadius:12,background:"#F0EDE9",color:C.sub,fontSize:14,fontWeight:700}}>
                キャンセル
              </button>
              <button className="btn" onClick={function(){handleDelete(deleteConfirm);}}
                style={{flex:1,padding:14,borderRadius:12,background:"#C0625A",color:"#fff",fontSize:14,fontWeight:700}}>
                削除する
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ヘッダー */}
      <div style={{background:C.nav,borderBottom:"1px solid "+C.border,padding:"14px 18px",position:"sticky",top:0,zIndex:100,boxShadow:"0 1px 8px rgba(0,0,0,0.05)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
<div style={{fontSize:16,fontWeight:900,color:C.text,letterSpacing:"-0.3px"}}>株式会社アルチブリッジ</div>
<div style={{display:"flex",alignItems:"center",gap:6,marginTop:2}}>
  <span style={{fontSize:15,fontWeight:900,color:C.accent}}>🌿 ヒヤリ報告</span>
  <span style={{fontSize:10,color:C.sub,background:"#F0EDE9",borderRadius:6,padding:"2px 7px",fontWeight:600}}>みんなで安全をつくろう</span>
</div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <div style={{textAlign:"center",background:C.accentLight,borderRadius:10,padding:"6px 12px",minWidth:48}}>
              <div style={{fontSize:17,fontWeight:900,color:C.accent,lineHeight:1}}>{todayCount}</div>
              <div style={{fontSize:9,color:C.sub,marginTop:2}}>本日</div>
            </div>
            <div style={{textAlign:"center",background:"#FAEAE9",borderRadius:10,padding:"6px 12px",minWidth:48}}>
              <div style={{fontSize:17,fontWeight:900,color:"#C0625A",lineHeight:1}}>{highCount}</div>
              <div style={{fontSize:9,color:C.sub,marginTop:2}}>重大</div>
            </div>
            <button className="btn" onClick={function(){isAdmin?setView("admin"):setView("adminLogin");}}
              style={{background:isAdmin?"#EDF6F4":"#F0EDE9",borderRadius:10,padding:"8px 10px",fontSize:18,lineHeight:1}}>
              {isAdmin?"🛡️":"🔒"}
            </button>
          </div>
        </div>
      </div>

      <div style={{paddingBottom:88}}>

        {/* 管理者ログイン */}
        {view==="adminLogin" && (
          <div className="slide-up" style={{padding:"40px 24px"}}>
            <div style={{textAlign:"center",marginBottom:32}}>
              <div style={{fontSize:52,marginBottom:12}}>🔒</div>
              <div style={{fontSize:20,fontWeight:900}}>管理者ログイン</div>
              <div style={{fontSize:13,color:C.sub,marginTop:6}}>管理者専用エリアです</div>
            </div>
            <div className="card" style={{padding:24}}>
              <label>パスワード</label>
              <input type="password" value={adminPw}
                onChange={function(e){setAdminPw(e.target.value);}}
                onKeyDown={function(e){if(e.key==="Enter")adminLogin();}}
                placeholder="パスワードを入力" />
              {adminErr && <div style={{color:"#C0625A",fontSize:12,marginTop:8,textAlign:"center"}}>{adminErr}</div>}
              <button className="btn" onClick={adminLogin}
                style={{width:"100%",marginTop:16,padding:14,borderRadius:12,background:C.accent,color:"#fff",fontSize:15,fontWeight:700}}>
                ログイン
              </button>
              <button className="btn" onClick={function(){setView("feed");}}
                style={{width:"100%",marginTop:10,padding:12,borderRadius:12,background:"#F0EDE9",color:C.sub,fontSize:14}}>
                キャンセル
              </button>
            </div>
          </div>
        )}

        {/* 管理者パネル */}
        {view==="admin" && isAdmin && (
          <div className="slide-up">
            <div style={{padding:"16px 18px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{fontSize:17,fontWeight:900}}>🛡️ 管理者パネル</div>
              <button className="btn" onClick={function(){setIsAdmin(false);setView("feed");}}
                style={{background:"#FAEAE9",color:"#C0625A",borderRadius:10,padding:"6px 14px",fontSize:12,fontWeight:700}}>
                ログアウト
              </button>
            </div>
            <div style={{display:"flex",padding:"0 18px 14px"}}>
              {[["locations","📍 場所"],["departments","🏢 部署"],["categories","🏷️ カテゴリ"]].map(function(item){
                return (
                  <button key={item[0]} className="btn" onClick={function(){setAdminTab(item[0]);setEditIdx(null);}}
                    style={{flex:1,padding:"9px 4px",fontSize:12,fontWeight:700,
                      borderBottom:"2.5px solid "+(adminTab===item[0]?C.accent:"#DDD8D2"),
                      color:adminTab===item[0]?C.accent:C.sub,background:"none"}}>
                    {item[1]}
                  </button>
                );
              })}
            </div>
            {!settingsLoaded ? (
              <div style={{padding:40,textAlign:"center"}}><div className="spinner"/></div>
            ) : (function(){
              var list = adminTab==="locations"?locations:adminTab==="departments"?departments:categories;
              var lbl  = adminTab==="locations"?"場所":adminTab==="departments"?"部署":"カテゴリ";
              return (
                <div style={{padding:"0 18px"}}>
                  <div className="card" style={{padding:16,marginBottom:12}}>
                    <label>{"新しい"+lbl+"を追加"}</label>
                    <div style={{display:"flex",gap:8}}>
                      <input value={newItem} onChange={function(e){setNewItem(e.target.value);}}
                        onKeyDown={function(e){if(e.key==="Enter")addListItem(adminTab);}}
                        placeholder={"例：新しい"+lbl} style={{flex:1}} />
                      <button className="btn" onClick={function(){addListItem(adminTab);}}
                        style={{background:C.accent,color:"#fff",borderRadius:10,padding:"0 18px",fontSize:20,fontWeight:700,flexShrink:0}}>＋</button>
                    </div>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:8,paddingBottom:16}}>
                    {list.map(function(item,idx){
                      var key = adminTab+"-"+idx;
                      var displayName = adminTab==="categories"?item.label:item;
                      var icon = adminTab==="locations"?"📍":adminTab==="departments"?"🏢":item.icon;
                      return (
                        <div key={key} className="card" style={{padding:"12px 14px"}}>
                          {editIdx===key ? (
                            <div style={{display:"flex",gap:8,alignItems:"center"}}>
                              <input value={editVal} onChange={function(e){setEditVal(e.target.value);}}
                                style={{flex:1,padding:"8px 10px",fontSize:14}} />
                              <button className="btn" onClick={function(){saveEdit(adminTab,idx);}}
                                style={{background:C.green,color:"#fff",borderRadius:8,padding:"8px 12px",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>保存</button>
                              <button className="btn" onClick={function(){setEditIdx(null);setEditVal("");}}
                                style={{background:"#F0EDE9",color:C.sub,borderRadius:8,padding:"8px 10px",fontSize:12}}>×</button>
                            </div>
                          ) : (
                            <div style={{display:"flex",gap:8,alignItems:"center"}}>
                              <span style={{fontSize:18}}>{icon}</span>
                              <span style={{flex:1,fontSize:14,fontWeight:500}}>{displayName}</span>
                              <button className="btn" onClick={function(){setEditIdx(key);setEditVal(displayName);}}
                                style={{background:"#F0EDE9",color:C.sub,borderRadius:8,padding:"6px 10px",fontSize:12,whiteSpace:"nowrap"}}>編集</button>
                              <button className="btn" onClick={function(){deleteListItem(adminTab,idx);}}
                                style={{background:"#FAEAE9",color:"#C0625A",borderRadius:8,padding:"6px 10px",fontSize:12,whiteSpace:"nowrap"}}>削除</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* 報告一覧 */}
        {view==="feed" && (
          <div className="slide-up">
            <div style={{padding:"12px 18px 10px",background:C.nav,borderBottom:"1px solid "+C.border}}>
              <div className="scroll-x">
                {[{id:"all",label:"すべて",color:C.accent}].concat(SEVERITY).map(function(s){
                  return (
                    <button key={s.id} className="btn" onClick={function(){setFilterSev(s.id);}}
                      style={{whiteSpace:"nowrap",padding:"6px 14px",borderRadius:20,fontSize:12,fontWeight:700,flexShrink:0,
                        background:filterSev===s.id?s.color:"#F0EDE9",color:filterSev===s.id?"#fff":C.sub}}>
                      {s.label}
                    </button>
                  );
                })}
              </div>
              <div className="scroll-x" style={{marginTop:8}}>
                <button className="btn" onClick={function(){setFilterCat("all");}}
                  style={{whiteSpace:"nowrap",padding:"5px 12px",borderRadius:20,fontSize:11,fontWeight:600,flexShrink:0,
                    background:filterCat==="all"?"#E8E3DC":"transparent",color:filterCat==="all"?C.text:C.sub,border:"1px solid "+C.border}}>
                  全て
                </button>
                {categories.map(function(c){
                  return (
                    <button key={c.id} className="btn" onClick={function(){setFilterCat(c.id);}}
                      style={{whiteSpace:"nowrap",padding:"5px 12px",borderRadius:20,fontSize:11,fontWeight:600,flexShrink:0,
                        background:filterCat===c.id?c.color+"22":"transparent",
                        color:filterCat===c.id?c.color:C.sub,border:"1px solid "+(filterCat===c.id?c.color:C.border)}}>
                      {c.icon+" "+c.label}
                    </button>
                  );
                })}
              </div>
            </div>
            {loading ? (
              <div style={{padding:60,textAlign:"center"}}>
                <div className="spinner"/>
                <div style={{color:C.sub,fontSize:13,marginTop:14}}>読み込み中…</div>
              </div>
            ) : (
              <div style={{padding:"14px 16px",display:"flex",flexDirection:"column",gap:10}}>
                {filtered.length===0 && (
                  <div style={{textAlign:"center",color:C.sub,padding:48,fontSize:14}}>
                    <div style={{fontSize:40,marginBottom:12}}>🔍</div>
                    該当する報告がありません
                  </div>
                )}
                {filtered.map(function(r){
                  var cat = catMap[r.category]||{icon:"📋",label:"その他",color:"#8A9BB0"};
                  var sev = sevMap[r.severity]||SEVERITY[0];
                  return (
                    <div key={r.id} className="card fade-in" style={{cursor:"pointer"}}
                      onClick={function(){setSel(r);setView("detail");}}>
                      {r.image && <img src={r.image} alt="" style={{width:"100%",height:160,objectFit:"cover"}} />}
                      <div style={{padding:"14px 16px"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                            <span className="pill" style={{background:cat.color+"18",color:cat.color}}>{cat.icon+" "+cat.label}</span>
                            <span className="pill" style={{background:sev.bg,color:sev.color}}>{sev.label}</span>
                          </div>
                          <span style={{fontSize:11,color:C.sub,whiteSpace:"nowrap",marginLeft:6}}>{timeAgo(r.date)}</span>
                        </div>
                        <div style={{fontSize:12,color:C.sub,marginBottom:8}}>{"📍 "+r.location}</div>
                        <p style={{fontSize:14,lineHeight:1.65,color:C.text,marginBottom:12,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical"}}>
                          {r.description}
                        </p>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:10,borderTop:"1px solid "+C.border}}>
                          <div style={{display:"flex",alignItems:"center",gap:8}}>
                            <div style={{width:28,height:28,borderRadius:"50%",background:avatarColor(r.author),display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700,color:"#fff"}}>
                              {(r.author||"?")[0]}
                            </div>
                            <div>
                              <div style={{fontSize:12,fontWeight:700}}>{r.author}</div>
                              <div style={{fontSize:10,color:C.sub}}>{r.department}</div>
                            </div>
                          </div>
                          <div style={{display:"flex",gap:12,alignItems:"center"}}>
                            <button className="btn"
                              style={{background:"none",color:r.liked?"#C0625A":C.sub,fontSize:13,display:"flex",alignItems:"center",gap:3,padding:"4px 6px"}}
                              onClick={function(e){e.stopPropagation();handleLike(r.id);}}>
                              {r.liked?"❤️":"🤍"} <span style={{fontSize:12}}>{r.likes||0}</span>
                            </button>
                            <span style={{fontSize:12,color:C.sub}}>{"💬 "+(r.comments||[]).length}</span>
{isAdmin && (
  <button className="btn"
    style={{background:"#FAEAE9",color:"#C0625A",borderRadius:8,padding:"4px 10px",fontSize:11,fontWeight:700}}
    onClick={function(e){e.stopPropagation();setDeleteConfirm(r.id);}}>
    🗑️
  </button>
)}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 詳細 */}
        {view==="detail" && sel && (function(){
          var cat = catMap[sel.category]||{icon:"📋",label:"その他",color:"#8A9BB0"};
          var sev = sevMap[sel.severity]||SEVERITY[0];
          return (
            <div className="slide-up">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <button className="btn" onClick={function(){setView("feed");}}
                  style={{background:"none",color:C.sub,padding:"14px 18px",fontSize:14,display:"flex",alignItems:"center",gap:6}}>
                  ← 一覧に戻る
                </button>
                {isAdmin && (
                  <button className="btn" onClick={function(){setDeleteConfirm(sel.id);}}
                    style={{background:"#FAEAE9",color:"#C0625A",borderRadius:10,padding:"8px 14px",fontSize:12,fontWeight:700,margin:"8px 16px 0 0"}}>
                    🗑️ 削除
                  </button>
                )}
              </div>
              {sel.image && <img src={sel.image} alt="" style={{width:"100%",maxHeight:240,objectFit:"cover"}} />}
              <div style={{padding:"0 16px 24px"}}>
                <div style={{display:"flex",gap:8,marginBottom:12,marginTop:8,flexWrap:"wrap"}}>
                  <span className="pill" style={{background:cat.color+"18",color:cat.color,fontSize:12}}>{cat.icon+" "+cat.label}</span>
                  <span className="pill" style={{background:sev.bg,color:sev.color,fontSize:12}}>{sev.label+" — "+sev.desc}</span>
                </div>
                <div style={{fontSize:12,color:C.sub,marginBottom:14,display:"flex",gap:12}}>
                  <span>{"📍 "+sel.location}</span><span>{"🕐 "+timeAgo(sel.date)}</span>
                </div>
                <div className="card" style={{padding:16,marginBottom:12}}>
                  <div style={{fontSize:11,fontWeight:700,color:C.sub,marginBottom:8}}>状況・詳細</div>
                  <p style={{fontSize:14,lineHeight:1.7}}>{sel.description}</p>
                </div>
                {sel.action && (
                  <div className="card" style={{padding:16,marginBottom:12,borderLeft:"3px solid "+C.green}}>
                    <div style={{fontSize:11,fontWeight:700,color:C.green,marginBottom:8}}>💡 改善提案</div>
                    <p style={{fontSize:14,lineHeight:1.7}}>{sel.action}</p>
                  </div>
                )}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 0",borderTop:"1px solid "+C.border,borderBottom:"1px solid "+C.border,margin:"4px 0 16px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <div style={{width:36,height:36,borderRadius:"50%",background:avatarColor(sel.author),display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:"#fff"}}>
                      {(sel.author||"?")[0]}
                    </div>
                    <div>
                      <div style={{fontSize:14,fontWeight:700}}>{sel.author}</div>
                      <div style={{fontSize:11,color:C.sub}}>{sel.department}</div>
                    </div>
                  </div>
                  <button className="btn" onClick={function(){handleLike(sel.id);}}
                    style={{background:sel.liked?"#FAEAE9":"#F0EDE9",border:"1.5px solid "+(sel.liked?"#C0625A":C.border),
                      color:sel.liked?"#C0625A":C.sub,borderRadius:20,padding:"7px 16px",fontSize:13,fontWeight:700}}>
                    {sel.liked?"❤️":"🤍"} {sel.likes||0}
                  </button>
                </div>
                <div style={{fontSize:13,fontWeight:700,color:C.sub,marginBottom:10}}>{"💬 コメント（"+(sel.comments||[]).length+"件）"}</div>
                {(sel.comments||[]).map(function(c,i){
                  return (
                    <div key={i} style={{background:"#F7F4F0",borderRadius:12,padding:"10px 14px",marginBottom:8,fontSize:13,lineHeight:1.6}}>
                      {c}
                    </div>
                  );
                })}
                <div style={{display:"flex",gap:8,marginTop:10}}>
                  <input value={newComment} onChange={function(e){setNewComment(e.target.value);}}
                    onKeyDown={function(e){if(e.key==="Enter")addComment();}}
                    placeholder="コメント・対策案を入力…" style={{flex:1,fontSize:13,padding:"10px 12px"}} />
                  <button className="btn" onClick={addComment}
                    style={{background:C.accent,color:"#fff",borderRadius:10,padding:"10px 16px",fontSize:13,fontWeight:700,whiteSpace:"nowrap"}}>
                    送信
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* 報告フォーム */}
        {view==="report" && (
          <div className="slide-up">
            {submitted ? (
              <div className="pop-in" style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"65vh",gap:16,padding:24}}>
                <div style={{fontSize:72}}>✅</div>
                <div style={{fontSize:22,fontWeight:900,color:C.green}}>報告完了！</div>
                <div style={{fontSize:14,color:C.sub,textAlign:"center"}}>みんなで共有されました</div>
              </div>
            ) : (
              <div style={{padding:"16px 16px 32px"}}>
                <div style={{marginBottom:20}}>
                  <div style={{fontSize:19,fontWeight:900,marginBottom:4}}>📝 ヒヤリハット報告</div>
                  <div style={{fontSize:12,color:C.sub}}>気づいたことをすぐに記録しましょう</div>
                </div>
                <div style={{marginBottom:18}}>
                  <label>カテゴリ <span style={{color:"#C0625A"}}>*</span></label>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    {categories.map(function(c){
                      return (
                        <button key={c.id} className="btn"
                          onClick={function(){setForm(function(f){return Object.assign({},f,{category:c.id});});}}
                          style={{padding:"11px 12px",borderRadius:12,border:"2px solid "+(form.category===c.id?c.color:C.border),
                            background:form.category===c.id?c.color+"18":"#FAFAF8",
                            color:form.category===c.id?c.color:C.sub,fontSize:13,fontWeight:600,
                            display:"flex",alignItems:"center",gap:8,textAlign:"left"}}>
                          <span style={{fontSize:16}}>{c.icon}</span>{c.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{marginBottom:18}}>
                  <label>深刻度 <span style={{color:"#C0625A"}}>*</span></label>
                  <div style={{display:"flex",gap:8}}>
                    {SEVERITY.map(function(s){
                      return (
                        <button key={s.id} className="btn"
                          onClick={function(){setForm(function(f){return Object.assign({},f,{severity:s.id});});}}
                          style={{flex:1,padding:"12px 6px",borderRadius:12,border:"2px solid "+(form.severity===s.id?s.color:C.border),
                            background:form.severity===s.id?s.bg:"#FAFAF8",
                            color:form.severity===s.id?s.color:C.sub,fontSize:12,fontWeight:700,textAlign:"center"}}>
                          <div style={{fontSize:13}}>{s.label}</div>
                          <div style={{fontSize:10,marginTop:3,opacity:0.85,fontWeight:500}}>{s.desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div style={{marginBottom:14}}>
                  <label>発生場所 <span style={{color:"#C0625A"}}>*</span></label>
                  <select value={form.location} onChange={function(e){setForm(function(f){return Object.assign({},f,{location:e.target.value});});}}>
                    <option value="">場所を選択してください</option>
                    {locations.map(function(l){return <option key={l} value={l}>{l}</option>;})}
                  </select>
                </div>
                <div style={{marginBottom:14}}>
                  <label>状況・詳細 <span style={{color:"#C0625A"}}>*</span></label>
                  <textarea value={form.description}
                    onChange={function(e){setForm(function(f){return Object.assign({},f,{description:e.target.value});});}}
                    placeholder="何が起きたか、どんな危険があったかを具体的に書いてください…" />
                </div>
                <div style={{marginBottom:14}}>
                  <label style={{color:C.green}}>💡 改善提案（任意）</label>
                  <textarea value={form.action}
                    onChange={function(e){setForm(function(f){return Object.assign({},f,{action:e.target.value});});}}
                    placeholder="再発を防ぐためのアイデアがあれば…" style={{minHeight:70}} />
                </div>
                <div style={{marginBottom:16}}>
                  <label>📷 写真（任意）</label>
                  <input type="file" accept="image/*" capture="environment" ref={fileRef} style={{display:"none"}} onChange={handleImg} />
                  {form.imagePreview ? (
                    <div style={{position:"relative"}}>
                      <img src={form.imagePreview} alt="" style={{width:"100%",height:180,objectFit:"cover",borderRadius:12}} />
                      <button className="btn"
                        onClick={function(){setForm(function(f){return Object.assign({},f,{imageFile:null,imagePreview:null});});}}
                        style={{position:"absolute",top:8,right:8,background:"rgba(0,0,0,0.5)",color:"#fff",borderRadius:"50%",width:28,height:28,fontSize:14,fontWeight:700}}>×</button>
                    </div>
                  ) : (
                    <button className="btn" onClick={function(){fileRef.current.click();}}
                      style={{width:"100%",padding:22,borderRadius:12,border:"2px dashed "+C.border,background:"#FAFAF8",
                        color:C.sub,fontSize:14,display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
                      <span style={{fontSize:30}}>📷</span>
                      <span>タップして写真を追加</span>
                      <span style={{fontSize:11}}>カメラ・アルバムから選択できます</span>
                    </button>
                  )}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:24}}>
                  <div>
                    <label>氏名 <span style={{color:"#C0625A"}}>*</span></label>
                    <input value={form.author}
                      onChange={function(e){setForm(function(f){return Object.assign({},f,{author:e.target.value});});}}
                      placeholder="山田 太郎" />
                  </div>
                  <div>
                    <label>部署</label>
                    <select value={form.department}
                      onChange={function(e){setForm(function(f){return Object.assign({},f,{department:e.target.value});});}}>
                      <option value="">選択</option>
                      {departments.map(function(d){return <option key={d} value={d}>{d}</option>;})}
                    </select>
                  </div>
                </div>
                <button className="btn" onClick={handleSubmit} disabled={submitting}
                  style={{width:"100%",padding:16,borderRadius:14,fontSize:16,fontWeight:900,
                    background:(form.category&&form.severity&&form.location&&form.description&&form.author&&!submitting)
                      ?"linear-gradient(135deg,#E07B54,#D97B4F)":"#E8E3DC",
                    color:(form.category&&form.severity&&form.location&&form.description&&form.author&&!submitting)?"#fff":C.sub,
                    transition:"all 0.2s",display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
                  {submitting ? (
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div className="spinner" style={{width:18,height:18,borderWidth:2,margin:0}}/>
                      <span>送信中…</span>
                    </div>
                  ) : "報告を送信する"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ボトムナビ */}
      {view!=="adminLogin" && (
        <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,
          background:C.nav,borderTop:"1px solid "+C.border,display:"flex",alignItems:"center",
          padding:"8px 12px",gap:6,paddingBottom:"calc(8px + env(safe-area-inset-bottom))"}}>
          <button className="btn" onClick={function(){setView("feed");}}
            style={{flex:1,padding:"10px 6px",borderRadius:12,background:view==="feed"?C.accentLight:"none",
              color:view==="feed"?C.accent:C.sub,fontSize:11,fontWeight:700,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
            <span style={{fontSize:20}}>📋</span>一覧
          </button>
          <button className="btn" onClick={function(){setView("report");}}
            style={{flex:1.8,padding:"13px 8px",borderRadius:14,fontSize:14,fontWeight:900,
              background:"linear-gradient(135deg,#E07B54,#D97B4F)",color:"#fff",
              boxShadow:"0 4px 16px rgba(217,123,79,0.4)",display:"flex",alignItems:"center",justifyContent:"center",gap:6}}>
            ＋ 今すぐ報告
          </button>
          <button className="btn" onClick={function(){isAdmin?setView("admin"):setView("adminLogin");}}
            style={{flex:1,padding:"10px 6px",borderRadius:12,
              background:(view==="admin"||view==="adminLogin")?"#EDF6F4":"none",
              color:(view==="admin"||view==="adminLogin")?C.green:C.sub,fontSize:11,fontWeight:700,
              display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
            <span style={{fontSize:20}}>{isAdmin?"🛡️":"🔒"}</span>{isAdmin?"管理":"管理者"}
          </button>
        </div>
      )}
    </div>
  );
}
