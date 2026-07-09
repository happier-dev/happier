import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { decodeTranscriptBody } from '@/session/services/transcript/transcriptBodyDecoder';

function normalizePreviewText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}

function readDirectTranscriptItemPreview(item: ExternalSessionTranscriptRawMessageV1): string | null {
    const decoded = decodeTranscriptBody(item.raw);
    return decoded?.semanticRole === 'assistant'
        ? normalizePreviewText(decoded.text)
        : null;
}

export function buildExternalSessionReadyNotificationPreview(
    items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>,
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
