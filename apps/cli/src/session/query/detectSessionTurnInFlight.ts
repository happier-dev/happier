import { decodeBase64, decrypt } from '@/api/encryption';
import { fetchEncryptedTranscriptPageAfterSeq, fetchEncryptedTranscriptPageLatest } from '@/api/session/fetchEncryptedTranscriptWindow';
import {
    applySessionTurnLifecycleEvent,
    detectSessionTurnLifecycleEvent,
} from '@/session/shared/sessionTurnLifecycle';

type SessionStoredContentEncryptionMode = 'e2ee' | 'plain';

export type SessionTurnActivity = Readonly<{
    pendingUserTurns: number;
    activeTaskInFlight: boolean;
    turnInFlight: boolean;
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

export function detectSessionTurnActivityFromProjection(value: unknown): SessionTurnActivity | null {
    const record = asRecord(value);
    if (!record) return null;

    const latestTurnStatus = readSessionProjectedTurnStatus(record.latestTurnStatus);
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

function isMemoryArtifactDecryptedRow(value: unknown): boolean {
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
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
}>): unknown | null {
    if (params.content.t === 'plain') return params.content.v;
    try {
        return decrypt(
            params.encryptionKey,
            params.encryptionVariant,
            decodeBase64(params.content.c, 'base64'),
        );
    } catch {
        return null;
    }
}

export function isSessionUserMessage(value: unknown): boolean {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    return obj?.role === 'user';
}

export async function detectSessionTurnActivity(params: Readonly<{
    token: string;
    sessionId: string;
    encryptionMode: SessionStoredContentEncryptionMode;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    afterSeqExclusive?: number;
    sessionProjection?: unknown;
}>): Promise<SessionTurnActivity> {
    const projectedActivity = detectSessionTurnActivityFromProjection(params.sessionProjection);
    if (projectedActivity) {
        return projectedActivity;
    }

    try {
        const rows =
            typeof params.afterSeqExclusive === 'number' && Number.isFinite(params.afterSeqExclusive)
                ? await fetchEncryptedTranscriptPageAfterSeq({
                    token: params.token,
                    sessionId: params.sessionId,
                    afterSeq: Math.max(0, Math.trunc(params.afterSeqExclusive)),
                    limit: 20,
                })
                : await fetchEncryptedTranscriptPageLatest({
                    token: params.token,
                    sessionId: params.sessionId,
                    limit: 20,
                });
        const orderedRows = [...rows].sort((a, b) => a.seq - b.seq);

        let pendingUserTurns = 0;
        let activeTaskInFlight = false;

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

            if (isSessionUserMessage(obj)) {
                pendingUserTurns += 1;
                continue;
            }
            const lifecycleEvent = detectSessionTurnLifecycleEvent(obj);
            if (!lifecycleEvent) continue;
            ({
                pendingUserTurns,
                activeTaskInFlight,
            } = applySessionTurnLifecycleEvent({
                pendingUserTurns,
                activeTaskInFlight,
                event: lifecycleEvent,
            }));
        }

        return {
            pendingUserTurns,
            activeTaskInFlight,
            turnInFlight: activeTaskInFlight || pendingUserTurns > 0,
        };
    } catch {
        return {
            pendingUserTurns: 0,
            activeTaskInFlight: false,
            turnInFlight: false,
        };
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
