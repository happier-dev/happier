import { GIT_COMMIT_MESSAGE_MAX_LENGTH } from '@happier-dev/protocol';

export type CommitMessageValidationResult =
    | { ok: true; message: string }
    | { ok: false; message: string };

export function validateCommitMessage(rawMessage: string): CommitMessageValidationResult {
    const message = rawMessage.trim();
    if (message.length === 0) {
        return {
            ok: false,
            message: 'Commit message cannot be empty.',
        };
    }

    if (message.length > GIT_COMMIT_MESSAGE_MAX_LENGTH) {
        return {
            ok: false,
            message: `Commit message is too long. Maximum length is ${GIT_COMMIT_MESSAGE_MAX_LENGTH} characters.`,
        };
    }

    return {
        ok: true,
        message,
    };
}
