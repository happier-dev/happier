import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '../cleanup/standardCleanup';

afterEach(() => {
    standardCleanup();
});

describe('UI testkit hook helpers', () => {
    it('creates deferred promises that can be resolved later', async () => {
        const { createDeferred } = await import('./createDeferred');

        const deferred = createDeferred<number>();
        deferred.resolve(42);

        await expect(deferred.promise).resolves.toBe(42);
    });

    it('renders hooks and supports rerendering with new props', async () => {
        const { renderHook } = await import('./renderHook');

        const hook = await renderHook(({ value }: { value: number }) => React.useMemo(() => value * 2, [value]), {
            initialProps: { value: 2 },
        });

        expect(hook.getCurrent()).toBe(4);

        await hook.rerender({ value: 5 });
        expect(hook.getCurrent()).toBe(10);
    });

    it('flushes fake timers and microtasks when requested', async () => {
        const { renderHook } = await import('./renderHook');
        const { flushHookEffects } = await import('./flushHookEffects');

        vi.useFakeTimers();

        const hook = await renderHook(() => {
            const [value, setValue] = React.useState('idle');
            React.useEffect(() => {
                setTimeout(() => {
                    setValue('done');
                }, 10);
            }, []);
            return value;
        });

        expect(hook.getCurrent()).toBe('idle');

        await flushHookEffects({ advanceTimersMs: 10 });
        expect(hook.getCurrent()).toBe('done');
    });

    it('flushes requestAnimationFrame callbacks when requested', async () => {
        const { renderHook } = await import('./renderHook');
        const { flushHookEffects } = await import('./flushHookEffects');

        const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
        vi.useFakeTimers();
        globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
            return setTimeout(() => callback(0), 0) as unknown as number;
        }) as typeof globalThis.requestAnimationFrame;
        const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
        globalThis.cancelAnimationFrame = ((handle: number) => {
            clearTimeout(handle);
        }) as typeof globalThis.cancelAnimationFrame;

        try {
            const hook = await renderHook(() => {
                const [value, setValue] = React.useState('idle');
                React.useEffect(() => {
                    requestAnimationFrame(() => {
                        setValue('done');
                    });
                }, []);
                return value;
            }, {
                flushOptions: { cycles: 0 },
            });

            expect(hook.getCurrent()).toBe('idle');

            await flushHookEffects({ cycles: 1, frames: 1 });
            expect(hook.getCurrent()).toBe('done');
        } finally {
            globalThis.requestAnimationFrame = originalRequestAnimationFrame;
            globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
            vi.useRealTimers();
        }
    });

    it('runs only pending timers when requested', async () => {
        const { renderHook } = await import('./renderHook');
        const { flushHookEffects } = await import('./flushHookEffects');

        vi.useFakeTimers();

        const hook = await renderHook(() => {
            const [value, setValue] = React.useState('idle');
            React.useEffect(() => {
                setTimeout(() => {
                    setValue('done');
                }, 0);
            }, []);
            return value;
        });

        expect(hook.getCurrent()).toBe('idle');

        await flushHookEffects({ cycles: 1, turns: 0, runOnlyPendingTimers: true });
        expect(hook.getCurrent()).toBe('done');
    });
});
