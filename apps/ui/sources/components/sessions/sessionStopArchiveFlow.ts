import { HappyError } from '@/utils/errors/errors';
import { Modal } from '@/modal';
import { t } from '@/text';
import { storage } from '@/sync/domains/state/storage';

type SessionMutationResult = Readonly<{
    success: boolean;
    message?: string;
}>;

export type StopSessionAndMaybeArchiveParams = Readonly<{
    sessionId: string;
    hideInactiveSessions: boolean;
    isPinned: boolean;
    stopSession: () => Promise<SessionMutationResult>;
    archiveSession: () => Promise<SessionMutationResult>;
    stopErrorMessage: string;
    archiveErrorMessage: string;
}>;

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
    if (params.hideInactiveSessions && !params.isPinned) {
        keepSessionVisibleWhenInactive(params.sessionId);
    }

    const stopResult = await params.stopSession();
    if (!stopResult.success) {
        if (params.hideInactiveSessions && !params.isPinned) {
            clearSessionVisibleWhenInactive(params.sessionId);
        }
        throw new HappyError(stopResult.message || params.stopErrorMessage, false);
    }

    if (!params.hideInactiveSessions || params.isPinned) {
        return;
    }

    const shouldArchive = await Modal.confirm(
        t('sessionInfo.archiveSession'),
        t('sessionInfo.archiveSessionConfirm'),
        {
            cancelText: t('common.keep'),
            confirmText: t('sessionInfo.archiveSession'),
            destructive: true,
        },
    );
    if (!shouldArchive) {
        return;
    }

    const archiveResult = await params.archiveSession();
    if (!archiveResult.success) {
        throw new HappyError(archiveResult.message || params.archiveErrorMessage, false);
    }

    clearSessionVisibleWhenInactive(params.sessionId);
}
