import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { syncSwitchServer } from '@/sync/sync';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { loadLocalSettings, saveLocalSettings } from '@/sync/domains/state/persistence';
import { clearPersistence } from '@/sync/domains/state/persistenceLifecycle';
import { forgetPluginAccountAvailabilityArtifacts } from '@/sync/domains/plugins/availability/projection';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { trackLogout } from '@/track';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } from '@/sync/runtime/orchestration/concurrentSessionCache';
import { subscribeAuthCredentialsInvalidation } from '@/sync/runtime/orchestration/authCredentialsInvalidation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    guardAccountEncryptionFirstKeyCredentialMutation,
    isAccountEncryptionFirstKeyCredentialPersistenceAuthorized,
    type AccountEncryptionFirstKeyCredentialPersistenceOptions,
    type AccountEncryptionFirstKeyRecoveryHandle,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';

export type AuthCredentialLifecycleResult =
    | Readonly<{ kind: 'completed' }>
    | Readonly<{
        kind: 'finish_encryption_setup';
        recovery: AccountEncryptionFirstKeyRecoveryHandle;
    }>
    | Readonly<{ kind: 'recovery_failed' }>;

type AuthLogoutOptions = Readonly<{
    beforeMutation?: () => void | Promise<void>;
}>;

interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    login: (token: string, secret: string) => Promise<AuthCredentialLifecycleResult>;
    loginWithCredentials: (
        credentials: AuthCredentials,
        options?: AccountEncryptionFirstKeyCredentialPersistenceOptions,
    ) => Promise<AuthCredentialLifecycleResult>;
    logout: (
        options?: AuthLogoutOptions,
    ) => Promise<AuthCredentialLifecycleResult>;
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
    const applyLocalSettings = useApplyLocalSettings();

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

    const loginWithCredentials = React.useCallback(async (
        newCredentials: AuthCredentials,
        options?: AccountEncryptionFirstKeyCredentialPersistenceOptions,
    ): Promise<AuthCredentialLifecycleResult> => {
        if (
            !isAccountEncryptionFirstKeyCredentialPersistenceAuthorized(
                options,
                newCredentials,
            )
        ) {
            const guard =
                await guardAccountEncryptionFirstKeyCredentialMutation();
            if (guard.kind !== 'allowed') {
                return guard;
            }
        }
        const success = await TokenStorage.setCredentials(newCredentials);
        if (!success) {
            throw new Error('Failed to save credentials');
        }
        // Mark this device as one where the user has authenticated at least once.
        // We persist this through the store (not raw saveLocalSettings) so the
        // in-memory Zustand `localSettings` slice — which survives logout because
        // clearPersistence only wipes MMKV — also reflects the flag. The welcome
        // screen reads it via useLocalSetting('hasCompletedAuthOnce') to swap to
        // the warmer "Good to have you back" copy on subsequent visits.
        if (!loadLocalSettings().hasCompletedAuthOnce) {
            applyLocalSettings({ hasCompletedAuthOnce: true });
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
        return { kind: 'completed' };
    }, [applyLocalSettings, refreshFromActiveServer]);

    const login = React.useCallback(
        async (
            token: string,
            secret: string,
        ) => {
            const newCredentials: AuthCredentials = { token, secret };
            return await loginWithCredentials(newCredentials);
        },
        [loginWithCredentials],
    );

    const logout = React.useCallback(async (
        options?: AuthLogoutOptions,
    ): Promise<AuthCredentialLifecycleResult> => {
        const guard =
            await guardAccountEncryptionFirstKeyCredentialMutation();
        if (guard.kind !== 'allowed') {
            return guard;
        }
        await options?.beforeMutation?.();
        trackLogout();
        // Signing out forgets this Account on this device, so its Artifact
        // bytes are deleted as well as retired. An Account switch or
        // deactivation deliberately does not: it retires reachability and
        // leaves the Account-qualified bytes inert and reusable.
        const forgottenScope = getActiveServerAccountScope();
        if (forgottenScope) forgetPluginAccountAvailabilityArtifacts(forgottenScope);
        // Preserve device-local flags across logout — the user is signing out of
        // an account but the device itself has still seen the brand hero and
        // still has prior auth experience. Clearing these would force returning
        // users back into the first-time welcome copy after every logout.
        const { brandHeroSeenAt, hasCompletedAuthOnce } = loadLocalSettings();
        clearPersistence();
        if (brandHeroSeenAt != null || hasCompletedAuthOnce) {
            saveLocalSettings({
                ...localSettingsDefaults,
                brandHeroSeenAt,
                hasCompletedAuthOnce,
            });
        }
        await TokenStorage.removeCredentials();
        await syncSwitchServer(null);
        loginSyncServerKeyRef.current = null;
        setCredentials(null);
        setIsAuthenticated(false);
        return { kind: 'completed' };
    }, []);

    // Single source of truth for the context value so consumers (and the non-React
    // `getCurrentAuth()` bridge) share one identity-stable object. Without this memo the
    // provider hands every consumer a fresh object on each render, re-rendering all ~50
    // `useAuth()` callers — including the root layout Stack subtree — on unrelated renders.
    const value = React.useMemo<AuthContextType>(() => ({
        isAuthenticated,
        credentials,
        login,
        loginWithCredentials,
        logout,
        refreshFromActiveServer,
    }), [isAuthenticated, credentials, login, loginWithCredentials, logout, refreshFromActiveServer]);

    // Update global auth state when local state changes
    useEffect(() => {
        setCurrentAuth(value);
    }, [value]);

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
        return subscribeAuthCredentialsInvalidation((event) => {
            if (
                event.kind
                === 'first_key_recovery_required'
            ) {
                fireAndForget((async () => {
                    await syncSwitchServer(null);
                    loginSyncServerKeyRef.current = null;
                    setCredentials(null);
                    setIsAuthenticated(false);
                })(), {
                    tag: 'AuthContext.authCredentialsInvalidated.firstKeyRecovery',
                });
                return;
            }
            fireAndForget(refreshFromActiveServer(), {
                tag: 'AuthContext.authCredentialsInvalidated.refreshFromActiveServer',
            });
        });
    }, [refreshFromActiveServer]);

    // Secondary Home projections own their credentials and lifecycle. They must
    // remain reconcilable even when the focused Home is signed out or expired;
    // the concurrent runtime localizes auth failures per Home. Keep one global
    // start/stop lifecycle tied to the provider rather than focused auth state.
    useEffect(() => {
        startConcurrentSessionCacheSync();
        return () => {
            stopConcurrentSessionCacheSync();
        };
    }, []);

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
