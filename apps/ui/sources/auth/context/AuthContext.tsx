import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { syncSwitchServer } from '@/sync/sync';
import { clearPersistence } from '@/sync/domains/state/persistenceLifecycle';
import { trackLogout } from '@/track';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } from '@/sync/runtime/orchestration/concurrentSessionCache';
import { subscribeAuthCredentialsInvalidation } from '@/sync/runtime/orchestration/authCredentialsInvalidation';
import { fireAndForget } from '@/utils/system/fireAndForget';

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<void>;
    loginWithCredentials: (credentials: AuthCredentials) => Promise<void>;
    logout: () => Promise<void>;
    refreshFromActiveServer: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function resolveActiveServerKey(snapshot: Readonly<{ serverId?: string | null; serverUrl?: string | null }>): string | null {
    const serverId = String(snapshot.serverId ?? '').trim();
    const serverUrl = String(snapshot.serverUrl ?? '').trim();
    if (!serverId && !serverUrl) return null;
    return `${serverId}|${serverUrl}`;
}

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);
    const activeServerKeyRef = React.useRef<string | null>(null);
    const isLoginSyncInFlightRef = React.useRef(false);
    const loginSyncServerKeyRef = React.useRef<string | null>(null);

    const refreshFromActiveServer = React.useCallback(async () => {
        const nextCredentials = await switchConnectionToActiveServer();
        if (!nextCredentials) {
            const activeServerKey = resolveActiveServerKey(getActiveServerSnapshot());
            if (isLoginSyncInFlightRef.current && activeServerKey === loginSyncServerKeyRef.current) return;
            await syncSwitchServer(null);
        }
        setCredentials(nextCredentials);
        setIsAuthenticated(Boolean(nextCredentials));
    }, []);

    const loginWithCredentials = React.useCallback(async (newCredentials: AuthCredentials) => {
        const success = await TokenStorage.setCredentials(newCredentials);
        if (!success) {
            throw new Error('Failed to save credentials');
        }
        setCredentials(newCredentials);
        setIsAuthenticated(true);
        isLoginSyncInFlightRef.current = true;
        loginSyncServerKeyRef.current = resolveActiveServerKey(getActiveServerSnapshot());
        fireAndForget(
            (async () => {
                try {
                    await syncSwitchServer(newCredentials);
                } finally {
                    isLoginSyncInFlightRef.current = false;
                    loginSyncServerKeyRef.current = null;
                    fireAndForget(refreshFromActiveServer(), { tag: 'AuthContext.login.refreshFromActiveServer' });
                }
            })(),
            { tag: 'AuthContext.login.syncSwitchServer' },
        );
    }, [refreshFromActiveServer]);

    const login = React.useCallback(
        async (token: string, secret: string) => {
            const newCredentials: AuthCredentials = { token, secret };
            await loginWithCredentials(newCredentials);
        },
        [loginWithCredentials],
    );

    const logout = React.useCallback(async () => {
        trackLogout();
        clearPersistence();
        await TokenStorage.removeCredentials();
        await syncSwitchServer(null);
        loginSyncServerKeyRef.current = null;
        setCredentials(null);
        setIsAuthenticated(false);
    }, []);

    // Update global auth state when local state changes
    useEffect(() => {
        setCurrentAuth({
            isAuthenticated,
            credentials,
            login,
            loginWithCredentials,
            logout,
            refreshFromActiveServer,
        });
    }, [isAuthenticated, credentials, login, loginWithCredentials, logout, refreshFromActiveServer]);

    useEffect(() => {
        const unsubscribe = subscribeActiveServer((snapshot) => {
            const serverKey = resolveActiveServerKey(snapshot);
            if (activeServerKeyRef.current === serverKey) return;
            activeServerKeyRef.current = serverKey;
            fireAndForget(refreshFromActiveServer(), { tag: 'AuthContext.refreshFromActiveServer' });
        });
        return unsubscribe;
    }, [refreshFromActiveServer]);

    useEffect(() => {
        return subscribeAuthCredentialsInvalidation(() => {
            fireAndForget(refreshFromActiveServer(), {
                tag: 'AuthContext.authCredentialsInvalidated.refreshFromActiveServer',
            });
        });
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
        <AuthContext.Provider
            value={{
                isAuthenticated,
                credentials,
                login,
                loginWithCredentials,
                logout,
                refreshFromActiveServer,
            }}
        >
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
