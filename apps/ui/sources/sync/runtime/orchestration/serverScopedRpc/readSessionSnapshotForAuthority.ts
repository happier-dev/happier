import type { Session } from '@/sync/domains/state/storageTypes';
import { isTerminalAuthError } from '@/sync/runtime/connectivity/authErrors';
import { fetchSessionByIdWithServerScope, createOperationAccountCurrentnessSource } from './fetchSessionByIdWithServerScope';
import { runWithServerRequestAuthorityForServerAccountScope, type ServerAccountRequestAuthority } from './createServerRequestWithServerScope';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';
import { createTaskLimiter } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import type { SessionByIdPrefetchedRead } from '@/sync/engine/sessions/sessionById';
import { readSessionBatchForAuthority } from './readSessionBatchForAuthority';
import { readSessionDetailAccessProjectionVersion } from '@/sync/api/session/sessionDetailAccessProjection';
import { isSessionAccessRecipient } from '@/sync/engine/sessions/normalizeSessionAccessProjection';

type SessionSnapshot = Omit<Session, 'presence'> & { presence?: 'online' | number };
type SnapshotHydrationContext = Pick<Parameters<typeof fetchSessionByIdWithServerScope>[0], 'getExistingSession'> & Readonly<{
    /** The containing hydration stages these until its currentness checks settle. */
    sessionDataKeys?: Map<string, Uint8Array>;
    sessionDataKeyEnvelopes?: Map<string, string>;
    awaitDisplayProjectionMaintenance?: true;
    /** Read-only full snapshots can omit tuple writer inputs and maintenance. */
    includeMetadataTupleMutationSnapshot?: false;
}>;

/**
 * Typed, content-free failure from the canonical exact-Home Session reader.
 * UI consumers may distinguish authentication loss, unsupported projections,
 * and retryable transport failure without interpreting transport bodies.
 */
export class SessionSnapshotReadError extends Error {
    constructor(
        readonly errorCode: string,
        readonly httpStatus?: number,
    ) {
        super('Session snapshot unavailable');
        this.name = 'SessionSnapshotReadError';
    }
}

/** Reads a fresh Session without publishing it into the active Home's store. */
export async function readSessionSnapshotForAuthority(params: Readonly<{
    authority: ServerAccountRequestAuthority;
    sessionId: string;
    prefetched?: SessionByIdPrefetchedRead;
    /** Interval consumers need an admitted projection, including a successful empty one. */
    requireTurns?: boolean;
    /** Mode/key consumers need the Session, not its turn inventory. */
    includeTurns?: boolean;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
    accountCurrentnessSource?: ReturnType<typeof createOperationAccountCurrentnessSource>;
}> & SnapshotHydrationContext): Promise<Readonly<{ session: SessionSnapshot; callerDataKeyEnvelope: string | null;
    displayProjectionMaintenance?: 'satisfied' | 'deferred' }>> {
    const credentials = params.authority.context.credentials;
    if (!credentials) throw new Error('Session request requires credentials');
    const projection: { session: SessionSnapshot | null } = { session: null };
    const envelopes = params.sessionDataKeyEnvelopes ?? new Map<string, string>();
    let result: Awaited<ReturnType<typeof fetchSessionByIdWithServerScope>>;
    try {
        result = await fetchSessionByIdWithServerScope({
            authority: params.authority,
            serverId: params.authority.scope.serverId,
            sessionId: params.sessionId,
            prefetched: params.prefetched,
            awaitDisplayProjectionMaintenance: params.awaitDisplayProjectionMaintenance,
            includeMetadataTupleMutationSnapshot: params.includeMetadataTupleMutationSnapshot,
            includeTurnsProjection: params.requireTurns ? 'required' : params.includeTurns,
            activeCredentials: credentials,
            activeRequest: params.authority.request,
            sessionDataKeys: params.sessionDataKeys ?? new Map(),
            sessionDataKeyEnvelopes: envelopes,
            applySessions: (sessions) => { projection.session = sessions.find((session) => session.id === params.sessionId) ?? null; },
            log: { log: () => {} },
            isCurrent: params.isCurrent,
            signal: params.signal,
            accountCurrentnessSource: params.accountCurrentnessSource,
            getExistingSession: params.getExistingSession,
        });
    } catch (error) {
        if (isTerminalAuthError(error)) {
            throw new SessionSnapshotReadError('unauthorized');
        }
        throw error;
    }
    if (!result.ok || !projection.session) {
        throw new SessionSnapshotReadError(
            result.errorCode ?? 'unavailable',
            result.httpStatus,
        );
    }
    // Hydration may omit failed optional turns. Required evidence must not turn
    // that absence into a reusable successful snapshot on either transport.
    if (params.requireTurns && !projection.session.sessionTurns) {
        throw new SessionSnapshotReadError('turns_unavailable');
    }
    return { session: projection.session, callerDataKeyEnvelope: envelopes.get(params.sessionId) ?? null,
        ...(result.displayProjectionMaintenance ? { displayProjectionMaintenance: result.displayProjectionMaintenance } : {}) };
}

