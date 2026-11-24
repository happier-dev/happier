import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { SessionMessagePageActivityV1, SessionMessageV1 } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { isMemoryArtifactDecryptedRow, isSessionAgentThreadTextUserMessage, isSessionAgentMessage } from './sessionTurnLifecycle.js';
import { applySessionTurnLifecycleEvent, detectSessionTurnLifecycleEvent, isBareSessionReadyEvent } from './sessionTurnLifecycle.js';

export type SessionTurnActivity = Readonly<{
    pendingUserTurns: number;
    activeTaskInFlight: boolean;
    turnInFlight: boolean;
    /** Effective primary Pending count from the same snapshot as the reduced transcript. */
    pendingInputCount?: number;
}>;

type ProjectedTurnStatus = 'in_progress' | 'completed' | 'cancelled' | 'failed';

const PROJECTED_TURN_STATUSES = new Set<string>(['in_progress', 'completed', 'cancelled', 'failed']);

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readNonnegativeInteger(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return null;
    }
    return value;
}

export function readSessionProjectedTurnStatus(value: unknown): ProjectedTurnStatus | null {
    if (typeof value !== 'string' || !PROJECTED_TURN_STATUSES.has(value)) {
        return null;
    }
    return value as ProjectedTurnStatus;
}

export function readSessionProjectedPendingRequestCount(value: unknown): number | null {
    const record = asRecord(value);
    if (!record) return null;

    const pendingPermissionRequestCount = readNonnegativeInteger(record.pendingPermissionRequestCount);
    const pendingUserActionRequestCount = readNonnegativeInteger(record.pendingUserActionRequestCount);
    if (pendingPermissionRequestCount === null || pendingUserActionRequestCount === null) {
        return null;
    }

    return pendingPermissionRequestCount + pendingUserActionRequestCount;
}

export function readSessionProjectedPendingInputCount(value: unknown): number | null {
    const record = asRecord(value);
    if (!record) return null;
    const pendingCount = readNonnegativeInteger(record.pendingCount);
    if (pendingCount === null) return null;
    const pendingBlockedCount = readNonnegativeInteger(record.pendingBlockedCount);
    const pendingBlockedNoEffectCount = readNonnegativeInteger(record.pendingBlockedNoEffectCount);
    // Missing or inconsistent proof retains the total, including bodyless queue hints.
    if (pendingBlockedCount === null || pendingBlockedNoEffectCount === null
        || pendingBlockedNoEffectCount > pendingBlockedCount || pendingBlockedCount > pendingCount) {
        return pendingCount;
    }
    return pendingCount - pendingBlockedNoEffectCount;
}

export function detectSessionTurnActivityFromProjection(value: unknown): SessionTurnActivity | null {
    const record = asRecord(value);
    if (!record) return null;

    const latestTurnStatus = readSessionProjectedTurnStatus(record.latestTurnStatus);
    const pendingInputCount = readNonnegativeInteger(record.pendingCount);
    const pendingBlockedCount = readNonnegativeInteger(record.pendingBlockedCount);
    // Blocked custody needs the coherent transcript crossover; aggregate counts cannot prove idle.
    if (pendingInputCount !== null && pendingInputCount > 0 && pendingBlockedCount === pendingInputCount
        && latestTurnStatus !== 'in_progress') return null;
    if (pendingInputCount !== null && pendingInputCount > 0) {
        return {
            pendingUserTurns: pendingInputCount,
            activeTaskInFlight: latestTurnStatus === 'in_progress',
            turnInFlight: true,
        };
    }
    const projectedPendingRequestCount = readSessionProjectedPendingRequestCount(record);
    if (!latestTurnStatus || projectedPendingRequestCount === null) {
        return null;
    }

    const activeTaskInFlight = latestTurnStatus === 'in_progress';
    return {
        pendingUserTurns: 0,
        activeTaskInFlight,
        turnInFlight: activeTaskInFlight || projectedPendingRequestCount > 0,
    };
}

