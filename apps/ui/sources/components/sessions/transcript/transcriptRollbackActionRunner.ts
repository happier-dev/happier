import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { t } from '@/text';
import type { SessionRollbackCodeMode, SessionRollbackTarget } from '@happier-dev/protocol';
import type { CheckpointCodeRollbackDialogConfirmValue } from './CheckpointCodeRollbackDialog';
import { showCheckpointCodeRollbackDialog } from './CheckpointCodeRollbackDialog';

type TranscriptRollbackExecutor = Pick<ReturnType<typeof createDefaultActionExecutor>, 'execute'>;

export type CheckpointCodeRollbackEvidence = Readonly<{
    conversationRollbackSupported: boolean;
    turnId: string;
    cwd: string;
    expectedStartRef: string;
    expectedFinalRef: string;
}>;

function readInnerOkError(value: unknown): { ok: boolean; errorMessage?: string } | null {
    if (!value || typeof value !== 'object') return null;
    if (!('ok' in value)) return null;
    const ok = (value as { ok?: unknown }).ok;
    if (typeof ok !== 'boolean') return null;
    const errorMessage = (value as { errorMessage?: unknown }).errorMessage;
    return {
        ok,
        ...(typeof errorMessage === 'string' ? { errorMessage } : null),
    };
}

function isApprovalRequestCreated(value: unknown): boolean {
    return !!value
        && typeof value === 'object'
        && (value as { kind?: unknown }).kind === 'approval_request_created';
}

function readCheckpointRollbackFailure(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;
    const status = (value as { status?: unknown }).status;
    if (status === 'applied' || status === 'conversation_only') return null;
    if (status !== 'conflict' && status !== 'aborted' && status !== 'unavailable') return null;
    const diagnostics = (value as { diagnostics?: unknown }).diagnostics;
    if (Array.isArray(diagnostics)) {
        const message = diagnostics.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
        if (message) return message;
    }
    return t('errors.unknownError');
}

function toCodeOnlyCheckpointRollbackMode(mode: SessionRollbackCodeMode): 'code_only_with_stash' | 'code_only_without_stash' | null {
    if (mode === 'code_only_with_stash' || mode === 'conversation_and_code_with_stash') return 'code_only_with_stash';
    if (mode === 'code_only_without_stash' || mode === 'conversation_and_code_without_stash') return 'code_only_without_stash';
    return null;
}

export async function executeTranscriptRollbackAction(params: Readonly<{
    checkpointChoice?: CheckpointCodeRollbackDialogConfirmValue | null;
    checkpointCodeRollback?: CheckpointCodeRollbackEvidence;
    executor: TranscriptRollbackExecutor;
    restoredDraftText?: string | null;
    sessionId: string;
    target?: SessionRollbackTarget;
}>): Promise<void> {
    const checkpoint = params.checkpointCodeRollback;
    const checkpointChoice = checkpoint
        ? params.checkpointChoice ?? await showCheckpointCodeRollbackDialog({
            conversationRollbackSupported: checkpoint.conversationRollbackSupported,
        })
        : null;
    if (checkpoint && !checkpointChoice) return;

    const shouldRollbackConversation = !checkpoint
        || checkpointChoice?.mode === 'conversation_only'
        || checkpointChoice?.mode.startsWith('conversation_and_code_') === true;
    if (shouldRollbackConversation) {
        const target = params.target ?? { type: 'latest_turn' };
        const result = await params.executor.execute('session.rollback', {
            sessionId: params.sessionId,
            target,
        }, {
            defaultSessionId: params.sessionId,
            surface: 'ui',
        });

        if (result.ok !== true) {
            Modal.alert(t('common.error'), result.error ?? t('errors.unknownError'));
            return;
        }

        if (isApprovalRequestCreated(result.result)) {
            return;
        }

        const inner = readInnerOkError(result.result);
        if (!inner) {
            Modal.alert(t('common.error'), t('errors.unknownError'));
            return;
        }
        if (inner && inner.ok !== true) {
            Modal.alert(t('common.error'), inner.errorMessage ?? t('errors.unknownError'));
            return;
        }
    }

    if (checkpoint && checkpointChoice && checkpointChoice.mode !== 'conversation_only') {
        const selectedCheckpointChoice = checkpointChoice;
        const codeMode = toCodeOnlyCheckpointRollbackMode(selectedCheckpointChoice.mode);
        if (!codeMode) return;
        const request = {
            v: 1,
            sessionId: params.sessionId,
            turnId: checkpoint.turnId,
            cwd: checkpoint.cwd,
            codeMode,
            backupMode: selectedCheckpointChoice.backupMode,
            expectedStartRef: checkpoint.expectedStartRef,
            expectedFinalRef: checkpoint.expectedFinalRef,
            codeOnlyTranscriptDivergenceConfirmed: true,
        } as const;
        const result = await params.executor.execute('session.checkpoint_code_rollback', request, {
            defaultSessionId: params.sessionId,
            surface: 'ui',
        });
        if (result.ok !== true) {
            Modal.alert(t('common.error'), result.error ?? t('errors.unknownError'));
            return;
        }
        const rollbackFailure = readCheckpointRollbackFailure(result.result);
        if (rollbackFailure) {
            Modal.alert(t('common.error'), rollbackFailure);
        }
        return;
    }

    const restoredDraftText = typeof params.restoredDraftText === 'string' ? params.restoredDraftText : null;
    if (restoredDraftText && restoredDraftText.trim().length > 0) {
        storage.getState().updateSessionDraft(params.sessionId, restoredDraftText);
    }
}
