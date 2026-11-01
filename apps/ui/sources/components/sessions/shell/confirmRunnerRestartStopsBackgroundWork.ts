import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { hasActiveSessionRuntimeActivity } from '@happier-dev/protocol';

// Repeated presses while the dialog is open must not stack dialogs (and restart requests).
let confirmationOpen = false;

/**
 * Restarting a session runner ends its provider process, which also stops every background agent
 * or shell it hosts. The user decides here before the restart request is sent; the daemon trusts
 * this confirmation and does not re-check background activity for UI-originated restarts.
 * Resolves `true` when the restart may proceed.
 */
export async function confirmRunnerRestartStopsBackgroundWork(sessionId: string): Promise<boolean> {
    const session = storage.getState().sessions[sessionId];
    // SessionView renders only stored sessions, so a missing record has no runtime to protect.
    if (!session) return true;
    if (!hasActiveSessionRuntimeActivity({
        state: session.runtimeActivityState,
        activeCount: session.runtimeActivityActiveCount,
    })) return true;
    if (confirmationOpen) return false;
    confirmationOpen = true;
    try {
        return await Modal.confirm(
            t('session.runnerRestartBackgroundWork.title'),
            t('session.runnerRestartBackgroundWork.body', { count: session.runtimeActivityActiveCount ?? 0 }),
            {
                cancelText: t('common.cancel'),
                confirmText: t('session.runnerRestartBackgroundWork.confirmAction'),
                destructive: true,
            },
        );
    } finally {
        confirmationOpen = false;
    }
}
