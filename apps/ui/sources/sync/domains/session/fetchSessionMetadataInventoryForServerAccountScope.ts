import { isTokenOnlyAuthCredentials, subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { storage } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { fetchAndApplySessions } from '@/sync/engine/sessions/syncSessions';
import { exhaustSessionListPages } from '@/sync/engine/sessions/exhaustSessionListPages';
import { serverFetch } from '@/sync/http/client';
import {
    captureServerRequestAuthorityForServerAccountScope,
    type ServerAccountRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import {
    applySessionListRenderablePatch,
    buildSessionListRenderableFromSession,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveUiClientEncryptionRequirementForScope } from '@/sync/domains/settings/clientEncryptionRequirement';
import { captureSessionFullPublicationBaseline } from './sessionRuntimeObservation';
import { readSessionSnapshotsForAuthority, SessionSnapshotReadError, ensureSessionDisplayProjectionsForRead } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { readSessionListRowForServerId } from './listing/sessionListRowStateLookup';
import { SESSION_LIST_DOCUMENT_ADMISSION, areSessionListDocumentAdmissionsEqual, hasCurrentSessionListDisplayMetadata } from './sessionDocumentAdmission';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';
import type { SessionListFetchResult } from '@/sync/engine/sessions/sessionSnapshot';

/**
 * One demanded display page under an existing captured Account request. Unlike a mounted list,
 * this finite reader needs no selected-Home runtime and publishes no corpus membership.
 */
export async function fetchSessionListQueryPageForServerAccountScope(params: Readonly<{
    scope: ServerAccountScope;
    query: SessionListQueryV1;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    isCurrent: () => boolean;
    signal?: AbortSignal;
}>): Promise<SessionListFetchResult> {
    const authority = await captureServerRequestAuthorityForServerAccountScope({
        scope: params.scope, activeRequest: params.request, signal: params.signal,
    });
    try {
        const credentials = authority.context.credentials;
        if (!credentials) throw new Error('Scoped Session inventory credentials are unavailable');
        const shouldContinue = () => !params.signal?.aborted && params.isCurrent();
        const encryption = isTokenOnlyAuthCredentials(credentials) ? null : await createEncryptionFromAuthCredentials(credentials);
        const result = await fetchAndApplySessions({
            clientEncryptionRequirement: resolveUiClientEncryptionRequirementForScope({
                scope: params.scope, focusedSettings: storage.getState().settings,
            }),
            serverId: params.scope.serverId,
            source: { kind: 'query', body: params.query, allowV1Fallback: false },
            sessionListPageSize: params.query.limit,
            sessionListCursor: params.query.cursor,
            sessionListMaxPages: 1,
            sessionListAttentionMaxPages: params.query.includeAttention ? 1 : 0,
            requiredHydrationSessionIds: 'all', awaitSessionListHydration: true,
            contentDemand: 'list-projection',
            credentials, encryption, signal: params.signal,
            sessionDataKeys: new Map<string, Uint8Array>(), sessionDataKeyEnvelopes: new Map<string, string>(),
            // Keep the invocation's request proof and cancellation; do not replace it with
            // a background runtime's transport merely because that Home is also mounted.
            request: (path, init) => params.request(path, { ...init, signal: params.signal }),
            getCurrentSessionListRenderable: sessionId => readSessionListRowForServerId(
                storage.getState().sessionListRowsByServerId, params.scope.serverId, sessionId),
            shouldContinue,
            applySessions: () => {},
            applySessionListRenderables: rows => {
                if (shouldContinue()) storage.getState().applyServerScopedSessionListRows(params.scope.serverId, rows,
                    { source: 'rowOnly', mode: 'append' });
            },
            applySessionListRenderablePatches: patches => {
                if (shouldContinue()) storage.getState().applyServerScopedSessionListRowPatches(params.scope.serverId, patches);
            },
            log: { log: () => {} },
        });
        const { prefetchedFullSessionReads: _fullReads, ...page } = result;
        return page;
    } finally { await authority.release(); }
}

export type SessionMetadataInventoryAccountLifetime = Readonly<{
    isCurrent(): boolean;
    onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
}>;

/** Private Agent recipes are opened only for an actual local facet/picker demand. */
export async function hydrateSessionListAgentTargetsForServerAccountScope(params: Readonly<{
    scope: ServerAccountScope;
    sessionIds: readonly string[];
    accountLifetime: SessionMetadataInventoryAccountLifetime;
    signal?: AbortSignal;
}>): Promise<void> {
    const isCurrent = () => !params.signal?.aborted && params.accountLifetime.isCurrent();
    if (!isCurrent()) return;
    const authority = await captureServerRequestAuthorityForServerAccountScope({ scope: params.scope,
        activeRequest: (path, init) => serverFetch(path, init) });
    try {
        if (!isCurrent()) return;
        const candidates = params.sessionIds.filter(id => {
            const row = readSessionListRowForServerId(storage.getState().sessionListRowsByServerId, params.scope.serverId, id);
            return row?.agentTargetKey === undefined && row != null && hasCurrentSessionListDisplayMetadata(row);
        });
        if (candidates.length === 0) return;
        const results = await readSessionSnapshotsForAuthority({ authority, sessionIds: candidates,
            includeTurns: false, signal: params.signal, isCurrent });
        if (!isCurrent()) return;
        let unavailable = false;
        storage.getState().applyServerScopedSessionListRowPatches(params.scope.serverId, candidates.map(sessionId => ({
            sessionId,
            patch: (row) => {
                if (!isCurrent() || row.agentTargetKey !== undefined) return null;
                const result = results.get(sessionId);
                if (!result?.ok) { unavailable = true; return null; }
                const session = result.snapshot.session;
                const admission = row[SESSION_LIST_DOCUMENT_ADMISSION];
                if (session.metadataProjection === 'displayOnly' || !hasCurrentSessionListDisplayMetadata(session)
                    || !areSessionListDocumentAdmissionsEqual(admission, session[SESSION_LIST_DOCUMENT_ADMISSION])
                    || session.metadataVersion !== row.metadataVersion
                    || session.metadataVersion < (admission?.observedMetadataVersion ?? 0)) return null;
                // Use the same full-document resolver as every semantic row; never infer recipes from display flavor.
                return { agentTargetKey: buildSessionListRenderableFromSession(session).agentTargetKey };
            },
        })));
        if (unavailable) throw new SessionSnapshotReadError('agent_target_unavailable');
    } finally {
        await authority.release();
    }
}

type SessionMetadataInventoryAuthority = ServerAccountRequestAuthority;

async function fetchSessionMetadataInventoryWithAuthority(params: Readonly<{
    scope: ServerAccountScope;
    authority: SessionMetadataInventoryAuthority;
    signal: AbortSignal;
    baseline: Readonly<Record<string, SessionListRenderableSession>>;
    fullPublicationBaseline: Readonly<Record<string, number | undefined>>;
}>): Promise<void> {
    const credentials = params.authority.context.credentials;
    if (!credentials) throw new Error('Scoped Session inventory credentials are unavailable');
    if (!areServerAccountScopesEqual(params.authority.scope, params.scope)) {
        throw new Error('Scoped Session inventory authority does not match requested Account');
    }
    const encryption = isTokenOnlyAuthCredentials(credentials)
        ? null
        : await createEncryptionFromAuthCredentials(credentials);
    const sessionDataKeys = new Map<string, Uint8Array>();
    const sessionDataKeyEnvelopes = new Map<string, string>();
    const tuning = loadSyncTuning();
    const shouldContinue = () => !params.signal.aborted;
    const renderablesBySessionId = new Map(Object.entries(params.baseline));
    // Prior rows are the reconciliation basis, not proof of current membership.
    // Keep fetched order and remove absent rows only after the census completes.
    const inventorySessionIds = new Set<string>();
    const publishedBaseline = { ...params.baseline };
    const publishedFullPublicationBaseline = { ...params.fullPublicationBaseline };

    const fetchListing = async (sessionListPath: string | undefined): Promise<void> => {
        let cursor: string | null = null;
        let hasNext = false;
        const fetchPage = async (pageCursor: string | null) => {
            const pageSessionIds = new Set<string>();
            const result = await fetchAndApplySessions({
                clientEncryptionRequirement: resolveUiClientEncryptionRequirementForScope({
                    scope: params.scope,
                    focusedSettings: storage.getState().settings,
                }),
                ...(sessionListPath
                    ? { sessionListPath }
                    : pageCursor === null
                        ? { includeActiveSessionRows: true }
                        : {}),
                sessionListCursor: pageCursor,
                sessionListMaxPages: 1,
                // This explicitly demanded metadata inventory must settle continuation
                // facts while it still holds the fetched ciphertext, not reread detail
                // bodies after an unopened list projection has discarded that input.
                requiredHydrationSessionIds: 'all',
                awaitSessionListHydration: true,
                contentDemand: 'list-projection',
                serverId: params.scope.serverId,
                signal: params.signal,
                credentials,
                encryption,
                sessionDataKeys,
                sessionDataKeyEnvelopes,
                request: (path, init) => params.authority.request(path, { ...init, signal: params.signal }),
                readTransport: params.authority.readTransport,
                // Collected rows win across pages; the captured baseline supplies
                // prior owner provenance without retaining absent inventory members.
                getCurrentSessionListRenderable: (sessionId) => renderablesBySessionId.get(sessionId) ?? null,
                shouldContinue,
                // Stage the page until all of its metadata is admitted. The caller
                // publishes these rows without opening Session entities or owning membership.
                applySessions: (sessions) => {
                    if (!shouldContinue()) return;
                    for (const session of sessions) {
                        renderablesBySessionId.set(session.id, buildSessionListRenderableFromSession(
                            session,
                            renderablesBySessionId.get(session.id),
                        ));
                        pageSessionIds.add(session.id);
                    }
                },
                applySessionListRenderables: (sessions) => {
                    if (!shouldContinue()) return;
                    for (const session of sessions) {
                        renderablesBySessionId.set(session.id, session);
                        pageSessionIds.add(session.id);
                    }
                },
                applySessionListRenderablePatches: (patches) => {
                    if (!shouldContinue()) return;
                    for (const { sessionId, patch } of patches) {
                        const current = renderablesBySessionId.get(sessionId);
                        if (current) {
                            renderablesBySessionId.set(sessionId, applySessionListRenderablePatch(current, patch));
                            pageSessionIds.add(sessionId);
                        }
                    }
                },
                sessionListHydrationConcurrencyLimit: tuning.sessionListHydrationConcurrencyLimit,
                log: { log: () => {} },
            });
            if (shouldContinue()) {
                for (const sessionId of pageSessionIds) inventorySessionIds.add(sessionId);
                const publishedRows = storage.getState().applyServerScopedSessionListRows(
                    params.scope.serverId,
                    [...pageSessionIds].flatMap((sessionId) => {
                        const row = renderablesBySessionId.get(sessionId);
                        return row ? [row] : [];
                    }),
                    { source: 'rowOnly', mode: 'append', baseline: {
                        rows: publishedBaseline,
                        fullPublicationBaseline: publishedFullPublicationBaseline,
                    } },
                );
                if (publishedRows) {
                    Object.assign(publishedBaseline, publishedRows.rows);
                    Object.assign(publishedFullPublicationBaseline, publishedRows.fullPublicationBaseline);
                }
            }
            await ensureSessionDisplayProjectionsForRead({ serverId: params.scope.serverId, credentials,
                request: (path, init) => params.authority.request(path, init),
                prefetched: result.prefetchedFullSessionReads, signal: params.signal, isCurrent: shouldContinue });
            const { prefetchedFullSessionReads: _consumedFullReads, ...publishedResult } = result;
            return publishedResult;
        };
        await exhaustSessionListPages({
            fetchFirstPage: async () => {
                const result = await fetchPage(null);
                cursor = result.nextCursor;
                hasNext = result.hasNext;
            },
            hasNextPage: () => hasNext && Boolean(cursor),
            fetchNextPage: async () => {
                const result = await fetchPage(cursor);
                cursor = result.nextCursor;
                hasNext = result.hasNext;
            },
            shouldContinue,
        });
    };

    await fetchListing(undefined);
    if (shouldContinue()) await fetchListing('/v2/sessions/archived');
    if (shouldContinue()) {
        storage.getState().reconcileSessionListRowsForServerScope(
            params.scope.serverId,
            [...inventorySessionIds].flatMap(sessionId => {
                const row = renderablesBySessionId.get(sessionId);
                return row ? [row] : [];
            }),
            publishedBaseline,
            publishedFullPublicationBaseline,
        );
    }
}

type SessionMetadataInventoryEnsureEntry = {
    controller: AbortController;
    promise: Promise<void>;
    status: 'pending' | 'ready';
    disposeCredentialWatch: () => void;
};

const inventoryEnsures = new Map<string, SessionMetadataInventoryEnsureEntry>();

function inventoryEnsureKey(scope: ServerAccountScope): string {
    return JSON.stringify([scope.serverId, scope.accountId]);
}

function createAbortError(): Error {
    return new DOMException('Aborted', 'AbortError');
}

async function runSessionMetadataInventory(params: Readonly<{
    scope: ServerAccountScope;
    signal: AbortSignal;
}>): Promise<void> {
    let authority: SessionMetadataInventoryAuthority | null = null;
    const baseline = storage.getState().sessionListRowsByServerId[params.scope.serverId] ?? {};
    const fullPublicationBaseline = captureSessionFullPublicationBaseline(params.scope.serverId, Object.keys(baseline));
    try {
        if (params.signal.aborted) throw createAbortError();
        authority = await captureServerRequestAuthorityForServerAccountScope({
            scope: params.scope,
            activeRequest: (path, init) => serverFetch(path, init),
        });
        if (params.signal.aborted) throw createAbortError();
        await fetchSessionMetadataInventoryWithAuthority({
            scope: params.scope,
            authority,
            signal: params.signal,
            baseline,
            fullPublicationBaseline,
        });
    } finally {
        await authority?.release();
    }
}

function waitForInventoryEnsure(params: Readonly<{
    entry: SessionMetadataInventoryEnsureEntry;
    accountLifetime: SessionMetadataInventoryAccountLifetime;
    signal?: AbortSignal;
}>): Promise<void> {
    if (params.signal?.aborted || !params.accountLifetime.isCurrent()) {
        return Promise.reject(createAbortError());
    }
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        let retirement: Readonly<{ dispose(): void }> | null = null;
        const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            params.signal?.removeEventListener('abort', retire);
            retirement?.dispose();
            if (error !== undefined) reject(error);
            else resolve();
        };
        const retire = () => finish(createAbortError());
        retirement = params.accountLifetime.onRetire(retire);
        if (settled) retirement.dispose();
        params.signal?.addEventListener('abort', retire, { once: true });
        // Abort may race the initial check and listener registration.
        if (params.signal?.aborted || !params.accountLifetime.isCurrent()) retire();
        params.entry.promise.then(
            () => finish(),
            (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))),
        );
    });
}

