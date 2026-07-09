import { describe, expect, it } from 'vitest';

import { resolveTranscriptJumpTargetIndex } from './resolveTranscriptJumpTargetIndex';

const seqByMessageId: Record<string, number> = {
    'msg-2200': 2200,
    'msg-2300': 2300,
    'msg-2400': 2400,
    'msg-2500': 2500,
};

const routeIdByMessageId: Record<string, string> = {
    'msg-2200': 'server:msg-2200',
    'msg-2300': 'server:msg-2300',
    'msg-2400': 'server:msg-2400',
    'msg-2500': 'server:msg-2500',
    'msg-block-1': 'server:shared-assistant',
    'msg-block-2': 'server:shared-assistant',
};

const transcriptBlockIndexByMessageId: Record<string, number> = {
    'msg-block-1': 1,
    'msg-block-2': 2,
};

const loadedWindowItems = [
    {
        id: 'turn:a',
        kind: 'turn',
        turn: {
            userMessageId: 'msg-2200',
            content: [{ kind: 'message', messageId: 'msg-2300' }],
        },
    },
    {
        id: 'turn:b',
        kind: 'turn',
        turn: {
            userMessageId: 'msg-2400',
            content: [],
        },
    },
    {
        id: 'msg:msg-2500',
        kind: 'message',
        messageId: 'msg-2500',
        seq: 2500,
    },
] as const;

function resolveSeqForMessageId(messageId: string): number | null {
    return seqByMessageId[messageId] ?? null;
}

function resolveRouteMessageIdForMessageId(messageId: string): string | null {
    return routeIdByMessageId[messageId] ?? null;
}

function resolveTranscriptBlockIndexForMessageId(messageId: string): number | null {
    return transcriptBlockIndexByMessageId[messageId] ?? null;
}

describe('resolveTranscriptJumpTargetIndex', () => {
    it('resolves a seq target to the mounted transcript item', () => {
        const result = resolveTranscriptJumpTargetIndex({
            target: { kind: 'seq', seq: 2400 },
            items: loadedWindowItems,
            resolveSeqForMessageId,
            resolveRouteMessageIdForMessageId,
            hasMoreOlder: true,
            hasMoreNewer: false,
        });

        expect(result).toMatchObject({
            status: 'found',
            index: 1,
            seq: 2400,
            routeMessageId: 'server:msg-2400',
        });
    });

    it('resolves a route-message-id target to the mounted transcript item', () => {
        const result = resolveTranscriptJumpTargetIndex({
            target: { kind: 'route-message-id', routeMessageId: 'server:msg-2300' },
            items: loadedWindowItems,
            resolveSeqForMessageId,
            resolveRouteMessageIdForMessageId,
            hasMoreOlder: true,
            hasMoreNewer: false,
        });

        expect(result).toMatchObject({
            status: 'found',
            index: 0,
            seq: 2300,
            routeMessageId: 'server:msg-2300',
        });
    });

    it('uses block and role identity when route and seq are shared by multiple mounted rows', () => {
        const result = resolveTranscriptJumpTargetIndex({
            target: {
                kind: 'route-message-id',
                routeMessageId: 'server:shared-assistant',
                seqHint: 2300,
                transcriptBlockIndex: 2,
                role: 'assistant',
            },
            items: [
                {
                    id: 'msg:block-1',
                    kind: 'message',
                    messageId: 'msg-block-1',
                    seq: 2300,
                },
                {
                    id: 'msg:block-2',
                    kind: 'message',
                    messageId: 'msg-block-2',
                    seq: 2300,
                },
            ],
            resolveSeqForMessageId: () => 2300,
            resolveRouteMessageIdForMessageId,
            resolveTranscriptBlockIndexForMessageId,
            resolveRoleForMessageId: () => 'assistant',
            hasMoreOlder: false,
            hasMoreNewer: false,
        });

        expect(result).toMatchObject({
            status: 'found',
            index: 1,
            seq: 2300,
            routeMessageId: 'server:shared-assistant',
        });
    });

    it('defers an older seq target while older pages may contain it', () => {
        const result = resolveTranscriptJumpTargetIndex({
            target: { kind: 'seq', seq: 2100 },
            items: loadedWindowItems,
            resolveSeqForMessageId,
            resolveRouteMessageIdForMessageId,
            hasMoreOlder: true,
            hasMoreNewer: false,
        });

        expect(result).toMatchObject({
            status: 'unresolved',
            direction: 'older',
            targetSeq: 2100,
            nearestIndex: 0,
            nearestSeq: 2200,
        });
    });

    it('defers a newer seq target while newer pages may contain it', () => {
        const result = resolveTranscriptJumpTargetIndex({
            target: { kind: 'seq', seq: 2600 },
            items: loadedWindowItems,
            resolveSeqForMessageId,
            resolveRouteMessageIdForMessageId,
            hasMoreOlder: true,
            hasMoreNewer: true,
        });

        expect(result).toMatchObject({
            status: 'unresolved',
            direction: 'newer',
            targetSeq: 2600,
            nearestIndex: 2,
            nearestSeq: 2500,
        });
    });

    it('falls back to the nearest loaded item for a newer target after the newer side is exhausted', () => {
        const result = resolveTranscriptJumpTargetIndex({
            target: { kind: 'seq', seq: 2600 },
            items: loadedWindowItems,
            resolveSeqForMessageId,
            resolveRouteMessageIdForMessageId,
            hasMoreOlder: true,
            hasMoreNewer: false,
        });

        expect(result).toMatchObject({
            status: 'nearest',
            index: 2,
            seq: 2500,
            targetSeq: 2600,
        });
    });

    it('returns not-found for an invalid target', () => {
        const result = resolveTranscriptJumpTargetIndex({
            target: { kind: 'seq', seq: -1 },
            items: loadedWindowItems,
            resolveSeqForMessageId,
            resolveRouteMessageIdForMessageId,
            hasMoreOlder: true,
            hasMoreNewer: true,
        });

        expect(result).toEqual({ status: 'not-found', reason: 'invalid-target' });
    });

    it('returns not-found when a route target has no loaded route and no seq hint', () => {
        const result = resolveTranscriptJumpTargetIndex({
            target: { kind: 'route-message-id', routeMessageId: 'server:missing' },
            items: loadedWindowItems,
            resolveSeqForMessageId,
            resolveRouteMessageIdForMessageId,
            hasMoreOlder: true,
            hasMoreNewer: true,
        });

        expect(result).toEqual({ status: 'not-found', reason: 'unavailable' });
    });
});
