import { describe, expect, it } from 'vitest';

import { SCM_COMMIT_MESSAGE_MAX_LENGTH } from '@happier-dev/protocol';

import { validateCommitMessage } from './commitMessage';

describe('validateCommitMessage', () => {
    it('rejects empty or whitespace-only messages', () => {
        expect(validateCommitMessage('')).toEqual({
            ok: false,
            message: 'Commit message cannot be empty.',
        });
        expect(validateCommitMessage('   ')).toEqual({
            ok: false,
            message: 'Commit message cannot be empty.',
        });
    });

    it('trims valid messages and accepts them', () => {
        expect(validateCommitMessage('  hello world  ')).toEqual({
            ok: true,
            message: 'hello world',
        });
    });

    it('rejects overly long messages using protocol max length', () => {
        const tooLong = 'a'.repeat(SCM_COMMIT_MESSAGE_MAX_LENGTH + 1);
        const result = validateCommitMessage(tooLong);

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toContain(String(SCM_COMMIT_MESSAGE_MAX_LENGTH));
        }
    });
});
