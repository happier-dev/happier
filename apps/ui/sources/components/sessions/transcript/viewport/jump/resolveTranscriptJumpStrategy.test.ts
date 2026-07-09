import { describe, expect, it } from 'vitest';

import { resolveTranscriptJumpTargetIndex } from './resolveTranscriptJumpTargetIndex';
import { resolveTranscriptJumpStrategy } from './resolveTranscriptJumpStrategy';
import type { TranscriptJumpTargetIndexResult } from './transcriptJumpTargetTypes';

const mainScope = { kind: 'main', sessionId: 'session-1' } as const;

const foundIndex: TranscriptJumpTargetIndexResult = {
    status: 'found',
    index: 2,
    seq: 2400,
    routeMessageId: 'server:msg-2400',
};

describe('resolveTranscriptJumpStrategy', () => {
    it('scrolls directly when the target is mounted in the main transcript', () => {
        const strategy = resolveTranscriptJumpStrategy({
            target: { kind: 'seq', seq: 2400 },
            scope: mainScope,
            targetIndex: foundIndex,
            mode: 'mounted-list',
            nearbySeqThreshold: 80,
            canRenderTargetWindow: true,
        });

        expect(strategy).toMatchObject({
            status: 'scroll-mounted',
            index: 2,
            seq: 2400,
            routeMessageId: 'server:msg-2400',
        });
    });

    it('pages toward a near older target instead of rendering a replacement window', () => {
        const targetIndex: TranscriptJumpTargetIndexResult = {
            status: 'unresolved',
            direction: 'older',
            targetSeq: 2350,
            nearestIndex: 0,
            nearestSeq: 2400,
        };

        const strategy = resolveTranscriptJumpStrategy({
            target: { kind: 'seq', seq: 2350 },
            scope: mainScope,
            targetIndex,
            mode: 'mounted-list',
            nearbySeqThreshold: 80,
            canRenderTargetWindow: true,
        });

        expect(strategy).toMatchObject({
            status: 'page-nearby',
            direction: 'older',
            targetSeq: 2350,
            nearestSeq: 2400,
        });
    });

    it('pages toward a near newer target when newer pages may contain it', () => {
        const targetIndex: TranscriptJumpTargetIndexResult = {
            status: 'unresolved',
            direction: 'newer',
            targetSeq: 2460,
            nearestIndex: 2,
            nearestSeq: 2400,
        };

        const strategy = resolveTranscriptJumpStrategy({
            target: { kind: 'seq', seq: 2460 },
            scope: mainScope,
            targetIndex,
            mode: 'mounted-list',
            nearbySeqThreshold: 80,
            canRenderTargetWindow: true,
        });

        expect(strategy).toMatchObject({
            status: 'page-nearby',
            direction: 'newer',
            targetSeq: 2460,
            nearestSeq: 2400,
        });
    });

    it('renders a replacement target window for a far target', () => {
        const targetIndex: TranscriptJumpTargetIndexResult = {
            status: 'unresolved',
            direction: 'older',
            targetSeq: 1200,
            nearestIndex: 0,
            nearestSeq: 2400,
        };

        const strategy = resolveTranscriptJumpStrategy({
            target: { kind: 'seq', seq: 1200 },
            scope: mainScope,
            targetIndex,
            mode: 'mounted-list',
            nearbySeqThreshold: 80,
            canRenderTargetWindow: true,
        });

        expect(strategy).toMatchObject({
            status: 'render-target-window',
            targetSeq: 1200,
            direction: 'older',
        });
    });

    it('renders a replacement target window for a far nearest-loaded gap', () => {
        const strategy = resolveTranscriptJumpStrategy({
            target: { kind: 'seq', seq: 331 },
            scope: mainScope,
            targetIndex: {
                status: 'nearest',
                index: 10,
                seq: 437,
                targetSeq: 331,
            },
            mode: 'mounted-list',
            nearbySeqThreshold: 80,
            canRenderTargetWindow: true,
        });

        expect(strategy).toEqual({
            status: 'render-target-window',
            target: { kind: 'seq', seq: 331 },
            direction: null,
            targetSeq: 331,
        });
    });

    it('defers sidechain execution when no sidechain jump executor is available', () => {
        const strategy = resolveTranscriptJumpStrategy({
            target: { kind: 'seq', seq: 2400 },
            scope: { kind: 'sidechain', sessionId: 'session-1', sidechainId: 'chain-a' },
            targetIndex: foundIndex,
            mode: 'mounted-list',
            nearbySeqThreshold: 80,
            canRenderTargetWindow: true,
            sidechainExecution: 'defer',
        });

        expect(strategy).toEqual({
            status: 'deferred',
            reason: 'sidechain-executor-unavailable',
            target: { kind: 'seq', seq: 2400 },
        });
    });

    it('resolves route targets without executing when requested by a deep-link route', () => {
        const strategy = resolveTranscriptJumpStrategy({
            target: { kind: 'route-message-id', routeMessageId: 'server:msg-2400', seqHint: 2400 },
            scope: mainScope,
            targetIndex: { status: 'not-found', reason: 'unavailable' },
            mode: 'resolve-only',
            nearbySeqThreshold: 80,
            canRenderTargetWindow: true,
        });

        expect(strategy).toEqual({
            status: 'resolved-only',
            target: { kind: 'route-message-id', routeMessageId: 'server:msg-2400', seqHint: 2400 },
            routeMessageId: 'server:msg-2400',
            seq: 2400,
        });
    });

    it('does not scroll a route target to a mounted co-seq row with a different route id', () => {
        const target = { kind: 'route-message-id', routeMessageId: 'server:assistant-10', seqHint: 10 } as const;
        const targetIndex = resolveTranscriptJumpTargetIndex({
            target,
            items: [
                {
                    id: 'msg:user-10',
                    kind: 'message',
                    messageId: 'user-10',
                    seq: 10,
                    routeMessageId: 'server:user-10',
                },
            ],
            resolveSeqForMessageId: () => null,
            resolveRouteMessageIdForMessageId: () => null,
            hasMoreOlder: true,
            hasMoreNewer: true,
        });

        const strategy = resolveTranscriptJumpStrategy({
            target,
            scope: mainScope,
            targetIndex,
            mode: 'mounted-list',
            nearbySeqThreshold: 80,
            canRenderTargetWindow: true,
        });

        expect(strategy).toEqual({
            status: 'render-target-window',
            target,
            direction: null,
            targetSeq: 10,
        });
    });

    it('returns invalid-target in resolve-only mode for invalid route targets', () => {
        const target = { kind: 'route-message-id', routeMessageId: '', seqHint: 2400 } as const;

        const strategy = resolveTranscriptJumpStrategy({
            target,
            scope: mainScope,
            targetIndex: { status: 'not-found', reason: 'unavailable' },
            mode: 'resolve-only',
            nearbySeqThreshold: 80,
            canRenderTargetWindow: true,
        });

        expect(strategy).toEqual({
            status: 'not-found',
            target,
            reason: 'invalid-target',
        });
    });

    it('returns not-found when the target cannot be resolved or fetched', () => {
        const strategy = resolveTranscriptJumpStrategy({
            target: { kind: 'route-message-id', routeMessageId: 'server:missing' },
            scope: mainScope,
            targetIndex: { status: 'not-found', reason: 'unavailable' },
            mode: 'mounted-list',
            nearbySeqThreshold: 80,
            canRenderTargetWindow: false,
        });

        expect(strategy).toEqual({
            status: 'not-found',
            target: { kind: 'route-message-id', routeMessageId: 'server:missing' },
            reason: 'unavailable',
        });
    });

    it('aborts without classifying or executing a target', () => {
        const strategy = resolveTranscriptJumpStrategy({
            target: { kind: 'seq', seq: 2400 },
            scope: mainScope,
            targetIndex: foundIndex,
            mode: 'mounted-list',
            nearbySeqThreshold: 80,
            canRenderTargetWindow: true,
            aborted: true,
        });

        expect(strategy).toEqual({
            status: 'aborted',
            target: { kind: 'seq', seq: 2400 },
        });
    });
});
