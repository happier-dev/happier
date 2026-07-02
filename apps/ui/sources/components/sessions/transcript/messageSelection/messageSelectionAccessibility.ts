import { t } from '@/text';

import type { TranscriptSelectableMessageRole } from './_types';

const MAX_ACCESSIBILITY_PREVIEW_LENGTH = 80;

export function truncateMessageSelectionAccessibilityPreview(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= MAX_ACCESSIBILITY_PREVIEW_LENGTH) return normalized;
    return `${normalized.slice(0, MAX_ACCESSIBILITY_PREVIEW_LENGTH - 1)}…`;
}

export function formatMessageSelectionRowAccessibilityLabel(props: Readonly<{
    role: TranscriptSelectableMessageRole;
    previewText: string;
}>): string {
    return t('transcript.selection.rowA11y', {
        role: props.role,
        preview: truncateMessageSelectionAccessibilityPreview(props.previewText),
    });
}
