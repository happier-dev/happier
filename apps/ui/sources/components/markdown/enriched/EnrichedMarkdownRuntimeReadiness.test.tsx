import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntryRestoreOwner } from '@/components/sessions/transcript/viewport/entryRestore/entryRestoreOwner';
import type { SessionOpenLatch } from '@/components/sessions/transcript/viewport/sessionOpen/sessionOpenLatch';
import type { TranscriptFirstPaintStateDeps } from '@/components/sessions/transcript/items/useTranscriptItemsPipeline';

const runtimeBoundary = vi.hoisted(() => ({
    astReady: false,
    lastRenderedAstReady: false,
    preload: vi.fn<() => Promise<void>>(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

vi.mock('react-native-enriched-markdown', () => ({
    preloadMarkdownRuntime: runtimeBoundary.preload,
    EnrichedMarkdownText: (props: Readonly<{ markdown: string }>) => {
        // The installed package memoizes its synchronous parse by Markdown and
        // parser flags. A readiness-only parent render therefore retains the
        // cold null result unless the package instance is replaced.
        const parsedSynchronously = React.useMemo(
            () => runtimeBoundary.astReady,
            [props.markdown],
        );
        runtimeBoundary.lastRenderedAstReady = parsedSynchronously;
        return React.createElement('EnrichedMarkdownText', {
            ...props,
            'data-ast-ready': parsedSynchronously,
        });
    },
}));

function createWebLegendFirstPaintDeps(
    overrides: Partial<TranscriptFirstPaintStateDeps> = {},
): TranscriptFirstPaintStateDeps {
    return {
        applySessionOpenLatchEffectsRef: { current: vi.fn() },
        currentSessionIdRef: { current: 'session-a' },
        entryAnchorForRender: null,
        entryRestoreOwner: {
            hasOpenTransaction: () => false,
        } as unknown as EntryRestoreOwner,
        firstListPaintObserved: true,
        isLoaded: true,
        isWarmKeepAliveInstance: false,
        itemCount: 1,
        jumpToSeqActive: false,
        lastPinOffsetForIntentRef: { current: null },
        nativeEntryRestorePaintReleased: false,
        nativeFirstPaintFallbackReleaseTimeoutRef: { current: null },
        nativeInitialViewportPendingObservation: false,
        nativeMountSettleDeadlineReached: false,
        nativeMountSettleStable: false,
        nativeViewportPaintObserved: false,
        nativeViewportPaintObservedRef: { current: false },
        pinThresholdPx: 72,
        platformOS: 'web',
        routeHydrationPending: false,
        sessionId: 'session-a',
        sessionOpenLatch: {
            onNativeFirstPaintFallbackDeadline: () => ({ effects: [] }),
            shouldShowNativeFirstPaintPlaceholder: () => false,
        } as unknown as SessionOpenLatch,
        transcriptInitialFillBudgetMs: 2_000,
        transcriptMountSettleQuiescentWindowMs: 120,
        ...overrides,
    };
}

describe('enriched Markdown runtime readiness join', () => {
    beforeEach(() => {
        vi.resetModules();
        runtimeBoundary.astReady = false;
        runtimeBoundary.lastRenderedAstReady = false;
        runtimeBoundary.preload.mockReset();
        runtimeBoundary.preload.mockImplementation(() => {
            runtimeBoundary.astReady = true;
            return Promise.resolve();
        });
    });

    it('keeps a loaded transcript covered after Legend first paint until the runtime becomes ready', async () => {
        let resolvePreload: (() => void) | null = null;
        runtimeBoundary.preload.mockImplementation(() => new Promise<void>((resolve) => {
            resolvePreload = resolve;
        }));
        const { useTranscriptFirstPaintState } = await import(
            '@/components/sessions/transcript/items/useTranscriptItemsPipeline'
        );
        const firstPaintDeps = createWebLegendFirstPaintDeps();
        const coverStates: boolean[] = [];

        function FirstPaintHarness() {
            const firstPaint = useTranscriptFirstPaintState(firstPaintDeps);
            React.useLayoutEffect(() => {
                coverStates.push(firstPaint.showFirstPaintPlaceholder);
            }, [firstPaint.showFirstPaintPlaceholder]);
            return null;
        }

        let tree!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            tree = TestRenderer.create(<FirstPaintHarness />);
            await Promise.resolve();
        });

        expect(resolvePreload).not.toBeNull();
        expect(coverStates.at(-1)).toBe(true);

        await act(async () => {
            resolvePreload?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(coverStates.at(-1)).toBe(false);

        act(() => {
            tree.unmount();
        });
    });

    it('does not cover empty or loading transcripts while the Markdown runtime is pending', async () => {
        runtimeBoundary.preload.mockImplementation(() => new Promise<void>(() => {}));
        const { useTranscriptFirstPaintState } = await import(
            '@/components/sessions/transcript/items/useTranscriptItemsPipeline'
        );

        function FirstPaintHarness(props: Readonly<{
            isLoaded: boolean;
            itemCount: number;
        }>) {
            const firstPaint = useTranscriptFirstPaintState(createWebLegendFirstPaintDeps(props));
            return React.createElement('FirstPaintState', {
                covered: firstPaint.showFirstPaintPlaceholder,
            });
        }

        let tree!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            tree = TestRenderer.create(<FirstPaintHarness isLoaded itemCount={0} />);
            await Promise.resolve();
        });

        expect(tree.root.findByType('FirstPaintState').props.covered).toBe(false);
        await act(async () => {
            tree.update(<FirstPaintHarness isLoaded={false} itemCount={1} />);
        });
        expect(tree.root.findByType('FirstPaintState').props.covered).toBe(false);

        act(() => {
            tree.unmount();
        });
    });

    it('commits a cold mounted adapter as AST-ready when the shared cover consumer releases', async () => {
        const runtimeOwner = await import('./preloadEnrichedMarkdownRuntime');
        const useRuntimeStatus = (
            runtimeOwner as typeof runtimeOwner & {
                useEnrichedMarkdownRuntimeStatus?: () => 'pending' | 'ready' | 'failed';
            }
        ).useEnrichedMarkdownRuntimeStatus;
        if (!useRuntimeStatus) {
            throw new Error('Expected the preload owner to expose a React runtime-status subscription');
        }
        const { EnrichedMarkdownTextAdapter } = await import('./EnrichedMarkdownTextAdapter');
        const commits: Array<Readonly<{
            coverVisible: boolean;
            markdownAstReady: boolean;
        }>> = [];

        function ReadinessJoinHarness() {
            const runtimeStatus = useRuntimeStatus();
            React.useLayoutEffect(() => {
                commits.push({
                    coverVisible: runtimeStatus === 'pending',
                    markdownAstReady: runtimeBoundary.lastRenderedAstReady,
                });
            });

            return (
                <EnrichedMarkdownTextAdapter
                    agentTexMath={false}
                    markdown={'## Cold heading\n\nCold body'}
                    profile="transcript"
                    selectable
                    streamingAnimated={false}
                />
            );
        }

        let tree!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            tree = TestRenderer.create(<ReadinessJoinHarness />);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(commits).not.toContainEqual({
            coverVisible: false,
            markdownAstReady: false,
        });
        expect(commits.at(-1)).toEqual({
            coverVisible: false,
            markdownAstReady: true,
        });

        act(() => {
            tree.unmount();
        });
    });

    it('settles as failed so a parser error cannot leave the shared cover permanent', async () => {
        runtimeBoundary.preload.mockRejectedValue(new Error('runtime unavailable'));
        const runtimeOwner = await import('./preloadEnrichedMarkdownRuntime');
        const { useTranscriptFirstPaintState } = await import(
            '@/components/sessions/transcript/items/useTranscriptItemsPipeline'
        );
        const firstPaintDeps = createWebLegendFirstPaintDeps();
        const statuses: string[] = [];
        const coverStates: boolean[] = [];

        function FailureHarness() {
            const status = runtimeOwner.useEnrichedMarkdownRuntimeStatus();
            const firstPaint = useTranscriptFirstPaintState(firstPaintDeps);
            React.useLayoutEffect(() => {
                statuses.push(status);
                coverStates.push(firstPaint.showFirstPaintPlaceholder);
            }, [firstPaint.showFirstPaintPlaceholder, status]);
            return null;
        }

        let tree!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            tree = TestRenderer.create(<FailureHarness />);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(statuses.at(-1)).toBe('failed');
        expect(coverStates.at(-1)).toBe(false);

        act(() => {
            tree.unmount();
        });
    });
});
