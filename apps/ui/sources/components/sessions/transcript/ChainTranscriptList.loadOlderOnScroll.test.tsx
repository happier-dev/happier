import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        getSyncTuning: () => ({
            transcriptFlashListEstimatedItemSize: 120,
        }),
    },
}));

vi.mock('@/components/sessions/transcript/MessageView', () => ({
    MessageView: () => null,
}));

let scrollToEndSpy: ReturnType<typeof vi.fn> | null = null;
let scrollToIndexSpy: ReturnType<typeof vi.fn> | null = null;
let scrollToOffsetSpy: ReturnType<typeof vi.fn> | null = null;
let scrollToIndexShouldReject = false;

vi.mock('@shopify/flash-list', () => ({
    FlashList: React.forwardRef((props: any, ref: any) => {
        scrollToEndSpy = vi.fn();
        scrollToIndexSpy = vi.fn((params: any) => {
            if (scrollToIndexShouldReject) {
                return Promise.reject(new Error('missing layout'));
            }
            return Promise.resolve(params);
        });
        scrollToOffsetSpy = vi.fn();
        const instance = {
            scrollToEnd: scrollToEndSpy,
            scrollToIndex: scrollToIndexSpy,
            scrollToOffset: scrollToOffsetSpy,
        };
        if (typeof ref === 'function') ref(instance);
        else if (ref && typeof ref === 'object') ref.current = instance;
        return React.createElement('FlashList', props);
    }),
}));

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('ChainTranscriptList', () => {
    it('does not pass deprecated estimatedItemSize to FlashList v2', async () => {
        scrollToIndexShouldReject = false;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                }),
            );
            await Promise.resolve();
        });

        const list = tree.root.findByType('FlashList' as any);
        expect(list.props.estimatedItemSize).toBeUndefined();
        expect(list.props.overrideProps).toBeUndefined();
    });

    it('pins to the last transcript item instead of scrolling into the footer on first layout', async () => {
        scrollToIndexShouldReject = false;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                    footer: React.createElement('Footer'),
                }),
            );
            await Promise.resolve();
        });

        const list = tree.root.findByType('FlashList' as any);

        await act(async () => {
            list.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
            list.props.onContentSizeChange(0, 600);
            await Promise.resolve();
        });

        expect(scrollToIndexSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                index: 0,
                animated: false,
                viewPosition: 1,
            }),
        );
        expect(scrollToEndSpy).not.toHaveBeenCalled();
    });

    it('falls back to an estimated last-item offset when scrollToIndex cannot measure yet', async () => {
        scrollToIndexShouldReject = true;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [
                        { kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'first', isThinking: false },
                        { kind: 'agent-text', id: 'm2', localId: null, createdAt: 2, text: 'second', isThinking: false },
                    ],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                    footer: React.createElement('Footer'),
                }),
            );
            await Promise.resolve();
        });

        const list = tree.root.findByType('FlashList' as any);

        await act(async () => {
            list.props.onLayout({ nativeEvent: { layout: { height: 300 } } });
            list.props.onContentSizeChange(0, 600);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(scrollToIndexSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                index: 0,
                animated: false,
                viewPosition: 1,
            }),
        );
        expect(scrollToOffsetSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                offset: 0,
                animated: false,
            }),
        );
        expect(scrollToEndSpy).not.toHaveBeenCalled();
    });

    it('does not call loadOlder more than once while a load is in flight', async () => {
        scrollToIndexShouldReject = false;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const deferred = createDeferred<{ loaded: number; hasMore: boolean; status: 'loaded' }>();
        const loadOlder = vi.fn(async () => await deferred.promise);

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                    loadOlder,
                }),
            );
            await Promise.resolve();
        });

        const list = tree.root.findByType('FlashList' as any);
        expect(typeof list.props.onScroll).toBe('function');
        expect(typeof list.props.onLayout).toBe('function');
        expect(typeof list.props.onContentSizeChange).toBe('function');

        await act(async () => {
            list.props.onLayout({ nativeEvent: { layout: { height: 500 } } });
            list.props.onContentSizeChange(0, 1000);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 0 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 0 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            await Promise.resolve();
        });

        expect(loadOlder).toHaveBeenCalledTimes(1);

        deferred.resolve({ loaded: 1, hasMore: true, status: 'loaded' });
        act(() => {
            tree.unmount();
        });
    });

    it('loads older when scrolled near the top (even if onStartReached is not fired)', async () => {
        scrollToIndexShouldReject = false;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const deferred = createDeferred<{ loaded: number; hasMore: boolean; status: 'loaded' }>();
        const loadOlder = vi.fn(async () => await deferred.promise);

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                    loadOlder,
                }),
            );
            await Promise.resolve();
        });

        const list = tree.root.findByType('FlashList' as any);
        expect(typeof list.props.onScroll).toBe('function');
        expect(typeof list.props.onLayout).toBe('function');
        expect(typeof list.props.onContentSizeChange).toBe('function');

        await act(async () => {
            list.props.onLayout({ nativeEvent: { layout: { height: 500 } } });
            list.props.onContentSizeChange(0, 1000);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 0 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                },
            });
            await Promise.resolve();
            expect(loadOlder).toHaveBeenCalledTimes(1);
            const loadOlderPromise = loadOlder.mock.results[0]?.value as Promise<unknown> | undefined;
            expect(loadOlderPromise).toBeInstanceOf(Promise);
            deferred.resolve({ loaded: 1, hasMore: true, status: 'loaded' });
            if (loadOlderPromise) {
                await loadOlderPromise;
            }
            await Promise.resolve();
        });

        expect(loadOlder).toHaveBeenCalledTimes(1);
        act(() => {
            tree.unmount();
        });
    });

    it('loads older on web-like scroll events where layout/content sizes are not present', async () => {
        scrollToIndexShouldReject = false;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const deferred = createDeferred<{ loaded: number; hasMore: boolean; status: 'loaded' }>();
        const loadOlder = vi.fn(async () => await deferred.promise);

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                    loadOlder,
                }),
            );
            await Promise.resolve();
        });

        const list = tree.root.findByType('FlashList' as any);
        expect(typeof list.props.onScroll).toBe('function');
        expect(typeof list.props.onLayout).toBe('function');
        expect(typeof list.props.onContentSizeChange).toBe('function');

        await act(async () => {
            list.props.onLayout({ nativeEvent: { layout: { height: 500 } } });
            list.props.onContentSizeChange(0, 1000);
            list.props.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
            await Promise.resolve();
            expect(loadOlder).toHaveBeenCalledTimes(1);
            const loadOlderPromise = loadOlder.mock.results[0]?.value as Promise<unknown> | undefined;
            expect(loadOlderPromise).toBeInstanceOf(Promise);
            deferred.resolve({ loaded: 1, hasMore: true, status: 'loaded' });
            if (loadOlderPromise) {
                await loadOlderPromise;
            }
            await Promise.resolve();
        });

        expect(loadOlder).toHaveBeenCalledTimes(1);
        act(() => {
            tree.unmount();
        });
    });

    it('does not load older while pinned at the bottom of a short transcript', async () => {
        scrollToIndexShouldReject = false;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const loadOlder = vi.fn(async () => ({ loaded: 1, hasMore: true, status: 'loaded' as const }));

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                    loadOlder,
                }),
            );
            await Promise.resolve();
        });

        const list = tree.root.findByType('FlashList' as any);
        await act(async () => {
            list.props.onLayout({ nativeEvent: { layout: { height: 500 } } });
            list.props.onContentSizeChange(0, 600);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 100 },
                    contentSize: { height: 600 },
                    layoutMeasurement: { height: 500 },
                },
            });
            await Promise.resolve();
        });

        expect(loadOlder).not.toHaveBeenCalled();
        act(() => {
            tree.unmount();
        });
    });

    it('preserves the viewport when older messages prepend above the current position on web', async () => {
        scrollToIndexShouldReject = false;
        const { ChainTranscriptList } = await import('./ChainTranscriptList');
        const scrollEl: any = {
            scrollTop: 100,
            scrollHeight: 1000,
            clientHeight: 500,
        };
        const loadOlder = vi.fn(async () => {
            scrollEl.scrollHeight = 1300;
            return { loaded: 5, hasMore: true, status: 'loaded' as const };
        });

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                React.createElement(ChainTranscriptList, {
                    sessionId: 's1',
                    messages: [{ kind: 'agent-text', id: 'm1', localId: null, createdAt: 1, text: 'hi', isThinking: false }],
                    metadata: null,
                    interaction: { canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true },
                    loadOlder,
                }),
            );
            await Promise.resolve();
        });

        const list = tree.root.findByType('FlashList' as any);
        await act(async () => {
            list.props.onLayout({ nativeEvent: { layout: { height: 500 } } });
            list.props.onContentSizeChange(0, 1000);
            list.props.onScroll({
                nativeEvent: {
                    contentOffset: { y: 100 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 500 },
                    target: scrollEl,
                },
                target: scrollEl,
            });
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(loadOlder).toHaveBeenCalledTimes(1);
        expect(scrollEl.scrollTop).toBe(400);
        act(() => {
            tree.unmount();
        });
    });
});
