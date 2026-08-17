import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityReleaseReadActionInputV1Schema,
    PluginAvailabilityReleaseReadActionOutputV1Schema,
    type PluginAvailabilityReleaseReadActionInputV1,
    type PluginAvailabilityReleaseReadActionOutputV1,
} from '@happier-dev/protocol/plugins/availability';

import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureSessionRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';

type AvailabilityReleaseReadServerSnapshot = Readonly<{
    serverId: string | null;
    generation: number;
}>;

type AvailabilityReleaseReadRequestAuthority = Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
}>;

export type ActivePluginAccountReleaseReaderDependencies = Readonly<{
    captureLifetime: () => ActiveServerAccountScopeLifetime | null;
    getServerSnapshot: () => AvailabilityReleaseReadServerSnapshot;
    captureRequestAuthority: (scope: ServerAccountScope) => Promise<AvailabilityReleaseReadRequestAuthority>;
}>;

export type ActivePluginAccountReleaseReadResult =
    | Readonly<{
        kind: 'available';
        availabilityCursor: PluginAvailabilityReleaseReadActionOutputV1['availabilityCursor'];
        facts: PluginAvailabilityReleaseReadActionOutputV1['facts'];
    }>
    | Readonly<{ kind: 'notFound' }>
    | Readonly<{
        kind: 'unavailable';
        code: 'account_scope_changed' | 'server_generation_changed' | 'transport_unavailable' | 'response_invalid';
    }>;

function unavailable(
    code: Extract<ActivePluginAccountReleaseReadResult, { kind: 'unavailable' }>['code'],
): ActivePluginAccountReleaseReadResult {
    return Object.freeze({ kind: 'unavailable' as const, code });
}

function defaultDependencies(): ActivePluginAccountReleaseReaderDependencies {
    return {
        captureLifetime: captureActiveServerAccountScopeLifetime,
        getServerSnapshot: () => {
            const snapshot = getActiveServerSnapshot();
            return { serverId: snapshot.serverId, generation: snapshot.generation };
        },
        captureRequestAuthority: async (scope) => {
            const authority = await captureSessionRequestAuthorityForServerAccountScope({
                scope,
                activeRequest: (path, init) => apiSocket.request(path, init),
            });
            return Object.freeze({ request: authority.request });
        },
    };
}

function currentnessCode(input: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    snapshot: AvailabilityReleaseReadServerSnapshot;
    getServerSnapshot: () => AvailabilityReleaseReadServerSnapshot;
}>): Extract<ActivePluginAccountReleaseReadResult, { kind: 'unavailable' }>['code'] | null {
    if (!input.lifetime.isCurrent()) return 'account_scope_changed';
    const current = input.getServerSnapshot();
    return current.serverId === input.snapshot.serverId && current.generation === input.snapshot.generation
        ? null
        : 'server_generation_changed';
}

function responseMatchesRequestedCoordinate(input: Readonly<{
    response: PluginAvailabilityReleaseReadActionOutputV1;
    request: PluginAvailabilityReleaseReadActionInputV1;
}>): boolean {
    return input.response.facts.ref.pluginId === input.request.release.pluginId
        && input.response.facts.ref.version === input.request.release.version;
}

function isExactReleaseNotFoundResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Readonly<Record<string, unknown>>;
    return Object.keys(record).length === 1 && record.error === 'plugin_release_not_found';
}

/**
 * Direct UI transport for one immutable release coordinate. It deliberately
 * owns neither Account selection intent nor catalog/discovery state: callers
 * receive only the target facts and the Account Availability cursor that fenced
 * their read.
 */
