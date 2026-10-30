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

    it('tracks exact target, event, capture and listener identity through out-of-order removals', () => {
        startDemoRuntimeResidueTracking('runtime');
        const target = new EventTarget();
        const otherTarget = new EventTarget();
        const delivered: Array<readonly [EventTarget | null, string]> = [];
        const first = (event: Event) => { delivered.push([event.target, event.type]); };
        const second = vi.fn();
        try {
            target.addEventListener('demo', first);
            otherTarget.addEventListener('demo', first);
            target.addEventListener('demo', second);
            target.addEventListener('demo', first, { capture: true });
            target.addEventListener('other', first);
            // Same registration is idempotent, but target/type/capture differences are not.
            target.addEventListener('demo', first);
            target.removeEventListener('demo', second);
            target.removeEventListener('demo', second);
            otherTarget.removeEventListener('demo', second);
            target.removeEventListener('missing', first);
            target.removeEventListener('demo', second, { capture: true });
            target.removeEventListener('demo', first, { capture: false });

            target.dispatchEvent(new Event('demo'));
            otherTarget.dispatchEvent(new Event('demo'));
            target.dispatchEvent(new Event('other'));
            expect(second).not.toHaveBeenCalled();
            expect(delivered).toEqual([[target, 'demo'], [otherTarget, 'demo'], [target, 'other']]);
            const findings = stopDemoRuntimeResidueTracking();
            expect(findings).toEqual([
                { kind: 'eventListener', label: 'attached EventTarget listeners', count: 3 },
            ]);
        } finally {
            target.removeEventListener('demo', first);
            target.removeEventListener('demo', first, { capture: true });
            target.removeEventListener('demo', second);
            otherTarget.removeEventListener('demo', first);
            target.removeEventListener('other', first);
        }
    });
});
