/** Preserve native content alongside the text projection used by existing clients. */
export function readCodexUserMessageContent(content: unknown): {
    text: string;
    nativeContent?: readonly Record<string, unknown>[];
} | null {
    if (typeof content === 'string') return content ? { text: content } : null;
    if (!Array.isArray(content)) throw new Error('Codex native history contains unsupported user content');
    const parts: Record<string, unknown>[] = [];
    const text: string[] = [];
    let preserveContent = false;
    for (const value of content) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Codex native history contains unsupported user content');
        }
        const part: Record<string, unknown> = value;
        if (part.type === 'text' && typeof part.text === 'string') {
            text.push(part.text);
            if (Array.isArray(part.text_elements) && part.text_elements.length > 0) preserveContent = true;
        } else if ((part.type === 'skill' || part.type === 'mention') && typeof part.name === 'string' && typeof part.path === 'string') {
            text.push(`[Codex ${part.type}: ${part.name} (${part.path})]`);
            preserveContent = true;
        } else if (part.type === 'image' && typeof part.url === 'string') {
            // Native data URLs can contain large private image bodies. Keep them out of display text.
            text.push('[Codex image: original content retained; preview unavailable]');
            preserveContent = true;
        } else if (part.type === 'localImage' && typeof part.path === 'string') {
            text.push(`[Codex local image: ${part.path}; preview unavailable]`);
            preserveContent = true;
        } else {
            throw new Error('Codex native history contains unsupported user content');
        }
        parts.push(part);
    }
    if (text.length === 0) return null;
    return { text: text.join('\n'), ...(preserveContent ? { nativeContent: parts } : {}) };
}
