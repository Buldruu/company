# 🏛️ OrgHub Mongolia

Монголын байгууллагуудын нэгдсэн мэдээллийн сан.

## Технологи

- **Frontend**: React 18 + Vite
- **Database**: Firebase Firestore (realtime)
- **Auth**: Firebase Authentication
- **Deploy**: GitHub Pages (автомат CI/CD)

---

## 1. Firebase тохиргоо

### Firebase Console дээр:

1. [console.firebase.google.com](https://console.firebase.google.com) → шинэ project үүсгэх
2. **Authentication** → Sign-in method → **Email/Password** идэвхжүүлэх
3. **Firestore Database** → Create database → **Production mode**
4. **Firestore Rules** дараахийг оруулах:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Users: зөвхөн өөрөө болон admin уншиж/засах
    match /users/{uid} {
      allow read: if request.auth != null && 
        (request.auth.uid == uid || 
         get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin');
      allow write: if request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
      allow create: if request.auth != null && request.auth.uid == uid;
    }
    // Orgs: баталгаажсан нь бүгд харна, засах зөвхөн эзэн болон admin
    match /orgs/{orgId} {
      allow read: if request.auth != null;
      allow create: if request.auth != null;
      allow update, delete: if request.auth != null && 
        (resource.data.ownerId == request.auth.uid ||
         get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin');
    }
  }
}
```

5. **Project Settings** → Your apps → **Web app** нэмэх → Config хуулах

### Эхний Админ үүсгэх:

1. Аппыг нээж, **бүртгүүлэх** хэсгээс шинэ данс үүсгэх
2. Firebase Console → **Firestore** → `users` collection → тухайн user-н document олох
3. `approved: true`, `role: "admin"` гэж засах

---

## 2. GitHub тохиргоо

### Repository Secrets нэмэх:

**Settings → Secrets and variables → Actions → New repository secret**

| Secret нэр | Утга |
|---|---|
| `VITE_FIREBASE_API_KEY` | Firebase config-с |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase config-с |
| `VITE_FIREBASE_PROJECT_ID` | Firebase config-с |
| `VITE_FIREBASE_STORAGE_BUCKET` | Firebase config-с |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase config-с |
| `VITE_FIREBASE_APP_ID` | Firebase config-с |
| `VITE_BASE_PATH` | `/your-repo-name/` (жишээ: `/orghub/`) |

### GitHub Pages идэвхжүүлэх:

**Settings → Pages → Source → GitHub Actions**

---

## 3. Локал ажиллуулах

```bash
# Хуулах
git clone https://github.com/YOUR_USERNAME/orghub.git
cd orghub

# Суулгах
npm install

# .env.local үүсгэх
cp .env.example .env.local
# .env.local файлд Firebase config-оо оруулах

# Ажиллуулах
npm run dev
```

---

## Firestore Collections

| Collection | Талбарууд |
|---|---|
| `users/{uid}` | `name, email, role, approved, createdAt` |
| `orgs/{id}` | `name, logo, tagline, description, categoryId, website, email, phone, address, founded, size, employees[], activities[], approved, ownerId, createdAt` |

---

## Deploy

`main` branch руу push хийхэд автоматаар GitHub Pages-д deploy болно.
