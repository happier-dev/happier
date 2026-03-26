import { HappyError } from '@/utils/errors/errors';
import { Modal } from '@/modal';
import { t } from '@/text';

type SessionMutationResult = Readonly<{
    success: boolean;
    message?: string;
}>;

export type StopSessionAndMaybeArchiveParams = Readonly<{
    hideInactiveSessions: boolean;
    isPinned: boolean;
    stopSession: () => Promise<SessionMutationResult>;
    archiveSession: () => Promise<SessionMutationResult>;
    stopErrorMessage: string;
    archiveErrorMessage: string;
}>;

export async function stopSessionAndMaybeArchive(params: StopSessionAndMaybeArchiveParams): Promise<void> {
    const stopResult = await params.stopSession();
    if (!stopResult.success) {
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
}
