import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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

describe('transcript row hover intent', () => {
    // The hook installs one document-level watch on first use; this suite owns the stub document it watches.
    const document = new EventTarget();
    async function loadHost() {
        vi.stubGlobal('document', document);
        const { useRowActionHoverHost } = await import('./rowActionRevealHost');
        document.dispatchEvent(new Event('pointermove'));
        return { document, useRowActionHoverHost };
    }
    afterAll(() => vi.unstubAllGlobals());

    it('hovers a stationary surface on pointer enter', async () => {
        const { document, useRowActionHoverHost } = await loadHost();
        const hook = await renderHook(useRowActionHoverHost);
        try {
            document.dispatchEvent(new Event('pointermove'));
            await act(async () => { hook.getCurrent().hoverProps.onPointerEnter(); });
            expect(hook.getCurrent().isHovered).toBe(true);
            await act(async () => { hook.getCurrent().hoverProps.onPointerLeave(); });
            expect(hook.getCurrent().isHovered).toBe(false);
        } finally {
            await hook.unmount();
        }
    });

    it('does not hover rows that scroll under a resting pointer, and hovers on the first real move', async () => {
        // Chromium, per wheel step: wheel → pointerenter on the row now under the pointer → scroll, and no
        // pointermove (P03 Q17). Each such enter used to reveal the row and list its plugin Actions.
        const { document, useRowActionHoverHost } = await loadHost();
        const hook = await renderHook(useRowActionHoverHost);
        try {
            let hovered = 0;
            for (let row = 0; row < 10; row += 1) {
                document.dispatchEvent(new Event('wheel'));
                await act(async () => { hook.getCurrent().hoverProps.onPointerEnter(); });
                if (hook.getCurrent().isHovered) hovered += 1;
                document.dispatchEvent(new Event('scroll'));
                await act(async () => { hook.getCurrent().hoverProps.onPointerLeave(); });
            }
            expect(hovered).toBe(0);
            await act(async () => { hook.getCurrent().hoverProps.onPointerEnter(); hook.getCurrent().hoverProps.onPointerMove(); });
            expect(hook.getCurrent().isHovered).toBe(true);
        } finally {
            await hook.unmount();
        }
    });
});
