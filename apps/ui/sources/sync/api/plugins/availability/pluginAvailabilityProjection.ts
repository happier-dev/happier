import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentReadActionOutputV1Schema,
    PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAvailabilityMaterializationsReadActionOutputV1Schema,
    PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE,
    type PluginAccountDeclarationBodyV1,
} from '@happier-dev/protocol/plugins/availability';
import { PluginDomainChangeEntrySchema } from '@happier-dev/protocol/changes';

import { apiSocket } from '@/sync/api/session/apiSocket';
import { ServerFetchReadSupersededError, type ServerFetch } from '@/sync/http/client';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { captureServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import type { PluginAccountAvailabilitySnapshot } from '@/sync/domains/plugins/availability/reader';
import {
    parsePluginAvailabilityResponse,
    PluginAvailabilityInvalidResponseError,
    isPluginAvailabilityResponseFailure,
    type PluginAvailabilityResponseFailure,
} from '@/sync/domains/plugins/availability/responseFailure';
import { postJson } from './request';

type ProjectionServerSnapshot = Readonly<{
    serverId: string | null;
    generation: number;
}>;

type ProjectionRequestAuthority = Readonly<{
    request: ServerFetch;
    release?: () => Promise<void>;
}>;

export type ActivePluginAccountAvailabilityProjectionHydratorDependencies = Readonly<{
    captureLifetime: () => ActiveServerAccountScopeLifetime | null;
    getServerSnapshot: () => ProjectionServerSnapshot;
    captureRequestAuthority: (
        scope: ServerAccountScope,
    ) => Promise<ProjectionRequestAuthority>;
}>;

export type ActivePluginAccountAvailabilityRefresh = Readonly<{
    scope: ServerAccountScope;
    snapshot: PluginAccountAvailabilitySnapshot;
    failedPluginIds: readonly string[];
    intentCensusIncomplete?: boolean;
    terminalFailure?: PluginAvailabilityResponseFailure;
    /**
     * Present on a row-level read: the snapshot holds only these plugins'
     * facts (every current Account Machine, filtered to them) and must be
     * merged into the held complete projection. Absent means a complete read.
     */
    pluginIds?: readonly string[];
}>;

export type ActivePluginAccountAvailabilityProjectionHydrator = Readonly<{
    /** Records closed Availability hints, retires stale reads, and names only affected plugins. */
    invalidate: (changes: readonly unknown[]) => readonly string[];
    /** Mutation receipts and exact semantic demand name the same pending resources as hints. */
    requestPlugins: (pluginIds: readonly string[]) => void;
    /** A structural/unknown/gap request: the next refresh reads the whole Account inventory. */
    requireFullRefresh: () => void;
    /** Clears remembered plugin ids when the Account lifetime/reset owner retires. */
    reset: () => void;
    /**
     * Reads current facts with explicit census failures, or null after scope
     * retirement. Only plugins named by Availability hints are read row-level,
     * and only when the caller holds a complete projection to merge them into;
     * every other refresh is a complete read.
     */
    refresh: (options?: Readonly<{
        canMergePlugins?: (scope: ServerAccountScope) => boolean;
    }>) => Promise<ActivePluginAccountAvailabilityRefresh | null>;
    /**
     * Content-addressed release-less declaration bodies for the named digests,
     * each admitted once by this read; empty after scope retirement. Currentness
     * stays with the projection: a digest names immutable content.
     */
    readDeclarationBodies: (pluginId: string, digests: readonly string[]) => Promise<readonly PluginAccountDeclarationBodyV1[]>;
}>;

type NamedIntentRead = Readonly<{
    pluginId: string;
    response: ReturnType<typeof PluginAvailabilityIntentReadActionOutputV1Schema.parse>;
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
}>, scope: ServerAccountScope): void {
    const { response } = input;
    if (response.intent && response.intent.pluginId !== input.pluginId) {
        throw new PluginAvailabilityInvalidResponseError('intent_identity', scope);
    }
    if (response.release && response.release.ref.pluginId !== input.pluginId) {
        throw new PluginAvailabilityInvalidResponseError('intent_identity', scope);
    }
    if (response.uiArtifacts.some((link) => link.release.pluginId !== input.pluginId)) {
        throw new PluginAvailabilityInvalidResponseError('intent_identity', scope);
    }
    if (response.packageAssets.some((link) => link.release.pluginId !== input.pluginId)) {
        throw new PluginAvailabilityInvalidResponseError('intent_identity', scope);
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
                activeRequest: (path, init, options) => apiSocket.request(path, init, options),
            });
            return { request: authority.request, release: authority.release };
        },
    };
}

