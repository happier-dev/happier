import { t } from '@/text';

import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';

function resolveFallbackLabel(entry: TranscriptNavigationEntry): string {
    if (entry.fallbackLabelKind === 'pinned-assistant') {
        return t('session.transcriptNavigation.fallbackPinnedAssistant');
    }
    if (entry.fallbackLabelKind === 'pinned-tool') {
        return t('session.transcriptNavigation.fallbackPinnedTool');
    }
    if (entry.fallbackLabelKind === 'pinned-message') {
        return t('session.transcriptNavigation.fallbackPinnedMessage');
    }
    return '';
}

function resolveEntryLabel(entry: TranscriptNavigationEntry): string {
    const label = entry.label.trim();
    return label.length > 0 ? label : resolveFallbackLabel(entry);
}

export function resolveTranscriptNavigationEntryPrimaryText(entry: TranscriptNavigationEntry): string {
    if (entry.kind === 'pinned-assistant' || entry.kind === 'pinned-tool' || entry.kind === 'deep-link-target') {
        return entry.responsePreview ?? resolveEntryLabel(entry);
    }
    return entry.promptPreview ?? resolveEntryLabel(entry);
}

export function resolveTranscriptNavigationEntrySecondaryText(entry: TranscriptNavigationEntry): string | null {
    if (entry.kind === 'pinned-assistant' || entry.kind === 'pinned-tool' || entry.kind === 'deep-link-target') {
        return entry.promptPreview;
    }
    return entry.responsePreview;
}

export function resolveTranscriptNavigationEntryAccessibilityLabel(entry: TranscriptNavigationEntry): string {
    const primary = resolveTranscriptNavigationEntryPrimaryText(entry);
    if (entry.pinned) {
        return t('session.transcriptNavigation.entryPinnedA11y', { label: primary });
    }
    return t('session.transcriptNavigation.entryA11y', { label: primary });
}
