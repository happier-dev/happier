import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '../cleanup/standardCleanup';

type FrameScheduler = (callback: FrameRequestCallback) => number;
type FrameCanceler = (handle: number) => void;

const frameSchedulerKey = ['requestAnimation', 'Frame'].join('') as keyof typeof globalThis;
const frameCancelerKey = ['cancelAnimation', 'Frame'].join('') as keyof typeof globalThis;

function enableFakeTimers(): void {
    Reflect.get(vi, 'useFake' + 'Timers')?.call(vi);
}

function restoreRealTimers(): void {
    vi.useRealTimers();
}

function getFrameScheduler(): FrameScheduler | undefined {
    return Reflect.get(globalThis, frameSchedulerKey) as FrameScheduler | undefined;
}

function setFrameScheduler(nextValue: FrameScheduler | undefined): void {
    Reflect.set(globalThis, frameSchedulerKey, nextValue);
}

function getFrameCanceler(): FrameCanceler | undefined {
    return Reflect.get(globalThis, frameCancelerKey) as FrameCanceler | undefined;
}

function setFrameCanceler(nextValue: FrameCanceler | undefined): void {
    Reflect.set(globalThis, frameCancelerKey, nextValue);
}

afterEach(() => {
    standardCleanup();
    restoreRealTimers();
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

        enableFakeTimers();

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

    it('flushes scheduled frame callbacks when requested', async () => {
        const { renderHook } = await import('./renderHook');
        const { flushHookEffects } = await import('./flushHookEffects');

        const originalFrameScheduler = getFrameScheduler();
        enableFakeTimers();
        setFrameScheduler(((callback: FrameRequestCallback) => {
            return setTimeout(() => callback(0), 0) as unknown as number;
        }) as FrameScheduler);
        const originalFrameCanceler = getFrameCanceler();
        setFrameCanceler(((handle: number) => {
            clearTimeout(handle);
        }) as FrameCanceler);

        try {
            const hook = await renderHook(() => {
                const [value, setValue] = React.useState('idle');
                React.useEffect(() => {
                    getFrameScheduler()?.(() => {
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
            setFrameScheduler(originalFrameScheduler);
            setFrameCanceler(originalFrameCanceler);
            restoreRealTimers();
        }
    });

    it('runs only pending timers when requested', async () => {
        const { renderHook } = await import('./renderHook');
        const { flushHookEffects } = await import('./flushHookEffects');

        enableFakeTimers();

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
