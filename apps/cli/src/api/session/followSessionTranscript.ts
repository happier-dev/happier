import type { FileBackedTranscriptSessionStore } from './fileBackedTranscripts/store';
import type { TranscriptFollowChangeV1, TranscriptOpenedAgentStateV1, TranscriptOpenedSharedMetadataV1 } from '@happier-dev/protocol';
import { waitForChange } from '@/utils/async/waitForChange';
import {
    normalizeBoundedInt,
    readOptionalString,
    readRecord,
    type SessionTranscriptActionResult,
} from './sessionTranscriptActionInput';

type SessionTranscriptFollowLease = Readonly<{
    sessionId: string;
    leaseId: string;
    idleTtlMs: number;
    release: () => Promise<void>;
    changes?: Readonly<{
        ready: () => Promise<void>;
        wait: (signal?: AbortSignal) => Promise<void>;
        take: () => TranscriptFollowChangeV1[];
        pending: () => boolean;
    }>;
}>;

export type SessionTranscriptFollowLeaseIdentity = Readonly<{
    sessionId: string;
    leaseId: string;
}>;

export type SessionTranscriptFollowLeaseRegistry = Readonly<{
    retain: (lease: SessionTranscriptFollowLease) => boolean;
    release: (
        identity: SessionTranscriptFollowLeaseIdentity,
        expectedLease?: SessionTranscriptFollowLease,
    ) => Promise<boolean>;
    dispose: () => Promise<void>;
    activeCount: () => number;
    resolveIdleTtlMs: (requestedIdleTtlMs: unknown) => number;
    get: (identity: SessionTranscriptFollowLeaseIdentity) => SessionTranscriptFollowLease | undefined;
    suspendIdleExpiry: (identity: SessionTranscriptFollowLeaseIdentity) => () => void;
}>;

type SessionTranscriptFollowLeaseRegistryParams = Readonly<{
    idleTtlMs: number;
    hostPolicy?: Readonly<{ idleTtlMs?: number }>;
}>;

type FollowSessionTranscriptParams<TItem> = Readonly<{
    store: FileBackedTranscriptSessionStore<TItem>;
    registry: SessionTranscriptFollowLeaseRegistry;
    sessionId: string;
    input?: unknown;
    signal?: AbortSignal;
    onUpdate?: (update: Readonly<{
        items: readonly TItem[];
        nextCursor: string | null;
        truncated: boolean;
    }>) => void | Promise<void>;
}>;

let generatedFollowLeaseCounter = 0;

export const DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS = 600_000;

export function createSessionTranscriptFollowLeaseRegistry(
    params: SessionTranscriptFollowLeaseRegistryParams,
): SessionTranscriptFollowLeaseRegistry {
    const leases = new Map<string, SessionTranscriptFollowLease>();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let disposed = false;
    let disposePromise: Promise<void> | null = null;

    const getLeaseKey = (identity: SessionTranscriptFollowLeaseIdentity): string => JSON.stringify([
        identity.sessionId,
        identity.leaseId,
    ]);

    const clearLeaseTimer = (leaseKey: string): void => {
        const timer = timers.get(leaseKey);
        if (timer) {
            clearTimeout(timer);
            timers.delete(leaseKey);
        }
    };

    const release = async (
        identity: SessionTranscriptFollowLeaseIdentity,
        expectedLease?: SessionTranscriptFollowLease,
    ): Promise<boolean> => {
        const leaseKey = getLeaseKey(identity);
        const lease = leases.get(leaseKey);
        if (expectedLease !== undefined && lease !== expectedLease) return false;
        clearLeaseTimer(leaseKey);
        if (!lease) return false;
        leases.delete(leaseKey);
        await lease.release();
        return true;
    };

    const scheduleIdleExpiry = (identity: SessionTranscriptFollowLeaseIdentity, idleTtlMs: number): void => {
        const leaseKey = getLeaseKey(identity);
        clearLeaseTimer(leaseKey);
        const timer = setTimeout(() => {
            void release(identity);
        }, idleTtlMs);
        timer.unref?.();
        timers.set(leaseKey, timer);
    };

    const resolveIdleTtlMs = (requestedIdleTtlMs: unknown): number => {
        if (typeof params.hostPolicy?.idleTtlMs === 'number' && params.hostPolicy.idleTtlMs > 0) {
            return params.hostPolicy.idleTtlMs;
        }
        return normalizeBoundedInt(requestedIdleTtlMs, params.idleTtlMs, params.idleTtlMs);
    };

    const dispose = (): Promise<void> => {
        disposePromise ??= (async () => {
            disposed = true;
            const results = await Promise.allSettled(
                [...leases.values()].map((lease) => release(lease, lease)),
            );
            for (const leaseKey of [...timers.keys()]) clearLeaseTimer(leaseKey);
            const failures = results
                .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
                .map((result) => result.reason);
            if (failures.length > 0) {
                throw new AggregateError(failures, 'Failed to dispose transcript follow leases');
            }
        })();
        return disposePromise;
    };

    return {
        retain: (lease) => {
            if (disposed) return false;
            const identity = { sessionId: lease.sessionId, leaseId: lease.leaseId };
            const leaseKey = getLeaseKey(identity);
            if (leases.has(leaseKey)) {
                void release(identity);
            }
            leases.set(leaseKey, lease);
            scheduleIdleExpiry(identity, lease.idleTtlMs);
            return true;
        },
        release,
        dispose,
        activeCount: () => leases.size,
        resolveIdleTtlMs,
        get: (identity) => leases.get(getLeaseKey(identity)),
        suspendIdleExpiry: (identity) => {
            const leaseKey = getLeaseKey(identity);
            const lease = leases.get(leaseKey);
            clearLeaseTimer(leaseKey);
            return () => { if (lease && leases.get(leaseKey) === lease) scheduleIdleExpiry(identity, lease.idleTtlMs); };
        },
    };
}

