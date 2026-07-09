import { describe, expect, it } from 'vitest';

import { resolveTranscriptTargetWindowDisplay } from './resolveTranscriptTargetWindowDisplay';
import type { TranscriptTargetWindowState } from './transcriptTargetWindowTypes';

const inactiveWindow: TranscriptTargetWindowState = {
    isWindowMode: false,
    windowId: null,
    targetSeq: null,
    windowMinSeq: null,
    windowMaxSeq: null,
    olderCursor: null,
    newerCursor: null,
    hasMoreOlder: null,
    hasMoreNewer: null,
    activatedAtMs: null,
};

const activeWindow: TranscriptTargetWindowState = {
    isWindowMode: true,
    windowId: 'window-1',
    targetSeq: 100,
    windowMinSeq: 100,
    windowMaxSeq: 101,
    olderCursor: 100,
    newerCursor: 101,
    hasMoreOlder: true,
    hasMoreNewer: true,
    activatedAtMs: 10,
};

describe('resolveTranscriptTargetWindowDisplay', () => {
    it('returns the full tail list when target-window mode is inactive', () => {
        const items = [
            { id: 'msg-1', seq: 1 },
            { id: 'msg-2', seq: 2 },
        ] as const;

        const result = resolveTranscriptTargetWindowDisplay({
            items,
            windowState: inactiveWindow,
        });

        expect(result).toEqual({
            mode: 'tail',
            items,
            windowId: null,
            targetSeq: null,
            targetPresent: null,
            omittedBeforeCount: 0,
            omittedAfterCount: 0,
        });
    });

    it('renders only the replacement target window while leaving normalized rows untouched', () => {
        const tailBefore = { id: 'msg-1', seq: 1 };
        const target = { id: 'msg-100', seq: 100 };
        const targetNext = { id: 'msg-101', seq: 101 };
        const tailAfter = { id: 'msg-200', seq: 200 };
        const items = [tailBefore, target, targetNext, tailAfter] as const;

        const result = resolveTranscriptTargetWindowDisplay({
            items,
            windowState: activeWindow,
        });

        expect(result).toMatchObject({
            mode: 'window',
            windowId: 'window-1',
            targetSeq: 100,
            targetPresent: true,
            omittedBeforeCount: 1,
            omittedAfterCount: 1,
        });
        expect(result.items).toEqual([target, targetNext]);
        expect(items).toEqual([tailBefore, target, targetNext, tailAfter]);
    });

    it('uses a supplied seq resolver for row-shell items that do not carry seq directly', () => {
        const items = [
            { id: 'row-1', messageId: 'msg-1' },
            { id: 'row-100', messageId: 'msg-100' },
            { id: 'row-101', messageId: 'msg-101' },
            { id: 'row-200', messageId: 'msg-200' },
        ] as const;
        const seqByMessageId = new Map([
            ['msg-1', 1],
            ['msg-100', 100],
            ['msg-101', 101],
            ['msg-200', 200],
        ]);

        const result = resolveTranscriptTargetWindowDisplay({
            items,
            windowState: activeWindow,
            resolveSeq: (item) => seqByMessageId.get(item.messageId) ?? null,
        });

        expect(result.items.map((item) => item.id)).toEqual(['row-100', 'row-101']);
    });

    it('does not render distant in-window regions adjacent across an invisible seq gap', () => {
        const items = [
            { id: 'msg-100', seq: 100 },
            { id: 'msg-101', seq: 101 },
            { id: 'msg-105', seq: 105 },
            { id: 'msg-106', seq: 106 },
            { id: 'msg-120', seq: 120 },
        ] as const;

        const result = resolveTranscriptTargetWindowDisplay({
            items,
            windowState: {
                ...activeWindow,
                targetSeq: 105,
                windowMinSeq: 100,
                windowMaxSeq: 120,
            },
        });

        expect(result).toMatchObject({
            mode: 'window',
            windowId: 'window-1',
            targetSeq: 105,
            targetPresent: true,
            omittedBeforeCount: 2,
            omittedAfterCount: 1,
        });
        expect(result.items.map((item) => item.id)).toEqual(['msg-105', 'msg-106']);
    });

    it('keeps contiguity across item-seq gaps whose intermediate seqs are loaded (absorbed rows)', () => {
        // Live RG1/RG4 evidence: tool-result and meta messages render INSIDE their tool row,
        // so consecutive items can jump seq 331 -> 333 while seq 332 is fully loaded. Breaking
        // the group there truncates the window display right after the target and strands the
        // viewport at a false content bottom.
        const items = [
            { id: 'msg-330', seq: 330 },
            { id: 'tool-331', seq: 331 },
            { id: 'tool-333', seq: 333 },
            { id: 'msg-335', seq: 335 },
        ] as const;

        const result = resolveTranscriptTargetWindowDisplay({
            items,
            isSeqLoaded: (seq) => seq >= 300 && seq <= 400,
            windowState: {
                ...activeWindow,
                targetSeq: 331,
                windowMinSeq: 300,
                windowMaxSeq: 400,
            },
        });

        expect(result.targetPresent).toBe(true);
        expect(result.items.map((item) => item.id)).toEqual(['msg-330', 'tool-331', 'tool-333', 'msg-335']);
    });

    it('still breaks contiguity across gaps whose intermediate seqs are NOT loaded', () => {
        const items = [
            { id: 'msg-100', seq: 100 },
            { id: 'msg-101', seq: 101 },
            { id: 'msg-120', seq: 120 },
        ] as const;

        const result = resolveTranscriptTargetWindowDisplay({
            items,
            isSeqLoaded: (seq) => seq <= 101 || seq === 120,
            windowState: {
                ...activeWindow,
                targetSeq: 100,
                windowMinSeq: 100,
                windowMaxSeq: 120,
            },
        });

        expect(result.targetPresent).toBe(true);
        expect(result.items.map((item) => item.id)).toEqual(['msg-100', 'msg-101']);
    });

    it('returns an explicit absent-target window result instead of rendering the nearest group', () => {
        const items = [
            { id: 'msg-100', seq: 100 },
            { id: 'msg-101', seq: 101 },
            { id: 'msg-110', seq: 110 },
            { id: 'msg-111', seq: 111 },
        ] as const;

        const result = resolveTranscriptTargetWindowDisplay({
            items,
            windowState: {
                ...activeWindow,
                targetSeq: 105,
                windowMinSeq: 100,
                windowMaxSeq: 111,
            },
        });

        expect(result).toEqual({
            mode: 'window',
            items: [],
            windowId: 'window-1',
            targetSeq: 105,
            targetPresent: false,
            omittedBeforeCount: 4,
            omittedAfterCount: 0,
        });
    });
});
