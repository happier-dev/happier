import { describe, expect, it } from 'vitest';

import {
    resolveToolCallsGroupAutoExpandLimit,
    shouldAutoExpandToolCallsGroupForShortTranscript,
} from './resolveToolCallsGroupAutoExpandPolicy';

describe('resolveToolCallsGroupAutoExpandPolicy', () => {
    it('does not auto-expand groups with no hidden tools', () => {
        expect(shouldAutoExpandToolCallsGroupForShortTranscript({
            toolMessageCount: 5,
            collapsedPreviewCount: 5,
            maxTurnEntriesPerListItem: 8,
        })).toBe(false);
    });

    it('keeps the short-transcript fallback for small hidden tool groups just above the preview band', () => {
        // preview=5 → upper band = max(5*2, 6) = 10; a 10-tool group is still small enough to expand.
        expect(shouldAutoExpandToolCallsGroupForShortTranscript({
            toolMessageCount: 10,
            collapsedPreviewCount: 5,
            maxTurnEntriesPerListItem: 8,
        })).toBe(true);
    });

    it('does NOT auto-expand a medium/large group (29) — it stays collapsed to summary like a freshly-streamed group', () => {
        // A ~29-tool group should NOT auto-expand into a tall rendered block on reopen. With the
        // default preview of 3 the upper band is max(3*2, 6) = 6, so 29 stays collapsed.
        expect(shouldAutoExpandToolCallsGroupForShortTranscript({
            toolMessageCount: 29,
            collapsedPreviewCount: 3,
            maxTurnEntriesPerListItem: 8,
        })).toBe(false);
        // Even with a larger preview of 5 (band = 10), 29 is well past the band and stays collapsed.
        expect(shouldAutoExpandToolCallsGroupForShortTranscript({
            toolMessageCount: 29,
            collapsedPreviewCount: 5,
            maxTurnEntriesPerListItem: 8,
        })).toBe(false);
    });

    it('does not auto-expand huge tool groups into one giant rendered row', () => {
        expect(shouldAutoExpandToolCallsGroupForShortTranscript({
            toolMessageCount: 200,
            collapsedPreviewCount: 5,
            maxTurnEntriesPerListItem: 8,
        })).toBe(false);
    });

    it('caps the upper auto-expand band at max(collapsedPreviewCount*2, 6), independent of turn grouping', () => {
        // Default preview (3) → floor of 6.
        expect(resolveToolCallsGroupAutoExpandLimit({
            collapsedPreviewCount: 3,
            maxTurnEntriesPerListItem: 8,
        })).toBe(6);
        // preview*2 dominates above the floor.
        expect(resolveToolCallsGroupAutoExpandLimit({
            collapsedPreviewCount: 5,
            maxTurnEntriesPerListItem: 8,
        })).toBe(10);
        expect(resolveToolCallsGroupAutoExpandLimit({
            collapsedPreviewCount: 12,
            maxTurnEntriesPerListItem: 8,
        })).toBe(24);
        // maxTurnEntriesPerListItem no longer widens the band — the ceiling tracks the preview only.
        expect(resolveToolCallsGroupAutoExpandLimit({
            collapsedPreviewCount: 5,
            maxTurnEntriesPerListItem: 16,
        })).toBe(10);
    });
});
