import { HappyError } from '@/utils/errors/errors';
import { storage } from '@/sync/domains/state/storage';
import { delay } from '@/utils/timing/time';

type SessionMutationResult = Readonly<{
    success: boolean;
    message?: string;
    code?: string;
}>;

export type StopSessionAndMaybeArchiveParams = Readonly<{
    sessionId: string;
    hideInactiveSessions: boolean;
    isPinned: boolean;
    archiveAfterStop: 'never' | 'always';
    stopSession: () => Promise<SessionMutationResult>;
    archiveSession: () => Promise<SessionMutationResult>;
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

function readSessionArchiveAfterStopTimeoutMsFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_HAPPIER_SESSION_ARCHIVE_AFTER_STOP_TIMEOUT_MS ?? '').trim();
    if (!raw) return 75_000;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 75_000;
    return Math.max(0, Math.min(5 * 60_000, parsed));
}

export function isSessionActiveArchiveResult(result: SessionMutationResult): boolean {
    return result.success === false && result.code === 'session_active';
}

async function archiveAfterStopWithRetry(params: Readonly<{
    archiveSession: () => Promise<SessionMutationResult>;
    archiveErrorMessage: string;
}>): Promise<void> {
    let archiveResult = await params.archiveSession();
    const deadlineMs = Date.now() + readSessionArchiveAfterStopTimeoutMsFromEnv();
    const retryDelayMs = readSessionArchiveAfterStopRetryDelayMsFromEnv();

    while (isSessionActiveArchiveResult(archiveResult) && Date.now() < deadlineMs) {
        await delay(retryDelayMs);
        archiveResult = await params.archiveSession();
    }

    if (!archiveResult.success) {
        const message = isSessionActiveArchiveResult(archiveResult)
            ? params.archiveErrorMessage
            : archiveResult.message || params.archiveErrorMessage;
        throw new HappyError(message, false);
    }
}

export function keepSessionVisibleWhenInactive(sessionId: string): void {
    storage.getState().applySessionListRenderablePatches([
        {
            sessionId,
            patch: { keepVisibleWhenInactive: true },
        },
    ]);
}

export function clearSessionVisibleWhenInactive(sessionId: string): void {
    storage.getState().applySessionListRenderablePatches([
        {
            sessionId,
            patch: { keepVisibleWhenInactive: false },
        },
    ]);
}

export async function stopSessionAndMaybeArchive(params: StopSessionAndMaybeArchiveParams): Promise<void> {
    const keepVisibleWhenStopping = params.archiveAfterStop === 'always';

    if (keepVisibleWhenStopping) {
        keepSessionVisibleWhenInactive(params.sessionId);
    }

    const stopResult = await params.stopSession();
    if (!stopResult.success) {
        if (keepVisibleWhenStopping) {
            clearSessionVisibleWhenInactive(params.sessionId);
        }
        throw new HappyError(stopResult.message || params.stopErrorMessage, false);
    }

    if (params.archiveAfterStop === 'never') {
        return;
    }

    try {
        await archiveAfterStopWithRetry({
            archiveSession: params.archiveSession,
            archiveErrorMessage: params.archiveErrorMessage,
        });
    } finally {
        if (keepVisibleWhenStopping) {
            clearSessionVisibleWhenInactive(params.sessionId);
        }
    }
}
