import { isAgentThreadTextConversationTurnMeta } from '@happier-dev/protocol';

import { decodeBase64, decrypt } from '@/api/encryption';
import { fetchEncryptedTranscriptPageAfterSeq, fetchEncryptedTranscriptPageLatest } from '@/api/session/fetchEncryptedTranscriptWindow';
import {
    applySessionTurnLifecycleEvent,
    detectSessionTurnLifecycleEvent,
    isBareSessionReadyEvent,
} from '@/session/shared/sessionTurnLifecycle';

type SessionStoredContentEncryptionMode = 'e2ee' | 'plain';

export type SessionTurnActivity = Readonly<{
    pendingUserTurns: number;
    activeTaskInFlight: boolean;
    turnInFlight: boolean;
}>;

export class SessionTurnActivityUnavailableError extends Error {
    readonly originalError: unknown;

    constructor(originalError: unknown) {
        super('Session transcript activity is unavailable');
        this.name = 'SessionTurnActivityUnavailableError';
        this.originalError = originalError;
    }
}

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

    return readNonnegativeInteger(record.pendingCount);
}

export function detectSessionTurnActivityFromProjection(value: unknown): SessionTurnActivity | null {
    const record = asRecord(value);
    if (!record) return null;

    const latestTurnStatus = readSessionProjectedTurnStatus(record.latestTurnStatus);
    const pendingInputCount = readSessionProjectedPendingInputCount(record);
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

export function isMemoryArtifactDecryptedRow(value: unknown): boolean {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    if (!obj) return false;
    const meta = obj.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
    const happier = (meta as Record<string, unknown>).happier;
    if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return false;
    const kind = (happier as Record<string, unknown>).kind;
    return kind === 'session_summary_shard.v1' || kind === 'session_synopsis.v1';
}

function tryDecryptTranscriptEnvelope(params: Readonly<{
    content: { t: 'encrypted'; c: string } | { t: 'plain'; v: unknown };
    encryptionMode: SessionStoredContentEncryptionMode;
    encryptionKey: Uint8Array | null;
    encryptionVariant: 'legacy' | 'dataKey' | null;
}>): unknown | null {
    if (params.content.t === 'plain') return params.content.v;
    if (!params.encryptionKey || !params.encryptionVariant) {
        throw new SessionTurnActivityUnavailableError(
            new Error('Session encryption material is unavailable'),
        );
    }
    try {
        return decrypt(
            params.encryptionKey,
            params.encryptionVariant,
            decodeBase64(params.content.c, 'base64'),
        );
    } catch (error) {
        throw new SessionTurnActivityUnavailableError(error);
    }
}

export function isSessionAgentThreadTextUserMessage(value: unknown): boolean {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    return obj?.role === 'user' && isAgentThreadTextConversationTurnMeta(obj.meta);
}

export function isSessionAgentMessage(value: unknown): boolean {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    return obj?.role === 'agent';
}

export async function detectSessionTurnActivity(params: Readonly<{
    token: string;
    sessionId: string;
    encryptionMode: SessionStoredContentEncryptionMode;
    encryptionKey: Uint8Array | null;
    encryptionVariant: 'legacy' | 'dataKey' | null;
    afterSeqExclusive?: number;
    sessionProjection?: unknown;
    readyCompletesPendingUserTurns?: boolean;
    transcriptFetchTimeoutMs?: number;
}>): Promise<SessionTurnActivity> {
    const projectedActivity = detectSessionTurnActivityFromProjection(params.sessionProjection);
    if (projectedActivity) {
        return projectedActivity;
    }
    const readyCompletesPendingUserTurns = params.readyCompletesPendingUserTurns !== false;

    try {
        const rows =
            typeof params.afterSeqExclusive === 'number' && Number.isFinite(params.afterSeqExclusive)
                ? await fetchEncryptedTranscriptPageAfterSeq({
                    token: params.token,
                    sessionId: params.sessionId,
                    afterSeq: Math.max(0, Math.trunc(params.afterSeqExclusive)),
                    limit: 20,
                    ...(typeof params.transcriptFetchTimeoutMs === 'number'
                        ? { timeoutMs: params.transcriptFetchTimeoutMs }
                        : {}),
                })
                : await fetchEncryptedTranscriptPageLatest({
                    token: params.token,
                    sessionId: params.sessionId,
                    limit: 20,
                    ...(typeof params.transcriptFetchTimeoutMs === 'number'
                        ? { timeoutMs: params.transcriptFetchTimeoutMs }
                        : {}),
                });
        const orderedRows = [...rows].sort((a, b) => a.seq - b.seq);

        let pendingUserTurns = 0;
        let activeTaskInFlight = false;
        let observedAgentProgress = false;

        for (const row of orderedRows) {
            const decrypted = tryDecryptTranscriptEnvelope({
                content: row.content,
                encryptionMode: params.encryptionMode,
                encryptionKey: params.encryptionKey,
                encryptionVariant: params.encryptionVariant,
            });
            if (!decrypted || isMemoryArtifactDecryptedRow(decrypted)) continue;
            const obj = decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)
                ? (decrypted as Record<string, unknown>)
                : null;
            if (!obj) continue;

            if (isSessionAgentThreadTextUserMessage(obj)) {
                pendingUserTurns += 1;
                continue;
            }
            const lifecycleEvent = detectSessionTurnLifecycleEvent(obj);
            if (!lifecycleEvent) {
                if (isSessionAgentMessage(obj) && pendingUserTurns > 0) {
                    observedAgentProgress = true;
                }
                continue;
            }
            if (
                lifecycleEvent === 'ready'
                && !readyCompletesPendingUserTurns
                && !activeTaskInFlight
                && !observedAgentProgress
                && isBareSessionReadyEvent(obj)
            ) {
                continue;
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
        }

        const transcriptActivity = {
            pendingUserTurns,
            activeTaskInFlight,
            turnInFlight: activeTaskInFlight || pendingUserTurns > 0,
        };
        if (transcriptActivity.turnInFlight) {
            return transcriptActivity;
        }
        return projectedActivity ?? transcriptActivity;
    } catch (error) {
        if (error instanceof SessionTurnActivityUnavailableError) {
            throw error;
        }
        throw new SessionTurnActivityUnavailableError(error);
    }
}

export async function detectSessionTurnInFlight(params: Readonly<{
    token: string;
    sessionId: string;
    encryptionMode: SessionStoredContentEncryptionMode;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    afterSeqExclusive?: number;
    sessionProjection?: unknown;
}>): Promise<boolean> {
    const activity = await detectSessionTurnActivity(params);
    return activity.turnInFlight;
}
