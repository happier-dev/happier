import { describe, expect, it } from 'vitest';

import type { TranscriptRowShellItem } from '@/components/sessions/transcript/measurement/transcriptRowShellSignature';

import {
    resolveTranscriptRowContentCount,
    resolveTranscriptRowViewportRelation,
} from './transcriptRowEvidence';

describe('resolveTranscriptRowViewportRelation (N1.2)', () => {
    const viewport = { scrollOffsetY: 1000, viewportHeightPx: 800 };

    it('classifies a row fully above the viewport as above', () => {
        expect(resolveTranscriptRowViewportRelation({
            rowTopY: 100,
            rowHeightPx: 200,
            ...viewport,
        })).toBe('above');
    });

    it('classifies a row touching the viewport top edge as above (exclusive boundary)', () => {
        expect(resolveTranscriptRowViewportRelation({
            rowTopY: 800,
            rowHeightPx: 200,
            ...viewport,
        })).toBe('above');
    });

    it('classifies a row overlapping the viewport as inside', () => {
        expect(resolveTranscriptRowViewportRelation({
            rowTopY: 900,
            rowHeightPx: 200,
            ...viewport,
        })).toBe('inside');
        expect(resolveTranscriptRowViewportRelation({
            rowTopY: 1700,
            rowHeightPx: 200,
            ...viewport,
        })).toBe('inside');
    });

    it('classifies a row spanning the whole viewport as inside', () => {
        expect(resolveTranscriptRowViewportRelation({
            rowTopY: 500,
            rowHeightPx: 2000,
            ...viewport,
        })).toBe('inside');
    });

    it('classifies a row starting at or past the viewport bottom edge as below', () => {
        expect(resolveTranscriptRowViewportRelation({
            rowTopY: 1800,
            rowHeightPx: 100,
            ...viewport,
        })).toBe('below');
        expect(resolveTranscriptRowViewportRelation({
            rowTopY: 2400,
            rowHeightPx: 50,
            ...viewport,
        })).toBe('below');
    });

    it('returns unknown when any geometry input is missing or invalid', () => {
        expect(resolveTranscriptRowViewportRelation({
            rowTopY: undefined,
            rowHeightPx: 100,
            ...viewport,
        })).toBe('unknown');
        expect(resolveTranscriptRowViewportRelation({
            rowTopY: 100,
            rowHeightPx: undefined,
            ...viewport,
        })).toBe('unknown');
        expect(resolveTranscriptRowViewportRelation({
            rowTopY: 100,
            rowHeightPx: 100,
            scrollOffsetY: undefined,
            viewportHeightPx: 800,
        })).toBe('unknown');
        expect(resolveTranscriptRowViewportRelation({
            rowTopY: 100,
            rowHeightPx: 100,
            scrollOffsetY: 1000,
            viewportHeightPx: 0,
        })).toBe('unknown');
        expect(resolveTranscriptRowViewportRelation({
            rowTopY: Number.NaN,
            rowHeightPx: 100,
            ...viewport,
        })).toBe('unknown');
    });
});

describe('resolveTranscriptRowContentCount (N1.3)', () => {
    it('counts tool-calls-group rows by tool message ids', () => {
        const item: TranscriptRowShellItem = {
            kind: 'tool-calls-group',
            id: 'group-1',
            toolMessageIds: ['t1', 't2', 't3'],
            createdAt: 0,
        };
        expect(resolveTranscriptRowContentCount(item)).toBe(3);
    });

    it('counts turn rows by user message plus content message ids', () => {
        const item: TranscriptRowShellItem = {
            kind: 'turn',
            id: 'turn-1',
            turn: {
                id: 'turn-1',
                userMessageId: 'u1',
                content: [
                    { kind: 'message', messageId: 'm1' },
                    { kind: 'tool_calls', id: 'tc-1', toolMessageIds: ['t1', 't2'] },
                ],
            },
        };
        expect(resolveTranscriptRowContentCount(item)).toBe(4);
    });

    it('counts a turn without a user message by content only', () => {
        const item: TranscriptRowShellItem = {
            kind: 'turn',
            id: 'turn-2',
            turn: {
                id: 'turn-2',
                userMessageId: null,
                content: [{ kind: 'tool_calls', id: 'tc-1', toolMessageIds: ['t1'] }],
            },
        };
        expect(resolveTranscriptRowContentCount(item)).toBe(1);
    });

    it('returns 1 for single-message rows', () => {
        const item: TranscriptRowShellItem = {
            kind: 'message',
            id: 'row-1',
            messageId: 'm1',
            createdAt: 0,
            seq: 1,
        };
        expect(resolveTranscriptRowContentCount(item)).toBe(1);
    });

    it('counts every tool-group unit row as exactly 1 (N2c stable virtualization units)', () => {
        const groupId = 'toolCalls:turn:x:t1';
        const toolMessageIds = ['t1', 't2', 't3'];
        const units: TranscriptRowShellItem[] = [
            {
                kind: 'tool-group-header',
                id: `${groupId}#header`,
                groupId,
                toolMessageIds,
                expanded: false,
                hiddenCount: 1,
                createdAt: 0,
            },
            {
                kind: 'tool-group-expand',
                id: `${groupId}#expand`,
                groupId,
                toolMessageIds,
                hiddenCount: 1,
                createdAt: 0,
            },
            {
                kind: 'tool-group-tool',
                id: `${groupId}#tool:t2`,
                groupId,
                toolMessageId: 't2',
                toolMessageIds,
                expanded: false,
                createdAt: 0,
                seq: null,
            },
            {
                kind: 'tool-group-footer',
                id: `${groupId}#footer`,
                groupId,
                toolMessageIds,
                expanded: false,
                createdAt: 0,
            },
        ];
        for (const unit of units) {
            expect(resolveTranscriptRowContentCount(unit)).toBe(1);
        }
    });

    it('returns undefined for rows without trackable content', () => {
        const item: TranscriptRowShellItem = {
            kind: 'fork-divider',
            id: 'fork-1',
            parentSessionId: 'p',
            childSessionId: 'c',
            parentCutoffSeqInclusive: 5,
        };
        expect(resolveTranscriptRowContentCount(item)).toBeUndefined();
    });
});