/**
 * Materializes the complete current and archived Session metadata projection for
 * one explicitly selected Home. The exact credential authority—not the active
 * Sync singleton—owns transport and Account identity. A consumer may detach
 * without cancelling shared work; the canonical Home credential mutation
 * aborts that work and fences every store publication. Admitted pages are readable
 * while later pages load; membership and removals reconcile only on completion.
 */
export async function ensureSessionMetadataInventoryForServerAccountScope(params: Readonly<{
    scope: ServerAccountScope;
    accountLifetime: SessionMetadataInventoryAccountLifetime;
    signal?: AbortSignal;
    /** Explicit retry after a reported failure; ordinary consumers reuse ready/in-flight work. */
    refresh?: boolean;
}>): Promise<void> {
    if (params.signal?.aborted || !params.accountLifetime.isCurrent()) throw createAbortError();
    const key = inventoryEnsureKey(params.scope);
    let entry = inventoryEnsures.get(key);
    if (entry?.controller.signal.aborted) {
        entry.disposeCredentialWatch();
        inventoryEnsures.delete(key);
        entry = undefined;
    }
    const projectionExists = params.scope.serverId in storage.getState().sessionListRowsByServerId;
    if (params.refresh || (entry?.status === 'ready' && !projectionExists)) {
        entry?.controller.abort();
        entry?.disposeCredentialWatch();
        inventoryEnsures.delete(key);
        entry = undefined;
    }
    if (!entry) {
        const controller = new AbortController();
        const created: SessionMetadataInventoryEnsureEntry = {
            controller,
            status: 'pending',
            promise: Promise.resolve(),
            disposeCredentialWatch: () => {},
        };
        created.promise = runSessionMetadataInventory({ scope: params.scope, signal: controller.signal })
            .then(() => {
                if (controller.signal.aborted) throw createAbortError();
                created.status = 'ready';
            })
            .catch((error: unknown) => {
                if (inventoryEnsures.get(key) === created) {
                    inventoryEnsures.delete(key);
                    created.disposeCredentialWatch();
                }
                throw error;
            });
        inventoryEnsures.set(key, created);
        created.disposeCredentialWatch = subscribeHomeCredentialMutations((event) => {
            if (!areServerProfileIdentifiersEquivalent(params.scope.serverId, event.serverId)) return;
            created.controller.abort();
            created.disposeCredentialWatch();
            if (inventoryEnsures.get(key) === created) inventoryEnsures.delete(key);
            storage.getState().clearSessionListRowsForServerScope(params.scope.serverId);
        });
        entry = created;
    }
    await waitForInventoryEnsure({
        entry,
        accountLifetime: params.accountLifetime,
        ...(params.signal ? { signal: params.signal } : {}),
    });
}
