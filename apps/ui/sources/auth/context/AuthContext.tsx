import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { getCurrentAuth, setCurrentAuth } from './currentAuth';
export { getCurrentAuth, setCurrentAuth } from './currentAuth';
import { readCredentialAuthorityKind, type CredentialAuthorityKind } from './credentialAuthority';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { loadLocalSettings } from '@/sync/domains/state/persistence';
import { forgetPluginAccountAvailabilityArtifacts } from '@/sync/domains/plugins/availability/projection';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { useApplyLocalSettings } from '@/sync/store/settingsWriters';
import { trackLogout } from '@/track';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import {
    areServerProfileIdentifiersEquivalent,
    listServerProfiles,
    resolveServerProfileScopeId,
} from '@/sync/domains/server/serverProfiles';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import {
    disconnectActiveServerConnectionIfCurrent,
    switchConnectionToActiveServer,
} from '@/sync/runtime/orchestration/connectionManager';
import { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } from '@/sync/runtime/orchestration/concurrentSessionCache';
import { subscribeAuthCredentialsInvalidation } from '@/sync/runtime/orchestration/authCredentialsInvalidation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import {
    guardAccountEncryptionFirstKeyCredentialMutation,
    isAccountEncryptionFirstKeyCredentialPersistenceAuthorized,
    type AccountEncryptionFirstKeyCredentialPersistenceOptions,
    type AccountEncryptionFirstKeyRecoveryHandle,
} from '@/sync/ops/account/accountEncryptionFirstKeyExternalAuth';
import { loadExpoPushTokensToUnregister } from '@/sync/domains/state/pushTokenRegistration';
import { unregisterPushTokenForHomeBestEffort } from '@/sync/engine/account/syncAccount';

export type AuthCredentialLifecycleResult =
    | Readonly<{ kind: 'completed' }>
    | Readonly<{
        kind: 'finish_encryption_setup';
        recovery: AccountEncryptionFirstKeyRecoveryHandle;
    }>
    | Readonly<{ kind: 'recovery_failed' }>;

type AuthLogoutOptions = Readonly<{
    beforeMutation?: () => void | Promise<void>;
    scope?: 'focused-home' | 'all-credentials';
}>;

/** The exact Home a credential belongs to: endpoint URL plus stable identity. */
export type HomeCredentialTarget = Readonly<{
    serverUrl: string;
    serverId?: string;
}>;

export type AuthCredentialPersistenceOptions = Readonly<{
        firstKeyRecoveryAuthorization?: AccountEncryptionFirstKeyCredentialPersistenceOptions['firstKeyRecoveryAuthorization'];
        /**
         * The exact Home this credential was issued by, captured before the
         * awaits that produced it. Focus can move to another Home while an
         * external authentication is still resolving, so a targeted write is
         * bound to this Home and never to whichever Home happens to be focused
         * when the token finally arrives.
         */
        target?: HomeCredentialTarget;
        /** Refuse adoption when another Account replaced the captured one. */
        expectedCredentials?: AuthCredentials;
    }>;

