import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { createTranscriptFreshnessGate, resolveTranscriptUtteranceIdentity } from './transcriptFreshnessGate';
import { installTranscriptMotionCommonModuleMocks } from './transcriptMotionTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const motionState = vi.hoisted(() => ({
    startedTimings: [] as any[],
    animatedValues: [] as Array<{ __value: number }>,
}));

installTranscriptMotionCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
            Animated: {
                Value: function Value(this: any, initial: number) {
                    this.__value = initial;
                    this.setValue = (next: number) => { this.__value = next; };
                    motionState.animatedValues.push(this);
                },
                timing: (_value: any, config: any) => ({
                    start: () => { motionState.startedTimings.push(config); },
                }),
                parallel: () => ({ start: () => undefined }),
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

function createRuntime(gate: ReturnType<typeof createTranscriptFreshnessGate>) {
    return {
        gate,
        config: {
            preset: 'full' as const,
            freshnessMs: 60_000,
            animateNewItemsEnabled: true,
            animateToolExpandCollapseEnabled: true,
            animateToolExpandCollapseFreshOnly: true,
            animateThinkingEnabled: true,
        },
    };
}

function utteranceId(localId: string): string {
    const identity = resolveTranscriptUtteranceIdentity(localId);
    if (identity == null) throw new Error(`expected utterance identity for ${localId}`);
    return identity;
}

describe('TranscriptEnterWrapper send crossover', () => {
    beforeEach(() => {
        motionState.startedTimings = [];
        motionState.animatedValues = [];
    });

    it('starts without waiting for a layout event or animation frame', async () => {
        const originalRaf = globalThis.requestAnimationFrame;
        (globalThis as any).requestAnimationFrame = () => 1;
        try {
            const { TranscriptMotionContext } = await import('./TranscriptMotionContext');
            const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');
            const gate = createTranscriptFreshnessGate({ freshnessMs: 60_000, getNowMs: () => 1_000 });
            await act(async () => {
                renderer.create(
                    <TranscriptMotionContext.Provider value={createRuntime(gate) as any}>
                        <TranscriptEnterWrapper id="msg:server-1" createdAt={990}><div /></TranscriptEnterWrapper>
                    </TranscriptMotionContext.Provider>,
                );
            });
            expect(motionState.startedTimings.length).toBeGreaterThan(0);
        } finally {
            (globalThis as any).requestAnimationFrame = originalRaf;
        }
    });

    it('does not animate the committed twin of an already-painted pending utterance', async () => {
        const { TranscriptMotionContext } = await import('./TranscriptMotionContext');
        const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');
        const gate = createTranscriptFreshnessGate({ freshnessMs: 60_000, getNowMs: () => 1_000 });
        const utterance = utteranceId('local-1');
        let tree: renderer.ReactTestRenderer | null = null;

        await act(async () => {
            tree = renderer.create(
                <TranscriptMotionContext.Provider value={createRuntime(gate) as any}>
                    <TranscriptEnterWrapper id="pending-queue" createdAt={990} paintedIds={[utterance]}>
                        <div />
                    </TranscriptEnterWrapper>
                </TranscriptMotionContext.Provider>,
            );
        });
        const pendingTimingCount = motionState.startedTimings.length;
        const pendingValueCount = motionState.animatedValues.length;
        expect(pendingTimingCount).toBeGreaterThan(0);

        await act(async () => { tree!.unmount(); });
        await act(async () => {
            renderer.create(
                <TranscriptMotionContext.Provider value={createRuntime(gate) as any}>
                    <TranscriptEnterWrapper id="msg:server-1" createdAt={990} paintedIds={[utterance]}>
                        <div />
                    </TranscriptEnterWrapper>
                </TranscriptMotionContext.Provider>,
            );
        });

        expect(motionState.startedTimings).toHaveLength(pendingTimingCount);
        expect(motionState.animatedValues).toHaveLength(pendingValueCount);
    });
});
