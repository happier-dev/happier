import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

type FakeVisualViewport = {
    width: number;
    height: number;
    offsetTop: number;
    listeners: Map<string, Set<() => void>>;
    addEventListener: (name: string, listener: () => void) => void;
    removeEventListener: (name: string, listener: () => void) => void;
    dispatch: (name: string) => void;
};

type FakeBrowserWindow = {
    innerHeight: number;
    visualViewport: FakeVisualViewport;
    listeners: Map<string, Set<() => void>>;
    addEventListener: (name: string, listener: () => void) => void;
    removeEventListener: (name: string, listener: () => void) => void;
    dispatch: (name: string) => void;
};

function createListenerHost<T extends object>(target: T): T & { listeners: Map<string, Set<() => void>>; addEventListener: (name: string, listener: () => void) => void; removeEventListener: (name: string, listener: () => void) => void; dispatch: (name: string) => void } {
    const listeners = new Map<string, Set<() => void>>();
    return Object.assign(target, {
        listeners,
        addEventListener(name: string, listener: () => void) {
            const set = listeners.get(name) ?? new Set();
            set.add(listener);
            listeners.set(name, set);
        },
        removeEventListener(name: string, listener: () => void) {
            listeners.get(name)?.delete(listener);
        },
        dispatch(name: string) {
            for (const listener of listeners.get(name) ?? []) listener();
        },
    });
}

function createFakeBrowser(baselineViewportHeight: number, innerHeight: number, editable: unknown = null): FakeBrowserWindow {
    const visualViewport = createListenerHost({ width: 480, height: baselineViewportHeight, offsetTop: 0 });
    const windowFake = createListenerHost({ innerHeight, visualViewport });
    (globalThis as Record<string, unknown>).window = windowFake;
    (globalThis as Record<string, unknown>).document = { activeElement: editable };
    return windowFake as FakeBrowserWindow;
}

function focusEditable(windowFake: FakeBrowserWindow): void {
    (globalThis.document as unknown as { activeElement: unknown }).activeElement = {
        tagName: 'textarea',
        getAttribute: () => null,
    };
    windowFake.dispatch('focusin');
}

async function loadHook() {
    const module = await import('./useKeyboardHeight');
    return renderHook(() => module.useKeyboardHeight());
}

describe('useKeyboardHeight on web', () => {
    afterEach(() => {
        standardCleanup();
        delete (globalThis as Record<string, unknown>).window;
        delete (globalThis as Record<string, unknown>).document;
    });

    it('tracks the keyboard from the visual-viewport baseline, not a lying window.innerHeight', async () => {
        const baselineViewportHeight = 820;
        const keyboardViewportHeight = 533;
        createFakeBrowser(baselineViewportHeight, 846);
        const hook = await loadHook();
        expect(hook.getCurrent()).toBe(0);

        const windowFake = globalThis.window as unknown as FakeBrowserWindow;
        act(() => {
            focusEditable(windowFake);
            windowFake.visualViewport.dispatch('resize');
        });
        expect(hook.getCurrent()).toBe(0);

        act(() => {
            windowFake.visualViewport.height = keyboardViewportHeight;
            windowFake.visualViewport.dispatch('resize');
        });

        // innerHeight - vv.height = 313 would float consumers 26px above the keyboard top;
        // the true occupancy is the baseline shrink, 287.
        expect(hook.getCurrent()).toBe(baselineViewportHeight - keyboardViewportHeight);

        // Keyboard dismissal restores zero so bottom chrome un-hides and releases its space.
        act(() => {
            (globalThis.document as unknown as { activeElement: unknown }).activeElement = null;
            windowFake.dispatch('focusout');
            windowFake.visualViewport.height = baselineViewportHeight;
            windowFake.visualViewport.dispatch('resize');
        });
        expect(hook.getCurrent()).toBe(0);
    });

    it('ignores visual-viewport shrinkage on non-mobile widths', async () => {
        const windowFake = createFakeBrowser(820, 846);
        windowFake.visualViewport.width = 1280;
        const hook = await loadHook();

        act(() => {
            focusEditable(windowFake);
            windowFake.visualViewport.height = 533;
            windowFake.visualViewport.dispatch('resize');
        });

        expect(hook.getCurrent()).toBe(0);
    });
});
