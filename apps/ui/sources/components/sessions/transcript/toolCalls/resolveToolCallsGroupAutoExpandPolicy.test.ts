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

    it('keeps the short-transcript fallback for small hidden tool groups', () => {
        expect(shouldAutoExpandToolCallsGroupForShortTranscript({
            toolMessageCount: 10,
            collapsedPreviewCount: 5,
            maxTurnEntriesPerListItem: 8,
        })).toBe(true);
    });

    it('does not auto-expand huge tool groups into one giant rendered row', () => {
        expect(shouldAutoExpandToolCallsGroupForShortTranscript({
            toolMessageCount: 200,
            collapsedPreviewCount: 5,
            maxTurnEntriesPerListItem: 8,
        })).toBe(false);
    });

    it('scales the huge-group cutoff from transcript grouping and preview policy', () => {
        expect(resolveToolCallsGroupAutoExpandLimit({
            collapsedPreviewCount: 5,
            maxTurnEntriesPerListItem: 8,
        })).toBe(32);
        expect(resolveToolCallsGroupAutoExpandLimit({
            collapsedPreviewCount: 12,
            maxTurnEntriesPerListItem: 8,
        })).toBe(48);
        expect(resolveToolCallsGroupAutoExpandLimit({
            collapsedPreviewCount: 5,
            maxTurnEntriesPerListItem: 16,
        })).toBe(64);
    });
});
