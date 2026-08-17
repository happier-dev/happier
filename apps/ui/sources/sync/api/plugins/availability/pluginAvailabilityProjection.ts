import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAvailabilityMaterializationsReadActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability';
import { PluginDomainChangeEntrySchema } from '@happier-dev/protocol/changes';

import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureSessionRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import type { PluginAccountAvailabilitySnapshot } from '@/sync/domains/plugins/availability/reader';

type ProjectionServerSnapshot = Readonly<{
    serverId: string | null;
    generation: number;
}>;

type ProjectionRequestAuthority = Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
}>;

type IntentListReadResult =
    | Readonly<{
        kind: 'available';
        response: ReturnType<typeof PluginAvailabilityIntentsListActionOutputV1Schema.parse>;
    }>
    | Readonly<{ kind: 'routeNotSupported' }>;

export type ActivePluginAccountAvailabilityProjectionHydratorDependencies = Readonly<{
    captureLifetime: () => ActiveServerAccountScopeLifetime | null;
    getServerSnapshot: () => ProjectionServerSnapshot;
    captureRequestAuthority: (
        scope: ServerAccountScope,
    ) => Promise<ProjectionRequestAuthority>;
}>;

export type ActivePluginAccountAvailabilityProjectionHydrator = Readonly<{
    /** Records a closed Availability hint and retires an in-flight stale read. */
    invalidate: (changes: readonly unknown[]) => boolean;
    /** Clears remembered plugin ids when the Account lifetime/reset owner retires. */
    reset: () => void;
    /** Reads one complete current projection, or null after a lifetime/generation change. */
    refresh: () => Promise<Readonly<{
        scope: ServerAccountScope;
        snapshot: PluginAccountAvailabilitySnapshot;
    }> | null>;
}>;

function scopesEqual(left: ServerAccountScope | null, right: ServerAccountScope): boolean {
    return left?.serverId === right.serverId && left.accountId === right.accountId;
}

function sameServerSnapshot(
    left: ProjectionServerSnapshot,
    right: ProjectionServerSnapshot,
): boolean {
    return left.serverId === right.serverId && left.generation === right.generation;
}

function assertIntentResponseIdentity(input: Readonly<{
    pluginId: string;
    response: ReturnType<typeof PluginAvailabilityIntentReadActionOutputV1Schema.parse>;
}>): void {
    const { response } = input;
    if (response.intent && response.intent.pluginId !== input.pluginId) {
        throw new Error('Plugin Availability intent read returned a different plugin.');
    }
    if (response.release && response.release.ref.pluginId !== input.pluginId) {
        throw new Error('Plugin Availability release read returned a different plugin.');
    }
    if (response.uiArtifacts.some((link) => link.release.pluginId !== input.pluginId)) {
        throw new Error('Plugin Availability artifact link returned a different plugin.');
    }
}

function defaultDependencies(): ActivePluginAccountAvailabilityProjectionHydratorDependencies {
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
            return { request: authority.request };
        },
    };
}

async function postJson(
    authority: ProjectionRequestAuthority,
    path: string,
    body: unknown,
    signal: AbortSignal,
): Promise<unknown> {
    const response = await authority.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (!response.ok) {
        throw new Error(`Plugin Availability projection request failed with status ${response.status}.`);
    }
    return await response.json();
}

function isExactFastifyRouteNotFoundResponse(input: unknown, path: string): boolean {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const body = input as Readonly<Record<string, unknown>>;
    return Object.keys(body).length === 3
        && body.error === 'Not found'
        && body.path === path
        && body.method === 'POST';
}

/**
 * Older supported servers do not have this additive bootstrap route. Only the
 * incumbent Fastify missing-route envelope may retain materialization/hint
 * discovery; every current-server failure stays fail-closed.
 */
async function postIntentList(
    authority: ProjectionRequestAuthority,
    signal: AbortSignal,
): Promise<IntentListReadResult> {
    const path = PluginAvailabilityActionHttpPathsV1[
        'account.plugins.availability.intents.list'
    ];
    const response = await authority.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal,
    });
    if (response.status === 404) {
        const body = await response.json();
        if (isExactFastifyRouteNotFoundResponse(body, path)) {
            return Object.freeze({ kind: 'routeNotSupported' });
        }
        throw new Error(`Plugin Availability projection request failed with status ${response.status}.`);
    }
    if (!response.ok) {
        throw new Error(`Plugin Availability projection request failed with status ${response.status}.`);
    }
    return Object.freeze({
        kind: 'available',
        response: PluginAvailabilityIntentsListActionOutputV1Schema.parse(await response.json()),
    });
}

/**
 * One active-Account reader for the closed Availability HTTP family. It owns
 * neither the projection nor a second cache/currentness record: callers make
 * the one atomic replacement only after this helper has fenced Account scope,
 * server generation, request supersession, and a coherent cursor.
 */
