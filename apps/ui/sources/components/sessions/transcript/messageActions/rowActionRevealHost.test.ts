import { afterEach, describe, expect, it, vi } from 'vitest';

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
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
        matchMedia: (query: string) => {
            pointerState.matchMediaCalls.push(query);
            const matches =
                query === '(pointer: coarse)' || query === '(hover: none)'
                    ? pointerState.coarse
                    : query === '(pointer: fine)' || query === '(hover: hover)'
                        ? !pointerState.coarse
                        : false;
            return {
                matches,
                addEventListener: (event: string, listener: MediaChangeListener) => {
                    if (event === 'change') pointerState.changeListeners.push(listener);
                },
            };
        },
    };
    return () => {
        (globalThis as { window?: unknown }).window = previousWindow;
    };
}

describe('readCoarsePrimaryPointer', () => {
    afterEach(() => {
        pointerState.coarse = false;
        pointerState.changeListeners.length = 0;
        pointerState.matchMediaCalls.length = 0;
    });

    it('caches per host capability and re-resolves after the primary pointer changes', async () => {
        const restoreWindow = installPointerMatchMedia();
        try {
            const { readCoarsePrimaryPointer } = await import('./rowActionRevealHost');

            expect(readCoarsePrimaryPointer()).toBe(false);
            const callsAfterFirstRead = pointerState.matchMediaCalls.length;
            // Cached: a second read must not re-evaluate the media queries, or every
            // row of a long transcript pays for a host-level property on every render.
            expect(readCoarsePrimaryPointer()).toBe(false);
            expect(pointerState.matchMediaCalls).toHaveLength(callsAfterFirstRead);

            // One module-scope listener, not one per row.
            expect(pointerState.changeListeners).toHaveLength(1);

            pointerState.coarse = true;
            for (const listener of [...pointerState.changeListeners]) {
                listener();
            }

            expect(readCoarsePrimaryPointer()).toBe(true);
        } finally {
            restoreWindow();
        }
    });
});
