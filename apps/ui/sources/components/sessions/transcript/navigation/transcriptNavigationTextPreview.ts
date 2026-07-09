import { stripMarkdown } from '@/utils/sessions/messageUtils';

const PREVIEW_MAX_LENGTH = 220;

export function normalizeTranscriptNavigationTextPreview(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const normalized = stripMarkdown(value);
    if (!normalized) return null;
    if (normalized.length <= PREVIEW_MAX_LENGTH) return normalized;
    return `${normalized.slice(0, PREVIEW_MAX_LENGTH - 3).trimEnd()}...`;
}