export function createActivePluginAccountAvailabilityProjectionHydrator(
    overrides: Partial<ActivePluginAccountAvailabilityProjectionHydratorDependencies> = {},
): ActivePluginAccountAvailabilityProjectionHydrator {
    const defaults = defaultDependencies();
    const dependencies: ActivePluginAccountAvailabilityProjectionHydratorDependencies = {
        ...defaults,
        ...overrides,
    };
    let trackedScope: ServerAccountScope | null = null;
    let knownPluginIds = new Set<string>();
    let requestEpoch = 0;

    const reset = (): void => {
        requestEpoch += 1;
        trackedScope = null;
        knownPluginIds = new Set<string>();
    };

    const ensureScope = (scope: ServerAccountScope): void => {
        if (scopesEqual(trackedScope, scope)) return;
        trackedScope = scope;
        knownPluginIds = new Set<string>();
        requestEpoch += 1;
    };

    const isCurrent = (
        lifetime: ActiveServerAccountScopeLifetime,
        serverSnapshot: ProjectionServerSnapshot,
        epoch: number,
    ): boolean => {
        return requestEpoch === epoch
            && lifetime.isCurrent()
            && sameServerSnapshot(dependencies.getServerSnapshot(), serverSnapshot);
    };

    const invalidate = (changes: readonly unknown[]): boolean => {
        const lifetime = dependencies.captureLifetime();
        if (!lifetime) {
            reset();
            return false;
        }
        ensureScope(lifetime.scope);
        let affected = false;
        for (const change of changes) {
            const parsed = PluginDomainChangeEntrySchema.safeParse(change);
            if (!parsed.success || parsed.data.hint.pluginDomain !== 'availability') continue;
            knownPluginIds.add(parsed.data.hint.pluginId);
            affected = true;
        }
        if (affected) requestEpoch += 1;
        return affected;
    };

    const refresh = async (): Promise<Readonly<{
        scope: ServerAccountScope;
        snapshot: PluginAccountAvailabilitySnapshot;
    }> | null> => {
        const lifetime = dependencies.captureLifetime();
        if (!lifetime || !lifetime.isCurrent()) return null;
        ensureScope(lifetime.scope);
        const serverSnapshot = dependencies.getServerSnapshot();
        if (serverSnapshot.serverId !== lifetime.scope.serverId) return null;
        const epoch = ++requestEpoch;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        try {
            const authority = await dependencies.captureRequestAuthority(lifetime.scope);
            if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;

            // A concurrent Account mutation can straddle the two operation
            // reads. One bounded retry avoids projecting a mixed cursor; a
            // continuing mutation fails closed and the caller's InvalidateSync
            // owns the next retry rather than retaining a partial snapshot.
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const materializations = PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse(
                    await postJson(
                        authority,
                        PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
                        {},
                        controller.signal,
                    ),
                );
                if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;

                const intentList = await postIntentList(authority, controller.signal);
                if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;

                const pluginIds = new Set(knownPluginIds);
                if (intentList.kind === 'available') {
                    for (const pluginId of intentList.response.pluginIds) {
                        pluginIds.add(pluginId);
                    }
                }
                for (const snapshot of materializations.snapshots) {
                    for (const materialization of snapshot.materializations) {
                        pluginIds.add(materialization.pluginId);
                    }
                }
                const sortedPluginIds = [...pluginIds].sort((left, right) => left.localeCompare(right));
                const intentReads = await Promise.all(sortedPluginIds.map(async (pluginId) => {
                    const response = PluginAvailabilityIntentReadActionOutputV1Schema.parse(
                        await postJson(
                            authority,
                            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'],
                            { pluginId },
                            controller.signal,
                        ),
                    );
                    assertIntentResponseIdentity({ pluginId, response });
                    return Object.freeze({ pluginId, response });
                }));
                if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;
                const cursor = materializations.availabilityCursor;
                if (
                    (intentList.kind === 'routeNotSupported'
                        || intentList.response.availabilityCursor === cursor)
                    && intentReads.every((projection) => projection.response.availabilityCursor === cursor)
                ) {
                    knownPluginIds = pluginIds;
                    return Object.freeze({
                        scope: lifetime.scope,
                        snapshot: Object.freeze({
                            availabilityCursor: cursor,
                            intentReads: Object.freeze(intentReads),
                            materializations: Object.freeze(materializations.snapshots.flatMap(
                                (snapshot) => snapshot.materializations,
                            )),
                        }),
                    });
                }
                if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;
            }
            throw new Error('Plugin Availability changed while its projection was hydrating.');
        } catch (error) {
            if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;
            throw error;
        } finally {
            retirement.dispose();
        }
    };

    return Object.freeze({ invalidate, reset, refresh });
}