export async function followSessionTranscript<TItem>(
    params: FollowSessionTranscriptParams<TItem>,
): Promise<SessionTranscriptActionResult<{
    leaseId: string;
    items: readonly TItem[];
    nextCursor: string | null;
    truncated: boolean;
    projection?: 'openedMessagesV1';
    agentState?: TranscriptOpenedAgentStateV1 | null;
    sharedMetadata?: TranscriptOpenedSharedMetadataV1 | null;
    changes?: readonly TranscriptFollowChangeV1[];
}>> {
    const input = readRecord(params.input);
    const cursor = readOptionalString(input, 'cursor');
    if (!cursor) {
        return { ok: false, errorCode: 'missing_cursor', message: 'Transcript cursor is required.' };
    }

    const leaseId = readOptionalString(input, 'leaseId') ?? `transcript-follow-${++generatedFollowLeaseCounter}`;
    const idleTtlMs = params.registry.resolveIdleTtlMs(input.idleTtlMs);
    if (input.waitForChanges === true) {
        return await followWaitingSessionTranscript({ ...params, cursor, leaseId, idleTtlMs, input });
    }
    let released = false;
    let updateInFlight = false;
    let queuedUpdate: Readonly<{
        items: readonly TItem[];
        nextCursor: string | null;
        truncated: boolean;
    }> | null = null;

    const runUpdate = async (update: Readonly<{
        items: readonly TItem[];
        nextCursor: string | null;
        truncated: boolean;
    }>): Promise<void> => {
        if (released) return;
        if (updateInFlight) {
            queuedUpdate = update;
            return;
        }
        updateInFlight = true;
        try {
            await params.onUpdate?.(update);
        } finally {
            updateInFlight = false;
            if (queuedUpdate && !released) {
                const nextUpdate = queuedUpdate;
                queuedUpdate = null;
                await runUpdate(nextUpdate);
            }
        }
    };

    const unsubscribe = params.store.subscribe((update) => {
        void runUpdate(update);
    });
    const lease = {
        sessionId: params.sessionId,
        leaseId,
        idleTtlMs,
        release: async () => {
            if (released) return;
            released = true;
            unsubscribe();
        },
    };

    if (!params.registry.retain(lease)) {
        unsubscribe();
        return {
            ok: false,
            errorCode: 'transcript_follow_released',
            message: 'Transcript follow registry has been disposed.',
        };
    }

    let read: Awaited<ReturnType<typeof params.store.readAfter>>;
    try {
        read = await params.store.readAfter({
            cursor,
            maxBytes: normalizeBoundedInt(input.maxBytes, 64 * 1024, 1024 * 1024),
            maxItems: normalizeBoundedInt(input.maxItems, 100, 500),
            ...(input.projection === 'openedMessagesV1' ? {
                projection: input.projection,
                agentStateVersion: input.agentStateVersion,
                sharedMetadataVersion: input.sharedMetadataVersion,
            } : {}),
        });
    } catch (readError) {
        try {
            await params.registry.release(lease, lease);
        } finally {
            throw readError;
        }
    }
    return {
        ok: true,
        leaseId,
        items: read.items,
        nextCursor: read.nextCursor,
        truncated: read.truncated,
        ...(read.projection === 'openedMessagesV1' ? { projection: read.projection, agentState: read.agentState ?? null, sharedMetadata: read.sharedMetadata ?? null } : {}),
    };
}

