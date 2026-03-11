import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sessionExecutionRunListSpy = vi.fn();

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunList: (...args: unknown[]) => sessionExecutionRunListSpy(...args),
}));

import { resolveRunningExecutionRunsFromListResult, useSessionRunningExecutionRuns } from './useSessionRunningExecutionRuns';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushAsync(): Promise<void> {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
}

async function renderHarness(params: Readonly<{ sessionId: string; enabled: boolean }>): Promise<{
    getRuns: () => readonly any[];
    rerender: (next: Readonly<{ sessionId: string; enabled: boolean }>) => Promise<void>;
    unmount: () => void;
}> {
    let currentRuns: readonly any[] = [];

    function Harness(props: Readonly<{ sessionId: string; enabled: boolean }>) {
        currentRuns = useSessionRunningExecutionRuns({ sessionId: props.sessionId, enabled: props.enabled });
        return null;
    }

    let root: renderer.ReactTestRenderer | null = null;
    await act(async () => {
        root = renderer.create(React.createElement(Harness, params));
        await flushAsync();
    });

    return {
        getRuns: () => currentRuns,
        rerender: async (next) => {
            await act(async () => {
                root!.update(React.createElement(Harness, next));
                await flushAsync();
            });
        },
        unmount: () => {
            if (!root) return;
            act(() => root!.unmount());
        },
    };
}

describe('resolveRunningExecutionRunsFromListResult', () => {
    it('returns only execution runs with status=running', () => {
        const out = resolveRunningExecutionRunsFromListResult({
            runs: [
                { runId: 'run_1', status: 'running' } as any,
                { runId: 'run_2', status: 'failed' } as any,
                { runId: 'run_3', status: 'completed' } as any,
            ],
        } as any);

        expect(out.map((run) => run.runId)).toEqual(['run_1']);
    });

    it('returns empty array for ok:false responses', () => {
        const out = resolveRunningExecutionRunsFromListResult({
            ok: false,
            error: 'RPC failed',
        } as any);
        expect(out).toEqual([]);
    });
});

describe('useSessionRunningExecutionRuns', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        sessionExecutionRunListSpy.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('polls while a run is running and stops after it is confirmed finished', async () => {
        sessionExecutionRunListSpy
            .mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running' }] })
            .mockResolvedValueOnce({ runs: [] })
            .mockResolvedValueOnce({ runs: [] });

        const harness = await renderHarness({ sessionId: 's1', enabled: true });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
        expect(harness.getRuns().map((r: any) => r.runId)).toEqual(['run_1']);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(5_000);
            await flushAsync();
        });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(2);
        expect(harness.getRuns().map((r: any) => r.runId)).toEqual(['run_1']);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
            await flushAsync();
        });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(3);
        expect(harness.getRuns()).toEqual([]);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
            await flushAsync();
        });
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(3);
        harness.unmount();
    });

    it('does not poll repeatedly when there are no running runs', async () => {
        sessionExecutionRunListSpy.mockResolvedValueOnce({ runs: [] });

        const harness = await renderHarness({ sessionId: 's1', enabled: true });
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
        expect(harness.getRuns()).toEqual([]);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(60_000);
            await flushAsync();
        });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
        harness.unmount();
    });

    it('clears running runs when disabled', async () => {
        sessionExecutionRunListSpy.mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running' }] });

        const harness = await renderHarness({ sessionId: 's1', enabled: true });
        expect(harness.getRuns().map((r: any) => r.runId)).toEqual(['run_1']);

        await harness.rerender({ sessionId: 's1', enabled: false });
        expect(harness.getRuns()).toEqual([]);
        harness.unmount();
    });

    it('rechecks for running runs when execution-run activity is observed', async () => {
        sessionExecutionRunListSpy
            .mockResolvedValueOnce({ runs: [] })
            .mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running' }] });

        const harness = await renderHarness({ sessionId: 's1', enabled: true });
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
        expect(harness.getRuns()).toEqual([]);

        await act(async () => {
            notifyExecutionRunActivity('s1');
            await flushAsync();
        });

        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(2);
        expect(harness.getRuns().map((r: any) => r.runId)).toEqual(['run_1']);
        harness.unmount();
    });

    it('clears running runs state immediately when sessionId changes', async () => {
        sessionExecutionRunListSpy
            .mockResolvedValueOnce({ runs: [{ runId: 'run_1', status: 'running' }] })
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        setTimeout(() => resolve({ runs: [] }), 100);
                    }),
            );

        const harness = await renderHarness({ sessionId: 's1', enabled: true });
        expect(sessionExecutionRunListSpy).toHaveBeenCalledTimes(1);
        expect(harness.getRuns().map((r: any) => r.runId)).toEqual(['run_1']);

        await act(async () => {
            await harness.rerender({ sessionId: 's2', enabled: true });
        });

        // The old runs should be cleared immediately (synchronously) before the new poll completes
        expect(harness.getRuns()).toEqual([]);
        harness.unmount();
    });
});
