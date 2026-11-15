import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';

/**
 * Reads canonical typed tool errors and messages that contain <tool_use_error> tags.
 * Typed failures are not cancellation-tagged tool-use errors.
 * 
 * Example:
 * Input: "<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>"
 * Output: { isToolUseError: true, errorMessage: "File has not been read yet. Read it first before writing to it." }
 */
export function parseToolUseError(message: unknown): {
    isToolUseError: boolean;
    errorMessage: string | null;
} {
    if (message && typeof message === 'object' && !Array.isArray(message)) {
        const record = message as Record<string, unknown>;
        const errorMessage = record.errorMessage;
        if (typeof errorMessage === 'string' && errorMessage.trim()) {
            return { isToolUseError: false, errorMessage };
        }
        const failureReason = record.failureReason;
        if (typeof failureReason === 'string' && failureReason.trim()) {
            return { isToolUseError: false, errorMessage: failureReason };
        }
        // Pre-canonical native title failures remain in stored histories (and
        // the 0.2 producer). Translate only this observed Action error shape;
        // current writers supply errorMessage above, never diagnostic JSON.
        const nativeFailure = maybeParseJson(record.content);
        if (nativeFailure && typeof nativeFailure === 'object' && !Array.isArray(nativeFailure)) {
            const failure = nativeFailure as Record<string, unknown>;
            if (failure.errorCode === 'change_title_failed' && typeof failure.error === 'string' && failure.error.trim()) {
                return { isToolUseError: false, errorMessage: failure.error };
            }
        }
    }
    // Check if the message is a string
    if (typeof message !== 'string') {
        return {
            isToolUseError: false,
            errorMessage: null
        };
    }

    // Match <tool_use_error> tags with content inside
    // The 's' flag allows . to match newlines
    const regex = /<tool_use_error>(.*?)<\/tool_use_error>/s;
    const match = message.match(regex);

    if (match) {
        return {
            isToolUseError: true,
            errorMessage: match[1] ? match[1].trim() : ''
        };
    }

    return {
        isToolUseError: false,
        errorMessage: null
    };
}
