import { HappyError } from '@/utils/errors/errors';
import { storage } from '@/sync/domains/state/storage';
import { AsyncTimeoutError, delay } from '@/utils/timing/time';
import { t } from '@/text';
import type { SessionStopRecovery } from '@/sync/ops/sessionStopContract';
import { readSessionArchivePending, resolveSessionArchiveServerId } from '@/sync/domains/session/listing/sessionArchiveState';
import { withSessionArchiveDeadline, type SessionArchiveRequestOptions } from '@/sync/ops/sessionArchiveLifecycle';

type SessionMutationResult = Readonly<{
    success: boolean;
    message?: string;
    code?: string;
    recovery?: SessionStopRecovery;
}>;

export type StopSessionAndMaybeArchiveParams = Readonly<{
    sessionId: string;
    serverId?: string | null;
    hideInactiveSessions: boolean;
    isPinned: boolean;
    archiveAfterStop: 'never' | 'always';
    stopSession: () => Promise<SessionMutationResult>;
    archiveSession: (options?: SessionArchiveRequestOptions) => Promise<SessionMutationResult>;
    stopErrorMessage: string;
    archiveErrorMessage: string;
}>;

function readSessionArchiveAfterStopRetryDelayMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_RETRY_MS ?? '').trim();
    if (!raw) return 200;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 200;
    return Math.max(0, Math.min(5_000, parsed));
}

export function isSessionActiveArchiveResult(result: SessionMutationResult): boolean {
    return result.success === false && result.code === 'session_active';
}

export function resolveSessionStopFailureMessage(
    result: SessionMutationResult,
    fallbackMessage: string,
): string {
    if (result.recovery === 'retry_when_runtime_available') {
        return t('sessionInfo.stopSessionControlUnavailable');
    }
    return result.message || fallbackMessage;
}

async function runAfterStopWithRetry(params: Readonly<{
    run: (options?: SessionArchiveRequestOptions) => Promise<SessionMutationResult>;
    errorMessage: string;
    waitForInactive?: boolean;
}>): Promise<void> {
    try {
        await withSessionArchiveDeadline(async ({ signal, deadlineMs, retryActiveSession }) => {
            let result = await params.run({ signal });
            const retryDelayMs = readSessionArchiveAfterStopRetryDelayMsFromEnv();

            while (retryActiveSession && params.waitForInactive !== false && isSessionActiveArchiveResult(result) && Date.now() < deadlineMs) {
                await delay(Math.min(retryDelayMs, Math.max(0, deadlineMs - Date.now())));
                if (signal.aborted || Date.now() >= deadlineMs) break;
                result = await params.run({ signal });
            }

            if (!result.success) {
                const message = isSessionActiveArchiveResult(result)
                    ? params.errorMessage
                    : result.message || params.errorMessage;
                throw new HappyError(message, false);
            }
        });
    } catch (error) {
        if (error instanceof AsyncTimeoutError) throw new HappyError(params.errorMessage, false);
        throw error;
    }
}

export function isSessionArchivePending(sessionId: string, serverId?: string | null): boolean {
    return readSessionArchivePending(storage.getState(), sessionId, resolveSessionArchiveServerId(serverId));
}

export async function archiveSessionWithPendingState<T>(
    sessionId: string,
    archiveSession: () => Promise<T>,
    serverId?: string | null,
): Promise<T | false> {
    // Admission is synchronous, after caller-owned confirmation, and shared by every entry point.
    const operation = storage.getState().beginSessionArchive(sessionId, resolveSessionArchiveServerId(serverId));
    if (!operation) return false;
    try {
        return await archiveSession();
    } finally {
        storage.getState().finishSessionArchive(operation);
    }
}

function isStopAcceptedAndPending(result: SessionMutationResult): boolean {
    return result.success === false
        && result.code === 'session_stop_requested'
        && result.recovery === 'wait_for_inactive';
}

/** Missing runner control permits one end-action attempt without waiting for a new inactivity signal. */
function isStopTargetMissing(result: SessionMutationResult): boolean {
    return result.success === false && result.code === 'session_stop_not_found';
}

export type StopSessionAndRunActionParams = Readonly<{
    stopSession: () => Promise<SessionMutationResult>;
    stopErrorMessage: string;
    endAction?: Readonly<{
        run: (options?: SessionArchiveRequestOptions) => Promise<SessionMutationResult>;
        errorMessage: string;
    }>;
}>;

/** End actions establish inactivity themselves; a stop acknowledgement alone never permits a mutation. */
export async function stopSessionAndRunAction(params: StopSessionAndRunActionParams): Promise<void> {
    const stopResult = await params.stopSession();
    const targetMissing = isStopTargetMissing(stopResult);
    if (!stopResult.success && !isStopAcceptedAndPending(stopResult) && !(params.endAction && targetMissing)) {
        throw new HappyError(resolveSessionStopFailureMessage(stopResult, params.stopErrorMessage), false);
    }
    if (!params.endAction) return;
    await runAfterStopWithRetry({
        run: params.endAction.run,
        errorMessage: params.endAction.errorMessage,
        waitForInactive: !targetMissing,
    });
}

export async function stopSessionAndMaybeArchive(params: StopSessionAndMaybeArchiveParams): Promise<void | false> {
    if (params.archiveAfterStop === 'never') {
        return await stopSessionAndRunAction(params);
    }

    return archiveSessionWithPendingState(params.sessionId, async () => {
        await stopSessionAndRunAction({
            stopSession: params.stopSession,
            stopErrorMessage: params.stopErrorMessage,
            endAction: { run: params.archiveSession, errorMessage: params.archiveErrorMessage },
        });
    }, params.serverId);
}
