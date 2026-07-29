import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTranscriptFreshnessGate } from './transcriptFreshnessGate';
import { installTranscriptMotionCommonModuleMocks } from './transcriptMotionTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installTranscriptMotionCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Animated: {
                Value: function Value(this: any, initial: number) {
                    this.__value = initial;
                    this.setValue = (next: number) => {
                        this.__value = next;
                    };
                    motionState.animatedValues.push(this);
                },
                timing: () => ({ start: () => undefined }),
                parallel: () => ({ start: () => undefined }),
            },
            View: (props: any) => React.createElement('View', props, props.children),
        });
    },
});

const neverSettles = new Promise<never>(() => {});
const motionState = vi.hoisted(() => ({
    animatedValues: [] as Array<{ __value: number }>,
}));

function SuspendAfterRow(props: Readonly<{ shouldSuspend: boolean }>) {
    if (props.shouldSuspend) throw neverSettles;
    return null;
}

function createRuntime() {
    const gate = createTranscriptFreshnessGate({
        freshnessMs: 60_000,
        getNowMs: () => 1_000,
    });
    return {
        gate,
        runtime: {
            gate,
            config: {
                preset: 'full' as const,
                freshnessMs: 60_000,
                animateNewItemsEnabled: true,
                animateToolExpandCollapseEnabled: true,
                animateToolExpandCollapseFreshOnly: true,
                animateThinkingEnabled: true,
            },
        },
    };
}

describe('TranscriptEnterWrapper commit timing', () => {
    beforeEach(() => {
        motionState.animatedValues = [];
    });

    it('does not consume same-session freshness in an abandoned render', async () => {
        const { gate, runtime } = createRuntime();
        const { TranscriptMotionContext } = await import('./TranscriptMotionContext');
        const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');
        const renderHarness = (params: Readonly<{ showRow: boolean; shouldSuspend: boolean }>) => (
            <TranscriptMotionContext.Provider value={runtime}>
                <React.Suspense fallback={null}>
                    {params.showRow ? (
                        <>
                            <TranscriptEnterWrapper id="fresh-row" createdAt={900}>
                                <div />
                            </TranscriptEnterWrapper>
                            <SuspendAfterRow shouldSuspend={params.shouldSuspend} />
                        </>
                    ) : null}
                </React.Suspense>
            </TranscriptMotionContext.Provider>
        );
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(renderHarness({
                showRow: false,
                shouldSuspend: false,
            }), { unstable_isConcurrent: true } as unknown as renderer.TestRendererOptions);
        });

        await act(async () => {
            React.startTransition(() => {
                tree.update(renderHarness({
                    showRow: true,
                    shouldSuspend: true,
                }));
            });
            await Promise.resolve();
        });

        expect(gate.isSeen('fresh-row')).toBe(false);

        await act(async () => {
            tree.update(renderHarness({
                showRow: true,
                shouldSuspend: false,
            }));
        });

        expect(gate.isSeen('fresh-row')).toBe(true);
        expect(tree.root.findAllByType('Animated.View')).toHaveLength(1);

        await act(async () => {
            tree.unmount();
        });
    });

    it('reveals the row before paint when a child layout effect wins the freshness race', async () => {
        const { gate, runtime } = createRuntime();
        const { TranscriptMotionContext } = await import('./TranscriptMotionContext');
        const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');

        function ChildFreshnessConsumer() {
            React.useLayoutEffect(() => {
                gate.consumeFreshness({ id: 'shared-row', createdAt: 900 });
            }, []);
            return <div />;
        }

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <TranscriptMotionContext.Provider value={runtime}>
                    <TranscriptEnterWrapper id="shared-row" createdAt={900}>
                        <ChildFreshnessConsumer />
                    </TranscriptEnterWrapper>
                </TranscriptMotionContext.Provider>,
            );
        });

        expect(gate.isSeen('shared-row')).toBe(true);
        expect(motionState.animatedValues[0]?.__value).toBe(1);

        await act(async () => {
            tree.unmount();
        });
    });

    it('consumes freshness only once when strict effects replay', async () => {
        const { gate, runtime } = createRuntime();
        const consumeFreshness = vi.spyOn(gate, 'consumeFreshness');
        const { TranscriptMotionContext } = await import('./TranscriptMotionContext');
        const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(
                <React.StrictMode>
                    <TranscriptMotionContext.Provider value={runtime}>
                        <TranscriptEnterWrapper id="strict-row" createdAt={900}>
                            <div />
                        </TranscriptEnterWrapper>
                    </TranscriptMotionContext.Provider>
                </React.StrictMode>,
                { unstable_strictMode: true } as unknown as renderer.TestRendererOptions,
            );
        });

        expect(gate.isSeen('strict-row')).toBe(true);
        expect(consumeFreshness).toHaveBeenCalledTimes(1);

        await act(async () => {
            tree.unmount();
        });
    });

    it('keeps the committed enter wrapper mounted after freshness is consumed', async () => {
        const { gate, runtime } = createRuntime();
        const { TranscriptMotionContext } = await import('./TranscriptMotionContext');
        const { TranscriptEnterWrapper } = await import('./TranscriptEnterWrapper');
        const renderHarness = (childVersion: number) => (
            <TranscriptMotionContext.Provider value={runtime}>
                <TranscriptEnterWrapper id="stable-row" createdAt={900}>
                    <div data-version={childVersion} />
                </TranscriptEnterWrapper>
            </TranscriptMotionContext.Provider>
        );
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(renderHarness(1));
        });
        expect(gate.isSeen('stable-row')).toBe(true);
        expect(tree.root.findAllByType('Animated.View')).toHaveLength(1);

        await act(async () => {
            tree.update(renderHarness(2));
        });
        expect(tree.root.findAllByType('Animated.View')).toHaveLength(1);

        await act(async () => {
            tree.unmount();
        });
    });
});
