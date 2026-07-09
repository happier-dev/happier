import { describe, expect, it } from 'vitest';

import {
    buildTranscriptHotColdSegments,
    NATIVE_LIVE_TAIL_SAFETY_CEILING_ITEMS,
} from './buildTranscriptHotColdSegments';

describe('buildTranscriptHotColdSegments', () => {
    it('keeps the newest tail items hot and older items cold', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 2,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'message', id: 'm2', messageId: 'm2' },
                { kind: 'message', id: 'm3', messageId: 'm3' },
                { kind: 'message', id: 'm4', messageId: 'm4' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(),
        });

        expect(result.coldItems.map((item) => item.id)).toEqual(['m1', 'm2']);
        expect(result.hotItems.map((item) => item.id)).toEqual(['m3', 'm4']);
    });

    it('widens the hot segment to keep an active thinking row in the live tail', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 1,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'message', id: 'm2', messageId: 'm2' },
                { kind: 'message', id: 'm3', messageId: 'm3' },
            ],
            activeThinkingMessageId: 'm2',
            expandedToolCallsAnchorMessageIds: new Set<string>(),
        });

        expect(result.coldItems.map((item) => item.id)).toEqual(['m1']);
        expect(result.hotItems.map((item) => item.id)).toEqual(['m2', 'm3']);
    });

    it('widens the hot segment to keep expanded tool groups in the live tail', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 1,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'tool-calls-group', id: 'tools-1', toolMessageIds: ['tool-1', 'tool-2'] },
                { kind: 'message', id: 'm2', messageId: 'm2' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(['tool-2']),
        });

        expect(result.coldItems.map((item) => item.id)).toEqual(['m1']);
        expect(result.hotItems.map((item) => item.id)).toEqual(['tools-1', 'm2']);
    });

    it('keeps pending queues and action drafts in the hot tail even when the tail window is small', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 1,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'pending-queue', id: 'pending-queue' },
                { kind: 'action-draft', id: 'draft:1' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(),
        });

        expect(result.coldItems.map((item) => item.id)).toEqual(['m1']);
        expect(result.hotItems.map((item) => item.id)).toEqual(['pending-queue', 'draft:1']);
    });

    it('leaves the transcript unsplit when disabled', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: false,
            hotTailItemCount: 2,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'message', id: 'm2', messageId: 'm2' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(),
        });

        expect(result.coldItems.map((item) => item.id)).toEqual(['m1', 'm2']);
        expect(result.hotItems).toEqual([]);
    });

    it('keeps at least one item cold when segmentation is enabled', () => {
        const result = buildTranscriptHotColdSegments({
            enabled: true,
            hotTailItemCount: 999,
            items: [
                { kind: 'message', id: 'm1', messageId: 'm1' },
                { kind: 'message', id: 'm2', messageId: 'm2' },
            ],
            activeThinkingMessageId: null,
            expandedToolCallsAnchorMessageIds: new Set<string>(),
        });

        expect(result.coldItems.length).toBe(1);
        expect(result.hotItems.map((item) => item.id)).toEqual(['m2']);
    });

    describe('liveTailOnly (native live-tail carve)', () => {
        it('does not carve when nothing is streaming (no anchor)', () => {
            const result = buildTranscriptHotColdSegments({
                enabled: true,
                hotTailItemCount: 4,
                liveTailOnly: true,
                maxHotTailItems: 4,
                liveTailAnchorMessageId: null,
                items: [
                    { kind: 'message', id: 'm1', messageId: 'm1' },
                    { kind: 'message', id: 'm2', messageId: 'm2' },
                    { kind: 'message', id: 'm3', messageId: 'm3' },
                ],
                activeThinkingMessageId: null,
                expandedToolCallsAnchorMessageIds: new Set<string>(),
            });

            expect(result.hotItems).toEqual([]);
            expect(result.coldItems.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
        });

        it('carves the live region from the anchored streaming row to the end', () => {
            const result = buildTranscriptHotColdSegments({
                enabled: true,
                hotTailItemCount: 4,
                liveTailOnly: true,
                maxHotTailItems: 4,
                liveTailAnchorMessageId: 'm3',
                items: [
                    { kind: 'message', id: 'm1', messageId: 'm1' },
                    { kind: 'message', id: 'm2', messageId: 'm2' },
                    { kind: 'message', id: 'm3', messageId: 'm3' },
                    { kind: 'message', id: 'm4', messageId: 'm4' },
                ],
                activeThinkingMessageId: null,
                expandedToolCallsAnchorMessageIds: new Set<string>(),
            });

            expect(result.coldItems.map((item) => item.id)).toEqual(['m1', 'm2']);
            expect(result.hotItems.map((item) => item.id)).toEqual(['m3', 'm4']);
        });

        it('anchors on a running tool group row owning the streaming id', () => {
            const result = buildTranscriptHotColdSegments({
                enabled: true,
                hotTailItemCount: 4,
                liveTailOnly: true,
                maxHotTailItems: 4,
                liveTailAnchorMessageId: 'tool-2',
                items: [
                    { kind: 'message', id: 'm1', messageId: 'm1' },
                    { kind: 'message', id: 'm2', messageId: 'm2' },
                    { kind: 'tool-calls-group', id: 'tools-1', toolMessageIds: ['tool-1', 'tool-2'] },
                ],
                activeThinkingMessageId: null,
                expandedToolCallsAnchorMessageIds: new Set<string>(),
            });

            expect(result.coldItems.map((item) => item.id)).toEqual(['m1', 'm2']);
            expect(result.hotItems.map((item) => item.id)).toEqual(['tools-1']);
        });

        it('keeps the WHOLE live region hot even when it exceeds maxHotTailItems (R3 — newest growing row always hot)', () => {
            const items = [
                { kind: 'message' as const, id: 'm0', messageId: 'm0' },
                ...Array.from({ length: 10 }, (_, i) => ({
                    kind: 'message' as const,
                    id: `live${i}`,
                    messageId: `live${i}`,
                })),
            ];
            const result = buildTranscriptHotColdSegments({
                enabled: true,
                hotTailItemCount: 4,
                liveTailOnly: true,
                maxHotTailItems: 4,
                liveTailAnchorMessageId: 'live0',
                items,
                activeThinkingMessageId: null,
                expandedToolCallsAnchorMessageIds: new Set<string>(),
            });

            // The cap does NOT forward-clip the live region: the full [anchor, end] stays hot.
            expect(result.coldItems.map((item) => item.id)).toEqual(['m0']);
            expect(result.hotItems).toHaveLength(10);
            expect(result.hotItems[0]!.id).toBe('live0');
            expect(result.hotItems[result.hotItems.length - 1]!.id).toBe('live9');
        });

        it('bounds only a PATHOLOGICAL live region by the safety ceiling, clipping oldest settled rows', () => {
            const total = NATIVE_LIVE_TAIL_SAFETY_CEILING_ITEMS + 12;
            const items = Array.from({ length: total }, (_, i) => ({
                kind: 'message' as const,
                id: `m${i}`,
                messageId: `m${i}`,
            }));
            const result = buildTranscriptHotColdSegments({
                enabled: true,
                hotTailItemCount: 4,
                liveTailOnly: true,
                maxHotTailItems: 4,
                // Anchor at index 0: the live region spans the whole (pathologically huge) transcript.
                liveTailAnchorMessageId: 'm0',
                items,
                activeThinkingMessageId: null,
                expandedToolCallsAnchorMessageIds: new Set<string>(),
            });

            // The newest rows are always hot; the oldest settled rows are clipped to the ceiling.
            expect(result.hotItems).toHaveLength(NATIVE_LIVE_TAIL_SAFETY_CEILING_ITEMS);
            expect(result.coldItems).toHaveLength(total - NATIVE_LIVE_TAIL_SAFETY_CEILING_ITEMS);
            expect(result.hotItems[result.hotItems.length - 1]!.id).toBe(`m${total - 1}`);
        });

        it('does NOT carve when the anchor lands at index 0 with no settled cold body (FIX 3)', () => {
            const result = buildTranscriptHotColdSegments({
                enabled: true,
                hotTailItemCount: 4,
                liveTailOnly: true,
                maxHotTailItems: 4,
                liveTailAnchorMessageId: 'm0',
                items: [
                    { kind: 'message', id: 'm0', messageId: 'm0' },
                    { kind: 'pending-queue', id: 'pending-queue' },
                ],
                activeThinkingMessageId: null,
                expandedToolCallsAnchorMessageIds: new Set<string>(),
            });

            expect(result.hotItems).toEqual([]);
            expect(result.coldItems.map((item) => item.id)).toEqual(['m0', 'pending-queue']);
        });

        it('carves when a genuine cold body precedes the anchor at index 1 (FIX 3 positive control)', () => {
            const result = buildTranscriptHotColdSegments({
                enabled: true,
                hotTailItemCount: 4,
                liveTailOnly: true,
                maxHotTailItems: 4,
                liveTailAnchorMessageId: 'm1',
                items: [
                    { kind: 'message', id: 'm0', messageId: 'm0' },
                    { kind: 'message', id: 'm1', messageId: 'm1' },
                ],
                activeThinkingMessageId: null,
                expandedToolCallsAnchorMessageIds: new Set<string>(),
            });

            expect(result.coldItems.map((item) => item.id)).toEqual(['m0']);
            expect(result.hotItems.map((item) => item.id)).toEqual(['m1']);
        });
    });
});
