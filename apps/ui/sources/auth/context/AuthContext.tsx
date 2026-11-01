import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { syncSwitchServer } from '@/sync/sync';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { clearPersistence, loadLocalSettings, saveLocalSettings } from '@/sync/domains/state/persistence';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { trackLogout } from '@/track';
import { subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } from '@/sync/runtime/orchestration/concurrentSessionCache';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { storage } from '@/sync/domains/state/storageStore';
import { parseToken } from '@/utils/auth/parseToken';

interface AuthContextType {
    isAuthenticated: boolean;
    /**
     * Authentication completed during this app run (a login, not credentials restored at
     * launch). Ephemeral by design: it is the one entry-context fact desktop setup reads to
     * decide whether unresolved local facts already show the Home's checking panel (R14/R11).
     */
    authenticatedThisRun: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<void>;
    loginWithCredentials: (credentials: AuthCredentials) => Promise<void>;
    logout: () => Promise<void>;
    refreshFromActiveServer: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [authenticatedThisRun, setAuthenticatedThisRun] = useState(false);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);
    const activeServerKeyRef = React.useRef<string | null>(null);
    const applyLocalSettings = useApplyLocalSettings();

    const loginWithCredentials = React.useCallback(async (newCredentials: AuthCredentials) => {
        let resetPendingArchives = false;
        if (credentials) {
            try {
                resetPendingArchives = parseToken(credentials.token) !== parseToken(newCredentials.token);
            } catch {
                console.warn('AuthContext.loginWithCredentials: invalid token while comparing account identities');
                resetPendingArchives = true;
            }
        }
        const success = await TokenStorage.setCredentials(newCredentials);
        if (!success) {
            throw new Error('Failed to save credentials');
        }
        if (resetPendingArchives) {
            storage.setState({ sessionArchiveOperations: {} });
        }
        // Mark this device as one where the user has authenticated at least once.
        // We persist this through the store (not raw saveLocalSettings) so the
        // in-memory Zustand `localSettings` slice — which survives logout because
        // clearPersistence only wipes persisted values — also reflects the flag. The welcome
        // screen reads it via useLocalSetting('hasCompletedAuthOnce') to swap to
        // the warmer "Good to have you back" copy on subsequent visits.
        if (!loadLocalSettings().hasCompletedAuthOnce) {
            applyLocalSettings({ hasCompletedAuthOnce: true });
        }
        setCredentials(newCredentials);
        setIsAuthenticated(true);
        setAuthenticatedThisRun(true);
        await syncSwitchServer(newCredentials);
    }, [applyLocalSettings, credentials]);

    const login = React.useCallback(
        async (token: string, secret: string) => {
            const newCredentials: AuthCredentials = { token, secret };
            await loginWithCredentials(newCredentials);
        },
        [loginWithCredentials],
    );

    const logout = React.useCallback(async () => {
        trackLogout();
        storage.setState({ sessionArchiveOperations: {} });
        // Preserve device-local flags across logout — the user is signing out of
        // an account but the device itself has still seen the brand hero and
        // still has prior auth experience. Clearing these would force returning
        // users back into the first-time welcome copy after every logout.
        const { brandHeroSeenAt, hasCompletedAuthOnce } = loadLocalSettings();
        await clearPersistence();
        if (brandHeroSeenAt != null || hasCompletedAuthOnce) {
            saveLocalSettings({
                ...localSettingsDefaults,
                brandHeroSeenAt,
                hasCompletedAuthOnce,
            });
        }
        await TokenStorage.removeCredentials();
        await syncSwitchServer(null);
        setCredentials(null);
        setIsAuthenticated(false);
    }, []);

    const refreshFromActiveServer = React.useCallback(async () => {
        const nextCredentials = await switchConnectionToActiveServer();
        setCredentials(nextCredentials);
        setIsAuthenticated(Boolean(nextCredentials));
    }, []);

    // Single source of truth for the context value so consumers (and the non-React
    // `getCurrentAuth()` bridge) share one identity-stable object. Without this memo the
    // provider hands every consumer a fresh object on each render, re-rendering all ~50
    // `useAuth()` callers — including the root layout Stack subtree — on unrelated renders.
    const value = React.useMemo<AuthContextType>(() => ({
        isAuthenticated,
        authenticatedThisRun,
        credentials,
        login,
        loginWithCredentials,
        logout,
        refreshFromActiveServer,
    }), [isAuthenticated, authenticatedThisRun, credentials, login, loginWithCredentials, logout, refreshFromActiveServer]);

    // Update global auth state when local state changes
    useEffect(() => {
        setCurrentAuth(value);
    }, [value]);

    useEffect(() => {
        const unsubscribe = subscribeActiveServer((snapshot) => {
            const serverKey = `${snapshot.serverId}|${snapshot.serverUrl}`;
            if (activeServerKeyRef.current === serverKey) return;
            activeServerKeyRef.current = serverKey;
            fireAndForget(refreshFromActiveServer(), { tag: 'AuthContext.refreshFromActiveServer' });
        });
        return unsubscribe;
    }, [refreshFromActiveServer]);

    useEffect(() => {
        if (!isAuthenticated) {
            stopConcurrentSessionCacheSync();
            return;
        }
        startConcurrentSessionCacheSync();
        return () => {
            stopConcurrentSessionCacheSync();
        };
    }, [isAuthenticated]);

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}

// Helper to get current auth state for non-React contexts
let currentAuthState: AuthContextType | null = null;

export function setCurrentAuth(auth: AuthContextType | null) {
    currentAuthState = auth;
}

export function getCurrentAuth(): AuthContextType | null {
    return currentAuthState;
}
