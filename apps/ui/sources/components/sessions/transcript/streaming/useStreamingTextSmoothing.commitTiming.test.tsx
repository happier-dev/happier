import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStreamingTextSmoothing } from './useStreamingTextSmoothing';

type SmoothingResult = ReturnType<typeof useStreamingTextSmoothing>;

const neverSettles = new Promise<never>(() => {});

function Harness(props: Readonly<{
    enabled: boolean;
    resultRef: { current: SmoothingResult | null };
    settleDelayMs: number;
    shouldSuspend?: boolean;
    targetText: string;
}>) {
    const result = useStreamingTextSmoothing({
        enabled: props.enabled,
        settleDelayMs: props.settleDelayMs,
        targetText: props.targetText,
    });
    React.useLayoutEffect(() => {
        props.resultRef.current = result;
    }, [props.resultRef, result]);
    if (props.shouldSuspend === true) throw neverSettles;
    return null;
}

function renderHarness(props: React.ComponentProps<typeof Harness>): React.ReactElement {
    return (
        <React.Suspense fallback={null}>
            <Harness {...props} />
        </React.Suspense>
    );
}

describe('useStreamingTextSmoothing commit timing', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps an already-armed A tick on A timing through an abandoned same-message B render', async () => {
        const resultRef = { current: null as SmoothingResult | null };
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(renderHarness({
                enabled: true,
                resultRef,
                settleDelayMs: 20,
                targetText: 'a',
            }), { unstable_isConcurrent: true } as unknown as renderer.TestRendererOptions);
        });
        await act(async () => {
            tree.update(renderHarness({
                enabled: true,
                resultRef,
                settleDelayMs: 20,
                targetText: 'ab',
            }));
        });
        expect(resultRef.current?.isStreaming).toBe(true);

        await act(async () => {
            React.startTransition(() => {
                tree.update(renderHarness({
                    enabled: true,
                    resultRef,
                    settleDelayMs: 10_000,
                    shouldSuspend: true,
                    targetText: 'ab',
                }));
            });
            await Promise.resolve();
        });

        await act(async () => {
            vi.advanceTimersByTime(2_000);
        });
        expect(resultRef.current).toEqual({
            displayText: 'ab',
            isStreaming: false,
        });

        await act(async () => {
            tree.update(renderHarness({
                enabled: true,
                resultRef,
                settleDelayMs: 10_000,
                targetText: 'abc',
            }));
        });
        expect(resultRef.current?.isStreaming).toBe(true);
        await act(async () => {
            vi.advanceTimersByTime(2_000);
        });
        expect(resultRef.current).toEqual({
            displayText: 'abc',
            isStreaming: true,
        });
        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });
        expect(resultRef.current).toEqual({
            displayText: 'abc',
            isStreaming: false,
        });

        await act(async () => {
            tree.unmount();
        });
    });

    it('does not report a committed A target as changed after an abandoned same-message B target render', async () => {
        const resultRef = { current: null as SmoothingResult | null };
        let tree!: renderer.ReactTestRenderer;

        await act(async () => {
            tree = renderer.create(renderHarness({
                enabled: true,
                resultRef,
                settleDelayMs: 20,
                targetText: 'committed-a',
            }), { unstable_isConcurrent: true } as unknown as renderer.TestRendererOptions);
        });
        expect(resultRef.current?.isStreaming).toBe(false);

        await act(async () => {
            React.startTransition(() => {
                tree.update(renderHarness({
                    enabled: true,
                    resultRef,
                    settleDelayMs: 20,
                    shouldSuspend: true,
                    targetText: 'abandoned-b',
                }));
            });
            await Promise.resolve();
        });

        await act(async () => {
            tree.update(renderHarness({
                enabled: true,
                resultRef,
                settleDelayMs: 20,
                targetText: 'committed-a',
            }));
        });
        expect(resultRef.current).toEqual({
            displayText: 'committed-a',
            isStreaming: false,
        });

        await act(async () => {
            tree.unmount();
        });
    });
});
