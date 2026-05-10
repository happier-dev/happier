import type { CheckpointCodeRollbackBackupMode, SessionRollbackCodeMode } from '@happier-dev/protocol';

export type CheckpointCodeRollbackChoice = Readonly<{
    mode: SessionRollbackCodeMode;
    backupMode: CheckpointCodeRollbackBackupMode;
    primary: boolean;
    enabled: boolean;
    disabledReason?: 'conversation_rollback_unavailable';
    requiresAdvancedConfirmation: boolean;
}>;

export function requiresCheckpointCodeRollbackAdvancedConfirmation(mode: SessionRollbackCodeMode): boolean {
    return mode === 'code_only_with_stash' || mode === 'code_only_without_stash';
}

function choice(input: Readonly<{
    mode: SessionRollbackCodeMode;
    backupMode: CheckpointCodeRollbackBackupMode;
    primary: boolean;
    conversationRollbackSupported: boolean;
}>): CheckpointCodeRollbackChoice {
    const conversationMode = input.mode === 'conversation_only'
        || input.mode === 'conversation_and_code_with_stash'
        || input.mode === 'conversation_and_code_without_stash';
    const enabled = !conversationMode || input.conversationRollbackSupported;
    return {
        mode: input.mode,
        backupMode: input.backupMode,
        primary: input.primary,
        enabled,
        ...(enabled ? {} : { disabledReason: 'conversation_rollback_unavailable' as const }),
        requiresAdvancedConfirmation: requiresCheckpointCodeRollbackAdvancedConfirmation(input.mode),
    };
}

export function resolveCheckpointCodeRollbackChoices(input: Readonly<{
    conversationRollbackSupported: boolean;
}>): readonly CheckpointCodeRollbackChoice[] {
    return [
        choice({
            mode: 'conversation_only',
            backupMode: 'happier_checkpoint_only',
            primary: true,
            conversationRollbackSupported: input.conversationRollbackSupported,
        }),
        choice({
            mode: 'conversation_and_code_with_stash',
            backupMode: 'happier_checkpoint_and_git_stash',
            primary: true,
            conversationRollbackSupported: input.conversationRollbackSupported,
        }),
        choice({
            mode: 'conversation_and_code_without_stash',
            backupMode: 'happier_checkpoint_only',
            primary: true,
            conversationRollbackSupported: input.conversationRollbackSupported,
        }),
        choice({
            mode: 'code_only_with_stash',
            backupMode: 'happier_checkpoint_and_git_stash',
            primary: false,
            conversationRollbackSupported: input.conversationRollbackSupported,
        }),
        choice({
            mode: 'code_only_without_stash',
            backupMode: 'happier_checkpoint_only',
            primary: false,
            conversationRollbackSupported: input.conversationRollbackSupported,
        }),
    ];
}
