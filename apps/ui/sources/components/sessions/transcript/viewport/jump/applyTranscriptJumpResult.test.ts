import { describe, expect, it, vi } from 'vitest';

import { applyTranscriptJumpResult } from './applyTranscriptJumpResult';

describe('applyTranscriptJumpResult', () => {
    it('executes mounted scrolls through the supplied adapter', async () => {
        const scrollToIndex = vi.fn();

        const result = await applyTranscriptJumpResult({
            strategy: {
                status: 'scroll-mounted',
                target: { kind: 'seq', seq: 2400 },
                index: 2,
                seq: 2400,
                routeMessageId: 'server:msg-2400',
            },
            adapters: { scrollToIndex },
        });

        expect(scrollToIndex).toHaveBeenCalledWith({
            index: 2,
            target: { kind: 'seq', seq: 2400 },
            seq: 2400,
            routeMessageId: 'server:msg-2400',
        });
        expect(result).toEqual({ status: 'scrolled', target: { kind: 'seq', seq: 2400 } });
    });

    it('does not report scrolled when the mounted-scroll adapter reports no applied command', async () => {
        const scrollToIndex = vi.fn(() => false);

        const result = await applyTranscriptJumpResult({
            strategy: {
                status: 'scroll-mounted',
                target: { kind: 'seq', seq: 2400 },
                index: 2,
                seq: 2400,
                routeMessageId: 'server:msg-2400',
            },
            adapters: { scrollToIndex },
        });

        expect(scrollToIndex).toHaveBeenCalledWith({
            index: 2,
            target: { kind: 'seq', seq: 2400 },
            seq: 2400,
            routeMessageId: 'server:msg-2400',
        });
        expect(result).toEqual({ status: 'not-found', reason: 'unavailable' });
    });

    it('executes far jumps through the target-window adapter', async () => {
        const renderTargetWindow = vi.fn(async () => ({ windowId: 'window-2' }));

        const result = await applyTranscriptJumpResult({
            strategy: {
                status: 'render-target-window',
                target: { kind: 'seq', seq: 1200 },
                targetSeq: 1200,
                direction: 'older',
            },
            adapters: { renderTargetWindow },
        });

        expect(renderTargetWindow).toHaveBeenCalledWith({
            target: { kind: 'seq', seq: 1200 },
            targetSeq: 1200,
            direction: 'older',
        });
        expect(result).toEqual({
            status: 'window-rendered',
            target: { kind: 'seq', seq: 1200 },
            windowId: 'window-2',
        });
    });

    it('does not report a rendered window when the target-window adapter cannot materialize the target', async () => {
        const renderTargetWindow = vi.fn(async () => null);

        const result = await applyTranscriptJumpResult({
            strategy: {
                status: 'render-target-window',
                target: { kind: 'seq', seq: 1200 },
                targetSeq: 1200,
                direction: 'older',
            },
            adapters: { renderTargetWindow },
        });

        expect(renderTargetWindow).toHaveBeenCalledWith({
            target: { kind: 'seq', seq: 1200 },
            targetSeq: 1200,
            direction: 'older',
        });
        expect(result).toEqual({ status: 'not-found', reason: 'unavailable' });
    });

    it('returns resolved-only results without calling execution adapters', async () => {
        const scrollToIndex = vi.fn();

        const result = await applyTranscriptJumpResult({
            strategy: {
                status: 'resolved-only',
                target: { kind: 'route-message-id', routeMessageId: 'server:msg-2400', seqHint: 2400 },
                routeMessageId: 'server:msg-2400',
                seq: 2400,
            },
            adapters: { scrollToIndex },
        });

        expect(scrollToIndex).not.toHaveBeenCalled();
        expect(result).toEqual({
            status: 'resolved-only',
            target: { kind: 'route-message-id', routeMessageId: 'server:msg-2400', seqHint: 2400 },
            routeMessageId: 'server:msg-2400',
            seq: 2400,
        });
    });

    it('maps unsupported deferred strategies to a not-found result', async () => {
        const result = await applyTranscriptJumpResult({
            strategy: {
                status: 'deferred',
                target: { kind: 'seq', seq: 2400 },
                reason: 'sidechain-executor-unavailable',
            },
            adapters: {},
        });

        expect(result).toEqual({
            status: 'not-found',
            reason: 'unsupported',
        });
    });

    it('returns aborted without invoking adapters', async () => {
        const scrollToIndex = vi.fn();
        const renderTargetWindow = vi.fn();

        const result = await applyTranscriptJumpResult({
            strategy: {
                status: 'aborted',
                target: { kind: 'seq', seq: 2400 },
            },
            adapters: { scrollToIndex, renderTargetWindow },
        });

        expect(scrollToIndex).not.toHaveBeenCalled();
        expect(renderTargetWindow).not.toHaveBeenCalled();
        expect(result).toEqual({ status: 'aborted' });
    });
});
