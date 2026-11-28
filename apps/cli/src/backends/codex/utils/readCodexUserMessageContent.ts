import { readCodexMessageContentText } from './readCodexMessageContentText';
import { codexNativeProjectionError } from './codexNativeProjectionError';

/** Preserve native content alongside the text projection used by existing clients. */
export function readCodexUserMessageContent(content: unknown): {
    text: string;
    nativeContent?: readonly Record<string, unknown>[];
} | null {
    if (typeof content === 'string') return content ? { text: content } : null;
    if (!Array.isArray(content)) throw codexNativeProjectionError('user content', null);
    const parts: Record<string, unknown>[] = [];
    const text: string[] = [];
    let preserveContent = false;
    for (const value of content) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw codexNativeProjectionError('user content', null);
        }
        const part: Record<string, unknown> = value;
        if (part.type === 'text' && typeof part.text === 'string') {
            text.push(part.text);
            if ((Array.isArray(part.text_elements) && part.text_elements.length > 0)
                || (Array.isArray(part.textElements) && part.textElements.length > 0)) preserveContent = true;
        } else if ((part.type === 'skill' || part.type === 'mention') && typeof part.name === 'string' && typeof part.path === 'string') {
            text.push(`[Codex ${part.type}: ${part.name} (${part.path})]`);
            preserveContent = true;
        } else if ((part.type === 'image' || part.type === 'audio')
            && (typeof part.url === 'string' || typeof part.fileId === 'string')) {
            // Codex 0.167 UserInput supports URLs or file ids; inline bodies stay out of display text.
            text.push(`[Codex ${part.type}: original content retained; preview unavailable]`);
            preserveContent = true;
        } else if ((part.type === 'localImage' || part.type === 'localAudio') && typeof part.path === 'string') {
            text.push(`[Codex local ${part.type === 'localImage' ? 'image' : 'audio'}: ${part.path}; preview unavailable]`);
            preserveContent = true;
        } else {
            throw codexNativeProjectionError('user content', part.type);
        }
        parts.push(part);
    }
    if (text.length === 0) return null;
    return { text: text.join('\n'), ...(preserveContent ? { nativeContent: parts } : {}) };
}


/** Rollouts persist Responses API ContentItem parts. Project supported parts through the UserInput reader. */
export function readCodexRolloutUserMessageContent(content: unknown): ReturnType<typeof readCodexUserMessageContent> {
    if (!Array.isArray(content)) {
        const text = readCodexMessageContentText(content);
        return text ? { text } : null;
    }

    const parts: Record<string, unknown>[] = [];
    for (const value of content) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const part: Record<string, unknown> = value;
        if (part.type === 'input_image') {
            const image = typeof part.image_url === 'string' ? { url: part.image_url }
                : typeof part.file_id === 'string' ? { fileId: part.file_id } : null;
            if (image) parts.push({ type: 'image', ...image, ...(typeof part.detail === 'string' ? { detail: part.detail } : {}) });
        } else if (part.type === 'input_audio' && typeof part.audio_url === 'string') {
            parts.push({ type: 'audio', url: part.audio_url });
        } else if (typeof part.text === 'string' && part.text.trim()) {
            parts.push({ type: 'text', text: part.text });
        }
    }
    return readCodexUserMessageContent(parts);
}
