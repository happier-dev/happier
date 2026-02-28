import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const poolSpy = vi.fn();
let rendererMode: 'happier' | 'pierre' = 'pierre';
let killSwitchEnabled = true;
let runtimeSupported = true;
const PREWARM_MARKER = '__HAPPIER_PIERRE_DIFF_WORKER_PREWARMED__';

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => {
        if (key === 'filesDiffRendererMode') return rendererMode;
        return undefined;
    },
}));

vi.mock('./pierreWorkerPool.web', () => ({
    getPierreDiffWorkerPool: (params: any) => poolSpy(params),
}));

vi.mock('./pierreRuntimeSupport.web', () => ({
    isPierreDiffKillSwitchEnabled: () => killSwitchEnabled,
    supportsPierreRuntime: () => runtimeSupported,
}));

describe('usePierreDiffWorkerPoolWarmup (web)', () => {
    it('prewarms both unified and split pools when Pierre renderer is enabled and supported', async () => {
        vi.useFakeTimers();
        poolSpy.mockClear();
        delete (globalThis as any)[PREWARM_MARKER];
        rendererMode = 'pierre';
        killSwitchEnabled = true;
        runtimeSupported = true;

        const { usePierreDiffWorkerPoolWarmup } = await import('./usePierreDiffWorkerPoolWarmup.web');

        function Harness() {
            usePierreDiffWorkerPoolWarmup();
            return null;
        }

        await act(async () => {
            renderer.create(<Harness />);
        });

        await act(async () => {
            vi.runAllTimers();
        });

        expect(poolSpy).toHaveBeenCalledWith({ style: 'unified' });
        expect(poolSpy).toHaveBeenCalledWith({ style: 'split' });
        vi.useRealTimers();
    });

    it('does not prewarm when Pierre renderer is disabled', async () => {
        vi.useFakeTimers();
        poolSpy.mockClear();
        delete (globalThis as any)[PREWARM_MARKER];
        rendererMode = 'happier';

        const { usePierreDiffWorkerPoolWarmup } = await import('./usePierreDiffWorkerPoolWarmup.web');

        function Harness() {
            usePierreDiffWorkerPoolWarmup();
            return null;
        }

        await act(async () => {
            renderer.create(<Harness />);
        });

        await act(async () => {
            vi.runAllTimers();
        });

        expect(poolSpy).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});
