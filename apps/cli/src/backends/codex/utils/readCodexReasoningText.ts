function readPlaintextParts(value: unknown, partTypes: readonly string[]): string | null {
    if (!Array.isArray(value)) return null;
    const parts: string[] = [];
    for (const entry of value) {
        // Native app-server items expose strings; rollout response items use typed text blocks.
        if (typeof entry === 'string' && entry.length > 0) {
            parts.push(entry);
        } else if (entry && typeof entry === 'object' && !Array.isArray(entry)
            && 'type' in entry && typeof entry.type === 'string' && partTypes.includes(entry.type)
            && 'text' in entry && typeof entry.text === 'string' && entry.text.length > 0) {
            parts.push(entry.text);
        }
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
}

/** Read only provider-exposed plaintext. Encrypted reasoning is never a transcript source. */
export function readCodexReasoningText(item: Readonly<Record<string, unknown>>): string | null {
    return readPlaintextParts(item.content, ['reasoning_text', 'text'])
        ?? readPlaintextParts(item.summary, ['summary_text']);
}
