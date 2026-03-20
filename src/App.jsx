import { useState, useEffect, useRef } from "react";
import { auth, db } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  addDoc,
  serverTimestamp,
} from "firebase/firestore";

// ── Mock Data ──────────────────────────────────────────────────────────────
const CATEGORIES = [
  { id: 1, name: "Технологи", icon: "💻", color: "#6366f1" },
  { id: 2, name: "Санхүү", icon: "💰", color: "#10b981" },
  { id: 3, name: "Эрүүл мэнд", icon: "🏥", color: "#f43f5e" },
  { id: 4, name: "Боловсрол", icon: "🎓", color: "#f59e0b" },
  { id: 5, name: "Барилга", icon: "🏗️", color: "#8b5cf6" },
  { id: 6, name: "Худалдаа", icon: "🛒", color: "#06b6d4" },
];

const INIT_ORGS = [];

const INIT_USERS = [
  {
    id: 1,
    email: "admin@orghub.mn",
    password: "admin123",
    name: "Админ",
    role: "admin",
    approved: true,
  },
  {
    id: 2,
    email: "user@orghub.mn",
    password: "user123",
    name: "Болд Б.",
    role: "user",
    approved: true,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);

// ── Main App ──────────────────────────────────────────────────────────────
// Cache user profile to avoid redundant Firestore reads
const userCache = {};

export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [orgs, setOrgs] = useState([]);
  const [users, setUsers] = useState([]);
  const [page, setPage] = useState("home");
  const [selectedCat, setSelectedCat] = useState(null);
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [notification, setNotification] = useState(null);
  const justLoggedIn = useRef(false); // skip onAuthStateChanged re-read after login

  // ── Auth listener ─────────────────────────────────────────────────────
  useEffect(() => {
    // Safety timeout: if Firebase doesn't respond in 5s, show login page
    const timeout = setTimeout(() => {
      setAuthLoading(false);
    }, 5000);

    let unsub = () => {};
    try {
      unsub = onAuthStateChanged(auth, async (fu) => {
        clearTimeout(timeout);
        if (fu) {
          if (justLoggedIn.current) {
            justLoggedIn.current = false;
            setAuthLoading(false);
            return;
          }
          if (userCache[fu.uid]) {
            setCurrentUser(userCache[fu.uid]);
            setAuthLoading(false);
            return;
          }
          try {
            const snap = await getDoc(doc(db, "users", fu.uid));
            if (snap.exists()) {
              const data = { uid: fu.uid, ...snap.data() };
              userCache[fu.uid] = data;
              setCurrentUser(data);
            } else {
              await signOut(auth);
              setCurrentUser(null);
            }
          } catch (dbErr) {
            console.error("Firestore read error:", dbErr);
            setCurrentUser(null);
          }
        } else {
          setCurrentUser(null);
        }
        setAuthLoading(false);
      });
    } catch (err) {
      console.error("Auth init error:", err);
      clearTimeout(timeout);
      setAuthLoading(false);
    }

    return () => {
      clearTimeout(timeout);
      unsub();
    };
  }, []);

  // ── Realtime orgs ─────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onSnapshot(collection(db, "orgs"), (snap) =>
      setOrgs(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    );
    return unsub;
  }, []);

  // ── Admin: realtime users ─────────────────────────────────────────────
  useEffect(() => {
    if (!currentUser || currentUser.role !== "admin") return;
    const unsub = onSnapshot(collection(db, "users"), (snap) =>
      setUsers(snap.docs.map((d) => ({ uid: d.id, ...d.data() }))),
    );
    return unsub;
  }, [currentUser?.role]);

  const notify = (msg, type = "success") => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 3000);
  };

  const nav = (p, extra = {}) => {
    setPage(p);
    if (extra.org !== undefined) setSelectedOrg(extra.org);
    if (extra.cat !== undefined) setSelectedCat(extra.cat);
    window.scrollTo(0, 0);
  };

  // ── Login: fast path — set user immediately, skip onAuthStateChanged re-read
  const login = async (email, password) => {
    try {
      // Step 1: Firebase Auth
      const cred = await signInWithEmailAndPassword(auth, email, password);

      // Step 2: Firestore-оос хэрэглэгчийн мэдээлэл унших
      let snap;
      try {
        snap = await getDoc(doc(db, "users", cred.user.uid));
      } catch (dbErr) {
        await signOut(auth);
        return notify("Firestore алдаа: " + dbErr.message, "error");
      }

      if (!snap.exists()) {
        await signOut(auth);
        // User exists in Auth but not in Firestore — create basic record
        return notify(
          "Хэрэглэгчийн мэдээлэл Firestore-д байхгүй байна. Firebase Console → Firestore → users collection-д document үүсгэнэ үү.",
          "error",
        );
      }

      const data = snap.data();
      if (!data.approved) {
        await signOut(auth);
        return notify(
          "Бүртгэл баталгаажаагүй байна. Админ хянаж байна.",
          "error",
        );
      }

      const user = { uid: cred.user.uid, ...data };
      userCache[cred.user.uid] = user;
      justLoggedIn.current = true;
      setCurrentUser(user);
      notify(`Тавтай морил, ${data.name}! 👋`);
      nav(data.role === "admin" ? "admin" : "catalog");
    } catch (e) {
      const msg =
        {
          "auth/invalid-credential": "Имэйл эсвэл нууц үг буруу",
          "auth/user-not-found": "Энэ имэйл бүртгэлгүй байна",
          "auth/wrong-password": "Нууц үг буруу байна",
          "auth/too-many-requests": "Хэт олон оролдлого. Түр хүлээнэ үү.",
          "auth/user-disabled": "Энэ данс идэвхгүй болсон байна",
          "auth/network-request-failed": "Интернэт холболт алдаатай байна",
        }[e.code] || "Алдаа [" + e.code + "]: " + e.message;
      notify(msg, "error");
    }
  };

  const register = async (name, email, password) => {
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await setDoc(doc(db, "users", cred.user.uid), {
        name,
        email,
        role: "user",
        approved: false,
        createdAt: serverTimestamp(),
      });
      await signOut(auth);
      notify("Бүртгэл амжилттай! Админ баталгаажуулна хүртэл хүлээнэ үү.");
    } catch (e) {
      if (e.code === "auth/email-already-in-use")
        notify("Энэ имэйл бүртгэлтэй байна", "error");
      else notify(e.message, "error");
    }
  };

  const logout = async () => {
    await signOut(auth);
    setCurrentUser(null);
    setPage("home");
    notify("Системээс гарлаа");
  };

  const forgotPassword = async (email) => {
    try {
      await sendPasswordResetEmail(auth, email);
      notify("Нууц үг сэргээх холбоос илгээгдлээ ✉️");
    } catch {
      notify("Имэйл олдсонгүй", "error");
    }
  };

  // ── CRUD ──────────────────────────────────────────────────────────────
  const approveUser = async (uid) => {
    await updateDoc(doc(db, "users", uid), { approved: true });
    notify("Хэрэглэгч баталгаажлаа ✓");
  };
  const rejectUser = async (uid) => {
    await deleteDoc(doc(db, "users", uid));
    notify("Хэрэглэгч устгагдлаа", "error");
  };
  const approveOrg = async (id) => {
    await updateDoc(doc(db, "orgs", id), { approved: true });
    notify("Байгууллага баталгаажлаа ✓");
  };
  const rejectOrg = async (id) => {
    await deleteDoc(doc(db, "orgs", id));
    notify("Байгууллага татгалзагдлаа", "error");
  };
  const deleteOrg = async (id) => {
    await deleteDoc(doc(db, "orgs", id));
    notify("Байгууллага устгагдлаа", "error");
  };

  const addOrg = async (data) => {
    await addDoc(collection(db, "orgs"), {
      ...data,
      approved: false,
      ownerId: currentUser.uid,
      employees: [],
      activities: [],
      createdAt: serverTimestamp(),
    });
    notify("Байгууллага бүртгэгдлээ. Админ баталгаажуулна.");
    nav("dashboard");
  };

  const updateOrg = async (id, data) => {
    const clean = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== undefined),
    );
    await updateDoc(doc(db, "orgs", id), clean);
    notify("Хадгалагдлаа ✓");
  };

  const myOrgs = currentUser
    ? orgs.filter((o) => o.ownerId === currentUser.uid)
    : [];
  const approvedOrgs = orgs.filter((o) => o.approved);
  const pendingUsers = users.filter((u) => !u.approved && u.role !== "admin");

  const PROTECTED = ["catalog", "org", "dashboard", "addOrg", "admin"];
  const effectivePage =
    !currentUser && PROTECTED.includes(page) ? "home" : page;

  // ── Loading splash ────────────────────────────────────────────────────
  if (authLoading)
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f8fafc",
        }}
      >
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              width: 40,
              height: 40,
              border: "3px solid #e2e8f0",
              borderTop: "3px solid #6366f1",
              borderRadius: "50%",
              animation: "spin .8s linear infinite",
              margin: "0 auto 16px",
            }}
          ></div>
          <div style={{ color: "#64748b", fontWeight: 600, fontSize: 15 }}>
            Ачааллаж байна...
          </div>
          <div style={{ color: "#94a3b8", fontSize: 13, marginTop: 8 }}>
            5 секундын дараа автоматаар нэвтрэх хуудас руу шилжинэ
          </div>
        </div>
      </div>
    );

  const pages = {
    home: (
      <LandingPage
        login={login}
        register={register}
        nav={nav}
        notify={notify}
      />
    ),
    forgotpw: (
      <ForgotPwPage forgotPassword={forgotPassword} nav={nav} notify={notify} />
    ),
    catalog: (
      <CatalogPage
        orgs={approvedOrgs}
        categories={CATEGORIES}
        selectedCat={selectedCat}
        setSelectedCat={setSelectedCat}
        nav={nav}
        currentUser={currentUser}
        logout={logout}
      />
    ),
    org: (
      <OrgPage
        org={selectedOrg}
        nav={nav}
        currentUser={currentUser}
        logout={logout}
      />
    ),
    dashboard: (
      <DashboardPage
        currentUser={currentUser}
        myOrgs={myOrgs}
        nav={nav}
        logout={logout}
        updateOrg={updateOrg}
        deleteOrg={deleteOrg}
      />
    ),
    addOrg: (
      <AddOrgPage
        categories={CATEGORIES}
        addOrg={addOrg}
        nav={nav}
        currentUser={currentUser}
        logout={logout}
      />
    ),
    admin: (
      <AdminPage
        users={users}
        orgs={orgs}
        pendingUsers={pendingUsers}
        nav={nav}
        approveUser={approveUser}
        rejectUser={rejectUser}
        approveOrg={approveOrg}
        rejectOrg={rejectOrg}
        currentUser={currentUser}
        logout={logout}
      />
    ),
  };

  return (
    <div
      style={{
        fontFamily: "'Segoe UI', sans-serif",
        minHeight: "100vh",
        background: "#f8fafc",
      }}
    >
      {notification && (
        <div
          style={{
            position: "fixed",
            top: 20,
            right: 20,
            zIndex: 9999,
            background: notification.type === "error" ? "#ef4444" : "#10b981",
            color: "#fff",
            padding: "12px 20px",
            borderRadius: 10,
            fontWeight: 600,
            boxShadow: "0 4px 20px rgba(0,0,0,0.15)",
            animation: "slideIn .3s ease",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span>{notification.type === "error" ? "⚠️" : "✅"}</span>
          {notification.msg}
        </div>
      )}
      <style>{`
        @keyframes slideIn { from { transform: translateX(40px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        button { cursor: pointer; }
        input, textarea, select { outline: none; font-family: inherit; }
      `}</style>
      {pages[effectivePage] || pages.home}
    </div>
  );
}

// ── Navbar ────────────────────────────────────────────────────────────────
function Navbar({ nav, currentUser, logout }) {
  return (
    <nav
      style={{
        background: "#fff",
        borderBottom: "1px solid #e2e8f0",
        padding: "0 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 60,
        position: "sticky",
        top: 0,
        zIndex: 100,
        boxShadow: "0 1px 8px rgba(0,0,0,.06)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          cursor: "pointer",
        }}
        onClick={() => nav("home")}
      >
        <span style={{ fontSize: 24 }}>🏛️</span>
        <span style={{ fontWeight: 800, fontSize: 18, color: "#1e293b" }}>
          OrgHub <span style={{ color: "#6366f1" }}>Mongolia</span>
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {currentUser && (
          <>
            <NavBtn onClick={() => nav("catalog")}>Байгууллагууд</NavBtn>
            <NavBtn onClick={() => nav("dashboard")}>Мэдээлэл</NavBtn>
            {currentUser.role === "admin" && (
              <NavBtn onClick={() => nav("admin")} accent>
                Админ
              </NavBtn>
            )}
            <NavBtn onClick={logout} outline>
              Гарах
            </NavBtn>
          </>
        )}
      </div>
    </nav>
  );
}

function NavBtn({ children, onClick, accent, outline }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "7px 16px",
        borderRadius: 8,
        fontWeight: 600,
        fontSize: 14,
        border: "none",
        background: accent ? "#6366f1" : outline ? "transparent" : "#f1f5f9",
        color: accent ? "#fff" : outline ? "#64748b" : "#374151",
        border: outline ? "1.5px solid #e2e8f0" : "none",
        transition: "all .15s",
      }}
    >
      {children}
    </button>
  );
}

