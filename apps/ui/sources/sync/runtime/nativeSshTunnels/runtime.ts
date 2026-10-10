import {
    createNativeSshTunnelAdapter,
    type NativeSshTunnelAuthPromptResolver,
    type NativeSshTunnelHostKeyPromptResolver,
    type NativeSshTunnelCredentialResolution,
} from './adapter';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isRuntimeActive } from '@/utils/runtime/isRuntimeActive';
import { createNativeSshTunnelSupervisor } from './supervisor';
import type {
    NativeSshCredentialsRef,
    NativeSshTunnelLease,
    NativeSshTunnelRequest,
    NativeSshTunnelSnapshot,
    NativeSshTunnelSupervisor,
} from './types';

export type NativeSshTunnelRuntime = NativeSshTunnelSupervisor & Readonly<{
    subscribe: (listener: () => void) => () => void;
}>;

type RuntimeFactoryParams = Readonly<{
    createSupervisor?: () => NativeSshTunnelSupervisor;
}>;

const credentialResolutionsByRefKey = new Map<string, NativeSshTunnelCredentialResolution>();
let singletonRuntime: NativeSshTunnelRuntime | null = null;
let hostKeyPromptResolver: NativeSshTunnelHostKeyPromptResolver | null = null;
let authPromptResolver: NativeSshTunnelAuthPromptResolver | null = null;
let accountLifetimeBinding: Readonly<{ lifetime: ActiveServerAccountScopeLifetime; dispose(): void }> | null = null;

function bindNativeSshAccountLifetime(): void {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime || accountLifetimeBinding?.lifetime === lifetime) return;
    accountLifetimeBinding?.dispose();
    const retirement = lifetime.onRetire(() => {
        accountLifetimeBinding = null;
        // Withdraw material before asynchronous OS disposal. The incumbent
        // wrapper keeps its listeners and resets only its resource supervisor.
        credentialResolutionsByRefKey.clear();
        fireAndForget(singletonRuntime?.dispose(), { tag: 'NativeSshTunnelRuntime.retireAccount' });
    });
    accountLifetimeBinding = { lifetime, dispose: () => retirement.dispose() };
}

function buildCredentialRefKey(credentialsRef: NativeSshCredentialsRef): string {
    return JSON.stringify({
        remoteHostId: credentialsRef.remoteHostId,
        credentialId: credentialsRef.credentialId,
        storage: credentialsRef.storage,
    });
}

function createDefaultSupervisor(): NativeSshTunnelSupervisor {
    return createNativeSshTunnelSupervisor({
        adapter: createNativeSshTunnelAdapter({
            promptHostKey: async (event, request) => {
                if (!hostKeyPromptResolver) {
                    return {
                        decision: 'reject',
                        reason: 'Native SSH tunnel host-key prompt was not handled.',
                    };
                }
                return await hostKeyPromptResolver(event, request);
            },
            promptAuth: async (event, request) => {
                if (!authPromptResolver) {
                    return {
                        decision: 'cancel',
                        reason: 'Native SSH tunnel authentication prompt was not handled.',
                    };
                }
                return await authPromptResolver(event, request);
            },
            resolveCredentials: async (credentialsRef) => {
                const credentials = readNativeSshTunnelCredentialResolution(credentialsRef);
                if (!credentials) {
                    throw new Error('native_ssh_tunnel_missing_credentials');
                }
                return credentials;
            },
        }),
    });
}

export function setNativeSshTunnelCredentialResolution(
    credentialsRef: NativeSshCredentialsRef,
    credentials: NativeSshTunnelCredentialResolution,
): void {
    bindNativeSshAccountLifetime();
    credentialResolutionsByRefKey.set(buildCredentialRefKey(credentialsRef), credentials);
}

export function readNativeSshTunnelCredentialResolution(
    credentialsRef: NativeSshCredentialsRef,
): NativeSshTunnelCredentialResolution | null {
    return credentialResolutionsByRefKey.get(buildCredentialRefKey(credentialsRef)) ?? null;
}

export function setNativeSshTunnelHostKeyPromptResolver(
    resolver: NativeSshTunnelHostKeyPromptResolver | null,
): void {
    hostKeyPromptResolver = resolver;
}

export function setNativeSshTunnelAuthPromptResolver(
    resolver: NativeSshTunnelAuthPromptResolver | null,
): void {
    authPromptResolver = resolver;
}

function clearNativeSshTunnelCredentialResolution(credentialsRef: NativeSshCredentialsRef): void {
    credentialResolutionsByRefKey.delete(buildCredentialRefKey(credentialsRef));
}

