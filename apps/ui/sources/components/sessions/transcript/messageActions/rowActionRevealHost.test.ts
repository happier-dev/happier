import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit';

type MediaChangeListener = () => void;

const pointerState = vi.hoisted(() => ({
    coarse: false,
    changeListeners: [] as MediaChangeListener[],
    matchMediaCalls: [] as string[],
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

function installPointerMatchMedia(): () => void {
    vi.stubGlobal('matchMedia', (query: string) => {
            pointerState.matchMediaCalls.push(query);
            return {
                get matches() { return (
                query === '(pointer: coarse)' || query === '(hover: none)'
                    ? pointerState.coarse
                    : query === '(pointer: fine)' || query === '(hover: hover)'
                        ? !pointerState.coarse
                        : false); },
                addEventListener: (event: string, listener: MediaChangeListener) => {
                    if (event === 'change') pointerState.changeListeners.push(listener);
                },
                removeEventListener: (_event: string, listener: MediaChangeListener) => {
                    pointerState.changeListeners = pointerState.changeListeners.filter(value => value !== listener);
                },
            };
    });
    return () => vi.unstubAllGlobals();
}

describe('transcript primary pointer', () => {
    afterEach(() => {
        pointerState.coarse = false;
        pointerState.changeListeners.length = 0;
        pointerState.matchMediaCalls.length = 0;
    });

    it('updates the mounted transcript fact in both directions without another render trigger', async () => {
        const restoreWindow = installPointerMatchMedia();
        const { useCoarsePrimaryPointer } = await import('./rowActionRevealHost');
        const hook = await renderHook(useCoarsePrimaryPointer);
        try {
            expect(hook.getCurrent()).toBe(false);
            for (const coarse of [true, false]) {
                await act(async () => {
                    pointerState.coarse = coarse;
                    for (const listener of [...pointerState.changeListeners]) listener();
                });
                expect(hook.getCurrent()).toBe(coarse);
            }
        } finally {
            await hook.unmount();
            restoreWindow();
        }
    });
});
