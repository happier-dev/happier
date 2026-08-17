import {
    PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    PluginCollectionUiQueryErrorV1Schema,
    PluginCollectionUiQueryRequestV1Schema,
    PluginCollectionUiQueryResultV1Schema,
    validatePluginCollectionUiQueryParametersV1,
    validatePluginCollectionUiQueryResultV1,
    type NormalizedPluginCollectionUiQueryDescriptorV1,
    type PluginCollectionUiQueryErrorV1,
    type PluginCollectionUiQueryRequestV1,
    type PluginCollectionUiQueryResultV1,
} from '@happier-dev/protocol';
import { PluginDomainChangeEntrySchema } from '@happier-dev/protocol/changes';

import { apiSocket } from '@/sync/api/session/apiSocket';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    resolveAccountStoredContentCompatibilityHeaders,
    withAccountStoredContentCompatibilityRequestDeclaration,
    type AccountStoredContentCompatibilityUnavailableReason,
} from '@/sync/http/accountStoredContentCompatibility';
import { captureSessionRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';

export const PLUGIN_COLLECTION_UI_QUERY_PATH_V1 = '/v1/plugins/data/ui-query';

export type ActivePluginCollectionUiQueryInput = Readonly<{
    descriptor: NormalizedPluginCollectionUiQueryDescriptorV1;
    request: PluginCollectionUiQueryRequestV1;
}>;

export type PluginCollectionUiQueryUnavailableV1 = Readonly<{
    status: 'unavailable';
    reason: AccountStoredContentCompatibilityUnavailableReason;
}>;

export type PluginCollectionUiQueryOutcomeV1 =
    | PluginCollectionUiQueryResultV1
    | PluginCollectionUiQueryErrorV1
    | PluginCollectionUiQueryUnavailableV1;

export type PluginCollectionUiQueryWatchV1 = Readonly<{
    dispose(): void;
}>;

/**
 * A content-free, level-triggered collection wakeup. This is shared by the
 * static UI-query adapter and direct collection clients so AccountChange has
 * one local subscriber registry rather than a second UI change broker.
 */
export type PluginCollectionChangeWatchV1 = PluginCollectionUiQueryWatchV1;

export type WatchActivePluginCollectionChangesInput = Readonly<{
    pluginId: string;
    collectionId: string;
    onInvalidated(): void;
    /** A resolved direct client must retain its existing Account lifetime. */
    accountLifetime?: ActiveServerAccountScopeLifetime;
}>;

export type PluginCollectionUiQueryPagerSnapshotV1 = Readonly<{
    /** One bounded server page; the opaque continuation never leaves Data. */
    rows: readonly PluginCollectionUiQueryResultV1['rows'][number][];
    hasMore: boolean;
    status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
    /** A terminal server outcome, preserved in the Protocol's exact vocabulary. */
    error?: PluginCollectionUiQueryErrorV1;
}>;

export type ActivePluginCollectionUiQueryPagerV1 = Readonly<{
    getSnapshot(): PluginCollectionUiQueryPagerSnapshotV1;
    subscribe(listener: () => void): () => void;
    /** Replaces the current page with page one through the captured Account scope. */
    refresh(): Promise<void>;
    /** Advances Data's private query-bound cursor and replaces the bounded page. */
    loadMore(): Promise<void>;
    dispose(): void;
}>;

export type WatchActivePluginCollectionUiQueryInput = ActivePluginCollectionUiQueryInput & Readonly<{
    /**
     * Content-free, level-triggered wakeup. Consumers must re-query through
     * this module; neither AccountChange nor this watch carries collection
     * fields, row content, cursors, or credentials.
     */
    onInvalidated(): void;
}>;

export type ActivePluginCollectionUiQueryBindingV1 = Readonly<{
    /** A facade passes its existing sole Account lifetime; standalone callers capture normally. */
    accountLifetime?: ActiveServerAccountScopeLifetime;
    /** The mounted consumer's cancellation applies to every page operation. */
    signal?: AbortSignal;
}>;

type ActivePluginCollectionUiQueryWatch = Readonly<{
    pluginId: string;
    collectionId: string;
    lifetime: ActiveServerAccountScopeLifetime;
    onInvalidated: () => void;
}>;

type CapturedActivePluginCollectionUiQuery = Readonly<{
    input: ActivePluginCollectionUiQueryInput;
    request: PluginCollectionUiQueryRequestV1;
    lifetime: ActiveServerAccountScopeLifetime;
    serverSnapshot: ReturnType<typeof getActiveServerSnapshot>;
    signal?: AbortSignal;
}>;

const activePluginCollectionUiQueryWatches = new Set<ActivePluginCollectionUiQueryWatch>();

function assertLifetimeCurrent(lifetime: ActiveServerAccountScopeLifetime): void {
    if (!lifetime.isCurrent()) {
        throw new Error('Active Account scope changed while querying plugin collection data.');
    }
}

function assertServerGenerationCurrent(snapshot: ReturnType<typeof getActiveServerSnapshot>): void {
    const current = getActiveServerSnapshot();
    if (current.serverId !== snapshot.serverId || current.generation !== snapshot.generation) {
        throw new Error('Active server generation changed while querying plugin collection data.');
    }
}

function validateResponseIdentity(
    result: PluginCollectionUiQueryResultV1,
    request: PluginCollectionUiQueryRequestV1,
): void {
    for (const row of result.rows) {
        if (row.context.collection.pluginId !== request.pluginId
            || row.context.collection.collectionId !== request.collectionId) {
            throw new Error('Plugin collection UI query returned a row for a different collection.');
        }
    }
}

function validateActivePluginCollectionUiQueryInput(
    input: ActivePluginCollectionUiQueryInput,
): PluginCollectionUiQueryRequestV1 {
    const request = PluginCollectionUiQueryRequestV1Schema.parse(input.request);
    if (request.cursor !== undefined) {
        throw new Error('Plugin collection UI query cursors are owned by the Data pager.');
    }
    if (
        request.pluginId !== input.descriptor.collection.pluginId
        || request.collectionId !== input.descriptor.collection.collectionId
        || request.uiQueryId !== input.descriptor.id
    ) {
        throw new Error('Plugin collection UI query does not match its admitted descriptor.');
    }
    validatePluginCollectionUiQueryParametersV1(input.descriptor, request.parameters);
    return request;
}

function captureActivePluginCollectionUiQuery(
    input: ActivePluginCollectionUiQueryInput,
    binding?: ActivePluginCollectionUiQueryBindingV1,
): CapturedActivePluginCollectionUiQuery {
    const request = validateActivePluginCollectionUiQueryInput(input);
    const lifetime = binding?.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (!lifetime) {
        throw new Error('No active Account scope is available for plugin collection data.');
    }
    assertLifetimeCurrent(lifetime);
    const serverSnapshot = getActiveServerSnapshot();
    if (serverSnapshot.serverId !== lifetime.scope.serverId) {
        throw new Error('Active server does not match the active Account scope.');
    }
    return {
        input,
        request,
        lifetime,
        serverSnapshot,
        ...(binding?.signal ? { signal: binding.signal } : {}),
    };
}

async function executeCapturedActivePluginCollectionUiQuery(
    captured: CapturedActivePluginCollectionUiQuery,
    options?: Readonly<{
        cursor?: string;
        signal?: AbortSignal;
    }>,
): Promise<PluginCollectionUiQueryOutcomeV1> {
    const request = options?.cursor === undefined
        ? captured.request
        : { ...captured.request, cursor: options.cursor };
    const compatibility = resolveAccountStoredContentCompatibilityHeaders(
        { 'Content-Type': 'application/json' },
        {
            serverUrl: captured.serverSnapshot.serverUrl,
            declaration: PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
        },
    );
    if (compatibility.status === 'unavailable') {
        return { status: 'unavailable', reason: compatibility.reason };
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    const retirement = captured.lifetime.onRetire(abort);
    const signals = [captured.signal, options?.signal];
    for (const signal of signals) signal?.addEventListener('abort', abort, { once: true });
    if (signals.some((signal) => signal?.aborted)) abort();
    try {
        const authority = await captureSessionRequestAuthorityForServerAccountScope({
            scope: captured.lifetime.scope,
            activeRequest: (path, init) => apiSocket.request(path, init),
        });
        assertLifetimeCurrent(captured.lifetime);
        assertServerGenerationCurrent(captured.serverSnapshot);

        const response = await authority.request(
            PLUGIN_COLLECTION_UI_QUERY_PATH_V1,
            withAccountStoredContentCompatibilityRequestDeclaration({
                method: 'POST',
                headers: compatibility.headers,
                body: JSON.stringify(request),
                signal: controller.signal,
            }, PLUGIN_DATA_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
        );
        assertLifetimeCurrent(captured.lifetime);
        assertServerGenerationCurrent(captured.serverSnapshot);
        const body = await response.json();
        assertLifetimeCurrent(captured.lifetime);
        assertServerGenerationCurrent(captured.serverSnapshot);
        if (!response.ok) {
            const error = PluginCollectionUiQueryErrorV1Schema.safeParse(body);
            if (error.success) return error.data;
            throw new Error(`Plugin collection UI query request failed with status ${response.status}.`);
        }

        const result = PluginCollectionUiQueryResultV1Schema.parse(body);
        assertLifetimeCurrent(captured.lifetime);
        assertServerGenerationCurrent(captured.serverSnapshot);
        const validated = validatePluginCollectionUiQueryResultV1(captured.input.descriptor, result);
        validateResponseIdentity(validated, request);
        return validated;
    } finally {
        for (const signal of signals) signal?.removeEventListener('abort', abort);
        retirement.dispose();
    }
}

function registerActivePluginCollectionUiQueryWatch(input: Readonly<{
    pluginId: string;
    collectionId: string;
    lifetime: ActiveServerAccountScopeLifetime;
    onInvalidated(): void;
}>): PluginCollectionUiQueryWatchV1 {
    const watch: ActivePluginCollectionUiQueryWatch = Object.freeze({
        pluginId: input.pluginId,
        collectionId: input.collectionId,
        lifetime: input.lifetime,
        onInvalidated: input.onInvalidated,
    });
    let disposed = false;
    let retirement: Readonly<{ dispose(): void }> | null = null;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        activePluginCollectionUiQueryWatches.delete(watch);
        retirement?.dispose();
        retirement = null;
    };

    activePluginCollectionUiQueryWatches.add(watch);
    retirement = input.lifetime.onRetire(dispose);
    if (!input.lifetime.isCurrent()) dispose();
    return Object.freeze({ dispose });
}

function notifyWatches(watches: Iterable<ActivePluginCollectionUiQueryWatch>): void {
    for (const watch of watches) {
        if (!activePluginCollectionUiQueryWatches.has(watch) || !watch.lifetime.isCurrent()) continue;
        try {
            watch.onInvalidated();
        } catch {
            // A presentation callback cannot corrupt the canonical Account
            // change stream or retain a stale Account scope.
        }
    }
}

/**
 * Registers the Data-owned level-triggered wakeup before a consumer performs
 * its initial read. The existing Account-change pipeline calls the publisher
 * below; this module filters the closed content-free Data hint by collection.
 */
export function watchActivePluginCollectionUiQuery(
    input: WatchActivePluginCollectionUiQueryInput,
): PluginCollectionUiQueryWatchV1 {
    const request = validateActivePluginCollectionUiQueryInput(input);
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) {
        throw new Error('No active Account scope is available for plugin collection data.');
    }
    assertLifetimeCurrent(lifetime);
    return registerActivePluginCollectionUiQueryWatch({
        pluginId: request.pluginId,
        collectionId: request.collectionId,
        lifetime,
        onInvalidated: input.onInvalidated,
    });
}

/**
 * Registers the same Data-owned collection wakeup used by static UI queries.
 * A direct client captures the current Account scope here; it owns no global
 * store, scope epoch, or AccountChange producer.
 */
export function watchActivePluginCollectionChanges(
    input: WatchActivePluginCollectionChangesInput,
): PluginCollectionChangeWatchV1 | null {
    const lifetime = input.accountLifetime ?? captureActiveServerAccountScopeLifetime();
    if (!lifetime || !lifetime.isCurrent()) return null;
    return registerActivePluginCollectionUiQueryWatch({
        pluginId: input.pluginId,
        collectionId: input.collectionId,
        lifetime,
        onInvalidated: input.onInvalidated,
    });
}

/**
 * Called only from the existing AccountChange application path. One page
 * coalesces to at most one wakeup per watched collection and unparseable or
 * non-Data changes are deliberately ignored.
 */
export function publishActivePluginCollectionUiQueryChanges(changes: readonly unknown[]): void {
    publishActivePluginCollectionChanges(changes);
}

/**
 * Shared AccountChange projection for every current UI collection consumer.
 * The hint remains content-free and collection-scoped.
 */
export function publishActivePluginCollectionChanges(changes: readonly unknown[]): void {
    const affected = new Set<ActivePluginCollectionUiQueryWatch>();
    for (const rawChange of changes) {
        const parsed = PluginDomainChangeEntrySchema.safeParse(rawChange);
        if (!parsed.success || parsed.data.hint.pluginDomain !== 'dataCollection') continue;
        const { pluginId, collectionId } = parsed.data.hint;
        for (const watch of activePluginCollectionUiQueryWatches) {
            if (watch.pluginId === pluginId && watch.collectionId === collectionId) {
                affected.add(watch);
            }
        }
    }
    notifyWatches(affected);
}

/**
 * A retained cursor can fall below the server retention floor. A successful
 * canonical snapshot repairs that gap, so every current Data query gets one
 * content-free wakeup and re-reads through the normal authenticated route.
 */
export function resetActivePluginCollectionUiQueryWatches(): void {
    resetActivePluginCollectionChanges();
}

/** A canonical snapshot repair invalidates every current collection consumer. */
export function resetActivePluginCollectionChanges(): void {
    notifyWatches(activePluginCollectionUiQueryWatches);
}

function freezePagerRows(
    rows: readonly PluginCollectionUiQueryResultV1['rows'][number][],
): PluginCollectionUiQueryPagerSnapshotV1['rows'] {
    return Object.freeze(rows.map((row) => Object.freeze({
        context: Object.freeze({
            collection: Object.freeze({ ...row.context.collection }),
            rowId: row.context.rowId,
            revision: row.context.revision,
        }),
        fields: Object.freeze({ ...row.fields }),
    })));
}

function freezePagerSnapshot(input: PluginCollectionUiQueryPagerSnapshotV1): PluginCollectionUiQueryPagerSnapshotV1 {
    return Object.freeze({
        ...input,
        rows: freezePagerRows(input.rows),
        ...(input.error ? { error: Object.freeze({ ...input.error }) } : {}),
    });
}

/**
 * Data owns the opaque UI-query continuation. The presentation consumer sees
 * one bounded page plus `hasMore`, while refresh/change recovery resets the
 * continuation before rereading page one. The only Account currentness is the
 * captured shared lifetime; `readEpoch` merely discards superseded page work.
 */
export function createActivePluginCollectionUiQueryPager(
    input: ActivePluginCollectionUiQueryInput,
    binding?: ActivePluginCollectionUiQueryBindingV1,
): ActivePluginCollectionUiQueryPagerV1 {
    const captured = captureActivePluginCollectionUiQuery(input, binding);
    let disposed = false;
    let readEpoch = 0;
    let nextCursor: string | null = null;
    let pending: 'refresh' | 'loadMore' | null = null;
    let inFlight: Promise<void> | null = null;
    let inFlightAbort: AbortController | null = null;
    let snapshot = freezePagerSnapshot({ status: 'idle', rows: [], hasMore: false });
    const listeners = new Set<() => void>();

    const publishSnapshot = (next: PluginCollectionUiQueryPagerSnapshotV1): void => {
        if (disposed) return;
        snapshot = freezePagerSnapshot(next);
        for (const listener of listeners) {
            try {
                listener();
            } catch {
                // Presentation listeners cannot affect the authenticated query
                // owner, its currentness, or the canonical Account-change path.
            }
        }
    };

    const run = (): Promise<void> => {
        if (disposed) return Promise.resolve();
        if (inFlight) return inFlight;
        inFlight = Promise.resolve().then(async () => {
            while (!disposed && pending !== null) {
                const operation = pending;
                pending = null;
                const operationEpoch = readEpoch;
                const cursor = operation === 'loadMore' ? nextCursor : null;
                if (operation === 'loadMore' && cursor === null) continue;

                const controller = new AbortController();
                inFlightAbort = controller;
                publishSnapshot({
                    status: 'loading',
                    rows: snapshot.rows,
                    hasMore: operation === 'loadMore' && cursor !== null,
                });
                try {
                    const outcome = await executeCapturedActivePluginCollectionUiQuery(captured, {
                        ...(cursor !== null ? { cursor } : {}),
                        signal: controller.signal,
                    });
                    if (
                        disposed
                        || operationEpoch !== readEpoch
                        || !captured.lifetime.isCurrent()
                    ) {
                        continue;
                    }
                    if ('rows' in outcome) {
                        nextCursor = outcome.nextCursor ?? null;
                        publishSnapshot({
                            status: 'ready',
                            rows: outcome.rows,
                            hasMore: nextCursor !== null,
                        });
                    } else if ('error' in outcome) {
                        publishSnapshot({
                            status: 'error',
                            rows: snapshot.rows,
                            hasMore: operation === 'loadMore' && cursor !== null,
                            error: outcome,
                        });
                    } else {
                        nextCursor = null;
                        publishSnapshot({ status: 'unavailable', rows: [], hasMore: false });
                    }
                } catch {
                    if (
                        disposed
                        || operationEpoch !== readEpoch
                        || !captured.lifetime.isCurrent()
                    ) {
                        continue;
                    }
                    publishSnapshot({
                        status: 'error',
                        rows: snapshot.rows,
                        hasMore: operation === 'loadMore' && cursor !== null,
                    });
                } finally {
                    if (inFlightAbort === controller) inFlightAbort = null;
                }
            }
        }).finally(() => {
            inFlight = null;
            if (!disposed && pending !== null) void run();
        });
        return inFlight;
    };

    const refresh = (): Promise<void> => {
        if (disposed) return Promise.resolve();
        if (pending !== 'refresh') {
            readEpoch += 1;
            nextCursor = null;
            pending = 'refresh';
            inFlightAbort?.abort();
        }
        return run();
    };

    const loadMore = (): Promise<void> => {
        if (disposed || nextCursor === null || pending === 'refresh' || inFlight !== null) {
            return inFlight ?? Promise.resolve();
        }
        pending = 'loadMore';
        return run();
    };

    let watch: PluginCollectionUiQueryWatchV1 | null = null;
    let retirement: Readonly<{ dispose(): void }> | null = null;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        readEpoch += 1;
        pending = null;
        inFlightAbort?.abort();
        inFlightAbort = null;
        watch?.dispose();
        watch = null;
        retirement?.dispose();
        retirement = null;
        captured.signal?.removeEventListener('abort', dispose);
        // Account retirement is observable synchronously through the pager.
        // Clear the last page before listeners are released so a mounted
        // consumer cannot continue rendering Account A rows after the shared
        // Account lifetime has become stale.
        snapshot = freezePagerSnapshot({ status: 'idle', rows: [], hasMore: false });
        for (const listener of listeners) {
            try {
                listener();
            } catch {
                // A presentation listener cannot retain stale Account data.
            }
        }
        listeners.clear();
    };

    watch = registerActivePluginCollectionUiQueryWatch({
        pluginId: captured.request.pluginId,
        collectionId: captured.request.collectionId,
        lifetime: captured.lifetime,
        onInvalidated: () => { void refresh(); },
    });
    retirement = captured.lifetime.onRetire(dispose);
    captured.signal?.addEventListener('abort', dispose, { once: true });
    if (!captured.lifetime.isCurrent() || captured.signal?.aborted) dispose();

    return Object.freeze({
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
            if (disposed) return () => {};
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        refresh,
        loadMore,
        dispose,
    });
}

/**
 * The sole ordinary UI direct-client adapter for a statically admitted
 * collection UI query. Scope lifetime, credentials, and server generation are
 * captured from existing owners; this function owns neither a store nor a
 * secondary Account reset/currentness mechanism.
 */
export async function queryActivePluginCollectionUiQuery(
    input: ActivePluginCollectionUiQueryInput,
): Promise<PluginCollectionUiQueryOutcomeV1> {
    return await executeCapturedActivePluginCollectionUiQuery(
        captureActivePluginCollectionUiQuery(input),
    );
}