export interface AuthContextType {
    isAuthenticated: boolean;
    credentials: AuthCredentials | null;
    credentialAuthorityKind: CredentialAuthorityKind;
    login: (
        token: string,
        secret: string,
        options?: AuthCredentialPersistenceOptions,
    ) => Promise<AuthCredentialLifecycleResult>;
    loginWithCredentials: (
        credentials: AuthCredentials,
        options?: AuthCredentialPersistenceOptions,
    ) => Promise<AuthCredentialLifecycleResult>;
    logout: (
        options?: AuthLogoutOptions,
    ) => Promise<AuthCredentialLifecycleResult>;
    refreshFromActiveServer: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

async function refuseInjectedCredentialMutation(): Promise<AuthCredentialLifecycleResult> {
    throw new Error('Injected credentials are controlled by the embedding host');
}

async function keepInjectedCredential(): Promise<void> {}

/** Bridge-owned credentials use the same auth projection without the Account persistence lifecycle. */
export function InjectedAuthProvider(props: Readonly<{
    credentials: AuthCredentials | null;
    children: ReactNode;
}>) {
    const value = React.useMemo<AuthContextType>(() => ({
        isAuthenticated: props.credentials !== null,
        credentials: props.credentials,
        credentialAuthorityKind: readCredentialAuthorityKind(props.credentials?.token),
        login: refuseInjectedCredentialMutation,
        loginWithCredentials: refuseInjectedCredentialMutation,
        logout: refuseInjectedCredentialMutation,
        refreshFromActiveServer: keepInjectedCredential,
    }), [props.credentials]);
    useEffect(() => {
        setCurrentAuth(value);
        return () => {
            if (getCurrentAuth() === value) setCurrentAuth(null);
        };
    }, [value]);
    return <AuthContext.Provider value={value}>{props.children}</AuthContext.Provider>;
}

function resolveActiveServerKey(snapshot: Readonly<{
    serverId?: string | null;
    serverUrl?: string | null;
    connectionDescriptorRevision?: number;
}>): string | null {
    const serverId = String(snapshot.serverId ?? '').trim();
    const serverUrl = String(snapshot.serverUrl ?? '').trim();
    if (!serverId && !serverUrl) return null;
    return `${serverId}|${serverUrl}|${snapshot.connectionDescriptorRevision ?? 0}`;
}

function isSameServerTarget(
    left: Readonly<{ serverId?: string | null; serverUrl?: string | null }>,
    right: Readonly<{ serverId?: string | null; serverUrl?: string | null }>,
): boolean {
    const leftServerId = String(left.serverId ?? '').trim();
    const rightServerId = String(right.serverId ?? '').trim();
    const leftServerUrl = createServerUrlComparableKey(String(left.serverUrl ?? ''));
    const rightServerUrl = createServerUrlComparableKey(String(right.serverUrl ?? ''));
    if (leftServerId && rightServerId) {
        if (!areServerProfileIdentifiersEquivalent(leftServerId, rightServerId)) {
            return false;
        }
        return !leftServerUrl || !rightServerUrl || leftServerUrl === rightServerUrl;
    }
    return Boolean(
        leftServerUrl
        && leftServerUrl === rightServerUrl,
    );
}

export function AuthProvider({ children, initialCredentials }: { children: ReactNode; initialCredentials: AuthCredentials | null }) {
    const [isAuthenticated, setIsAuthenticated] = useState(!!initialCredentials);
    const [credentials, setCredentials] = useState<AuthCredentials | null>(initialCredentials);
    const credentialAuthorityKind = React.useMemo(() => readCredentialAuthorityKind(credentials?.token), [credentials?.token]);
    const activeServerKeyRef = React.useRef<string | null>(
        resolveActiveServerKey(getActiveServerSnapshot()),
    );
    const isLoginSyncInFlightRef = React.useRef(false);
    const loginSyncServerKeyRef = React.useRef<string | null>(null);
    const applyLocalSettings = useApplyLocalSettings();

    const refreshFromActiveServer = React.useCallback(async () => {
        const nextCredentials = await switchConnectionToActiveServer();
        if (!nextCredentials) {
            const activeServerKey = resolveActiveServerKey(getActiveServerSnapshot());
            if (isLoginSyncInFlightRef.current && activeServerKey === loginSyncServerKeyRef.current) return;
        }
        setCredentials(nextCredentials);
        setIsAuthenticated(Boolean(nextCredentials));
    }, []);

    const loginWithCredentials = React.useCallback(async (
        newCredentials: AuthCredentials,
        options?: AuthCredentialPersistenceOptions,
    ): Promise<AuthCredentialLifecycleResult> => {
        const target = options?.target ?? null;
        if (
            !isAccountEncryptionFirstKeyCredentialPersistenceAuthorized(
                options,
                newCredentials,
            )
        ) {
            const guard =
                await guardAccountEncryptionFirstKeyCredentialMutation(
                    target
                        ? {
                            serverUrl: target.serverUrl,
                            ...(target.serverId
                                ? { serverId: target.serverId }
                                : {}),
                        }
                        : undefined,
                );
            if (guard.kind !== 'allowed') {
                return guard;
            }
        }
        // An explicit target writes through the endpoint-scoped setter, which
        // fails closed when the stable identity no longer owns that URL. Only a
        // caller with no exact target left (legacy focused-Home login) resolves
        // the focused server at write time.
        const success = target
            ? await TokenStorage.setCredentialsForServerUrl(
                target.serverUrl,
                {
                    ...(target.serverId ? { serverId: target.serverId } : {}),
                    ...(options?.expectedCredentials ? { expectedCredentials: options.expectedCredentials } : {}),
                },
                newCredentials,
            )
            : await TokenStorage.setCredentials(newCredentials);
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
        if (target && !isSameServerTarget(target, getActiveServerSnapshot())) {
            // The credential belongs to a Home that is no longer focused. It is
            // persisted there; publishing it as the focused runtime's auth state
            // would attribute one Home's bearer to another.
            return { kind: 'completed' };
        }
        if (target) {
            // Focused-Home persistence clears auth auto-redirect suppression;
            // the endpoint-scoped setter deliberately leaves that active-scoped
            // fact alone because it also serves non-focused Homes.
            await TokenStorage.setAuthAutoRedirectSuppressedUntil(0);
            // Focus can change while suppression persistence is in flight. Do
            // not publish this Home's credentials into the newly focused
            // runtime after that await.
            if (!isSameServerTarget(target, getActiveServerSnapshot())) {
                return { kind: 'completed' };
            }
        }
        setCredentials(newCredentials);
        setIsAuthenticated(true);
        isLoginSyncInFlightRef.current = true;
        loginSyncServerKeyRef.current = resolveActiveServerKey(getActiveServerSnapshot());
        fireAndForget(
            (async () => {
                try {
                    // TokenStorage is already authoritative. Reuse the one
                    // active-connection owner so an Iroh-only Home publishes a
                    // verified runtime origin before Sync initializes/switches.
                    await switchConnectionToActiveServer();
                } finally {
                    isLoginSyncInFlightRef.current = false;
                    loginSyncServerKeyRef.current = null;
                }
            })(),
            { tag: 'AuthContext.login.switchConnectionToActiveServer' },
        );
        return { kind: 'completed' };
    }, [applyLocalSettings, refreshFromActiveServer]);

    const login = React.useCallback(
        async (
            token: string,
            secret: string,
            options?: AuthCredentialPersistenceOptions,
        ) => {
            const newCredentials: AuthCredentials = { token, secret };
            return await loginWithCredentials(newCredentials, options);
        },
        [loginWithCredentials],
    );

    const logout = React.useCallback(async (
        options?: AuthLogoutOptions,
    ): Promise<AuthCredentialLifecycleResult> => {
        const activeServer = getActiveServerSnapshot();
        const activeServerId = String(activeServer.serverId ?? '').trim();
        const activeServerUrl = String(activeServer.serverUrl ?? '').trim();
        const forgottenScope = getActiveServerAccountScope();
        // PA-CUSTODY1 guards the credential this logout destroys: a focused logout
        // removes only the active Home's credential, so only that Home's retained
        // first-key custody blocks it; forgetting every credential (or a logout
        // with no addressable active Home) stays guarded by custody on any Home.
        const guard =
            await guardAccountEncryptionFirstKeyCredentialMutation(
                options?.scope === 'all-credentials' || !activeServerUrl
                    ? undefined
                    : {
                        serverUrl: activeServerUrl,
                        ...(activeServerId ? { serverId: activeServerId } : {}),
                    },
            );
        if (guard.kind !== 'allowed') {
            return guard;
        }
        await options?.beforeMutation?.();
        if (options?.scope === 'all-credentials') {
            const pushTokens = loadExpoPushTokensToUnregister();
            const pushCleanupTargets: Array<Parameters<typeof unregisterPushTokenForHomeBestEffort>[0]> = [];
            for (const profile of listServerProfiles()) {
                const profileCredentials = await TokenStorage
                    .getCredentialsForServerUrl(profile.serverUrl, {
                        serverId: resolveServerProfileScopeId(profile),
                    })
                    .catch(() => null);
                if (!profileCredentials) continue;
                for (const pushToken of pushTokens) {
                    pushCleanupTargets.push({
                        credentials: profileCredentials,
                        token: pushToken,
                        serverUrl: profile.serverUrl,
                        profile,
                    });
                }
            }

            const credentialsRemoved = await TokenStorage.removeCredentials();
            const accountDirectoryCredentialsRemoved =
                await TokenStorage.accountDirectoryAuthCredentials.clear();
            const pendingAccountDirectoryAuthRemoved =
                await TokenStorage.clearPendingAccountDirectoryAuth();
            if (
                !credentialsRemoved
                || !accountDirectoryCredentialsRemoved
                || !pendingAccountDirectoryAuthRemoved
            ) {
                throw new Error('Failed to remove all local credentials');
            }

            trackLogout();
            if (forgottenScope) {
                forgetPluginAccountAvailabilityArtifacts(forgottenScope);
            }
            loginSyncServerKeyRef.current = null;
            setCredentials(null);
            setIsAuthenticated(false);
            const cleanup = Promise.allSettled(
                pushCleanupTargets.map(async (target) =>
                    await unregisterPushTokenForHomeBestEffort(target)),
            );
            await switchConnectionToActiveServer();
            fireAndForget(cleanup, { tag: 'AuthContext.logout.unregisterAllPushTokens' });
            return { kind: 'completed' };
        }

        let activeCredentials: AuthCredentials | null = credentials;
        if (activeServerUrl) {
            try {
                activeCredentials = await TokenStorage.getCredentialsForServerUrl(activeServerUrl, {
                    serverId: activeServerId || undefined,
                }) ?? credentials;
            } catch {
                activeCredentials = credentials;
            }
        }
        const activeProfile = activeServerUrl && activeCredentials
            ? listServerProfiles().find((profile) => (
                areServerProfileIdentifiersEquivalent(resolveServerProfileScopeId(profile), activeServerId)
            ))
            : undefined;
        const pushCleanupTargets = activeServerUrl && activeCredentials
            ? loadExpoPushTokensToUnregister().map((pushToken) => ({
                    credentials: activeCredentials,
                    token: pushToken,
                    serverUrl: activeServerUrl,
                    ...(activeProfile ? { profile: activeProfile } : {}),
                }))
            : [];
        trackLogout();
        // Signing out forgets this Account on this device, so its Artifact
        // bytes are deleted as well as retired. An Account switch or
        // deactivation deliberately does not: it retires reachability and
        // leaves the Account-qualified bytes inert and reusable.
        if (forgottenScope) forgetPluginAccountAvailabilityArtifacts(forgottenScope);
        // Home logout is scoped to the focused Home. Device-global Home-view
        // persistence, other Home credentials, and Account Service credentials
        // remain intact; only an explicit global-forget flow may clear them.
        if (activeServerUrl) {
            const removed = await TokenStorage.removeCredentialsForServerUrl(activeServerUrl, {
                serverId: activeServerId || undefined,
            });
            if (!removed) {
                throw new Error('Failed to remove active Home credentials');
            }
        }
        const shouldClearFocusedAuth = (
            (!activeServerId && !activeServerUrl)
            || isSameServerTarget(activeServer, getActiveServerSnapshot())
        );
        if (shouldClearFocusedAuth) {
            loginSyncServerKeyRef.current = null;
            setCredentials(null);
            setIsAuthenticated(false);
        }
        const cleanup = Promise.allSettled(
            pushCleanupTargets.map(async (target) =>
                await unregisterPushTokenForHomeBestEffort(target)),
        );
        if (shouldClearFocusedAuth) {
            await switchConnectionToActiveServer();
        }
        fireAndForget(cleanup, { tag: 'AuthContext.logout.unregisterPushToken' });
        return { kind: 'completed' };
    }, [credentials]);

    // Single source of truth for the context value so consumers (and the non-React
    // `getCurrentAuth()` bridge) share one identity-stable object. Without this memo the
    // provider hands every consumer a fresh object on each render, re-rendering all ~50
    // `useAuth()` callers — including the root layout Stack subtree — on unrelated renders.
    const value = React.useMemo<AuthContextType>(() => ({
        isAuthenticated,
        credentials,
        credentialAuthorityKind,
        login,
        loginWithCredentials,
        logout,
        refreshFromActiveServer,
    }), [isAuthenticated, credentials, credentialAuthorityKind, login, loginWithCredentials, logout, refreshFromActiveServer]);

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
                    const disconnected = await disconnectActiveServerConnectionIfCurrent({
                        serverId: event.serverId,
                        serverUrl: event.serverUrl,
                        ...(event.generation === undefined ? {} : { generation: event.generation }),
                    });
                    if (!disconnected) return;
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

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

/** Mount after supplied-Home admission, independently of the focused Home's auth. */
export function ConcurrentSessionCacheRuntime({ children }: { children: ReactNode }) {
    useEffect(() => {
        startConcurrentSessionCacheSync();
        return () => {
            stopConcurrentSessionCacheSync();
        };
    }, []);

    return <>{children}</>;
}

export function useOptionalAuth(): AuthContextType | null {
    return useContext(AuthContext) ?? null;
}

export function useAuth() {
    const context = useContext(AuthContext);
    if (context === undefined) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