export function createNativeSshTunnelRuntime(params: Readonly<{
    supervisor: NativeSshTunnelSupervisor;
    createSupervisor?: () => NativeSshTunnelSupervisor;
}>): NativeSshTunnelRuntime {
    const listeners = new Set<() => void>();
    const credentialRefsByLeaseId = new Map<string, Map<string, NativeSshCredentialsRef>>();
    let suspended = false;
    let supervisor = params.supervisor;
    let withdrawn = false;
    let disposal: Promise<void> | null = null;

    function notify(): void {
        for (const listener of [...listeners]) {
            listener();
        }
    }

    function ownsCredentialCleanup(owningSupervisor: NativeSshTunnelSupervisor,
        owningLifetime: ActiveServerAccountScopeLifetime | undefined): boolean {
        return !withdrawn && owningSupervisor === supervisor && (!owningLifetime || owningLifetime.isCurrent());
    }

    function dispose(): Promise<void> {
        if (disposal) return disposal;
        withdrawn = true;
        for (const refs of credentialRefsByLeaseId.values()) {
            for (const credentialsRef of refs.values()) clearNativeSshTunnelCredentialResolution(credentialsRef);
        }
        credentialRefsByLeaseId.clear();
        const retiredSupervisor = supervisor;
        disposal = (async () => {
            // This existing owner closes start admission synchronously, waits
            // for its accepted starts, and stops their exact native handles.
            await retiredSupervisor.dispose();
            if (params.createSupervisor) {
                supervisor = params.createSupervisor();
                if (suspended) supervisor.markSuspended();
                withdrawn = false;
            }
            notify();
        })().finally(() => { disposal = null; });
        notify();
        return disposal;
    }

    return {
        async ensureTunnel(request: NativeSshTunnelRequest): Promise<NativeSshTunnelLease> {
            if (withdrawn) throw new Error('native_ssh_tunnel_account_retired');
            if (suspended) {
                throw new Error('native_ssh_tunnel_suspended');
            }
            const admittedSupervisor = supervisor;
            const admittedLifetime = accountLifetimeBinding?.lifetime;
            try {
                const lease = await admittedSupervisor.ensureTunnel(request);
                if (withdrawn || admittedSupervisor !== supervisor) throw new Error('native_ssh_tunnel_account_retired');
                const refs = credentialRefsByLeaseId.get(lease.leaseId) ?? new Map<string, NativeSshCredentialsRef>();
                refs.set(buildCredentialRefKey(request.credentialsRef), request.credentialsRef);
                credentialRefsByLeaseId.set(lease.leaseId, refs);
                return lease;
            } catch (error) {
                if (ownsCredentialCleanup(admittedSupervisor, admittedLifetime)) {
                    clearNativeSshTunnelCredentialResolution(request.credentialsRef);
                }
                throw error;
            } finally {
                notify();
            }
        },
        listTunnels(): NativeSshTunnelSnapshot {
            const snapshot = supervisor.listTunnels();
            return withdrawn ? { ...snapshot, leases: [] } : snapshot;
        },
        async releaseTunnel(leaseId: string): Promise<void> {
            const credentialsRefs = credentialRefsByLeaseId.get(leaseId);
            const releasingSupervisor = supervisor;
            const releasingLifetime = accountLifetimeBinding?.lifetime;
            try {
                await releasingSupervisor.releaseTunnel(leaseId);
                if (!ownsCredentialCleanup(releasingSupervisor, releasingLifetime)) return;
                const leaseStillRetained = releasingSupervisor.listTunnels().leases
                    .some((lease) => lease.leaseId === leaseId);
                if (credentialsRefs && !leaseStillRetained) {
                    for (const credentialsRef of credentialsRefs.values()) {
                        clearNativeSshTunnelCredentialResolution(credentialsRef);
                    }
                    credentialRefsByLeaseId.delete(leaseId);
                }
            } catch (error) {
                if (credentialsRefs && ownsCredentialCleanup(releasingSupervisor, releasingLifetime)) {
                    for (const credentialsRef of credentialsRefs.values()) {
                        clearNativeSshTunnelCredentialResolution(credentialsRef);
                    }
                    credentialRefsByLeaseId.delete(leaseId);
                }
                throw error;
            } finally {
                notify();
            }
        },
        markSuspended(): void {
            suspended = true;
            supervisor.markSuspended();
            notify();
        },
        async markForeground(): Promise<void> {
            try {
                suspended = false;
                if (!withdrawn) await supervisor.markForeground();
            } finally {
                notify();
            }
        },
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        dispose,
    };
}

export function getNativeSshTunnelRuntime(params: RuntimeFactoryParams = {}): NativeSshTunnelRuntime {
    bindNativeSshAccountLifetime();
    if (!singletonRuntime) {
        const factory = params.createSupervisor ?? createDefaultSupervisor;
        singletonRuntime = createNativeSshTunnelRuntime({
            supervisor: factory(),
            createSupervisor: factory,
        });
        if (!isRuntimeActive()) singletonRuntime.markSuspended();
    }
    return singletonRuntime;
}

export async function disposeNativeSshTunnelRuntime(): Promise<void> {
    accountLifetimeBinding?.dispose();
    accountLifetimeBinding = null;
    hostKeyPromptResolver = null;
    authPromptResolver = null;
    credentialResolutionsByRefKey.clear();
    const runtime = singletonRuntime;
    await runtime?.dispose();
    if (singletonRuntime === runtime) singletonRuntime = null;
}
