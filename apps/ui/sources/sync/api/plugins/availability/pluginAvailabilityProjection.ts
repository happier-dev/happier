import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAvailabilityMaterializationsReadActionOutputV1Schema,
    PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE,
} from '@happier-dev/protocol/plugins/availability';
import { PluginDomainChangeEntrySchema } from '@happier-dev/protocol/changes';

import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import type { PluginAccountAvailabilitySnapshot } from '@/sync/domains/plugins/availability/reader';

type ProjectionServerSnapshot = Readonly<{
    serverId: string | null;
    generation: number;
}>;

type ProjectionRequestAuthority = Readonly<{
    request: (path: string, init?: RequestInit) => Promise<Response>;
    release?: () => Promise<void>;
}>;

export type ActivePluginAccountAvailabilityProjectionHydratorDependencies = Readonly<{
    captureLifetime: () => ActiveServerAccountScopeLifetime | null;
    getServerSnapshot: () => ProjectionServerSnapshot;
    captureRequestAuthority: (
        scope: ServerAccountScope,
    ) => Promise<ProjectionRequestAuthority>;
}>;

export type ActivePluginAccountAvailabilityProjectionHydrator = Readonly<{
    /** Records closed Availability hints, retires stale reads, and names only affected plugins. */
    invalidate: (changes: readonly unknown[]) => readonly string[];
    /** Clears remembered plugin ids when the Account lifetime/reset owner retires. */
    reset: () => void;
    /** Reads current facts with explicit census failures, or null after scope retirement. */
    refresh: () => Promise<Readonly<{
        scope: ServerAccountScope;
        snapshot: PluginAccountAvailabilitySnapshot;
        failedPluginIds: readonly string[];
        intentCensusIncomplete?: boolean;
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
    if (response.packageAssets.some((link) => link.release.pluginId !== input.pluginId)) {
        throw new Error('Plugin Availability package asset link returned a different plugin.');
    }
}

function defaultDependencies(): ActivePluginAccountAvailabilityProjectionHydratorDependencies {
    return {
        // Keep the active-scope import behind the invocation boundary. Sync
        // constructs this hydrator while the sync/store module graph is still
        // initializing, so eagerly reading the imported binding creates a TDZ
        // cycle even though no Availability read has started yet.
        captureLifetime: () => captureActiveServerAccountScopeLifetime(),
        getServerSnapshot: () => {
            const snapshot = getActiveServerSnapshot();
            return { serverId: snapshot.serverId, generation: snapshot.generation };
        },
        captureRequestAuthority: async (scope) => {
            const authority = await captureServerRequestAuthorityForServerAccountScope({
                scope,
                activeRequest: (path, init) => apiSocket.request(path, init),
            });
            return { request: authority.request, release: authority.release };
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

async function postIntentList(
    authority: ProjectionRequestAuthority,
    knownPluginIds: readonly string[],
    signal: AbortSignal,
    cursor?: string,
): Promise<ReturnType<typeof PluginAvailabilityIntentsListActionOutputV1Schema.parse>> {
    const path = PluginAvailabilityActionHttpPathsV1[
        'account.plugins.availability.intents.list'
    ];
    return PluginAvailabilityIntentsListActionOutputV1Schema.parse(
        await postJson(authority, path, {
            // The server merges these identities with its own next page. One
            // lookahead identity lets it own continuation without resending
            // the entire materialized/remembered inventory on every request.
            knownPluginIds: knownPluginIds.filter(pluginId => !cursor || pluginId > cursor)
                .slice(0, PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE + 1),
            ...(cursor ? { cursor } : {}),
        }, signal),
    );
}

/**
 * One active-Account reader for the closed Availability HTTP family. It owns
 * neither the projection nor a second cache/currentness record: callers apply
 * its per-plugin results only after Account scope, server generation, and
 * request supersession have been fenced.
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

    const invalidate = (changes: readonly unknown[]): readonly string[] => {
        const lifetime = dependencies.captureLifetime();
        if (!lifetime) {
            reset();
            return [];
        }
        ensureScope(lifetime.scope);
        const affectedPluginIds = new Set<string>();
        for (const change of changes) {
            const parsed = PluginDomainChangeEntrySchema.safeParse(change);
            if (!parsed.success || parsed.data.hint.pluginDomain !== 'availability') continue;
            knownPluginIds.add(parsed.data.hint.pluginId);
            affectedPluginIds.add(parsed.data.hint.pluginId);
        }
        if (affectedPluginIds.size > 0) requestEpoch += 1;
        return Object.freeze([...affectedPluginIds]);
    };

    const refresh = async (): Promise<Readonly<{
        scope: ServerAccountScope;
        snapshot: PluginAccountAvailabilitySnapshot;
        failedPluginIds: readonly string[];
        intentCensusIncomplete?: boolean;
    }> | null> => {
        const lifetime = dependencies.captureLifetime();
        if (!lifetime || !lifetime.isCurrent()) return null;
        ensureScope(lifetime.scope);
        const serverSnapshot = dependencies.getServerSnapshot();
        if (serverSnapshot.serverId !== lifetime.scope.serverId) return null;
        const epoch = ++requestEpoch;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        let authority: ProjectionRequestAuthority | null = null;
        try {
            authority = await dependencies.captureRequestAuthority(lifetime.scope);
            const capturedAuthority = authority;
            if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;

            const materializations = PluginAvailabilityMaterializationsReadActionOutputV1Schema.parse(await postJson(
                capturedAuthority,
                PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
                {},
                controller.signal,
            ));
            if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;

            const pluginIds = new Set(knownPluginIds);
            for (const snapshot of materializations.snapshots) {
                for (const materialization of snapshot.materializations) {
                    pluginIds.add(materialization.pluginId);
                }
            }
            const sortedPluginIds = [...pluginIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
            // Materializations discover plugins that have no Account intent row.
            // The batch must include them and remembered deletions on this first
            // refresh, so it depends on the completed machine inventory read.
            const failedPluginIds = new Set<string>();
            const intentReadsByPluginId = new Map<string, ReturnType<typeof PluginAvailabilityIntentsListActionOutputV1Schema.parse>['intentReads'][number]>();
            const accountedPluginIds = new Set<string>();
            let cursor: string | undefined;
            let intentCensusIncomplete = false;
            do {
                let page: ReturnType<typeof PluginAvailabilityIntentsListActionOutputV1Schema.parse>;
                try {
                    page = await postIntentList(capturedAuthority, sortedPluginIds, controller.signal, cursor);
                } catch {
                    if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;
                    intentCensusIncomplete = true;
                    break;
                }
                if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;
                for (const pluginId of page.pluginIds) pluginIds.add(pluginId);
                for (const pluginId of page.failedPluginIds) {
                    pluginIds.add(pluginId);
                    accountedPluginIds.add(pluginId);
                    failedPluginIds.add(pluginId);
                }
                for (const entry of page.intentReads) {
                    pluginIds.add(entry.pluginId);
                    accountedPluginIds.add(entry.pluginId);
                    try {
                        assertIntentResponseIdentity(entry);
                        intentReadsByPluginId.set(entry.pluginId, Object.freeze(entry));
                    } catch {
                        failedPluginIds.add(entry.pluginId);
                    }
                }
                if (page.nextCursor && cursor && page.nextCursor <= cursor) {
                    intentCensusIncomplete = true;
                    break;
                }
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            const intentReads = [...intentReadsByPluginId.values()];
            for (const pluginId of sortedPluginIds) {
                if (!accountedPluginIds.has(pluginId)) failedPluginIds.add(pluginId);
            }
            for (const pluginId of failedPluginIds) pluginIds.add(pluginId);
            knownPluginIds = pluginIds;
            return Object.freeze({
                scope: lifetime.scope,
                failedPluginIds: Object.freeze([...failedPluginIds]),
                ...(intentCensusIncomplete ? { intentCensusIncomplete: true } : {}),
                snapshot: Object.freeze({
                    availabilityCursor: materializations.availabilityCursor,
                    inventoryComplete: materializations.inventoryComplete !== false,
                    releases: Object.freeze(materializations.releases ?? []),
                    intentReads: Object.freeze(intentReads),
                    materializations: Object.freeze(materializations.snapshots.flatMap(
                        (snapshot) => snapshot.materializations,
                    )),
                    snapshots: Object.freeze(materializations.snapshots.map((snapshot) => Object.freeze({
                        ...snapshot,
                        materializations: Object.freeze([...snapshot.materializations]),
                    }))),
                }),
            });
        } catch (error) {
            if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;
            throw error;
        } finally {
            await authority?.release?.();
            retirement.dispose();
        }
    };

    return Object.freeze({ invalidate, reset, refresh });
}
