import { describe, expect, it } from 'vitest';

import {
    resolveTranscriptNavigationEntryAccessibilityLabel,
    resolveTranscriptNavigationEntryPrimaryText,
    resolveTranscriptNavigationEntrySecondaryText,
} from './transcriptNavigationAccessibility';
import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';

function entry(overrides: Partial<TranscriptNavigationEntry>): TranscriptNavigationEntry {
    return {
        id: 'entry-1',
        sessionId: 'session-1',
        seq: 10,
        routeMessageId: 'server:m1',
        transcriptBlockIndex: null,
        kind: 'user-turn',
        role: 'user',
        label: 'Label text',
        fallbackLabelKind: null,
        promptPreview: 'prompt preview',
        responsePreview: 'response preview',
        createdAtMs: 1,
        pinned: false,
        pinnedAtMs: null,
        loaded: true,
        ...overrides,
    };
}

describe('transcriptNavigationAccessibility', () => {
    it('uses the prompt preview as primary and response as secondary for user turns', () => {
        const userTurn = entry({ kind: 'user-turn' });
        expect(resolveTranscriptNavigationEntryPrimaryText(userTurn)).toBe('prompt preview');
        expect(resolveTranscriptNavigationEntrySecondaryText(userTurn)).toBe('response preview');
    });

    it('swaps primary/secondary for pinned assistant, pinned tool, and deep-link entries', () => {
        for (const kind of ['pinned-assistant', 'pinned-tool', 'deep-link-target'] as const) {
            const pinnedRow = entry({ kind });
            expect(resolveTranscriptNavigationEntryPrimaryText(pinnedRow)).toBe('response preview');
            expect(resolveTranscriptNavigationEntrySecondaryText(pinnedRow)).toBe('prompt preview');
        }
    });

    it('falls back to the trimmed label, then the localized fallback kind, when previews are absent', () => {
        const labelled = entry({ kind: 'user-turn', promptPreview: null, label: '  spaced label  ' });
        expect(resolveTranscriptNavigationEntryPrimaryText(labelled)).toBe('spaced label');

        const fallbackTool = entry({
            kind: 'pinned-tool',
            responsePreview: null,
            label: '   ',
            fallbackLabelKind: 'pinned-tool',
        });
        const fallbackAssistant = entry({
            kind: 'pinned-assistant',
            responsePreview: null,
            label: '',
            fallbackLabelKind: 'pinned-assistant',
        });
        const toolText = resolveTranscriptNavigationEntryPrimaryText(fallbackTool);
        const assistantText = resolveTranscriptNavigationEntryPrimaryText(fallbackAssistant);
        expect(toolText.length).toBeGreaterThan(0);
        expect(assistantText.length).toBeGreaterThan(0);
        expect(toolText).not.toBe(assistantText);
    });

    it('returns an empty primary when no preview, label, or fallback kind exists', () => {
        const empty = entry({ kind: 'user-turn', promptPreview: null, label: '', fallbackLabelKind: null });
        expect(resolveTranscriptNavigationEntryPrimaryText(empty)).toBe('');
    });

    it('produces distinct accessibility labels for pinned and unpinned entries around the same primary text', () => {
        const unpinned = entry({ pinned: false });
        const pinned = entry({ pinned: true });
        const unpinnedLabel = resolveTranscriptNavigationEntryAccessibilityLabel(unpinned);
        const pinnedLabel = resolveTranscriptNavigationEntryAccessibilityLabel(pinned);
        expect(unpinnedLabel).toContain('prompt preview');
        expect(pinnedLabel).toContain('prompt preview');
        expect(pinnedLabel).not.toBe(unpinnedLabel);
    });
});
