import { apiSocket } from '@/sync/api/session/apiSocket';
import { withActionFailureCauseDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';

type Snapshot = Readonly<{ serverId: string | null; generation: number }>;
type Authority = Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
    release?: () => Promise<void>;
}>;

export type ActivePluginAccountArtifactRemoverDependencies = Readonly<{
    getServerSnapshot: () => Snapshot;
    captureRequestAuthority: (scope: ServerAccountScope) => Promise<Authority>;
}>;

export type ActivePluginAccountArtifactRemoveResult =
    | Readonly<{ kind: 'removed' }>
    | Readonly<{ kind: 'unavailable' }>;

function defaultDependencies(): ActivePluginAccountArtifactRemoverDependencies {
    return {
        getServerSnapshot: () => {
            const snapshot = getActiveServerSnapshot();
            return { serverId: snapshot.serverId, generation: snapshot.generation };
        },
        captureRequestAuthority: async (scope) => {
            const authority = await captureServerRequestAuthorityForServerAccountScope({
                scope,
                activeRequest: (path, init) => apiSocket.request(path, init),
            });
            return Object.freeze({ request: authority.request, release: authority.release });
        },
    };
}

function isCurrent(
    lifetime: ActiveServerAccountScopeLifetime,
    snapshot: Snapshot,
    getSnapshot: () => Snapshot,
): boolean {
    const current = getSnapshot();
    return lifetime.isCurrent()
        && snapshot.serverId === lifetime.scope.serverId
        && current.serverId === snapshot.serverId
        && current.generation === snapshot.generation;
}

/** Exact qualified-link removal; Availability remains the link and Artifact owner. */
export function createActivePluginAccountArtifactRemover<TTarget>(
    contract: Readonly<{
        path: string;
        parseTarget: (target: TTarget) => Readonly<{ success: false }> | Readonly<{ success: true; data: TTarget }>;
        matchesResponse: (raw: unknown, target: TTarget) => boolean;
    }>,
    overrides: Partial<ActivePluginAccountArtifactRemoverDependencies> = {},
): Readonly<{
    remove: (input: Readonly<{
        accountLifetime: ActiveServerAccountScopeLifetime;
        target: TTarget;
    }>) => Promise<ActivePluginAccountArtifactRemoveResult>;
}> {
    const dependencies = { ...defaultDependencies(), ...overrides };
    return Object.freeze({
        remove: async ({ accountLifetime, target }) => {
            const parsed = contract.parseTarget(target);
            if (!parsed.success) return Object.freeze({ kind: 'unavailable' as const });
            const snapshot = dependencies.getServerSnapshot();
            if (!isCurrent(accountLifetime, snapshot, dependencies.getServerSnapshot)) {
                return Object.freeze({ kind: 'unavailable' as const });
            }
            const controller = new AbortController();
            const retirement = accountLifetime.onRetire(() => controller.abort());
            let authority: Authority | null = null;
            try {
                authority = await dependencies.captureRequestAuthority(accountLifetime.scope);
                if (!isCurrent(accountLifetime, snapshot, dependencies.getServerSnapshot)) {
                    return Object.freeze({ kind: 'unavailable' as const });
                }
                const response = await authority.request(
                    contract.path,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(parsed.data),
                        signal: controller.signal,
                    },
                );
                if (!response.ok) return Object.freeze(withActionFailureCauseDiagnostic(
                    { kind: 'unavailable' as const }, response, 'plugin_availability.artifact_remove'));
                const raw = await response.json();
                if (
                    !isCurrent(accountLifetime, snapshot, dependencies.getServerSnapshot)
                    || !contract.matchesResponse(raw, parsed.data)
                ) {
                    return Object.freeze({ kind: 'unavailable' as const });
                }
                return Object.freeze({ kind: 'removed' as const });
            } catch (error) {
                return Object.freeze(withActionFailureCauseDiagnostic(
                    { kind: 'unavailable' as const }, error, 'plugin_availability.artifact_remove'));
            } finally {
                retirement.dispose();
                await authority?.release?.();
            }
        },
    });
}

