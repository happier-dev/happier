import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    resetDemoRuntimeResidueTrackingForTests,
    startDemoRuntimeResidueTracking,
    stopDemoRuntimeResidueTracking,
} from './runtimeResidue';

describe('startDemoRuntimeResidueTracking runtime mode', () => {
    afterEach(() => {
        // Restore any monkeypatched globals if a test forgot to finish tracking.
        resetDemoRuntimeResidueTrackingForTests();
        vi.restoreAllMocks();
    });

    it('never constructs an Error to capture a stack when scheduling timers in runtime mode', () => {
        startDemoRuntimeResidueTracking('runtime');
        const errorSpy = vi.spyOn(globalThis, 'Error');
        try {
            const handle = globalThis.setTimeout(() => undefined, 100000);
            expect(errorSpy).not.toHaveBeenCalled();
            globalThis.clearTimeout(handle);
        } finally {
            stopDemoRuntimeResidueTracking();
        }
    });

    it('still constructs an Error to attribute the timer in strict mode', () => {
        startDemoRuntimeResidueTracking('strict');
        const errorSpy = vi.spyOn(globalThis, 'Error');
        try {
            const handle = globalThis.setTimeout(() => undefined, 100000);
            expect(errorSpy).toHaveBeenCalled();
            globalThis.clearTimeout(handle);
        } finally {
            stopDemoRuntimeResidueTracking();
        }
    });

    it('counts a pending runtime-mode timer without producing a stack attribution finding', () => {
        startDemoRuntimeResidueTracking('runtime');
        const handle = globalThis.setTimeout(() => undefined, 100000);
        const findings = stopDemoRuntimeResidueTracking();
        globalThis.clearTimeout(handle);
        expect(findings).toEqual([
            { kind: 'timer', label: 'pending setTimeout handles', count: 1 },
        ]);
    });

    it('tracks net event listeners in runtime mode via keyed O(1) removal (no linear scan)', () => {
        startDemoRuntimeResidueTracking('runtime');
        const target = new EventTarget();
        const first = () => undefined;
        const second = () => undefined;
        try {
            target.addEventListener('demo-a', first);
            target.addEventListener('demo-b', second);
            // Idempotent re-add must not inflate the count (matches DOM dedupe).
            target.addEventListener('demo-a', first);
            // Remove exactly one registration; the keyed structure must decrement
            // only the matching listener and leave the other attached.
            target.removeEventListener('demo-a', first);
            const findings = stopDemoRuntimeResidueTracking();
            expect(findings).toEqual([
                { kind: 'eventListener', label: 'attached EventTarget listeners', count: 1 },
            ]);
        } finally {
            target.removeEventListener('demo-b', second);
        }
    });
});