export async function readSessionTranscriptTurnActivity(params: Readonly<{
    readPage: (params: Readonly<{ limit: number; beforeSeq?: number; afterSeq?: number }>) => Promise<{
        messages: readonly SessionMessageV1[];
        hasMore?: boolean;
        nextBeforeSeq?: number | null;
        activity?: SessionMessagePageActivityV1;
    }>;
    openRow: (row: SessionMessageV1) => unknown | Promise<unknown>;
    assertReadActive: () => void;
    maxPageSize: number;
    afterSeqExclusive?: number;
    readyCompletesPendingUserTurns?: boolean;
}>): Promise<SessionTurnActivity> {
    const readyCompletesPendingUserTurns = params.readyCompletesPendingUserTurns !== false;
    const afterSeq = typeof params.afterSeqExclusive === 'number' && Number.isFinite(params.afterSeqExclusive)
        ? Math.max(0, Math.trunc(params.afterSeqExclusive))
        : null;
    const page = await params.readPage({
        ...(afterSeq !== null ? { afterSeq } : {}),
        limit: 20,
    });
    const rows = page.messages;
    if (afterSeq === null && !page.activity) {
        throw new Error('Requested Session activity snapshot is unavailable');
    }
    const activitySnapshot = afterSeq === null ? page.activity : undefined;
    const pendingInputCount = activitySnapshot ? readSessionProjectedPendingInputCount(activitySnapshot) : null;
    const orderedRows = [...rows].sort((a, b) => a.seq - b.seq);

    let pendingUserTurns = 0;
    let activeTaskInFlight = false;
    let observedAgentProgress = false;

    const applyDecryptedRow = (decrypted: unknown): boolean => {
        if (!decrypted || isMemoryArtifactDecryptedRow(decrypted)) return false;
        const obj = decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)
            ? (decrypted as Record<string, unknown>)
            : null;
        if (!obj) return false;

        if (isSessionAgentThreadTextUserMessage(obj)) {
            pendingUserTurns += 1;
            return true;
        }
        const lifecycleEvent = detectSessionTurnLifecycleEvent(obj);
        if (!lifecycleEvent) {
            if (isSessionAgentMessage(obj) && pendingUserTurns > 0) {
                observedAgentProgress = true;
            }
            return false;
        }
        if (
            lifecycleEvent === 'ready'
            && !readyCompletesPendingUserTurns
            && !activeTaskInFlight
            && !observedAgentProgress
            && isBareSessionReadyEvent(obj)
        ) {
            return true;
        }
        if (lifecycleEvent === 'ready' && !isBareSessionReadyEvent(obj) && pendingUserTurns > 0) {
            observedAgentProgress = true;
        }
        if (lifecycleEvent === 'task_started') {
            observedAgentProgress = true;
        }
        ({
            pendingUserTurns,
            activeTaskInFlight,
        } = applySessionTurnLifecycleEvent({
            pendingUserTurns,
            activeTaskInFlight,
            event: lifecycleEvent,
        }));
        return true;
    };
    let hasMaterialActivity = false;
    for (const row of orderedRows) {
        params.assertReadActive();
        if (row.pendingOwnsTranscript === true) continue;
        hasMaterialActivity = applyDecryptedRow(await params.openRow(row)) || hasMaterialActivity;
    }

    // Preserve the existing window reduction when it contains activity. A
    // tool/checkpoint-only tail needs the preceding signal, not a replay of
    // earlier prompts whose batching/consumption the legacy transcript omits.
    if (!hasMaterialActivity && afterSeq === null) {
        let beforeSeq = orderedRows[0]?.seq ?? 0;
        while (beforeSeq > 0) {
            params.assertReadActive();
            const page = await params.readPage({
                beforeSeq,
                limit: params.maxPageSize,
            });
            for (const row of [...page.messages].sort((a, b) => b.seq - a.seq)) {
                if (row.pendingOwnsTranscript === true) continue;
                params.assertReadActive();
                const decrypted = await params.openRow(row);
                // The server's main scope excludes materialized sidechains;
                // imported legacy rows can retain this identity only in meta.
                const meta = asRecord(asRecord(decrypted)?.meta);
                if (readNonBlankOpaqueIdentifier(row.sidechainId) || readNonBlankOpaqueIdentifier(meta?.sidechainId)) continue;
                if (applyDecryptedRow(decrypted)) {
                    hasMaterialActivity = true;
                    break;
                }
            }
            if (hasMaterialActivity || !page.hasMore) break;
            if (page.nextBeforeSeq == null) throw new Error('Transcript page continuation cannot advance');
            beforeSeq = page.nextBeforeSeq;
        }
    }
    params.assertReadActive();

    const snapshotTurnStatus = readSessionProjectedTurnStatus(activitySnapshot?.latestTurnStatus);
    if (snapshotTurnStatus) {
        activeTaskInFlight = snapshotTurnStatus === 'in_progress';
        // Foreground completion is authoritative even without a transcript completion marker.
        if (!activeTaskInFlight) pendingUserTurns = 0;
    }
    pendingUserTurns = Math.max(pendingUserTurns, pendingInputCount ?? 0);
    const pendingRequests = activitySnapshot ? readSessionProjectedPendingRequestCount(activitySnapshot) ?? 0 : 0;
    const transcriptActivity: SessionTurnActivity = {
        pendingUserTurns,
        activeTaskInFlight,
        turnInFlight: activeTaskInFlight || pendingUserTurns > 0 || pendingRequests > 0,
        ...(pendingInputCount !== null ? { pendingInputCount } : {}),
    };
    return transcriptActivity;
}
