function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' ? value.trim() || null : null;
}

/** Only native session records can establish the identity of a Claude transcript. */
export function readClaudeTranscriptRecordSessionId(value: unknown): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.type === 'system' && record.subtype === 'init') {
        return readNonEmptyString(record.session_id);
    }

    switch (record.type) {
        case 'last-prompt':
        case 'mode':
        case 'permission-mode':
        case 'system':
        case 'user':
        case 'assistant':
            return readNonEmptyString(record.sessionId);
        default:
            return null;
    }
}
