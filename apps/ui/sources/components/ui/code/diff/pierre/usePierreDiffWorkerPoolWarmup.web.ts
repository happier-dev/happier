import * as React from 'react';

import { useSetting } from '@/sync/domains/state/storage';

import { getPierreDiffWorkerPool } from './pierreWorkerPool.web';
import { isPierreDiffKillSwitchEnabled, supportsPierreRuntime } from './pierreRuntimeSupport.web';

const PREWARM_MARKER = '__HAPPIER_PIERRE_DIFF_WORKER_PREWARMED__';

function hasPrewarmed(): boolean {
    return Boolean((globalThis as any)?.[PREWARM_MARKER]);
}

function markPrewarmed() {
    try {
        (globalThis as any)[PREWARM_MARKER] = true;
    } catch {
        // ignore
    }
}

function scheduleWarmup(fn: () => void) {
    const w: any = (typeof window !== 'undefined' ? window : null) as any;
    if (w && typeof w.requestIdleCallback === 'function') {
        try {
            w.requestIdleCallback(() => fn(), { timeout: 2_000 });
            return;
        } catch {
            // fall through
        }
    }
    setTimeout(fn, 0);
}

export function usePierreDiffWorkerPoolWarmup(): void {
    const rendererMode = useSetting('filesDiffRendererMode');
    const wantsPierre = rendererMode === 'pierre';

    React.useEffect(() => {
        if (!wantsPierre) return;
        if (!isPierreDiffKillSwitchEnabled()) return;
        if (!supportsPierreRuntime()) return;
        if (hasPrewarmed()) return;
        markPrewarmed();

        scheduleWarmup(() => {
            try {
                getPierreDiffWorkerPool({ style: 'unified' });
                getPierreDiffWorkerPool({ style: 'split' });
            } catch {
                // Best-effort warmup; runtime has fallbacks if worker pools cannot be created.
            }
        });
    }, [wantsPierre]);
}
