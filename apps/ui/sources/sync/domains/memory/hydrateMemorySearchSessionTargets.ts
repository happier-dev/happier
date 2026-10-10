import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import {
    captureServerRequestAuthorityForServerAccountScope,
    type ServerAccountRequestAuthority,
} from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { areServerAccountScopesEqual, createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { serverFetch } from '@/sync/http/client';
import { runTasksWithLimit } from '@/sync/runtime/orchestration/runTasksWithLimit';
import { isMemorySessionSearchHitV1, type MemorySearchResultV1 } from '@happier-dev/protocol/memory/memorySearch';
import { fetchSessionByIdWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/fetchSessionByIdWithServerScope';
import type { Session } from '@/sync/domains/state/storageTypes';
import { storage } from '@/sync/domains/state/storage';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';

export type MemorySearchSessionTargetV1 = Readonly<{
    sessionKey: string;
    serverId: string;
    accountId: string;
    sessionId: string;
}>;

export type MemorySearchSessionRead = Readonly<{
    ok: boolean;
    /** Highest server sequence currently visible to the captured Account. */
    visibleThroughSeq?: number;
    errorCode?: string;
}>;

export async function captureMemorySearchSessionReadAuthority(input: Readonly<{
    serverId: string;
    accountId: string;
}>): Promise<ServerAccountRequestAuthority> {
    // The capture owner addresses either an exact scope or a bare Home; an
    // unusable pair fails closed with the same message the owner raises.
    const scope = createServerAccountScope(input.serverId, input.accountId);
    if (!scope) throw new Error('Account-scoped request requires an explicit Home');
    return await captureServerRequestAuthorityForServerAccountScope({
        scope,
        activeRequest: (path, init) => serverFetch(path, init),
    });
}

export function readMemorySearchSessionHydrationConcurrencyLimit(): number {
    return getSyncSingleton().getSyncTuning().sessionListHydrationConcurrencyLimit;
}

/**
 * Authorizes transcript hits for their exact Account and server scope.
 *
 * A transcript index — daemon-local or Home-derived — is derived state that can
 * outlive the Account's access to a Session. Every hit is therefore read through the
 * canonical explicit-server Session reader before it can be displayed or activated;
 * a locally projected Session is not evidence for the producing Account lifetime. A missing
 * authorization, a missing Session, or an unreadable target suppresses the row
 * rather than showing a stale entity — and the same read supplies the canonical
 * metadata a normal Session row needs.
 */
export async function hydrateMemorySearchSessionTargets<TAuthority>(params: Readonly<{
    targets: readonly MemorySearchSessionTargetV1[];
    authority: TAuthority;
    accountLifetime: Readonly<{
        isCurrent(): boolean;
        onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
    }>;
    readSessionForServerScope: (
        args: Readonly<{
            target: MemorySearchSessionTargetV1;
            authority: TAuthority;
            signal: AbortSignal;
        }>,
    ) => Promise<MemorySearchSessionRead>;
    concurrencyLimit: number;
    signal?: AbortSignal;
}>): Promise<readonly MemorySearchSessionTargetV1[]> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (params.signal?.aborted) abort();
    else params.signal?.addEventListener('abort', abort, { once: true });
    const retirement = params.accountLifetime.onRetire(abort);
    try {
        const reads = await runTasksWithLimit(
            params.targets.map((target) => async () => {
                if (controller.signal.aborted || !params.accountLifetime.isCurrent()) return null;
                try {
                    const read = await params.readSessionForServerScope({
                        target,
                        authority: params.authority,
                        signal: controller.signal,
                    });
                    return read.ok && !controller.signal.aborted && params.accountLifetime.isCurrent()
                        ? read
                        : null;
                } catch {
                    // Unreadable target: keep the surface coherent by suppressing the
                    // row instead of presenting an entity we cannot authorize.
                    return null;
                }
            }),
            params.concurrencyLimit,
        );
        return controller.signal.aborted || !params.accountLifetime.isCurrent()
            ? []
            : params.targets.filter((_, index) => reads[index]?.ok === true);
    } finally {
        retirement.dispose();
        params.signal?.removeEventListener('abort', abort);
    }
}

/**
 * Applies the incumbent exact-server Session authorization owner to every
 * retained daemon result before a public Action can receive its summary.
 */
export async function authorizeMemorySearchResult<TAuthority>(params: Readonly<{
    result: MemorySearchResultV1;
    serverId: string;
    accountId: string;
    authority: TAuthority;
    accountLifetime: Readonly<{
        isCurrent(): boolean;
        onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
    }>;
    readSessionForServerScope: (
        args: Readonly<{
            target: MemorySearchSessionTargetV1;
            authority: TAuthority;
            signal: AbortSignal;
        }>,
    ) => Promise<MemorySearchSessionRead>;
    concurrencyLimit: number;
    signal?: AbortSignal;
}>): Promise<MemorySearchResultV1> {
    if (!params.result.ok) return params.result;
    const targets = [...new Set(params.result.hits.flatMap((hit) =>
        isMemorySessionSearchHitV1(hit) ? [hit.sessionId] : [],
    ))].map((sessionId) => ({
        sessionKey: `${params.accountId}:${params.serverId}:${sessionId}`,
        serverId: params.serverId,
        accountId: params.accountId,
        sessionId,
    }));
    const visibleThroughSeqBySessionId = new Map<string, number>();
    const authorizedTargets = await hydrateMemorySearchSessionTargets({
        targets,
        authority: params.authority,
        accountLifetime: params.accountLifetime,
        readSessionForServerScope: async (args) => {
            const read = await params.readSessionForServerScope(args);
            const visibleThroughSeq = read.visibleThroughSeq;
            if (
                !read.ok
                || typeof visibleThroughSeq !== 'number'
                || !Number.isSafeInteger(visibleThroughSeq)
                || visibleThroughSeq < 0
            ) {
                return { ok: false, errorCode: read.errorCode ?? 'session_visibility_unavailable' };
            }
            visibleThroughSeqBySessionId.set(args.target.sessionId, visibleThroughSeq);
            return read;
        },
        concurrencyLimit: params.concurrencyLimit,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    const authorizedSessionIds = new Set(authorizedTargets.map((target) => target.sessionId));
    return {
        ...params.result,
        hits: params.result.hits.filter((hit) => {
            if (!isMemorySessionSearchHitV1(hit)) {
                // Artifact currentness/access has already been qualified by the
                // daemon. Preserve the same captured Account lifetime here.
                return params.accountLifetime.isCurrent() && !params.signal?.aborted;
            }
            const visibleThroughSeq = visibleThroughSeqBySessionId.get(hit.sessionId);
            return authorizedSessionIds.has(hit.sessionId)
                && visibleThroughSeq !== undefined
                && hit.seqFrom <= visibleThroughSeq
                && hit.seqTo <= visibleThroughSeq;
        }),
    };
}

/** Authorizes a retained daemon window against the caller's current Session projection. */
export async function authorizeMemorySessionRange<TAuthority>(params: Readonly<{
    target: MemorySearchSessionTargetV1;
    seqFrom: number;
    seqTo: number;
    authority: TAuthority;
    accountLifetime: Readonly<{
        isCurrent(): boolean;
        onRetire(cancel: () => void): Readonly<{ dispose(): void }>;
    }>;
    readSessionForServerScope: (
        args: Readonly<{
            target: MemorySearchSessionTargetV1;
            authority: TAuthority;
            signal: AbortSignal;
        }>,
    ) => Promise<MemorySearchSessionRead>;
    signal?: AbortSignal;
}>): Promise<boolean> {
    let visibleThroughSeq: number | null = null;
    const authorized = await hydrateMemorySearchSessionTargets({
        targets: [params.target],
        authority: params.authority,
        accountLifetime: params.accountLifetime,
        readSessionForServerScope: async (args) => {
            const read = await params.readSessionForServerScope(args);
            if (
                !read.ok
                || typeof read.visibleThroughSeq !== 'number'
                || !Number.isSafeInteger(read.visibleThroughSeq)
                || read.visibleThroughSeq < 0
            ) {
                return { ok: false, errorCode: read.errorCode ?? 'session_visibility_unavailable' };
            }
            visibleThroughSeq = read.visibleThroughSeq;
            return read;
        },
        concurrencyLimit: 1,
        ...(params.signal ? { signal: params.signal } : {}),
    });
    return authorized.length === 1
        && visibleThroughSeq !== null
        && params.seqFrom <= visibleThroughSeq
        && params.seqTo <= visibleThroughSeq;
}

/**
 * Default binding of the explicit-server Session reader for the search surfaces.
 * It never falls back to the focused server: the hit's own captured server scope is
 * the request target.
 */
export async function readMemorySearchSessionForServerScope(
    args: Readonly<{
        target: MemorySearchSessionTargetV1;
        authority: ServerAccountRequestAuthority;
        signal: AbortSignal;
    }>,
): Promise<MemorySearchSessionRead> {
    const targetScope = createServerAccountScope(args.target.serverId, args.target.accountId);
    if (!areServerAccountScopesEqual(args.authority.scope, targetScope)) {
        return { ok: false, errorCode: 'account_scope_mismatch' };
    }
    const credentials = args.authority.context.credentials;
    if (!credentials) return { ok: false, errorCode: 'credentials_unavailable' };
    const hydratedRef: { current: Session | null } = { current: null };
    const result = await fetchSessionByIdWithServerScope({
        sessionId: args.target.sessionId,
        serverId: args.target.serverId,
        activeCredentials: credentials,
        activeRequest: (path, init) => args.authority.request(path, { ...init, signal: args.signal }),
        authority: {
            ...args.authority,
            request: (path, init) => args.authority.request(path, { ...init, signal: args.signal }),
        },
        sessionDataKeys: new Map(),
        sessionDataKeyEnvelopes: new Map(),
        applySessions: (sessions) => {
            hydratedRef.current = sessions.at(-1) as Session | undefined ?? null;
        },
        getExistingSession: () => null,
        isCurrent: () => !args.signal.aborted,
        includeTurnsProjection: false,
        log: { log: () => {} },
    });
    const hydratedSession = hydratedRef.current;
    if (!result.ok || !hydratedSession || args.signal.aborted) {
        return { ok: false, errorCode: result.ok ? 'session_unavailable' : result.errorCode };
    }
    storage.getState().mergeSessionListRowsForServerScope(
        args.target.serverId,
        [buildSessionListRenderableFromSession(hydratedSession)],
    );
    const visibleThroughSeq = hydratedSession.seq;
    if (!Number.isSafeInteger(visibleThroughSeq) || visibleThroughSeq < 0) {
        return { ok: false, errorCode: 'session_visibility_unavailable' };
    }
    return { ok: true, visibleThroughSeq };
}
