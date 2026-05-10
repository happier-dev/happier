import type { CheckpointCodeRollbackRequest } from '@happier-dev/protocol';

import { CHECKPOINT_ROLLBACK_RECEIPT_IDS } from './receipts';
import type { CheckpointCodeRollbackPlan } from './types';

function isConversationMode(mode: CheckpointCodeRollbackRequest['codeMode']): boolean {
    return mode === 'conversation_only'
        || mode === 'conversation_and_code_with_stash'
        || mode === 'conversation_and_code_without_stash';
}

function isCodeOnlyMode(mode: CheckpointCodeRollbackRequest['codeMode']): boolean {
    return mode === 'code_only_with_stash' || mode === 'code_only_without_stash';
}

function isCodeMode(mode: CheckpointCodeRollbackRequest['codeMode']): boolean {
    return mode !== 'conversation_only';
}

export function planCheckpointCodeRollback(input: Readonly<{
    request: CheckpointCodeRollbackRequest;
    conversationRollbackSupported: boolean;
}>): CheckpointCodeRollbackPlan {
    const requiresConversationRollback = isConversationMode(input.request.codeMode);
    const requiresCodeRollback = isCodeMode(input.request.codeMode);

    if (!isCodeOnlyMode(input.request.codeMode)) {
        return {
            status: 'unavailable',
            request: input.request,
            requiresConversationRollback,
            requiresCodeRollback: false,
            requiresBackupCheckpoint: false,
            requiresGitStash: false,
            diagnostics: ['checkpoint_code_rollback_requires_code_only_mode'],
            receipts: [],
        };
    }

    if (requiresConversationRollback && !input.conversationRollbackSupported) {
        return {
            status: 'unavailable',
            request: input.request,
            requiresConversationRollback,
            requiresCodeRollback: false,
            requiresBackupCheckpoint: false,
            requiresGitStash: false,
            diagnostics: ['conversation_rollback_unavailable'],
            receipts: [],
        };
    }

    return {
        status: 'ready',
        request: input.request,
        requiresConversationRollback,
        requiresCodeRollback,
        requiresBackupCheckpoint: requiresCodeRollback,
        requiresGitStash: input.request.backupMode === 'happier_checkpoint_and_git_stash',
        diagnostics: [],
        receipts: [],
    };
}

export { CHECKPOINT_ROLLBACK_RECEIPT_IDS };