/** Returns the unadmitted page body: the caller admits it only while its read is still current. */
async function postIntentList(
    authority: ProjectionRequestAuthority,
    knownPluginIds: readonly string[],
    signal: AbortSignal,
    scope: ServerAccountScope,
    cursor?: string,
): Promise<unknown> {
    const path = PluginAvailabilityActionHttpPathsV1[
        'account.plugins.availability.intents.list'
    ];
    return await postJson(authority, path, {
        // The server merges these identities with its own next page. One
        // lookahead identity lets it own continuation without resending
        // the entire materialized/remembered inventory on every request.
        knownPluginIds: knownPluginIds.filter(pluginId => !cursor || pluginId > cursor)
            .slice(0, PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE + 1),
        ...(cursor ? { cursor } : {}),
    }, signal, 'intent_census', scope);
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
    // Plugins named by Availability hints and not yet read. A refresh takes
    // them and puts them back unless its read is returned.
    let pendingPluginIds = new Set<string>();
    // Structural requests are counted so one arriving during a complete read
    // still gets its own complete read afterwards.
    let fullRefreshRequests = 1;
    let fullRefreshesSatisfied = 0;

    const reset = (): void => {
        requestEpoch += 1;
        trackedScope = null;
        knownPluginIds = new Set<string>();
        pendingPluginIds = new Set<string>();
        fullRefreshRequests += 1;
    };

    const ensureScope = (scope: ServerAccountScope): void => {
        if (scopesEqual(trackedScope, scope)) return;
        trackedScope = scope;
        knownPluginIds = new Set<string>();
        pendingPluginIds = new Set<string>();
        fullRefreshRequests += 1;
        requestEpoch += 1;
    };

    const requireFullRefresh = (): void => {
        fullRefreshRequests += 1;
    };

    const isCurrent = (
        lifetime: ActiveServerAccountScopeLifetime,
        serverSnapshot: ProjectionServerSnapshot,
        epoch: number,
    ): boolean => {
        if (!lifetime.isCurrent() || !scopesEqual(trackedScope, lifetime.scope)
            || !sameServerSnapshot(dependencies.getServerSnapshot(), serverSnapshot)) return false;
        // Same-Account waiters need the replacement attempt to publish before they resume.
        if (requestEpoch !== epoch) throw new ServerFetchReadSupersededError('Plugin Availability read superseded');
        return true;
    };

    const requestPlugins = (pluginIds: readonly string[]): void => {
        const lifetime = dependencies.captureLifetime();
        if (!lifetime) {
            reset();
            return;
        }
        ensureScope(lifetime.scope);
        for (const pluginId of pluginIds) {
            knownPluginIds.add(pluginId);
            pendingPluginIds.add(pluginId);
        }
        if (pluginIds.length > 0) requestEpoch += 1;
    };

    const invalidate = (changes: readonly unknown[]): readonly string[] => {
        const affectedPluginIds = new Set<string>();
        for (const change of changes) {
            const parsed = PluginDomainChangeEntrySchema.safeParse(change);
            if (!parsed.success || parsed.data.hint.pluginDomain !== 'availability') continue;
            affectedPluginIds.add(parsed.data.hint.pluginId);
        }
        requestPlugins([...affectedPluginIds]);
        return Object.freeze([...affectedPluginIds]);
    };

    /**
     * Exact intent reads for the named plugins: one request per Availability
     * page. Each plugin settles on its own; a failed page fails its plugins.
     */
    const readNamedIntents = async (
        authority: ProjectionRequestAuthority,
        pluginIds: readonly string[],
        scope: ServerAccountScope,
        signal: AbortSignal,
    ): Promise<readonly PromiseSettledResult<NamedIntentRead>[]> => {
        const pages: (readonly string[])[] = [];
        for (let start = 0; start < pluginIds.length; start += PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE) {
            pages.push(pluginIds.slice(start, start + PLUGIN_ACCOUNT_AVAILABILITY_INTENT_PAGE_SIZE));
        }
        const pageReads = await Promise.allSettled(pages.map(async page => parsePluginAvailabilityResponse(
            PluginAvailabilityIntentsListActionOutputV1Schema,
            await postJson(authority, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
                { pluginIds: page }, signal, 'intent_census', scope),
            'intent_census', scope,
        )));
        return pages.flatMap((page, index): PromiseSettledResult<NamedIntentRead>[] => {
            const pageRead = pageReads[index]!;
            if (pageRead.status === 'rejected') return page.map(() => ({ status: 'rejected', reason: pageRead.reason }));
            const responses = new Map(pageRead.value.intentReads.map(entry => [entry.pluginId, entry.response]));
            return page.map((pluginId): PromiseSettledResult<NamedIntentRead> => {
                const response = responses.get(pluginId);
                // The Home reports a plugin it could not read as failed (or omits it).
                if (!response) return { status: 'rejected', reason: undefined };
                try {
                    assertIntentResponseIdentity({ pluginId, response }, scope);
                } catch (error) {
                    return { status: 'rejected', reason: error };
                }
                return { status: 'fulfilled', value: Object.freeze({ pluginId, response }) };
            });
        });
    };

    /**
     * Row-level read for plugins named by Availability hints: their
     * materializations on every current Account Machine (`pluginIds` filter)
     * and their exact intent reads. 'incomplete' means the Home omitted an
     * unreadable Machine, whose rows are then unknown rather than removed.
     */
    const readNamedPlugins = async (
        authority: ProjectionRequestAuthority,
        pluginIds: readonly string[],
        lifetime: ActiveServerAccountScopeLifetime,
        serverSnapshot: ProjectionServerSnapshot,
        epoch: number,
        signal: AbortSignal,
        intentOutcomes: ReturnType<typeof readNamedIntents>,
    ): Promise<ActivePluginAccountAvailabilityRefresh | 'incomplete' | null> => {
        const scope = lifetime.scope;
        const materializationsBody = await postJson(
            authority,
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
            { pluginIds },
            signal,
            'materializations',
            scope,
        );
        const outcomes = await intentOutcomes;
        // Admission (manifest validation) is the cost of a read: a superseded body is dropped unread.
        if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;
        const materializations = parsePluginAvailabilityResponse(PluginAvailabilityMaterializationsReadActionOutputV1Schema,
            materializationsBody, 'materializations', scope);
        if (materializations.inventoryComplete === false) return 'incomplete';
        const failedPluginIds: string[] = [];
        const intentReads: PluginAccountAvailabilitySnapshot['intentReads'][number][] = [];
        let terminalFailure: PluginAvailabilityResponseFailure | undefined;
        outcomes.forEach((outcome, index) => {
            if (outcome.status === 'fulfilled') {
                intentReads.push(outcome.value);
                return;
            }
            if (isPluginAvailabilityResponseFailure(outcome.reason)) terminalFailure = outcome.reason;
            failedPluginIds.push(pluginIds[index]!);
        });
        return Object.freeze({
            scope,
            pluginIds: Object.freeze([...pluginIds]),
            failedPluginIds: Object.freeze(failedPluginIds),
            ...(terminalFailure ? { terminalFailure } : {}),
            snapshot: Object.freeze({
                availabilityCursor: materializations.availabilityCursor,
                inventoryComplete: true,
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
    };

    const refresh = async (options?: Readonly<{
        canMergePlugins?: (scope: ServerAccountScope) => boolean;
    }>): Promise<ActivePluginAccountAvailabilityRefresh | null> => {
        const lifetime = dependencies.captureLifetime();
        if (!lifetime || !lifetime.isCurrent()) return null;
        ensureScope(lifetime.scope);
        const serverSnapshot = dependencies.getServerSnapshot();
        if (serverSnapshot.serverId !== lifetime.scope.serverId) return null;
        const epoch = ++requestEpoch;
        const fullRequestsAtStart = fullRefreshRequests;
        const takenPluginIds = [...pendingPluginIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
        pendingPluginIds = new Set<string>();
        // Only hint-named plugins are read row-level, and only into a held
        // complete projection. Structural, unknown and gap requests (and any
        // refresh without named plugins) read the whole Account inventory.
        const rowLevel = takenPluginIds.length > 0
            && fullRefreshesSatisfied >= fullRequestsAtStart
            && options?.canMergePlugins?.(lifetime.scope) === true;
        let returned = false;
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        let authority: ProjectionRequestAuthority | null = null;
        try {
            authority = await dependencies.captureRequestAuthority(lifetime.scope);
            const capturedAuthority = authority;
            if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;
            // Start each named intent once. If a row-level materialization read
            // discovers an unreadable Machine, the full census reuses it.
            const namedIntentOutcomes = takenPluginIds.length > 0
                ? readNamedIntents(capturedAuthority, takenPluginIds, lifetime.scope, controller.signal)
                : undefined;

            if (rowLevel) {
                const named = await readNamedPlugins(capturedAuthority, takenPluginIds, lifetime, serverSnapshot, epoch, controller.signal,
                    namedIntentOutcomes!);
                if (named === null) return null;
                if (named !== 'incomplete') {
                    // Failed plugins stay named for the Sync owner's retry.
                    for (const pluginId of named.failedPluginIds) pendingPluginIds.add(pluginId);
                    returned = true;
                    return named;
                }
                // An omitted Machine cannot be merged row-level: read everything.
            }

            const materializationsBody = await postJson(
                capturedAuthority,
                PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'],
                {},
                controller.signal,
                'materializations',
                lifetime.scope,
            );
            // Admission (manifest validation) is the cost of a read: a superseded body is dropped unread.
            if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;
            const materializations = parsePluginAvailabilityResponse(PluginAvailabilityMaterializationsReadActionOutputV1Schema,
                materializationsBody, 'materializations', lifetime.scope);

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
            let terminalFailure: PluginAvailabilityResponseFailure | undefined;
            do {
                let page: ReturnType<typeof PluginAvailabilityIntentsListActionOutputV1Schema.parse>;
                try {
                    const body = await postIntentList(capturedAuthority, sortedPluginIds, controller.signal, lifetime.scope, cursor);
                    if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;
                    page = parsePluginAvailabilityResponse(PluginAvailabilityIntentsListActionOutputV1Schema, body,
                        'intent_census', lifetime.scope);
                } catch (error) {
                    if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;
                    if (isPluginAvailabilityResponseFailure(error)) terminalFailure = error;
                    intentCensusIncomplete = true;
                    break;
                }
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
                        assertIntentResponseIdentity(entry, lifetime.scope);
                        intentReadsByPluginId.set(entry.pluginId, Object.freeze(entry));
                    } catch (error) {
                        if (error instanceof PluginAvailabilityInvalidResponseError) terminalFailure = error;
                        failedPluginIds.add(entry.pluginId);
                    }
                }
                if (page.nextCursor && cursor && page.nextCursor <= cursor) {
                    intentCensusIncomplete = true;
                    terminalFailure = new PluginAvailabilityInvalidResponseError('intent_census', lifetime.scope);
                    break;
                }
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            // Structural recovery may require a full census even for an exact
            // demand. The named exact read started before the census settles
            // those plugins even when a census page fails: healthy Machine
            // Event setup must still work when another Machine is unreadable.
            if (namedIntentOutcomes) {
                const outcomes = await namedIntentOutcomes;
                if (!isCurrent(lifetime, serverSnapshot, epoch)) return null;
                outcomes.forEach((outcome, index) => {
                    const pluginId = takenPluginIds[index]!;
                    if (outcome.status === 'fulfilled') {
                        intentReadsByPluginId.set(pluginId, outcome.value);
                        failedPluginIds.delete(pluginId);
                    } else {
                        failedPluginIds.add(pluginId);
                        pendingPluginIds.add(pluginId);
                        if (isPluginAvailabilityResponseFailure(outcome.reason)) terminalFailure = outcome.reason;
                    }
                });
            }
            const intentReads = [...intentReadsByPluginId.values()];
            for (const pluginId of sortedPluginIds) {
                if (!accountedPluginIds.has(pluginId)) failedPluginIds.add(pluginId);
            }
            for (const pluginId of failedPluginIds) pluginIds.add(pluginId);
            knownPluginIds = pluginIds;
            fullRefreshesSatisfied = Math.max(fullRefreshesSatisfied, fullRequestsAtStart);
            returned = true;
            return Object.freeze({
                scope: lifetime.scope,
                failedPluginIds: Object.freeze([...failedPluginIds]),
                ...(intentCensusIncomplete ? { intentCensusIncomplete: true } : {}),
                ...(terminalFailure ? { terminalFailure } : {}),
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
            // A superseded, failed or retired read leaves its named plugins
            // pending for the trailing refresh of the same Account.
            if (!returned && scopesEqual(trackedScope, lifetime.scope)) {
                for (const pluginId of takenPluginIds) pendingPluginIds.add(pluginId);
            }
            await authority?.release?.();
            retirement.dispose();
        }
    };

    const readDeclarationBodies = async (pluginId: string, digests: readonly string[]): Promise<readonly PluginAccountDeclarationBodyV1[]> => {
        const lifetime = dependencies.captureLifetime();
        if (!lifetime || !lifetime.isCurrent() || digests.length === 0) return [];
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        let authority: ProjectionRequestAuthority | null = null;
        try {
            authority = await dependencies.captureRequestAuthority(lifetime.scope);
            const body = await postJson(authority, PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'],
                { pluginId, declarationDigests: digests }, controller.signal, 'intent_census', lifetime.scope);
            if (!lifetime.isCurrent()) return [];
            const response = parsePluginAvailabilityResponse(PluginAvailabilityIntentReadActionOutputV1Schema, body,
                'intent_census', lifetime.scope);
            assertIntentResponseIdentity({ pluginId, response }, lifetime.scope);
            const requested = new Set(digests);
            return Object.freeze((response.declarationBodies ?? []).filter(entry => requested.has(entry.declarationDigestSha256)
                && entry.manifest.id === pluginId));
        } catch (error) {
            if (!lifetime.isCurrent()) return [];
            throw error;
        } finally {
            await authority?.release?.();
            retirement.dispose();
        }
    };

    return Object.freeze({ invalidate, requestPlugins, requireFullRefresh, reset, refresh, readDeclarationBodies });
}
