import { describe, expect, it } from 'vitest';

import {
    resolveTranscriptViewportAnchorLookup,
    resolveTranscriptViewportAnchorDescriptor,
    resolveTranscriptViewportAnchorFocusOffsetPx,
    resolveTranscriptViewportAnchorIndex,
} from '@/components/sessions/transcript/viewport/entryRestore/transcriptViewportAnchorResolution';

describe('transcriptViewportAnchorResolution', () => {
    it('resolves anchors by message id before falling back to item id', () => {
        const items = [
            { kind: 'message', id: 'stale-item', messageId: 'other-message' },
            { kind: 'tool-calls-group', id: 'new-item', toolMessageIds: ['message-1'] },
        ] as const;

        expect(resolveTranscriptViewportAnchorIndex({
            anchor: { messageId: 'message-1', itemId: 'stale-item' },
            items,
        })).toBe(1);
    });

    it('finds message ids inside turn rows', () => {
        const items = [
            {
                kind: 'turn',
                id: 'turn-1',
                turn: {
                    userMessageId: 'user-1',
                    content: [
                        { kind: 'message', messageId: 'assistant-1' },
                        { kind: 'tool_calls', toolMessageIds: ['tool-1'] },
                    ],
                },
            },
        ] as const;

        expect(resolveTranscriptViewportAnchorIndex({
            anchor: { messageId: 'tool-1', itemId: 'missing-item' },
            items,
        })).toBe(0);
    });

    it('falls back to durable seq when hydrated anchor ids are runtime-stale', () => {
        const items = [
            { kind: 'message', id: 'new-runtime-m300', messageId: 'new-runtime-m300', seq: 300 },
            { kind: 'message', id: 'new-runtime-m301', messageId: 'new-runtime-m301', seq: 301 },
            { kind: 'message', id: 'new-runtime-m302', messageId: 'new-runtime-m302', seq: 302 },
        ] as const;

        expect(resolveTranscriptViewportAnchorIndex({
            anchor: {
                messageId: 'server-m301',
                itemId: 'old-runtime-m301',
                seq: 301,
            },
            items,
        })).toBe(1);
    });

    it('creates the finest stable descriptor available for a turn row', () => {
        expect(resolveTranscriptViewportAnchorDescriptor({
            kind: 'turn',
            id: 'turn-1',
            turn: {
                userMessageId: null,
                content: [{ kind: 'tool_calls', toolMessageIds: ['tool-1'] }],
            },
        })).toEqual({
            kind: 'toolGroup',
            itemId: 'turn-1',
            messageId: 'tool-1',
        });
    });

    describe('tool-group unit rows (N2c)', () => {
        const groupId = 'toolCalls:turn:x:tool-1';
        const toolMessageIds = ['tool-1', 'tool-2', 'tool-3'];
        const headerUnit = {
            kind: 'tool-group-header',
            id: `${groupId}#header`,
            groupId,
            toolMessageIds,
        } as const;
        const expandUnit = {
            kind: 'tool-group-expand',
            id: `${groupId}#expand`,
            groupId,
            toolMessageIds,
        } as const;
        const toolUnit = (toolMessageId: string) => ({
            kind: 'tool-group-tool',
            id: `${groupId}#tool:${toolMessageId}`,
            groupId,
            toolMessageId,
            toolMessageIds,
        } as const);
        const footerUnit = {
            kind: 'tool-group-footer',
            id: `${groupId}#footer`,
            groupId,
            toolMessageIds,
        } as const;

        it('prefers the exact message-owning tool unit over header containment', () => {
            const items = [headerUnit, expandUnit, toolUnit('tool-2'), toolUnit('tool-3'), footerUnit] as const;

            expect(resolveTranscriptViewportAnchorIndex({
                anchor: { messageId: 'tool-3', itemId: 'missing-item' },
                items,
            })).toBe(3);
        });

        it('falls back to the containing header unit for a collapsed/hidden tool', () => {
            // tool-1 is hidden behind the collapsed preview: no tool unit row exists for it.
            const items = [
                { kind: 'message', id: 'msg:m0', messageId: 'm0' },
                headerUnit,
                expandUnit,
                toolUnit('tool-3'),
                footerUnit,
            ] as const;

            expect(resolveTranscriptViewportAnchorIndex({
                anchor: { messageId: 'tool-1', itemId: 'missing-item' },
                items,
            })).toBe(1);
        });

        it('keeps the item-id fallback for unit rows', () => {
            const items = [headerUnit, footerUnit] as const;

            expect(resolveTranscriptViewportAnchorIndex({
                anchor: { messageId: 'unknown-message', itemId: `${groupId}#footer` },
                items,
            })).toBe(1);
        });

        it('describes a tool unit as a message anchor owning its tool message id', () => {
            expect(resolveTranscriptViewportAnchorDescriptor(toolUnit('tool-2'))).toEqual({
                kind: 'message',
                itemId: `${groupId}#tool:tool-2`,
                messageId: 'tool-2',
            });
        });

        it('describes header/expand/footer units as tool-group anchors keyed by the first tool', () => {
            expect(resolveTranscriptViewportAnchorDescriptor(headerUnit)).toEqual({
                kind: 'toolGroup',
                itemId: `${groupId}#header`,
                messageId: 'tool-1',
            });
            expect(resolveTranscriptViewportAnchorDescriptor(expandUnit)).toEqual({
                kind: 'toolGroup',
                itemId: `${groupId}#expand`,
                messageId: 'tool-1',
            });
            expect(resolveTranscriptViewportAnchorDescriptor(footerUnit)).toEqual({
                kind: 'toolGroup',
                itemId: `${groupId}#footer`,
                messageId: 'tool-1',
            });
        });
    });

    it('uses the shared clamped focus-line offset', () => {
        expect(resolveTranscriptViewportAnchorFocusOffsetPx(100)).toBe(64);
        expect(resolveTranscriptViewportAnchorFocusOffsetPx(600)).toBe(108);
        expect(resolveTranscriptViewportAnchorFocusOffsetPx(2000)).toBe(128);
    });

    describe('durable anchor lookup diagnostics', () => {
        const items = [
            { kind: 'message', id: 'msg:m10', messageId: 'm10', seq: 10 },
            { kind: 'message', id: 'msg:m20', messageId: 'm20', seq: 20 },
            { kind: 'message', id: 'msg:m40', messageId: 'm40', seq: 40 },
        ] as const;

        it('classifies cold durable-anchor misses with precise telemetry reasons', () => {
            expect(resolveTranscriptViewportAnchorLookup({
                anchor: { messageId: 'server-anchor', itemId: 'msg:server-anchor', seq: null },
                hydrationState: 'not-hydrated',
                items,
            })).toEqual({ status: 'missing', reason: 'not-hydrated' });

            expect(resolveTranscriptViewportAnchorLookup({
                anchor: { messageId: 'server-anchor', itemId: 'msg:server-anchor', seq: 5 },
                canMaterializeOlder: true,
                items,
                materializedSeqRange: { minSeq: 10, maxSeq: 40 },
            })).toEqual({ status: 'missing', reason: 'not-in-window' });

            expect(resolveTranscriptViewportAnchorLookup({
                anchor: { messageId: 'server-anchor', itemId: 'msg:server-anchor', seq: 5 },
                canMaterializeOlder: false,
                items,
                materializedSeqRange: { minSeq: 10, maxSeq: 40 },
            })).toEqual({ status: 'missing', reason: 'pruned' });

            expect(resolveTranscriptViewportAnchorLookup({
                anchor: { messageId: 'server-anchor', itemId: 'msg:server-anchor', seq: 5 },
                forkBoundarySeq: 8,
                items,
                materializedSeqRange: { minSeq: 10, maxSeq: 40 },
            })).toEqual({ status: 'missing', reason: 'fork-boundary' });

            expect(resolveTranscriptViewportAnchorLookup({
                anchor: { messageId: 'server-anchor', itemId: 'msg:server-anchor', seq: 30 },
                items,
                materializedSeqRange: { minSeq: 10, maxSeq: 40 },
            })).toEqual({ status: 'missing', reason: 'deleted-missing' });
        });
    });
});
