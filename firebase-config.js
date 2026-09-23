/**
 * Firebase Configuration and Cloud Sync Adapter for SSC Practice Platform
 * Supports:
 * - Google Sign-In (One-Click)
 * - Email / Password Sign-In & Sign-Up
 * - Firestore Cloud Database for real-time progress, set mastery, and activity syncing
 * - Offline / LocalStorage transparent fallback
 */

const CloudDB = {
    // Placeholder config. In public repositories, configure credentials via in-app Cloud Settings modal (saved in browser localStorage)
    defaultConfig: {
        apiKey: "",
        authDomain: "",
        projectId: "",
        storageBucket: "",
        messagingSenderId: "",
        appId: ""
    },

    STORAGE_KEY_CONFIG: "ssc_cgl_firebase_config_v1",
    app: null,
    auth: null,
    db: null,
    currentUser: null,
    syncStatus: "disconnected", // 'connected', 'syncing', 'offline', 'disconnected'
    listeners: [],

    getConfig() {
        try {
            const saved = localStorage.getItem(this.STORAGE_KEY_CONFIG);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed && parsed.apiKey && parsed.projectId) {
                    return parsed;
                }
            }
        } catch (e) {}

        if (this.defaultConfig.apiKey && this.defaultConfig.projectId) {
            return this.defaultConfig;
        }
        return null;
    },

    saveConfig(cfg) {
        if (!cfg || !cfg.apiKey || !cfg.projectId) {
            throw new Error("Invalid Firebase configuration. 'apiKey' and 'projectId' are required.");
        }
        localStorage.setItem(this.STORAGE_KEY_CONFIG, JSON.stringify(cfg));
        return this.init();
    },

    clearConfig() {
        localStorage.removeItem(this.STORAGE_KEY_CONFIG);
        if (this.auth) {
            try { this.auth.signOut(); } catch (e) {}
        }
        this.app = null;
        this.auth = null;
        this.db = null;
        this.currentUser = null;
        this.syncStatus = "disconnected";
        this.notifyStatus();
    },

    isConfigured() {
        return !!this.getConfig();
    },

    init() {
        const config = this.getConfig();
        if (!config || !window.firebase) {
            this.syncStatus = "disconnected";
            this.notifyStatus();
            return false;
        }

        try {
            if (!firebase.apps || firebase.apps.length === 0) {
                this.app = firebase.initializeApp(config);
            } else {
                this.app = firebase.app();
            }

            this.auth = firebase.auth();
            this.db = firebase.firestore();

            // Enable offline persistence in Firestore if possible
            this.db.enablePersistence({ synchronizeTabs: true }).catch(err => {
                if (err.code === 'failed-precondition') {
                    // Multiple tabs open, persistence can only be enabled in one tab at a time.
                } else if (err.code === 'unimplemented') {
                    // Current browser doesn't support persistence
                }
            });

            this.syncStatus = "connected";
            this.notifyStatus();

            // Setup auth state observer
            this.auth.onAuthStateChanged(async (firebaseUser) => {
                this.currentUser = firebaseUser;
                this.syncStatus = firebaseUser ? "connected" : "connected";
                this.notifyStatus();

                if (window.onCloudAuthStateChanged) {
                    window.onCloudAuthStateChanged(firebaseUser);
                }
            });

            return true;
        } catch (error) {
            console.error("Firebase initialization failed:", error);
            this.syncStatus = "offline";
            this.notifyStatus();
            return false;
        }
    },

    onStatusChange(callback) {
        if (typeof callback === "function") {
            this.listeners.push(callback);
            callback(this.syncStatus, this.currentUser);
        }
    },

    notifyStatus() {
        this.listeners.forEach(cb => {
            try { cb(this.syncStatus, this.currentUser); } catch (e) {}
        });
    },

    async signInWithGoogle() {
        if (!this.auth) {
            throw new Error("Firebase is not configured. Please add your Firebase configuration first.");
        }
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        try {
            this.syncStatus = "syncing";
            this.notifyStatus();
            const result = await this.auth.signInWithPopup(provider);
            this.syncStatus = "connected";
            this.notifyStatus();
            return result.user;
        } catch (err) {
            this.syncStatus = "connected";
            this.notifyStatus();
            throw err;
        }
    },

    async signInWithEmail(email, password) {
        if (!this.auth) {
            throw new Error("Firebase is not configured. Please add your Firebase configuration first.");
        }
        this.syncStatus = "syncing";
        this.notifyStatus();
        try {
            const res = await this.auth.signInWithEmailAndPassword(email, password);
            this.syncStatus = "connected";
            this.notifyStatus();
            return res.user;
        } catch (err) {
            this.syncStatus = "connected";
            this.notifyStatus();
            throw err;
        }
    },

    async signUpWithEmail(email, password, displayName = "") {
        if (!this.auth) {
            throw new Error("Firebase is not configured. Please add your Firebase configuration first.");
        }
        this.syncStatus = "syncing";
        this.notifyStatus();
        try {
            const res = await this.auth.createUserWithEmailAndPassword(email, password);
            if (displayName && res.user) {
                await res.user.updateProfile({ displayName });
            }
            this.syncStatus = "connected";
            this.notifyStatus();
            return res.user;
        } catch (err) {
            this.syncStatus = "connected";
            this.notifyStatus();
            throw err;
        }
    },

    async signOut() {
        if (this.auth) {
            await this.auth.signOut();
            this.currentUser = null;
            this.syncStatus = "connected";
            this.notifyStatus();
        }
    },

    // Save full user state (progress, sets, activity log) to Firestore
    async syncUserToCloud(userData) {
        if (!this.db || !this.currentUser || !userData) return false;
        try {
            this.syncStatus = "syncing";
            this.notifyStatus();

            const docRef = this.db.collection("users").doc(this.currentUser.uid);
            const payload = {
                id: this.currentUser.uid,
                email: this.currentUser.email || "",
                name: userData.name || this.currentUser.displayName || "Aspirant",
                avatar: userData.avatar || "👑",
                targetExam: userData.targetExam || "SSC CGL 2024/25",
                setsProgress: userData.setsProgress || {},
                activityLog: userData.activityLog || [],
                lastSyncedAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            await docRef.set(payload, { merge: true });
            this.syncStatus = "connected";
            this.notifyStatus();
            return true;
        } catch (error) {
            console.error("Failed to sync user data to Cloud Firestore:", error);
            this.syncStatus = "offline";
            this.notifyStatus();
            return false;
        }
    },

    // Load user state from Firestore
    async loadUserFromCloud(uid) {
        if (!this.db) return null;
        const targetUid = uid || (this.currentUser ? this.currentUser.uid : null);
        if (!targetUid) return null;

        try {
            this.syncStatus = "syncing";
            this.notifyStatus();

            const docRef = this.db.collection("users").doc(targetUid);
            const snap = await docRef.get();
            this.syncStatus = "connected";
            this.notifyStatus();

            if (snap.exists) {
                return snap.data();
            }
            return null;
        } catch (error) {
            console.error("Failed to load user data from Cloud Firestore:", error);
            this.syncStatus = "offline";
            this.notifyStatus();
            return null;
        }
    }
};

// Auto initialize when window finishes loading
window.addEventListener("DOMContentLoaded", () => {
    CloudDB.init();
});