type SessionSnapshotResult =
    | Readonly<{ ok: true; snapshot: Awaited<ReturnType<typeof readSessionSnapshotForAuthority>> }>
    | Readonly<{ ok: false; error: unknown }>;

/** Batch only the transport; each result passes through the same currentness, access and crypto owner. */
export async function readSessionSnapshotsForAuthority(params: Readonly<{
    authority: ServerAccountRequestAuthority;
    sessionIds: readonly string[];
    /** Full transport parts already captured by the same operation/authority. */
    prefetched?: ReadonlyMap<string, SessionByIdPrefetchedRead>;
    /** The containing maintenance operation's existing work budget, when declared. */
    processingConcurrencyLimit?: number;
    requireTurns?: boolean;
    /** Metadata-only consumers can omit optional turns; required interval evidence still wins. */
    includeTurns?: boolean;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    accountCurrentnessSource?: ReturnType<typeof createOperationAccountCurrentnessSource>;
    /** Each admitted snapshot can be consumed before the remaining batches settle. */
    onResult?: (sessionId: string, result: SessionSnapshotResult) => void;
}> & SnapshotHydrationContext): Promise<ReadonlyMap<string, SessionSnapshotResult>> {
    const credentials = params.authority.context.credentials;
    if (!credentials) throw new Error('Session request requires credentials');
    const currentness = params.accountCurrentnessSource ?? createOperationAccountCurrentnessSource({ credentials,
        request: params.authority.request, serverId: params.authority.scope.serverId });
    const assertCurrent = () => {
        currentness.assertCurrent();
        if (params.signal?.aborted) throw params.signal.reason ?? new SessionSnapshotReadError('cancelled');
        if (params.isCurrent?.() === false) throw new SessionSnapshotReadError('stale_response');
    };
    const opening = new Map<string, Promise<readonly [string, SessionSnapshotResult]>>();
    const schedule = params.processingConcurrencyLimit === undefined
        ? <T>(task: () => Promise<T>) => task()
        : createTaskLimiter(params.processingConcurrencyLimit);
    const accessProjectionVersion = readSessionDetailAccessProjectionVersion(params.authority.scope.serverId);
    const open = async (sessionId: string, detail: SessionByIdPrefetchedRead['detail'] | undefined,
        turns: SessionByIdPrefetchedRead['turns'], projectionVersion: 1 | undefined): Promise<readonly [string, SessionSnapshotResult]> => {
        let result: SessionSnapshotResult;
        try {
            assertCurrent();
            if (!detail) throw new SessionSnapshotReadError('invalid_response');
            const snapshot = await readSessionSnapshotForAuthority({ ...params, sessionId,
                accountCurrentnessSource: currentness, prefetched: { accessProjectionVersion: projectionVersion, detail, turns } });
            await currentness.ensureCurrent();
            assertCurrent();
            result = { ok: true, snapshot };
        } catch (error) { result = { ok: false, error }; }
        // Never disclose even a failure from a retired or cancelled borrower.
        if (!params.signal?.aborted && params.isCurrent?.() !== false && currentness.isCurrent()) {
            params.onResult?.(sessionId, result);
        }
        return [sessionId, result];
    };
    try {
        const sessionIds = [...new Set(params.sessionIds)];
        for (const sessionId of sessionIds) {
            const seed = params.prefetched?.get(sessionId);
            if (seed) {
                const pending = schedule(() => open(sessionId, seed.detail, seed.turns, seed.accessProjectionVersion));
                opening.set(sessionId, pending);
                void pending.catch(() => {});
            }
        }
        await readSessionBatchForAuthority({ ...params, sessionIds: sessionIds.filter(id => !opening.has(id)),
            accessProjectionVersion, includeSnapshot: true,
            includeTurns: params.requireTurns ? true : params.includeTurns, includeMessages: false, assertCurrent,
            onResult: (sessionId, row) => {
                const pending = schedule(() => open(sessionId, row.detail, row.turns, accessProjectionVersion));
                opening.set(sessionId, pending);
                // Keep rejection custody until the physical reader settles.
                void pending.catch(() => {});
            } });
        const results = await Promise.all(sessionIds.map(id => opening.get(id)!));
        await currentness.ensureCurrent();
        assertCurrent();
        return new Map(results);
    } finally {
        // Opening may already be in flight when a later physical batch fails.
        // Keep currentness alive through those admissions and progress callbacks.
        await Promise.allSettled(opening.values());
        if (!params.accountCurrentnessSource) currentness.dispose();
    }
}