export function createActivePluginAccountReleaseReader(
    overrides: Partial<ActivePluginAccountReleaseReaderDependencies> = {},
): Readonly<{
    read: (input: PluginAvailabilityReleaseReadActionInputV1) => Promise<ActivePluginAccountReleaseReadResult>;
}> {
    const dependencies: ActivePluginAccountReleaseReaderDependencies = {
        ...defaultDependencies(),
        ...overrides,
    };
    return Object.freeze({
        read: async (input) => {
            const parsed = PluginAvailabilityReleaseReadActionInputV1Schema.safeParse(input);
            if (!parsed.success) return unavailable('response_invalid');

            const lifetime = dependencies.captureLifetime();
            if (!lifetime?.isCurrent()) return unavailable('account_scope_changed');

            const snapshot = dependencies.getServerSnapshot();
            if (snapshot.serverId !== lifetime.scope.serverId) {
                return unavailable('server_generation_changed');
            }

            const controller = new AbortController();
            const retirement = lifetime.onRetire(() => controller.abort());
            try {
                const beforeAuthority = currentnessCode({
                    lifetime,
                    snapshot,
                    getServerSnapshot: dependencies.getServerSnapshot,
                });
                if (beforeAuthority || controller.signal.aborted) {
                    return unavailable(beforeAuthority ?? 'account_scope_changed');
                }

                let authority: AvailabilityReleaseReadRequestAuthority;
                try {
                    authority = await dependencies.captureRequestAuthority(lifetime.scope);
                } catch {
                    const afterAuthorityFailure = currentnessCode({
                        lifetime,
                        snapshot,
                        getServerSnapshot: dependencies.getServerSnapshot,
                    });
                    return unavailable(afterAuthorityFailure ?? 'transport_unavailable');
                }
                const afterAuthority = currentnessCode({
                    lifetime,
                    snapshot,
                    getServerSnapshot: dependencies.getServerSnapshot,
                });
                if (afterAuthority || controller.signal.aborted) {
                    return unavailable(afterAuthority ?? 'account_scope_changed');
                }

                let response: Response;
                try {
                    response = await authority.request(
                        PluginAvailabilityActionHttpPathsV1['account.plugins.availability.release.read'],
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(parsed.data),
                            signal: controller.signal,
                        },
                    );
                } catch {
                    const afterRequestFailure = currentnessCode({
                        lifetime,
                        snapshot,
                        getServerSnapshot: dependencies.getServerSnapshot,
                    });
                    return unavailable(afterRequestFailure ?? 'transport_unavailable');
                }
                const afterResponse = currentnessCode({
                    lifetime,
                    snapshot,
                    getServerSnapshot: dependencies.getServerSnapshot,
                });
                if (afterResponse || controller.signal.aborted) {
                    return unavailable(afterResponse ?? 'account_scope_changed');
                }

                const raw = await response.json().catch(() => null);
                const afterBody = currentnessCode({
                    lifetime,
                    snapshot,
                    getServerSnapshot: dependencies.getServerSnapshot,
                });
                if (afterBody || controller.signal.aborted) {
                    return unavailable(afterBody ?? 'account_scope_changed');
                }

                if (!response.ok) {
                    return response.status === 404 && isExactReleaseNotFoundResponse(raw)
                        ? Object.freeze({ kind: 'notFound' as const })
                        : unavailable('transport_unavailable');
                }

                const output = PluginAvailabilityReleaseReadActionOutputV1Schema.safeParse(raw);
                if (!output.success || !responseMatchesRequestedCoordinate({
                    response: output.data,
                    request: parsed.data,
                })) {
                    return unavailable('response_invalid');
                }
                return Object.freeze({
                    kind: 'available' as const,
                    availabilityCursor: output.data.availabilityCursor,
                    facts: output.data.facts,
                });
            } finally {
                retirement.dispose();
            }
        },
    });
}

const installedActivePluginAccountReleaseReader = createActivePluginAccountReleaseReader();

export async function readActivePluginAccountRelease(
    input: PluginAvailabilityReleaseReadActionInputV1,
): Promise<ActivePluginAccountReleaseReadResult> {
    return await installedActivePluginAccountReleaseReader.read(input);
}
