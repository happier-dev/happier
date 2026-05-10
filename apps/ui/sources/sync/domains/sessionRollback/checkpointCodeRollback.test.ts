import { describe, expect, it } from 'vitest';

import {
    requiresCheckpointCodeRollbackAdvancedConfirmation,
    resolveCheckpointCodeRollbackChoices,
} from './checkpointCodeRollback';

describe('resolveCheckpointCodeRollbackChoices', () => {
    it('enables the three primary choices when conversation rollback is supported', () => {
        const choices = resolveCheckpointCodeRollbackChoices({ conversationRollbackSupported: true });

        expect(choices.filter((choice) => choice.primary).map((choice) => [choice.mode, choice.enabled])).toEqual([
            ['conversation_only', true],
            ['conversation_and_code_with_stash', true],
            ['conversation_and_code_without_stash', true],
        ]);
    });

    it('disables conversation choices without falling back to code rollback when conversation rollback is unsupported', () => {
        const choices = resolveCheckpointCodeRollbackChoices({ conversationRollbackSupported: false });

        expect(choices.find((choice) => choice.mode === 'conversation_only')?.enabled).toBe(false);
        expect(choices.find((choice) => choice.mode === 'conversation_and_code_with_stash')?.enabled).toBe(false);
        expect(choices.find((choice) => choice.mode === 'conversation_and_code_without_stash')?.enabled).toBe(false);
        expect(choices.find((choice) => choice.mode === 'code_only_with_stash')?.enabled).toBe(true);
        expect(choices.find((choice) => choice.mode === 'code_only_without_stash')?.enabled).toBe(true);
    });

    it('requires advanced confirmation only for code-only modes', () => {
        expect(requiresCheckpointCodeRollbackAdvancedConfirmation('code_only_with_stash')).toBe(true);
        expect(requiresCheckpointCodeRollbackAdvancedConfirmation('code_only_without_stash')).toBe(true);
        expect(requiresCheckpointCodeRollbackAdvancedConfirmation('conversation_and_code_without_stash')).toBe(false);
    });
});
