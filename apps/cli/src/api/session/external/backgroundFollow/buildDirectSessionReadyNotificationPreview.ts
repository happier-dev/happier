import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

function normalizePreviewText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}

function readClaudeOutputPreview(data: unknown): string | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const typedData = data as Record<string, unknown>;
    const message = typedData.message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return null;
    }

    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') {
        return normalizePreviewText(content);
    }
    if (!Array.isArray(content)) {
        return null;
    }

    const fragments: string[] = [];
    for (const block of content) {
        if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
        const typedBlock = block as Record<string, unknown>;
        if (typedBlock.type !== 'text') continue;
        const text = normalizePreviewText(typedBlock.text);
        if (text) {
            fragments.push(text);
        }
    }

    return normalizePreviewText(fragments.join(' '));
}

function readCodexOutputPreview(data: unknown): string | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const typedData = data as Record<string, unknown>;
    if (typedData.type === 'message') {
        return normalizePreviewText(typedData.message);
    }
    return null;
}

function readDirectTranscriptItemPreview(item: DirectTranscriptRawMessageV1): string | null {
    const raw = item.raw;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const role = typeof (raw as { role?: unknown }).role === 'string'
        ? String((raw as { role?: unknown }).role).trim()
        : '';
    if (role === 'user') return null;

    const content = (raw as { content?: unknown }).content;
    if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
    const typedContent = content as Record<string, unknown>;

    if (typedContent.type === 'text') {
        return normalizePreviewText(typedContent.text);
    }
    if (typedContent.type === 'codex') {
        return readCodexOutputPreview(typedContent.data);
    }
    if (typedContent.type === 'output') {
        return readClaudeOutputPreview(typedContent.data);
    }
    return null;
}

export function buildDirectSessionReadyNotificationPreview(
    items: ReadonlyArray<DirectTranscriptRawMessageV1>,
): string | null {
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (!item) continue;
        const preview = readDirectTranscriptItemPreview(item);
        if (preview) {
            return preview;
        }
    }
    return null;
}
