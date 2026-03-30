import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const poolSpy = vi.fn();
let rendererMode: 'happier' | 'pierre' = 'pierre';
let killSwitchEnabled = true;
let runtimeSupported = true;
const PREWARM_MARKER = '__HAPPIER_PIERRE_DIFF_WORKER_PREWARMED__';

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSetting: (key: string) => {
        if (key === 'filesDiffRendererMode') return rendererMode;
        return undefined;
    },
});
});

vi.mock('./pierreWorkerPool.web', () => ({
    getPierreDiffWorkerPool: (params: any) => poolSpy(params),
}));

vi.mock('./pierreRuntimeSupport.web', () => ({
    isPierreDiffKillSwitchEnabled: () => killSwitchEnabled,
    supportsPierreRuntime: () => runtimeSupported,
}));

describe('usePierreDiffWorkerPoolWarmup (web)', () => {
    it('prewarms both unified and split pools when Pierre renderer is enabled and supported', async () => {
        poolSpy.mockClear();
        delete (globalThis as any)[PREWARM_MARKER];
        rendererMode = 'pierre';
        killSwitchEnabled = true;
        runtimeSupported = true;
        vi.stubGlobal('window', {
            requestIdleCallback: (callback: () => void) => {
                callback();
                return 0;
            },
        });

        try {
            const { usePierreDiffWorkerPoolWarmup } = await import('./usePierreDiffWorkerPoolWarmup.web');

            await renderHook(() => {
                usePierreDiffWorkerPoolWarmup();
                return null;
            });

            expect(poolSpy).toHaveBeenCalledWith({ style: 'unified' });
            expect(poolSpy).toHaveBeenCalledWith({ style: 'split' });
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('does not prewarm when Pierre renderer is disabled', async () => {
        poolSpy.mockClear();
        delete (globalThis as any)[PREWARM_MARKER];
        rendererMode = 'happier';

        const { usePierreDiffWorkerPoolWarmup } = await import('./usePierreDiffWorkerPoolWarmup.web');

        await renderHook(() => {
            usePierreDiffWorkerPoolWarmup();
            return null;
        });

        expect(poolSpy).not.toHaveBeenCalled();
    });
});