/**
 * Finish the already-authorized list read through the full snapshot/tuple owner.
 * Retained inventory adds known IDs to that same batch; fetched parts are reused,
 * and no full Session is published merely because its display needed backfill.
 */
export async function ensureSessionDisplayProjectionsForRead(params: Readonly<{
    serverId?: string | null;
    credentials: AuthCredentials;
    request: (path: string, init: RequestInit) => Promise<Response>;
    prefetched?: ReadonlyMap<string, SessionByIdPrefetchedRead>;
    sessionIds?: readonly string[];
    processingConcurrencyLimit?: number;
    isCurrent: () => boolean;
    signal?: AbortSignal;
}>): Promise<boolean> {
    const sessionIds = [...new Set([...(params.prefetched?.keys() ?? []), ...(params.sessionIds ?? [])])];
    if (!sessionIds.length) return true;
    if (!params.serverId || !params.isCurrent() || params.signal?.aborted
        || readCredentialAuthorityKind(params.credentials.token) !== 'account') return false;
    const scopeKey = resolveAuthCredentialsScopeKey(params.credentials);
    try {
        return await runWithServerRequestAuthorityForServerAccountScope({ serverId: params.serverId,
            activeRequest: (path, init) => params.request(path, init ?? {}) }, async authority => {
            if (!params.isCurrent() || !authority.context.credentials
                || resolveAuthCredentialsScopeKey(authority.context.credentials) !== scopeKey) return false;
            const results = await readSessionSnapshotsForAuthority({ authority, sessionIds,
                awaitDisplayProjectionMaintenance: true,
                prefetched: params.prefetched, includeTurns: false, signal: params.signal,
                processingConcurrencyLimit: params.processingConcurrencyLimit ?? loadSyncTuning().resumeConcurrencyLimit,
                isCurrent: params.isCurrent });
            const satisfied = params.isCurrent() && [...results.values()].every(result => result.ok
                && (result.snapshot.displayProjectionMaintenance === 'satisfied'
                    || isSessionAccessRecipient(result.snapshot.session.access, result.snapshot.session.accessLevel)));
            if (!satisfied && params.isCurrent()) {
                console.warn('[SessionDisplay] Full tuple maintenance unavailable; readable list display retained');
            }
            return satisfied;
        });
    } catch {
        console.warn('[SessionDisplay] Full tuple maintenance deferred; readable list display retained');
        return false;
    }
}

/** Draft pages consume the ordinary admitted mode/key path without opening Session content. */
export async function readSessionEncryptionContextsForAuthority(params: Readonly<{
    authority: ServerAccountRequestAuthority;
    sessionIds: readonly string[];
    sessionDataKeys: Map<string, Uint8Array>;
    sessionDataKeyEnvelopes: Map<string, string>;
    accountCurrentnessSource: ReturnType<typeof createOperationAccountCurrentnessSource>;
    isCurrent: () => boolean;
}>): Promise<ReadonlyMap<string, Awaited<ReturnType<typeof fetchSessionByIdWithServerScope>>>> {
    const credentials = params.authority.context.credentials;
    if (!credentials) throw new Error('Session request requires credentials');
    const assertCurrent = () => {
        params.accountCurrentnessSource.assertCurrent();
        if (!params.isCurrent()) throw new SessionSnapshotReadError('stale_response');
    };
    const accessProjectionVersion = readSessionDetailAccessProjectionVersion(params.authority.scope.serverId);
    const rows = await readSessionBatchForAuthority({ ...params, accessProjectionVersion,
        includeSnapshot: true, includeTurns: false, includeMessages: false, assertCurrent });
    const results = await Promise.all([...rows].map(async ([sessionId, row]) => {
        assertCurrent();
        if (!row.detail) throw new SessionSnapshotReadError('invalid_response');
        const result = await fetchSessionByIdWithServerScope({
            authority: params.authority, serverId: params.authority.scope.serverId, sessionId,
            prefetched: { accessProjectionVersion, detail: row.detail }, contentDemand: 'encryption-context',
            activeCredentials: credentials, activeEncryption: params.authority.context.encryption, activeRequest: params.authority.request,
            sessionDataKeys: params.sessionDataKeys, sessionDataKeyEnvelopes: params.sessionDataKeyEnvelopes,
            accountCurrentnessSource: params.accountCurrentnessSource, isCurrent: params.isCurrent,
            applySessions: () => {}, log: { log: () => {} },
        });
        assertCurrent();
        return [sessionId, result] as const;
    }));
    await params.accountCurrentnessSource.ensureCurrent();
    assertCurrent();
    return new Map(results);
}
