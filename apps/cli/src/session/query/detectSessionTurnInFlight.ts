import { requireEncryptedSessionContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { decodeBase64, decrypt } from '@/api/encryption';
import { fetchEncryptedTranscriptPageAfterSeq, fetchEncryptedTranscriptPageBeforeSeq, fetchEncryptedTranscriptPageLatest } from '@/api/session/fetchEncryptedTranscriptWindow';
import { MAX_TRANSCRIPT_MESSAGES_PAGE_SIZE, resolveTranscriptFetchTimeoutMs } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
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
    return record ? readNonnegativeInteger(record.pendingCount) : null;
}

export function detectSessionTurnActivityFromProjection(value: unknown): SessionTurnActivity | null {
    const record = asRecord(value);
    if (!record) return null;

    const latestTurnStatus = readSessionProjectedTurnStatus(record.latestTurnStatus);
    const projectedPendingRequestCount = readSessionProjectedPendingRequestCount(record);
    const pendingUserTurns = readSessionProjectedPendingInputCount(record);
    if (!latestTurnStatus || projectedPendingRequestCount === null || pendingUserTurns === null) {
        return null;
    }

    const activeTaskInFlight = latestTurnStatus === 'in_progress';
    return {
        pendingUserTurns,
        activeTaskInFlight,
        turnInFlight: activeTaskInFlight || pendingUserTurns > 0 || projectedPendingRequestCount > 0,
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
    encryptionVariant: 'legacy' | 'dataKey' | 'plain';
}>): unknown | null {
    if (params.content.t === 'plain') return params.content.v;
    try {
        requireEncryptedSessionContext(params);
        return decrypt(
            params.encryptionKey,
            params.encryptionVariant,
            decodeBase64(params.content.c, 'base64'),
        );
    } catch (error) {
        throw new SessionTurnActivityUnavailableError(error);
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
    encryptionKey: Uint8Array | null;
    encryptionVariant: 'legacy' | 'dataKey' | 'plain';
    afterSeqExclusive?: number;
    sessionProjection?: unknown;
    transcriptFetchTimeoutMs?: number;
    deadlineAtMs?: number;
    signal?: AbortSignal;
}>): Promise<SessionTurnActivity> {
    if (params.signal?.aborted) throw new SessionTurnActivityUnavailableError(params.signal.reason);
    const projectedActivity = detectSessionTurnActivityFromProjection(params.sessionProjection);
    if (projectedActivity) {
        return projectedActivity;
    }

    try {
        const timeoutMs = resolveTranscriptFetchTimeoutMs(params.transcriptFetchTimeoutMs);
        const deadlineAtMs = params.deadlineAtMs ?? Date.now() + timeoutMs;
        const assertReadActive = () => {
            params.signal?.throwIfAborted();
            if (Date.now() >= deadlineAtMs) throw new Error('Transcript read deadline exceeded');
        };
        assertReadActive();
        const readOptions = { timeoutMs, deadlineAtMs, ...(params.signal ? { signal: params.signal } : {}) };
        const afterSeq = typeof params.afterSeqExclusive === 'number' && Number.isFinite(params.afterSeqExclusive)
            ? Math.max(0, Math.trunc(params.afterSeqExclusive))
            : null;
        const rows =
            afterSeq !== null
                ? await fetchEncryptedTranscriptPageAfterSeq({
                    token: params.token,
                    sessionId: params.sessionId,
                    afterSeq,
                    limit: 20,
                    ...readOptions,
                })
                : await fetchEncryptedTranscriptPageLatest({
                    token: params.token,
                    sessionId: params.sessionId,
                    limit: 20,
                    ...readOptions,
                });
        const orderedRows = [...rows].sort((a, b) => a.seq - b.seq);

        let pendingUserTurns = 0;
        let activeTaskInFlight = false;
        const applyDecryptedRow = (decrypted: unknown): boolean => {
            if (!decrypted || isMemoryArtifactDecryptedRow(decrypted)) return false;
            const obj = decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)
                ? (decrypted as Record<string, unknown>)
                : null;
            if (!obj) return false;

            if (isSessionUserMessage(obj)) {
                pendingUserTurns += 1;
                return true;
            }
            const lifecycleEvent = detectSessionTurnLifecycleEvent(obj);
            if (!lifecycleEvent) return false;
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
        const decryptRow = (row: (typeof rows)[number]) => tryDecryptTranscriptEnvelope({
            content: row.content,
            encryptionMode: params.encryptionMode,
            encryptionKey: params.encryptionKey,
            encryptionVariant: params.encryptionVariant,
        });
        let hasMaterialActivity = false;
        for (const row of orderedRows) {
            assertReadActive();
            hasMaterialActivity = applyDecryptedRow(decryptRow(row)) || hasMaterialActivity;
        }

        // Preserve the existing window reduction when it contains activity. A
        // tool/checkpoint-only tail needs the preceding signal, not a replay of
        // earlier prompts whose batching/consumption the legacy transcript omits.
        if (!hasMaterialActivity && afterSeq === null) {
            let beforeSeq = orderedRows[0]?.seq ?? 0;
            while (beforeSeq > 0) {
                assertReadActive();
                const page = await fetchEncryptedTranscriptPageBeforeSeq({
                    token: params.token,
                    sessionId: params.sessionId,
                    beforeSeq,
                    limit: MAX_TRANSCRIPT_MESSAGES_PAGE_SIZE,
                    deadlineAtMs,
                    ...(params.signal ? { signal: params.signal } : {}),
                });
                for (const row of [...page.rows].sort((a, b) => b.seq - a.seq)) {
                    assertReadActive();
                    const decrypted = decryptRow(row);
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
                if (page.nextBeforeSeq === null) throw new Error('Transcript page continuation cannot advance');
                beforeSeq = page.nextBeforeSeq;
            }
        }
        assertReadActive();

        pendingUserTurns = Math.max(pendingUserTurns, readSessionProjectedPendingInputCount(params.sessionProjection) ?? 0);

        return {
            pendingUserTurns,
            activeTaskInFlight,
            turnInFlight: activeTaskInFlight || pendingUserTurns > 0,
        };
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
    encryptionKey: Uint8Array | null;
    encryptionVariant: 'legacy' | 'dataKey' | 'plain';
    afterSeqExclusive?: number;
    sessionProjection?: unknown;
    transcriptFetchTimeoutMs?: number;
    deadlineAtMs?: number;
    signal?: AbortSignal;
}>): Promise<boolean> {
    const activity = await detectSessionTurnActivity(params);
    return activity.turnInFlight;
}