// ── Landing / Auth Page ──────────────────────────────────────────────────
function useIsMobile() {
  const [mobile, setMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const h = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return mobile;
}

function LandingPage({ login, register, nav, notify }) {
  const isMobile = useIsMobile();
  const [tab, setTab] = useState("login");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [rName, setRName] = useState("");
  const [rEmail, setREmail] = useState("");
  const [rPw, setRPw] = useState("");
  const [rPw2, setRPw2] = useState("");
  const [loading, setLoading] = useState(false);

  const doLogin = async () => {
    setLoading(true);
    await login(email, pw);
    setLoading(false);
  };

  const doRegister = async () => {
    if (!rName || !rEmail || !rPw)
      return notify("Бүх талбарыг бөглөнө үү", "error");
    if (rPw !== rPw2) return notify("Нууц үг таарахгүй байна", "error");
    if (rPw.length < 6)
      return notify("Нууц үг хамгийн багадаа 6 тэмдэгт байна", "error");
    setLoading(true);
    await register(rName, rEmail, rPw);
    setLoading(false);
    setTab("login");
    setRName("");
    setREmail("");
    setRPw("");
    setRPw2("");
  };

  // ── Mobile layout ───────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "#fff",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Compact branded header */}
        <div
          style={{
            background: "linear-gradient(135deg, #4f46e5, #7c3aed)",
            padding: "28px 24px 32px",
            color: "#fff",
            textAlign: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                background: "rgba(255,255,255,.2)",
                borderRadius: 10,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 20,
              }}
            >
              🏛️
            </div>
            <span style={{ fontWeight: 800, fontSize: 20 }}>
              OrgHub <span style={{ opacity: 0.7 }}>Mongolia</span>
            </span>
          </div>
          <p style={{ fontSize: 13, opacity: 0.75, lineHeight: 1.5 }}>
            Байгууллагийн нэгдсэн мэдээллийн сан
          </p>
        </div>

        {/* Form area */}
        <div style={{ flex: 1, padding: "28px 20px 40px", background: "#fff" }}>
          {/* Tab switcher */}
          <div
            style={{
              display: "flex",
              background: "#f1f5f9",
              borderRadius: 12,
              padding: 4,
              marginBottom: 28,
              border: "1px solid #e2e8f0",
            }}
          >
            {[
              ["login", "Нэвтрэх"],
              ["register", "Бүртгүүлэх"],
            ].map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  flex: 1,
                  padding: "11px 0",
                  borderRadius: 9,
                  fontWeight: 700,
                  fontSize: 15,
                  border: "none",
                  background: tab === t ? "#fff" : "transparent",
                  color: tab === t ? "#6366f1" : "#64748b",
                  boxShadow: tab === t ? "0 1px 6px rgba(0,0,0,.1)" : "none",
                  transition: "all .2s",
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "login" ? (
            <div>
              <h2
                style={{
                  fontSize: 24,
                  fontWeight: 800,
                  color: "#111827",
                  marginBottom: 4,
                }}
              >
                Тавтай морил
              </h2>
              <p style={{ color: "#6b7280", fontSize: 14, marginBottom: 24 }}>
                Данснаасаа нэвтэрнэ үү
              </p>
              <MField
                label="Имэйл хаяг"
                value={email}
                onChange={setEmail}
                placeholder="name@company.mn"
                type="email"
              />
              <MField
                label="Нууц үг"
                value={pw}
                onChange={setPw}
                placeholder="••••••••"
                type="password"
              />
              <button
                onClick={() => nav("forgotpw")}
                style={{
                  background: "none",
                  border: "none",
                  color: "#6366f1",
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: "pointer",
                  marginBottom: 20,
                  display: "block",
                }}
              >
                Нууц үг мартсан уу?
              </button>
              <button
                onClick={doLogin}
                disabled={loading}
                style={{
                  width: "100%",
                  background: loading
                    ? "#c7d2fe"
                    : "linear-gradient(135deg, #6366f1, #8b5cf6)",
                  color: "#fff",
                  padding: "15px",
                  borderRadius: 12,
                  fontWeight: 700,
                  fontSize: 16,
                  border: "none",
                  cursor: loading ? "not-allowed" : "pointer",
                  marginBottom: 20,
                }}
              >
                {loading ? "Нэвтэрж байна..." : "Нэвтрэх →"}
              </button>
              <p
                style={{ textAlign: "center", color: "#6b7280", fontSize: 14 }}
              >
                Бүртгэл байхгүй юу?{" "}
                <span
                  style={{
                    color: "#6366f1",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                  onClick={() => setTab("register")}
                >
                  Бүртгүүлэх
                </span>
              </p>
            </div>
          ) : (
            <div>
              <h2
                style={{
                  fontSize: 24,
                  fontWeight: 800,
                  color: "#111827",
                  marginBottom: 4,
                }}
              >
                Шинэ бүртгэл
              </h2>
              <p style={{ color: "#6b7280", fontSize: 14, marginBottom: 16 }}>
                Мэдээллээ оруулж бүртгүүлнэ үү
              </p>
              <div
                style={{
                  background: "#fef3c7",
                  border: "1px solid #fcd34d",
                  borderRadius: 10,
                  padding: "10px 14px",
                  marginBottom: 20,
                  fontSize: 13,
                  color: "#92400e",
                }}
              >
                ⚠️ Бүртгэл үүсгэсний дараа <b>админ баталгаажуулна</b>.
              </div>
              <MField
                label="Нэр"
                value={rName}
                onChange={setRName}
                placeholder="Таны бүтэн нэр"
              />
              <MField
                label="Имэйл хаяг"
                value={rEmail}
                onChange={setREmail}
                placeholder="name@company.mn"
                type="email"
              />
              <MField
                label="Нууц үг (6+)"
                value={rPw}
                onChange={setRPw}
                placeholder="••••••••"
                type="password"
              />
              <MField
                label="Нууц үг давтах"
                value={rPw2}
                onChange={setRPw2}
                placeholder="••••••••"
                type="password"
              />
              <button
                onClick={doRegister}
                disabled={loading}
                style={{
                  width: "100%",
                  background: loading
                    ? "#c7d2fe"
                    : "linear-gradient(135deg, #6366f1, #8b5cf6)",
                  color: "#fff",
                  padding: "15px",
                  borderRadius: 12,
                  fontWeight: 700,
                  fontSize: 16,
                  border: "none",
                  cursor: loading ? "not-allowed" : "pointer",
                  marginBottom: 20,
                }}
              >
                {loading ? "Бүртгэж байна..." : "Бүртгүүлэх →"}
              </button>
              <p
                style={{ textAlign: "center", color: "#6b7280", fontSize: 14 }}
              >
                Бүртгэлтэй юу?{" "}
                <span
                  style={{
                    color: "#6366f1",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                  onClick={() => setTab("login")}
                >
                  Нэвтрэх
                </span>
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Desktop split layout ────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", display: "flex" }}>
      <div
        style={{
          flex: "0 0 50%",
          background:
            "linear-gradient(145deg, #4f46e5 0%, #7c3aed 60%, #a855f7 100%)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "60px 56px",
          color: "#fff",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: -80,
            right: -80,
            width: 280,
            height: 280,
            borderRadius: "50%",
            background: "rgba(255,255,255,.06)",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: -60,
            left: -60,
            width: 220,
            height: 220,
            borderRadius: "50%",
            background: "rgba(255,255,255,.06)",
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 48,
          }}
        >
          <span style={{ fontSize: 36 }}>🏛️</span>
          <span style={{ fontWeight: 900, fontSize: 22 }}>
            OrgHub <span style={{ opacity: 0.75 }}>Mongolia</span>
          </span>
        </div>
        <h1
          style={{
            fontSize: 38,
            fontWeight: 900,
            lineHeight: 1.2,
            marginBottom: 16,
            letterSpacing: -1,
          }}
        >
          Байгууллагийн нэгдсэн
          <br />
          мэдээллийн сан
        </h1>
        <p
          style={{
            fontSize: 16,
            opacity: 0.8,
            lineHeight: 1.7,
            marginBottom: 40,
            maxWidth: 380,
          }}
        >
          Байгууллагуудын мэдээлэл, үйл ажиллагаа, ажилчдыг нэг дороос харах
          боломжтой платформ.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {[
            ["📂", "Байгууллагуудыг ангилалаар харах"],
            ["🏢", "Байгууллагын дэлгэрэнгүй мэдээлэл"],
            ["👥", "Ажилчид болон үйл ажиллагаа"],
            ["✨", "Өөрийн байгууллагаа бүртгэх"],
          ].map(([icon, text], i) => (
            <div
              key={i}
              style={{ display: "flex", alignItems: "center", gap: 12 }}
            >
              <div
                style={{
                  background: "rgba(255,255,255,.15)",
                  borderRadius: 10,
                  width: 36,
                  height: 36,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 18,
                  flexShrink: 0,
                }}
              >
                {icon}
              </div>
              <span style={{ fontSize: 15, opacity: 0.9 }}>{text}</span>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          background: "#f8fafc",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px 32px",
        }}
      >
        <div style={{ width: "100%", maxWidth: 420 }}>
          <div
            style={{
              display: "flex",
              background: "#e2e8f0",
              borderRadius: 12,
              padding: 4,
              marginBottom: 32,
            }}
          >
            {[
              ["login", "🔐 Нэвтрэх"],
              ["register", "✨ Бүртгүүлэх"],
            ].map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  flex: 1,
                  padding: "10px 0",
                  borderRadius: 9,
                  fontWeight: 700,
                  fontSize: 15,
                  border: "none",
                  background: tab === t ? "#fff" : "transparent",
                  color: tab === t ? "#4f46e5" : "#64748b",
                  boxShadow: tab === t ? "0 1px 6px rgba(0,0,0,.1)" : "none",
                  transition: "all .2s",
                  cursor: "pointer",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === "login" ? (
            <div>
              <h2
                style={{
                  fontSize: 26,
                  fontWeight: 800,
                  color: "#1e293b",
                  marginBottom: 4,
                }}
              >
                Тавтай морил!
              </h2>
              <p style={{ color: "#94a3b8", fontSize: 14, marginBottom: 28 }}>
                Данснаасаа нэвтэрнэ үү
              </p>
              <FormField
                label="Имэйл хаяг"
                value={email}
                onChange={setEmail}
                placeholder="example@mail.mn"
                type="email"
              />
              <FormField
                label="Нууц үг"
                value={pw}
                onChange={setPw}
                placeholder="••••••••"
                type="password"
              />
              <button
                onClick={() => nav("forgotpw")}
                style={{
                  background: "none",
                  border: "none",
                  color: "#6366f1",
                  fontSize: 13,
                  cursor: "pointer",
                  marginBottom: 20,
                  display: "block",
                  fontWeight: 600,
                }}
              >
                Нууц үг мартсан уу?
              </button>
              <PrimaryBtn onClick={doLogin} disabled={loading}>
                {loading ? "Нэвтэрж байна..." : "Нэвтрэх →"}
              </PrimaryBtn>
              <p
                style={{
                  textAlign: "center",
                  marginTop: 20,
                  color: "#64748b",
                  fontSize: 14,
                }}
              >
                Бүртгэл байхгүй юу?{" "}
                <span
                  style={{
                    color: "#6366f1",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                  onClick={() => setTab("register")}
                >
                  Бүртгүүлэх
                </span>
              </p>
            </div>
          ) : (
            <div>
              <h2
                style={{
                  fontSize: 26,
                  fontWeight: 800,
                  color: "#1e293b",
                  marginBottom: 4,
                }}
              >
                Шинэ бүртгэл
              </h2>
              <p style={{ color: "#94a3b8", fontSize: 14, marginBottom: 16 }}>
                Мэдээллээ бөглөж бүртгүүлнэ үү
              </p>
              <div
                style={{
                  background: "#fff9e6",
                  border: "1px solid #fbbf24",
                  borderRadius: 10,
                  padding: "10px 14px",
                  marginBottom: 20,
                  fontSize: 12,
                  color: "#92400e",
                }}
              >
                ⚠️ Бүртгэл үүсгэсний дараа <b>админ баталгаажуулна</b>. 1-2
                хоног болно.
              </div>
              <FormField
                label="Нэр"
                value={rName}
                onChange={setRName}
                placeholder="Таны нэр"
              />
              <FormField
                label="Имэйл хаяг"
                value={rEmail}
                onChange={setREmail}
                placeholder="example@mail.mn"
                type="email"
              />
              <FormField
                label="Нууц үг (6+ тэмдэгт)"
                value={rPw}
                onChange={setRPw}
                placeholder="••••••••"
                type="password"
              />
              <FormField
                label="Нууц үг давтах"
                value={rPw2}
                onChange={setRPw2}
                placeholder="••••••••"
                type="password"
              />
              <PrimaryBtn onClick={doRegister} disabled={loading}>
                {loading ? "Бүртгэж байна..." : "Бүртгүүлэх →"}
              </PrimaryBtn>
              <p
                style={{
                  textAlign: "center",
                  marginTop: 20,
                  color: "#64748b",
                  fontSize: 14,
                }}
              >
                Бүртгэлтэй юу?{" "}
                <span
                  style={{
                    color: "#6366f1",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                  onClick={() => setTab("login")}
                >
                  Нэвтрэх
                </span>
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Mobile form field helper ──────────────────────────────────────────────
function MField({ label, value, onChange, placeholder, type = "text" }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label
        style={{
          display: "block",
          fontWeight: 600,
          marginBottom: 6,
          color: "#374151",
          fontSize: 14,
        }}
      >
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          padding: "13px 16px",
          border: "1.5px solid #e2e8f0",
          borderRadius: 10,
          fontSize: 15,
          color: "#111827",
          background: "#fff",
          outline: "none",
          transition: "border-color .2s",
        }}
        onFocus={(e) => (e.target.style.borderColor = "#6366f1")}
        onBlur={(e) => (e.target.style.borderColor = "#e2e8f0")}
      />
    </div>
  );
}

// ── Forgot Password ───────────────────────────────────────────────────────
function ForgotPwPage({ forgotPassword, nav, notify }) {
  const [email, setEmail] = useState("");
  const send = () => {
    if (!email) return notify("Имэйл оруулна уу", "error");
    notify("Нууц үг сэргээх холбоос илгээгдлээ (demo)");
    nav("login");
  };
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "linear-gradient(135deg, #f0f4ff 0%, #faf5ff 100%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: 20,
          padding: 40,
          width: "100%",
          maxWidth: 420,
          boxShadow: "0 20px 60px rgba(99,102,241,.12)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ fontSize: 48 }}>🔑</div>
          <h2
            style={{
              fontSize: 26,
              fontWeight: 800,
              color: "#1e293b",
              marginTop: 8,
            }}
          >
            Нууц үг сэргээх
          </h2>
        </div>
        <FormField
          label="Бүртгэлтэй имэйл хаяг"
          value={email}
          onChange={setEmail}
          placeholder="example@mail.mn"
          type="email"
        />
        <PrimaryBtn onClick={send}>Холбоос илгээх</PrimaryBtn>
        <p
          style={{
            textAlign: "center",
            marginTop: 16,
            cursor: "pointer",
            color: "#6366f1",
            fontWeight: 600,
            fontSize: 14,
          }}
          onClick={() => nav("login")}
        >
          ← Буцах
        </p>
      </div>
    </div>
  );
}

// ── Catalog Page ──────────────────────────────────────────────────────────
function CatalogPage({
  orgs,
  categories,
  selectedCat,
  setSelectedCat,
  nav,
  currentUser,
  logout,
}) {
  const [search, setSearch] = useState("");
  const filtered = orgs.filter(
    (o) =>
      (!selectedCat || o.categoryId === selectedCat) &&
      (!search || o.name.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div>
      <Navbar nav={nav} currentUser={currentUser} logout={logout} />
      <div
        className="catalog-hero"
        style={{ background: "#1e293b", padding: "40px 24px", color: "#fff" }}
      >
        <div style={{ maxWidth: 800, margin: "0 auto", textAlign: "center" }}>
          <h1 style={{ fontSize: 32, fontWeight: 800, marginBottom: 8 }}>
            📂 Байгууллагууд
          </h1>
          <p style={{ color: "#94a3b8", marginBottom: 24 }}>
            Монголын тэргүүлэх байгууллагуудтай танилц
          </p>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Байгууллага хайх..."
            style={{
              width: "100%",
              maxWidth: 480,
              padding: "12px 20px",
              borderRadius: 12,
              border: "none",
              fontSize: 16,
              background: "rgba(255,255,255,.1)",
              color: "#fff",
              outline: "none",
            }}
          />
        </div>
      </div>

      <div style={{ padding: "24px", maxWidth: 1100, margin: "0 auto" }}>
        <div
          className="cat-pills"
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 28,
          }}
        >
          <CatChip
            active={!selectedCat}
            onClick={() => setSelectedCat(null)}
            label="Бүгд"
            color="#6366f1"
          />
          {categories.map((c) => (
            <CatChip
              key={c.id}
              active={selectedCat === c.id}
              onClick={() => setSelectedCat(c.id)}
              label={`${c.icon} ${c.name}`}
              color={c.color}
            />
          ))}
        </div>

        {selectedCat ? (
          <div>
            {(() => {
              const cat = categories.find((c) => c.id === selectedCat);
              const catOrgs = filtered;
              return (
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      marginBottom: 24,
                      padding: "20px 24px",
                      background: "#fff",
                      borderRadius: 14,
                      border: "1.5px solid #e2e8f0",
                    }}
                  >
                    <span style={{ fontSize: 40 }}>{cat?.icon}</span>
                    <div>
                      <h2
                        style={{
                          fontSize: 22,
                          fontWeight: 800,
                          color: "#1e293b",
                        }}
                      >
                        {cat?.name}
                      </h2>
                      <p style={{ color: "#64748b", fontSize: 14 }}>
                        {catOrgs.length} байгууллага бүртгэлтэй
                      </p>
                    </div>
                  </div>
                  <div
                    className="org-grid"
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fill, minmax(200px, 1fr))",
                      gap: 16,
                    }}
                  >
                    {catOrgs.map((org) => (
                      <div
                        key={org.id}
                        onClick={() => nav("org", { org })}
                        style={{
                          background: "#fff",
                          borderRadius: 14,
                          padding: 20,
                          cursor: "pointer",
                          border: "1.5px solid #e2e8f0",
                          textAlign: "center",
                          transition: "all .2s",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.boxShadow =
                            "0 8px 24px rgba(99,102,241,.15)";
                          e.currentTarget.style.transform = "translateY(-2px)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.boxShadow = "none";
                          e.currentTarget.style.transform = "translateY(0)";
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "center",
                            marginBottom: 10,
                          }}
                        >
                          <LogoDisplay logo={org.logo} size={60} radius={14} />
                        </div>
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: 15,
                            color: "#1e293b",
                          }}
                        >
                          {org.name}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: "#94a3b8",
                            marginTop: 4,
                          }}
                        >
                          {org.tagline}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
          </div>
        ) : (
          <div>
            {categories.map((cat) => {
              const catOrgs = filtered.filter((o) => o.categoryId === cat.id);
              if (catOrgs.length === 0) return null;
              return (
                <div key={cat.id} style={{ marginBottom: 40 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 16,
                    }}
                  >
                    <span style={{ fontSize: 24 }}>{cat.icon}</span>
                    <h3
                      style={{
                        fontSize: 20,
                        fontWeight: 700,
                        color: "#1e293b",
                      }}
                    >
                      {cat.name}
                    </h3>
                    <span style={{ fontSize: 13, color: "#94a3b8" }}>
                      ({catOrgs.length})
                    </span>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fill, minmax(180px, 1fr))",
                      gap: 14,
                    }}
                  >
                    {catOrgs.map((org) => (
                      <div
                        key={org.id}
                        onClick={() => nav("org", { org })}
                        style={{
                          background: "#fff",
                          borderRadius: 12,
                          padding: 18,
                          cursor: "pointer",
                          border: "1.5px solid #e2e8f0",
                          textAlign: "center",
                          transition: "all .2s",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.borderColor = cat.color;
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.borderColor = "#e2e8f0";
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "center",
                            marginBottom: 8,
                          }}
                        >
                          <LogoDisplay logo={org.logo} size={52} radius={12} />
                        </div>
                        <div
                          style={{
                            fontWeight: 700,
                            fontSize: 14,
                            color: "#1e293b",
                          }}
                        >
                          {org.name}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CatChip({ active, onClick, label, color }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "7px 16px",
        borderRadius: 20,
        fontWeight: 600,
        fontSize: 13,
        border: "1.5px solid",
        borderColor: active ? color : "#e2e8f0",
        background: active ? color : "#fff",
        color: active ? "#fff" : "#374151",
        transition: "all .15s",
      }}
    >
      {label}
    </button>
  );
}

// ── Org Detail Page ───────────────────────────────────────────────────────
function OrgPage({ org, nav, currentUser, logout }) {
  if (!org)
    return (
      <div style={{ padding: 40, textAlign: "center" }}>
        Байгууллага олдсонгүй
      </div>
    );
  return (
    <div>
      <Navbar nav={nav} currentUser={currentUser} logout={logout} />
      <div
        className="org-cover"
        style={{
          background: "linear-gradient(135deg, #1e293b 0%, #334155 100%)",
          color: "#fff",
          padding: "48px 24px",
        }}
      >
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <button
            onClick={() => nav("catalog")}
            style={{
              background: "rgba(255,255,255,.1)",
              border: "none",
              color: "#fff",
              padding: "8px 16px",
              borderRadius: 8,
              fontSize: 14,
              marginBottom: 24,
              cursor: "pointer",
            }}
          >
            ← Буцах
          </button>
          <div
            style={{
              display: "flex",
              gap: 24,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <LogoDisplay logo={org.logo} size={100} radius={20} fallback="🏢" />
            <div>
              <h1 style={{ fontSize: 34, fontWeight: 900, marginBottom: 8 }}>
                {org.name}
              </h1>
              <p style={{ color: "#cbd5e1", fontSize: 16, marginBottom: 12 }}>
                {org.tagline}
              </p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <InfoTag icon="📅" text={`${org.founded} оноос`} />
                <InfoTag icon="👥" text={org.size} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className="page-pad"
        style={{ maxWidth: 900, margin: "0 auto", padding: "40px 24px" }}
      >
        <div
          className="two-col"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 24,
            marginBottom: 32,
          }}
        >
          <Section title="🏢 Тухай">
            <p style={{ color: "#64748b", lineHeight: 1.7, fontSize: 15 }}>
              {org.description}
            </p>
          </Section>
          <Section title="📞 Холбоо барих">
            <ContactRow icon="🌐" text={org.website} />
            <ContactRow icon="📧" text={org.email} />
            <ContactRow icon="📱" text={org.phone} />
            <ContactRow icon="📍" text={org.address} />
          </Section>
        </div>

        <Section title="⚡ Үйл ажиллагаа" style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {org.activities?.map((a, i) => (
              <span
                key={i}
                style={{
                  background: "#eef2ff",
                  color: "#6366f1",
                  padding: "6px 14px",
                  borderRadius: 20,
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                {a}
              </span>
            ))}
          </div>
        </Section>

        <Section title="👤 Ажилчид">
          <div
            className="org-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
              gap: 16,
            }}
          >
            {org.employees?.map((emp, i) => (
              <div
                key={i}
                style={{
                  background: "#f8fafc",
                  borderRadius: 12,
                  padding: 16,
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                }}
              >
                <EmpAvatar avatar={emp.avatar} size={52} />
                <div>
                  <div
                    style={{ fontWeight: 700, fontSize: 14, color: "#1e293b" }}
                  >
                    {emp.name}
                  </div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    {emp.role}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children, style }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 16,
        padding: 24,
        border: "1.5px solid #e2e8f0",
        ...style,
      }}
    >
      <h3
        style={{
          fontSize: 16,
          fontWeight: 800,
          color: "#1e293b",
          marginBottom: 16,
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

function InfoTag({ icon, text }) {
  return (
    <span
      style={{
        background: "rgba(255,255,255,.15)",
        padding: "4px 12px",
        borderRadius: 20,
        fontSize: 13,
      }}
    >
      {icon} {text}
    </span>
  );
}

function ContactRow({ icon, text }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        marginBottom: 10,
        fontSize: 14,
        color: "#64748b",
      }}
    >
      <span>{icon}</span>
      <span>{text}</span>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────
// OrgEditor: edit a single org's details, employees, activities
function OrgEditor({ org, updateOrg, deleteOrg, nav, onBack }) {
  const [section, setSection] = useState("info");
  const [editField, setEditField] = useState(null);
  const [form, setForm] = useState({ ...org });
  const [newEmp, setNewEmp] = useState({ name: "", role: "", avatar: null });
  const [newAct, setNewAct] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = (fields) => {
    const updated = { ...form, ...fields };
    updateOrg(org.id, updated);
    setForm(updated);
    setEditField(null);
  };

  const addEmp = () => {
    if (!newEmp.name) return;
    const emps = [...(form.employees || []), newEmp];
    save({ employees: emps });
    setNewEmp({ name: "", role: "", avatar: null });
  };

  const removeEmp = (i) =>
    save({ employees: (form.employees || []).filter((_, idx) => idx !== i) });
  const addAct = () => {
    if (!newAct.trim()) return;
    save({ activities: [...(form.activities || []), newAct.trim()] });
    setNewAct("");
  };
  const removeAct = (i) =>
    save({ activities: (form.activities || []).filter((_, idx) => idx !== i) });

  const TABS = [
    { key: "info", label: "🏢 Мэдээлэл" },
    { key: "employees", label: "👥 Ажилчид" },
    { key: "activities", label: "⚡ Үйл ажиллагаа" },
  ];

  // Use the live form data for display
  const display = form;

  return (
    <div
      className="page-pad"
      style={{ maxWidth: 860, margin: "0 auto", padding: "32px 24px" }}
    >
      {/* Header banner */}
      <div
        style={{
          background: "linear-gradient(135deg,#4f46e5,#7c3aed)",
          borderRadius: 18,
          padding: "24px 28px",
          marginBottom: 24,
          display: "flex",
          alignItems: "center",
          gap: 18,
          color: "#fff",
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: "rgba(255,255,255,.15)",
            border: "1.5px solid rgba(255,255,255,.3)",
            color: "#fff",
            padding: "7px 14px",
            borderRadius: 9,
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          ← Буцах
        </button>
        <LogoDisplay logo={display.logo} size={60} radius={12} />
        <div style={{ flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 2,
            }}
          >
            <span style={{ fontWeight: 900, fontSize: 20 }}>
              {display.name}
            </span>
            {!display.approved ? (
              <span
                style={{
                  background: "#fbbf24",
                  color: "#78350f",
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "2px 9px",
                  borderRadius: 20,
                }}
              >
                ⏳ Хянагдаж байна
              </span>
            ) : (
              <span
                style={{
                  background: "#10b981",
                  color: "#fff",
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "2px 9px",
                  borderRadius: 20,
                }}
              >
                ✓ Баталгаажсан
              </span>
            )}
          </div>
          <div style={{ opacity: 0.8, fontSize: 13 }}>{display.tagline}</div>
        </div>
        <button
          onClick={() => nav("org", { org: display })}
          style={{
            background: "rgba(255,255,255,.15)",
            border: "1.5px solid rgba(255,255,255,.3)",
            color: "#fff",
            padding: "7px 16px",
            borderRadius: 9,
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          👁 Харах
        </button>
        <button
          onClick={() => setConfirmDelete(true)}
          style={{
            background: "rgba(239,68,68,.25)",
            border: "1.5px solid rgba(239,68,68,.4)",
            color: "#fca5a5",
            padding: "7px 14px",
            borderRadius: 9,
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          🗑 Устгах
        </button>
      </div>

      {/* Delete confirm */}
      {confirmDelete && (
        <div
          style={{
            background: "#fff1f2",
            border: "1.5px solid #fca5a5",
            borderRadius: 14,
            padding: "18px 22px",
            marginBottom: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <div>
            <div style={{ fontWeight: 700, color: "#be123c", marginBottom: 2 }}>
              ⚠️ Байгууллага устгах уу?
            </div>
            <div style={{ fontSize: 13, color: "#9f1239" }}>
              "{display.name}" байгууллагыг устгавал буцаах боломжгүй.
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <button
              onClick={() => {
                deleteOrg(org.id);
                onBack();
              }}
              style={{
                background: "#ef4444",
                color: "#fff",
                padding: "8px 18px",
                borderRadius: 8,
                fontWeight: 700,
                border: "none",
              }}
            >
              Тийм, устга
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              style={{
                background: "#f1f5f9",
                color: "#374151",
                padding: "8px 16px",
                borderRadius: 8,
                fontWeight: 700,
                border: "none",
              }}
            >
              Цуцлах
            </button>
          </div>
        </div>
      )}

      {/* Tab nav */}
      <div
        style={{
          display: "flex",
          gap: 4,
          background: "#fff",
          borderRadius: 12,
          padding: 4,
          border: "1.5px solid #e2e8f0",
          marginBottom: 22,
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setSection(t.key);
              setEditField(null);
            }}
            style={{
              flex: 1,
              padding: "10px 0",
              borderRadius: 9,
              fontWeight: 700,
              fontSize: 14,
              border: "none",
              cursor: "pointer",
              background: section === t.key ? "#6366f1" : "transparent",
              color: section === t.key ? "#fff" : "#64748b",
              transition: "all .15s",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Info section */}
      {section === "info" && (
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
        >
          <Card
            title="🖼 Лого & Нэр"
            onEdit={() => setEditField(editField === "main" ? null : "main")}
            editing={editField === "main"}
            onSave={() => save({})}
          >
            {editField === "main" ? (
              <>
                <LogoUpload
                  value={form.logo}
                  onChange={(v) => setForm((f) => ({ ...f, logo: v }))}
                />
                <FormField
                  label="Нэр"
                  value={form.name || ""}
                  onChange={(v) => setForm((f) => ({ ...f, name: v }))}
                />
                <FormField
                  label="Уриа үг"
                  value={form.tagline || ""}
                  onChange={(v) => setForm((f) => ({ ...f, tagline: v }))}
                />
                <FormField
                  label="Үүсгэгдсэн он"
                  value={form.founded || ""}
                  onChange={(v) => setForm((f) => ({ ...f, founded: v }))}
                  placeholder="2010"
                />
                <FormField
                  label="Ажилчдын тоо"
                  value={form.size || ""}
                  onChange={(v) => setForm((f) => ({ ...f, size: v }))}
                  placeholder="100+ ажилтан"
                />
              </>
            ) : (
              <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                <LogoDisplay logo={display.logo} size={56} radius={12} />
                <div>
                  <div
                    style={{ fontWeight: 800, fontSize: 15, color: "#1e293b" }}
                  >
                    {display.name}
                  </div>
                  <div style={{ color: "#64748b", fontSize: 13, marginTop: 2 }}>
                    {display.tagline}
                  </div>
                  <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 3 }}>
                    📅 {display.founded} · 👥 {display.size}
                  </div>
                </div>
              </div>
            )}
          </Card>
          <Card
            title="📞 Холбоо барих"
            onEdit={() =>
              setEditField(editField === "contact" ? null : "contact")
            }
            editing={editField === "contact"}
            onSave={() => save({})}
          >
            {editField === "contact" ? (
              <>
                <FormField
                  label="Вэбсайт"
                  value={form.website || ""}
                  onChange={(v) => setForm((f) => ({ ...f, website: v }))}
                />
                <FormField
                  label="Имэйл"
                  value={form.email || ""}
                  onChange={(v) => setForm((f) => ({ ...f, email: v }))}
                  type="email"
                />
                <FormField
                  label="Утас"
                  value={form.phone || ""}
                  onChange={(v) => setForm((f) => ({ ...f, phone: v }))}
                />
                <FormField
                  label="Хаяг"
                  value={form.address || ""}
                  onChange={(v) => setForm((f) => ({ ...f, address: v }))}
                />
              </>
            ) : (
              <>
                <ContactRow icon="🌐" text={display.website} />
                <ContactRow icon="📧" text={display.email} />
                <ContactRow icon="📱" text={display.phone} />
                <ContactRow icon="📍" text={display.address} />
              </>
            )}
          </Card>
          <div style={{ gridColumn: "1/-1" }}>
            <Card
              title="📝 Тайлбар"
              onEdit={() => setEditField(editField === "desc" ? null : "desc")}
              editing={editField === "desc"}
              onSave={() => save({})}
            >
              {editField === "desc" ? (
                <FormField
                  label=""
                  value={form.description || ""}
                  onChange={(v) => setForm((f) => ({ ...f, description: v }))}
                  type="textarea"
                />
              ) : (
                <p style={{ color: "#64748b", lineHeight: 1.7, fontSize: 14 }}>
                  {display.description || "Тайлбар оруулаагүй байна."}
                </p>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* Employees section */}
      {section === "employees" && (
        <div>
          <div
            style={{
              background: "#fff",
              borderRadius: 16,
              padding: 22,
              border: "1.5px solid #e2e8f0",
              marginBottom: 18,
            }}
          >
            <h3
              style={{
                fontWeight: 700,
                marginBottom: 14,
                color: "#1e293b",
                fontSize: 15,
              }}
            >
              ➕ Шинэ ажилтан нэмэх
            </h3>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr 1fr auto",
                gap: 10,
                alignItems: "end",
              }}
            >
              <AvatarUpload
                value={newEmp.avatar}
                onChange={(v) => setNewEmp((e) => ({ ...e, avatar: v }))}
                compact
              />
              <FormField
                label="Нэр *"
                value={newEmp.name}
                onChange={(v) => setNewEmp((e) => ({ ...e, name: v }))}
              />
              <FormField
                label="Албан тушаал"
                value={newEmp.role}
                onChange={(v) => setNewEmp((e) => ({ ...e, role: v }))}
              />
              <button
                onClick={addEmp}
                style={{
                  background: "#6366f1",
                  color: "#fff",
                  padding: "10px 18px",
                  borderRadius: 8,
                  fontWeight: 700,
                  border: "none",
                  marginBottom: 14,
                }}
              >
                + Нэмэх
              </button>
            </div>
          </div>
          {(display.employees || []).length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: 40,
                color: "#94a3b8",
                background: "#fff",
                borderRadius: 16,
                border: "1.5px solid #e2e8f0",
              }}
            >
              👥 Ажилтан бүртгэгдээгүй байна
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))",
                gap: 12,
              }}
            >
              {(display.employees || []).map((emp, i) => (
                <div
                  key={i}
                  style={{
                    background: "#fff",
                    borderRadius: 14,
                    padding: 16,
                    border: "1.5px solid #e2e8f0",
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                  }}
                >
                  <EmpAvatar avatar={emp.avatar} size={48} />
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 14,
                        color: "#1e293b",
                      }}
                    >
                      {emp.name}
                    </div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>
                      {emp.role}
                    </div>
                  </div>
                  <button
                    onClick={() => removeEmp(i)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#cbd5e1",
                      fontSize: 16,
                      cursor: "pointer",
                      padding: 2,
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Activities section */}
      {section === "activities" && (
        <div>
          <div
            style={{
              background: "#fff",
              borderRadius: 16,
              padding: 22,
              border: "1.5px solid #e2e8f0",
              marginBottom: 18,
            }}
          >
            <h3
              style={{
                fontWeight: 700,
                marginBottom: 14,
                color: "#1e293b",
                fontSize: 15,
              }}
            >
              ➕ Үйл ажиллагаа нэмэх
            </h3>
            <div style={{ display: "flex", gap: 10 }}>
              <input
                value={newAct}
                onChange={(e) => setNewAct(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addAct()}
                placeholder="Жишээ: Програм хангамж хөгжүүлэлт"
                style={{
                  flex: 1,
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: "1.5px solid #e2e8f0",
                  fontSize: 14,
                }}
              />
              <button
                onClick={addAct}
                style={{
                  background: "#6366f1",
                  color: "#fff",
                  padding: "10px 22px",
                  borderRadius: 8,
                  fontWeight: 700,
                  border: "none",
                }}
              >
                + Нэмэх
              </button>
            </div>
          </div>
          {(display.activities || []).length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: 40,
                color: "#94a3b8",
                background: "#fff",
                borderRadius: 16,
                border: "1.5px solid #e2e8f0",
              }}
            >
              ⚡ Үйл ажиллагаа бүртгэгдээгүй байна
            </div>
          ) : (
            <div
              style={{
                background: "#fff",
                borderRadius: 16,
                padding: 22,
                border: "1.5px solid #e2e8f0",
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {(display.activities || []).map((a, i) => (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: "#eef2ff",
                      borderRadius: 20,
                      padding: "7px 14px",
                    }}
                  >
                    <span
                      style={{
                        color: "#6366f1",
                        fontWeight: 700,
                        fontSize: 14,
                      }}
                    >
                      {a}
                    </span>
                    <button
                      onClick={() => removeAct(i)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#a5b4fc",
                        fontSize: 13,
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// DashboardPage: list of user's orgs, select one to edit
function DashboardPage({
  currentUser,
  myOrgs,
  nav,
  logout,
  updateOrg,
  deleteOrg,
}) {
  const [selectedOrg, setSelectedOrg] = useState(null);

  if (!currentUser) return null;

  // If an org is selected, show its editor
  if (selectedOrg) {
    // Sync with latest data (in case of updates)
    return (
      <div style={{ background: "#f8fafc", minHeight: "100vh" }}>
        <Navbar nav={nav} currentUser={currentUser} logout={logout} />
        <OrgEditor
          org={selectedOrg}
          updateOrg={(id, data) => {
            updateOrg(id, data);
            setSelectedOrg((s) => ({ ...s, ...data }));
          }}
          deleteOrg={deleteOrg}
          nav={nav}
          onBack={() => setSelectedOrg(null)}
        />
      </div>
    );
  }

  return (
    <div style={{ background: "#f8fafc", minHeight: "100vh" }}>
      <Navbar nav={nav} currentUser={currentUser} logout={logout} />
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "40px 24px" }}>
        <div
          className="dash-header"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 32,
          }}
        >
          <div>
            <h1
              style={{
                fontSize: 26,
                fontWeight: 800,
                color: "#1e293b",
                marginBottom: 4,
              }}
            >
              👋 Сайн байна уу, {currentUser.name}
            </h1>
            <p style={{ color: "#64748b", fontSize: 14 }}>
              Таны бүртгэлтэй байгууллагууд
            </p>
          </div>
          <button
            onClick={() => nav("addOrg")}
            style={{
              background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
              color: "#fff",
              padding: "11px 22px",
              borderRadius: 12,
              fontWeight: 700,
              fontSize: 14,
              border: "none",
            }}
          >
            + Байгууллага нэмэх
          </button>
        </div>

        {myOrgs.length === 0 ? (
          <div
            style={{
              background: "#fff",
              borderRadius: 20,
              padding: 56,
              border: "2px dashed #c7d2fe",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 64, marginBottom: 16 }}>🏢</div>
            <h2
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: "#1e293b",
                marginBottom: 10,
              }}
            >
              Байгууллага бүртгэх
            </h2>
            <p style={{ color: "#64748b", marginBottom: 28, lineHeight: 1.6 }}>
              Та одоогоор байгууллага бүртгээгүй байна.
              <br />
              Өөрийн байгууллагын хуудсаа үүсгэнэ үү!
            </p>
            <button
              onClick={() => nav("addOrg")}
              style={{
                background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
                color: "#fff",
                padding: "13px 32px",
                borderRadius: 12,
                fontWeight: 700,
                fontSize: 16,
                border: "none",
              }}
            >
              + Байгууллага нэмэх
            </button>
          </div>
        ) : (
          <div
            className="org-cards-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))",
              gap: 18,
            }}
          >
            {myOrgs.map((org) => (
              <div
                key={org.id}
                style={{
                  background: "#fff",
                  borderRadius: 16,
                  border: "1.5px solid #e2e8f0",
                  overflow: "hidden",
                  transition: "all .2s",
                  cursor: "pointer",
                  boxShadow: "0 2px 8px rgba(0,0,0,.04)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.boxShadow =
                    "0 8px 28px rgba(99,102,241,.14)";
                  e.currentTarget.style.borderColor = "#6366f1";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,.04)";
                  e.currentTarget.style.borderColor = "#e2e8f0";
                }}
              >
                {/* Color top strip */}
                <div
                  style={{
                    height: 6,
                    background: org.approved
                      ? "linear-gradient(90deg,#6366f1,#8b5cf6)"
                      : "linear-gradient(90deg,#fbbf24,#f59e0b)",
                  }}
                />
                <div style={{ padding: 20 }}>
                  <div
                    style={{
                      display: "flex",
                      gap: 14,
                      alignItems: "center",
                      marginBottom: 14,
                    }}
                  >
                    <LogoDisplay logo={org.logo} size={52} radius={10} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 800,
                          fontSize: 15,
                          color: "#1e293b",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {org.name}
                      </div>
                      <div
                        style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}
                      >
                        {org.tagline}
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: "3px 10px",
                        borderRadius: 20,
                        background: org.approved ? "#dcfce7" : "#fff9e6",
                        color: org.approved ? "#16a34a" : "#d97706",
                      }}
                    >
                      {org.approved ? "✓ Баталгаажсан" : "⏳ Хянагдаж байна"}
                    </span>
                    <button
                      onClick={() => setSelectedOrg(org)}
                      style={{
                        background: "#6366f1",
                        color: "#fff",
                        padding: "7px 16px",
                        borderRadius: 8,
                        fontWeight: 700,
                        fontSize: 12,
                        border: "none",
                      }}
                    >
                      ✏️ Засах
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {/* Add new card */}
            <div
              onClick={() => nav("addOrg")}
              style={{
                background: "#fff",
                borderRadius: 16,
                border: "2px dashed #c7d2fe",
                padding: 20,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                minHeight: 140,
                cursor: "pointer",
                color: "#a5b4fc",
                transition: "all .2s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "#6366f1";
                e.currentTarget.style.color = "#6366f1";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "#c7d2fe";
                e.currentTarget.style.color = "#a5b4fc";
              }}
            >
              <div style={{ fontSize: 36, marginBottom: 8 }}>+</div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                Байгууллага нэмэх
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ title, children, onEdit, editing, onSave }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 16,
        padding: 22,
        border: editing ? "1.5px solid #6366f1" : "1.5px solid #e2e8f0",
        transition: "border .2s",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <h3
          style={{ fontWeight: 700, color: "#1e293b", fontSize: 14, margin: 0 }}
        >
          {title}
        </h3>
        {editing ? (
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={onSave}
              style={{
                background: "#10b981",
                color: "#fff",
                padding: "5px 14px",
                borderRadius: 7,
                fontWeight: 700,
                border: "none",
                fontSize: 12,
              }}
            >
              💾 Хадгалах
            </button>
            <button
              onClick={onEdit}
              style={{
                background: "#f1f5f9",
                color: "#374151",
                padding: "5px 12px",
                borderRadius: 7,
                fontWeight: 700,
                border: "none",
                fontSize: 12,
              }}
            >
              Цуцлах
            </button>
          </div>
        ) : (
          <button
            onClick={onEdit}
            style={{
              background: "#f1f5f9",
              color: "#6366f1",
              padding: "5px 12px",
              borderRadius: 7,
              fontWeight: 700,
              border: "none",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            ✏️ Засах
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Add Org Page ──────────────────────────────────────────────────────────
function AddOrgPage({ categories, addOrg, nav, currentUser, logout }) {
  const [form, setForm] = useState({
    logo: null,
    name: "",
    tagline: "",
    description: "",
    categoryId: 1,
    website: "",
    email: "",
    phone: "",
    address: "",
    founded: "",
    size: "",
  });
  const f = (key) => (v) => setForm((prev) => ({ ...prev, [key]: v }));
  const submit = () => {
    if (!form.name) return;
    addOrg(form);
  };

  return (
    <div>
      <Navbar nav={nav} currentUser={currentUser} logout={logout} />
      <div style={{ maxWidth: 700, margin: "0 auto", padding: "40px 24px" }}>
        <h1
          style={{
            fontSize: 28,
            fontWeight: 800,
            color: "#1e293b",
            marginBottom: 8,
          }}
        >
          🏢 Байгууллага бүртгэх
        </h1>
        <p style={{ color: "#64748b", marginBottom: 32 }}>
          Shopify шиг өөрийн байгууллагын хуудсаа тохируулна уу
        </p>
        <div
          style={{
            background: "#fff",
            borderRadius: 20,
            padding: 32,
            border: "1.5px solid #e2e8f0",
          }}
        >
          <div
            className="add-org-grid two-col"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
          >
            <div style={{ gridColumn: "1/-1" }}>
              <LogoUpload
                value={form.logo}
                onChange={(v) => setForm((p) => ({ ...p, logo: v }))}
              />
            </div>
            <FormField
              label="Байгууллагын нэр *"
              value={form.name}
              onChange={f("name")}
            />
            <div style={{ gridColumn: "1/-1" }}>
              <FormField
                label="Уриа үг"
                value={form.tagline}
                onChange={f("tagline")}
              />
            </div>
            <div style={{ gridColumn: "1/-1" }}>
              <FormField
                label="Тайлбар"
                value={form.description}
                onChange={f("description")}
                type="textarea"
              />
            </div>
            <div>
              <label
                style={{
                  display: "block",
                  fontWeight: 600,
                  marginBottom: 6,
                  color: "#374151",
                  fontSize: 14,
                }}
              >
                Ангилал
              </label>
              <select
                value={form.categoryId}
                onChange={(e) =>
                  setForm((p) => ({ ...p, categoryId: +e.target.value }))
                }
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1.5px solid #e2e8f0",
                  fontSize: 14,
                }}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.icon} {c.name}
                  </option>
                ))}
              </select>
            </div>
            <FormField
              label="Үүсгэн байгуулагдсан он"
              value={form.founded}
              onChange={f("founded")}
              placeholder="2010"
            />
            <FormField
              label="Ажилчдын тоо"
              value={form.size}
              onChange={f("size")}
              placeholder="100+ ажилтан"
            />
            <FormField
              label="Вэбсайт"
              value={form.website}
              onChange={f("website")}
            />
            <FormField
              label="Имэйл"
              value={form.email}
              onChange={f("email")}
              type="email"
            />
            <FormField label="Утас" value={form.phone} onChange={f("phone")} />
            <FormField
              label="Хаяг"
              value={form.address}
              onChange={f("address")}
            />
          </div>
          <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
            <PrimaryBtn onClick={submit}>📤 Бүртгэх (Хянуулах)</PrimaryBtn>
            <button
              onClick={() => nav("dashboard")}
              style={{
                padding: "12px 20px",
                borderRadius: 10,
                border: "1.5px solid #e2e8f0",
                background: "#fff",
                color: "#374151",
                fontWeight: 600,
                fontSize: 15,
              }}
            >
              Цуцлах
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Admin Page ────────────────────────────────────────────────────────────
function AdminPage({
  users,
  orgs,
  pendingUsers,
  nav,
  approveUser,
  rejectUser,
  approveOrg,
  rejectOrg,
  currentUser,
  logout,
}) {
  const [tab, setTab] = useState("users");
  const pendingOrgs = orgs.filter((o) => !o.approved);
  return (
    <div>
      <Navbar nav={nav} currentUser={currentUser} logout={logout} />
      <div
        className="page-pad"
        style={{ maxWidth: 900, margin: "0 auto", padding: "40px 24px" }}
      >
        <h1
          style={{
            fontSize: 28,
            fontWeight: 800,
            color: "#1e293b",
            marginBottom: 24,
          }}
        >
          🛡️ Админ самбар
        </h1>
        <div
          className="admin-tabs"
          style={{ display: "flex", gap: 8, marginBottom: 28 }}
        >
          {["users", "orgs", "all"].map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                padding: "8px 20px",
                borderRadius: 8,
                fontWeight: 700,
                border: "none",
                background: tab === t ? "#6366f1" : "#f1f5f9",
                color: tab === t ? "#fff" : "#374151",
              }}
            >
              {t === "users"
                ? `👤 Хэрэглэгчид (${pendingUsers.length} хүлээгдэж буй)`
                : t === "orgs"
                  ? `🏢 Байгууллагууд (${pendingOrgs.length} хүлээгдэж буй)`
                  : "📋 Бүгд"}
            </button>
          ))}
        </div>

        {tab === "users" && (
          <div>
            {pendingUsers.length === 0 ? (
              <Empty text="Хүлээгдэж буй хэрэглэгч байхгүй" />
            ) : (
              pendingUsers.map((u) => (
                <AdminRow
                  key={u.id}
                  title={u.name}
                  sub={u.email}
                  badge="Шинэ хэрэглэгч"
                  onApprove={() => approveUser(u.id)}
                  onReject={() => rejectUser(u.id)}
                />
              ))
            )}
            <h3
              style={{
                fontWeight: 700,
                color: "#94a3b8",
                fontSize: 13,
                marginTop: 24,
                marginBottom: 12,
              }}
            >
              Бүртгэлтэй хэрэглэгчид ({users.length})
            </h3>
            {users
              .filter((u) => u.approved)
              .map((u) => (
                <div
                  key={u.id}
                  style={{
                    background: "#fff",
                    borderRadius: 12,
                    padding: "14px 20px",
                    marginBottom: 8,
                    border: "1.5px solid #e2e8f0",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 700, color: "#1e293b" }}>
                      {u.name}
                    </span>
                    <span
                      style={{ color: "#94a3b8", fontSize: 13, marginLeft: 8 }}
                    >
                      {u.email}
                    </span>
                  </div>
                  <span
                    style={{
                      background: u.role === "admin" ? "#fee2e2" : "#dcfce7",
                      color: u.role === "admin" ? "#dc2626" : "#16a34a",
                      padding: "3px 10px",
                      borderRadius: 20,
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    {u.role}
                  </span>
                </div>
              ))}
          </div>
        )}

        {tab === "orgs" && (
          <div>
            <h3
              style={{
                fontWeight: 700,
                color: "#94a3b8",
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              Хүлээгдэж буй байгууллагууд ({pendingOrgs.length})
            </h3>
            {pendingOrgs.length === 0 ? (
              <Empty text="Хүлээгдэж буй байгууллага байхгүй" />
            ) : (
              pendingOrgs.map((o) => (
                <AdminRow
                  key={o.id}
                  title={o.name}
                  sub={o.tagline || o.email || ""}
                  badge="Шинэ байгууллага"
                  onApprove={() => approveOrg(o.id)}
                  onReject={() => rejectOrg(o.id)}
                />
              ))
            )}
            <h3
              style={{
                fontWeight: 700,
                color: "#94a3b8",
                fontSize: 13,
                marginTop: 24,
                marginBottom: 12,
              }}
            >
              Баталгаажсан байгууллагууд (
              {orgs.filter((o) => o.approved).length})
            </h3>
            {orgs
              .filter((o) => o.approved)
              .map((o) => (
                <div
                  key={o.id}
                  style={{
                    background: "#fff",
                    borderRadius: 12,
                    padding: "12px 18px",
                    marginBottom: 8,
                    border: "1.5px solid #e2e8f0",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <span style={{ fontWeight: 700, color: "#1e293b" }}>
                      {o.name}
                    </span>
                    <span
                      style={{ color: "#94a3b8", fontSize: 13, marginLeft: 8 }}
                    >
                      {o.tagline}
                    </span>
                  </div>
                  <span
                    style={{
                      background: "#dcfce7",
                      color: "#16a34a",
                      padding: "3px 10px",
                      borderRadius: 20,
                      fontSize: 12,
                      fontWeight: 700,
                    }}
                  >
                    ✓ Баталгаажсан
                  </span>
                </div>
              ))}
          </div>
        )}

        {tab === "all" && (
          <div
            className="two-col"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}
          >
            <div
              style={{
                background: "#fff",
                borderRadius: 16,
                padding: 24,
                border: "1.5px solid #e2e8f0",
              }}
            >
              <div style={{ fontSize: 32, marginBottom: 8 }}>👥</div>
              <div style={{ fontSize: 36, fontWeight: 900, color: "#6366f1" }}>
                {users.length}
              </div>
              <div style={{ color: "#64748b" }}>Нийт хэрэглэгч</div>
            </div>
            <div
              style={{
                background: "#fff",
                borderRadius: 16,
                padding: 24,
                border: "1.5px solid #e2e8f0",
              }}
            >
              <div style={{ fontSize: 32, marginBottom: 8 }}>🏢</div>
              <div style={{ fontSize: 36, fontWeight: 900, color: "#10b981" }}>
                {orgs.filter((o) => o.approved).length}
              </div>
              <div style={{ color: "#64748b" }}>Баталгаажсан байгууллага</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AdminRow({ title, sub, badge, onApprove, onReject }) {
  return (
    <div
      style={{
        background: "#fff",
        borderRadius: 14,
        padding: "16px 20px",
        marginBottom: 12,
        border: "1.5px solid #fbbf24",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <div>
        <div style={{ fontWeight: 700, color: "#1e293b", marginBottom: 2 }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: "#94a3b8" }}>{sub}</div>
        <span
          style={{
            fontSize: 11,
            background: "#fff9e6",
            color: "#d97706",
            padding: "2px 8px",
            borderRadius: 20,
            fontWeight: 700,
          }}
        >
          {badge}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={onApprove}
          style={{
            background: "#10b981",
            color: "#fff",
            padding: "7px 16px",
            borderRadius: 8,
            fontWeight: 700,
            border: "none",
            fontSize: 13,
          }}
        >
          ✓ Зөвшөөрөх
        </button>
        {onReject && (
          <button
            onClick={onReject}
            style={{
              background: "#ef4444",
              color: "#fff",
              padding: "7px 16px",
              borderRadius: 8,
              fontWeight: 700,
              border: "none",
              fontSize: 13,
            }}
          >
            ✕ Татгалзах
          </button>
        )}
      </div>
    </div>
  );
}

function Empty({ text }) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: 40,
        color: "#94a3b8",
        fontSize: 15,
      }}
    >
      ✅ {text}
    </div>
  );
}

// ── Shared Components ─────────────────────────────────────────────────────

// ── Avatar Upload (for employees) ────────────────────────────────────────
function AvatarUpload({ value, onChange, compact = false }) {
  const ref = useRef();
  const handle = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => onChange(ev.target.result);
    reader.readAsDataURL(file);
  };
  const isImg = value && value.startsWith("data:");
  return (
    <div
      style={{
        marginBottom: compact ? 0 : 14,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <div
        onClick={() => ref.current.click()}
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          border: "2px dashed #c7d2fe",
          background: "#f5f3ff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          flexShrink: 0,
          cursor: "pointer",
        }}
      >
        {isImg ? (
          <img
            src={value}
            alt="avatar"
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <span style={{ fontSize: 24 }}>👤</span>
        )}
      </div>
      {!compact && (
        <div>
          <button
            type="button"
            onClick={() => ref.current.click()}
            style={{
              background: "#6366f1",
              color: "#fff",
              padding: "6px 14px",
              borderRadius: 8,
              fontWeight: 700,
              fontSize: 12,
              border: "none",
              cursor: "pointer",
              display: "block",
              marginBottom: 4,
            }}
          >
            📷 Зураг сонгох
          </button>
          <span style={{ fontSize: 11, color: "#94a3b8" }}>Профайл зураг</span>
          {isImg && (
            <button
              type="button"
              onClick={() => onChange(null)}
              style={{
                background: "none",
                border: "none",
                color: "#ef4444",
                fontSize: 11,
                cursor: "pointer",
                display: "block",
                marginTop: 2,
                fontWeight: 600,
              }}
            >
              ✕ Устгах
            </button>
          )}
        </div>
      )}
      <input
        ref={ref}
        type="file"
        accept="image/*"
        onChange={handle}
        style={{ display: "none" }}
      />
    </div>
  );
}

function EmpAvatar({ avatar, size = 40 }) {
  const isImg =
    avatar && (avatar.startsWith("data:") || avatar.startsWith("http"));
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: "#e0e7ff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {isImg ? (
        <img
          src={avatar}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <span style={{ fontSize: size * 0.48 }}>👤</span>
      )}
    </div>
  );
}

function LogoUpload({ value, onChange }) {
  const ref = useRef();
  const handle = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => onChange(ev.target.result);
    reader.readAsDataURL(file);
  };
  return (
    <div style={{ marginBottom: 16 }}>
      <label
        style={{
          display: "block",
          fontWeight: 600,
          marginBottom: 8,
          color: "#374151",
          fontSize: 14,
        }}
      >
        Лого (зураг)
      </label>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          style={{
            width: 80,
            height: 80,
            borderRadius: 14,
            border: "2px dashed #c7d2fe",
            background: "#f5f3ff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          {value ? (
            <img
              src={value}
              alt="logo"
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
          ) : (
            <span style={{ fontSize: 32 }}>🏢</span>
          )}
        </div>
        <div>
          <button
            type="button"
            onClick={() => ref.current.click()}
            style={{
              background: "#6366f1",
              color: "#fff",
              padding: "8px 18px",
              borderRadius: 8,
              fontWeight: 700,
              fontSize: 13,
              border: "none",
              cursor: "pointer",
              display: "block",
              marginBottom: 6,
            }}
          >
            📁 Зураг сонгох
          </button>
          <span style={{ fontSize: 12, color: "#94a3b8" }}>
            PNG, JPG, WEBP — дээд тал 2MB
          </span>
          {value && (
            <button
              type="button"
              onClick={() => onChange(null)}
              style={{
                background: "none",
                border: "none",
                color: "#ef4444",
                fontSize: 12,
                cursor: "pointer",
                display: "block",
                marginTop: 4,
                fontWeight: 600,
              }}
            >
              ✕ Устгах
            </button>
          )}
        </div>
      </div>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        onChange={handle}
        style={{ display: "none" }}
      />
    </div>
  );
}

function LogoDisplay({ logo, size = 56, radius = 12, fallback = "🏢" }) {
  const isImg = logo && (logo.startsWith("data:") || logo.startsWith("http"));
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: "#f1f5f9",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {isImg ? (
        <img
          src={logo}
          alt="logo"
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <span style={{ fontSize: size * 0.6 }}>{logo || fallback}</span>
      )}
    </div>
  );
}

function FormField({ label, value, onChange, placeholder, type = "text" }) {
  const style = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1.5px solid #e2e8f0",
    fontSize: 14,
    fontFamily: "inherit",
    outline: "none",
  };
  return (
    <div style={{ marginBottom: 14 }}>
      {label && (
        <label
          style={{
            display: "block",
            fontWeight: 600,
            marginBottom: 6,
            color: "#374151",
            fontSize: 14,
          }}
        >
          {label}
        </label>
      )}
      {type === "textarea" ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={{ ...style, minHeight: 80, resize: "vertical" }}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={style}
        />
      )}
    </div>
  );
}

function PrimaryBtn({ onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
        color: "#fff",
        padding: "12px 24px",
        borderRadius: 10,
        fontWeight: 700,
        fontSize: 15,
        border: "none",
        transition: "opacity .15s",
      }}
    >
      {children}
    </button>
  );
}