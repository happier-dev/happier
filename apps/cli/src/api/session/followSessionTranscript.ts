import type { FileBackedTranscriptSessionStore } from './fileBackedTranscripts/store';
import {
    normalizeBoundedInt,
    readOptionalString,
    readRecord,
    type SessionTranscriptActionResult,
} from './sessionTranscriptActionInput';

type SessionTranscriptFollowLease = Readonly<{
    leaseId: string;
    idleTtlMs: number;
    release: () => Promise<void>;
}>;

export type SessionTranscriptFollowLeaseRegistry = Readonly<{
    retain: (lease: SessionTranscriptFollowLease) => boolean;
    release: (leaseId: string) => Promise<void>;
    activeCount: () => number;
    resolveIdleTtlMs: (requestedIdleTtlMs: unknown) => number;
}>;

type SessionTranscriptFollowLeaseRegistryParams = Readonly<{
    maxLeases: number;
    idleTtlMs: number;
    hostPolicy?: Readonly<{ idleTtlMs?: number }>;
}>;

type FollowSessionTranscriptParams<TItem> = Readonly<{
    store: FileBackedTranscriptSessionStore<TItem>;
    registry: SessionTranscriptFollowLeaseRegistry;
    input?: unknown;
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

    const clearLeaseTimer = (leaseId: string): void => {
        const timer = timers.get(leaseId);
        if (timer) {
            clearTimeout(timer);
            timers.delete(leaseId);
        }
    };

    const release = async (leaseId: string): Promise<void> => {
        clearLeaseTimer(leaseId);
        const lease = leases.get(leaseId);
        if (!lease) return;
        leases.delete(leaseId);
        await lease.release();
    };

    const scheduleIdleExpiry = (leaseId: string, idleTtlMs: number): void => {
        clearLeaseTimer(leaseId);
        const timer = setTimeout(() => {
            void release(leaseId);
        }, idleTtlMs);
        timer.unref?.();
        timers.set(leaseId, timer);
    };

    const resolveIdleTtlMs = (requestedIdleTtlMs: unknown): number => {
        if (typeof params.hostPolicy?.idleTtlMs === 'number' && params.hostPolicy.idleTtlMs > 0) {
            return params.hostPolicy.idleTtlMs;
        }
        return normalizeBoundedInt(requestedIdleTtlMs, params.idleTtlMs, params.idleTtlMs);
    };

    return {
        retain: (lease) => {
            if (leases.has(lease.leaseId)) {
                void release(lease.leaseId);
            } else if (leases.size >= params.maxLeases) {
                return false;
            }
            leases.set(lease.leaseId, lease);
            scheduleIdleExpiry(lease.leaseId, lease.idleTtlMs);
            return true;
        },
        release,
        activeCount: () => leases.size,
        resolveIdleTtlMs,
    };
}

export async function followSessionTranscript<TItem>(
    params: FollowSessionTranscriptParams<TItem>,
): Promise<SessionTranscriptActionResult<{
    leaseId: string;
    items: readonly TItem[];
    nextCursor: string | null;
    truncated: boolean;
}>> {
    const input = readRecord(params.input);
    const cursor = readOptionalString(input, 'cursor');
    if (!cursor) {
        return { ok: false, errorCode: 'missing_cursor', message: 'Transcript cursor is required.' };
    }

    const leaseId = readOptionalString(input, 'leaseId') ?? `transcript-follow-${++generatedFollowLeaseCounter}`;
    const idleTtlMs = params.registry.resolveIdleTtlMs(input.idleTtlMs);
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
            errorCode: 'follow_lease_limit_exceeded',
            message: 'Transcript follow lease limit exceeded.',
        };
    }

    const read = await params.store.readAfter({
        cursor,
        maxBytes: normalizeBoundedInt(input.maxBytes, 64 * 1024, 1024 * 1024),
        maxItems: normalizeBoundedInt(input.maxItems, 100, 500),
    });
    return {
        ok: true,
        leaseId,
        items: read.items,
        nextCursor: read.nextCursor,
        truncated: read.truncated,
    };
}