async function followWaitingSessionTranscript<TItem>(params: FollowSessionTranscriptParams<TItem> & Readonly<{
    cursor: string; leaseId: string; idleTtlMs: number; input: Record<string, unknown>;
}>) {
    const identity = { sessionId: params.sessionId, leaseId: params.leaseId };
    let lease = params.registry.get(identity);
    if (!lease?.changes) {
        if (!params.store.observeChanges) throw new Error('transcript_changes_unavailable');
        const pending: TranscriptFollowChangeV1[] = [];
        const waiters = new Set<() => void>();
        const wake = () => { for (const listener of waiters) listener(); };
        let released = false;
        let failure: unknown;
        const subscription = params.store.observeChanges((change) => {
            if (released) return;
            if (!pending.some((entry) => entry.kind === change.kind && (entry.kind !== 'revision'
                || change.kind === 'revision' && entry.messageId === change.messageId))) pending.push(change);
            wake();
        }, (error) => { failure = error; wake(); });
        lease = { ...identity, idleTtlMs: params.idleTtlMs,
            changes: { ready: () => subscription.ready,
                pending: () => pending.length > 0,
                take: () => pending.splice(0),
                wait: (signal) => waitForChange({ signal,
                    subscribe: (listener) => { waiters.add(listener); return () => { waiters.delete(listener); }; },
                    hasChanged: () => released || failure !== undefined || pending.length > 0,
                }).then(() => { if (failure !== undefined) throw failure; if (released) throw new Error('transcript_follow_released'); }),
            },
            release: async () => { released = true; wake(); await subscription.dispose(); },
        };
        if (!params.registry.retain(lease)) {
            await lease.release();
            return { ok: false as const, errorCode: 'transcript_follow_released', message: 'Transcript follow registry has been disposed.' };
        }
    }
    const changes = lease.changes!;
    const resumeIdleExpiry = params.registry.suspendIdleExpiry(identity);
    const abort = () => { void params.registry.release(identity, lease).catch(() => undefined); };
    params.signal?.addEventListener('abort', abort, { once: true });
    try {
        params.signal?.throwIfAborted();
        await changes.ready();
        params.signal?.throwIfAborted();
        let readCursor = params.cursor;
        const read = () => params.store.readAfter({ ...params.input,
            cursor: readCursor,
            maxBytes: normalizeBoundedInt(params.input.maxBytes, 64 * 1024, 1024 * 1024),
            maxItems: normalizeBoundedInt(params.input.maxItems, 100, 500),
            ...(params.signal ? { signal: params.signal } : {}),
        });
        let page = await read();
        readCursor = page.nextCursor ?? params.store.getTailCursor() ?? readCursor;
        params.signal?.throwIfAborted();
        if (!page.items.length && !page.truncated && !page.agentState && !page.sharedMetadata && !changes.pending()) {
            await changes.wait(params.signal);
            page = await read();
        }
        params.signal?.throwIfAborted();
        return { ok: true as const, leaseId: params.leaseId, ...page,
            nextCursor: page.nextCursor ?? (params.cursor === 'tail' ? params.store.getTailCursor() : params.cursor),
            changes: changes.take(),
        };
    } catch (error) {
        await params.registry.release(identity, lease);
        params.signal?.throwIfAborted();
        throw error;
    } finally {
        params.signal?.removeEventListener('abort', abort);
        resumeIdleExpiry();
    }
}
