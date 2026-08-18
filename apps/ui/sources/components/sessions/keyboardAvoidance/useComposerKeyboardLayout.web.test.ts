import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const webHookState = vi.hoisted(() => ({
    windowHeight: 800,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({
            width: 1024,
            height: webHookState.windowHeight,
            scale: 1,
            fontScale: 1,
        }),
    });
});

vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        useSharedValue: <T,>(value: T) => React.useRef({ value }).current,
    };
});

describe('useComposerKeyboardLayout web', () => {
    beforeEach(() => {
        standardCleanup();
        webHookState.windowHeight = 800;
    });

    it('does not reserve the measured composer height inside the transcript inset', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.web');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(127);
        });

        expect(hook.getCurrent().composerHeight.value).toBe(127);
        expect(hook.getCurrent().listBottomInset.value).toBe(0);
    });

    it('caps available panel height to the measured scaffold container', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.web');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            availablePanelMaxHeight: 420,
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        expect(hook.getCurrent().availablePanelHeight.value).toBe(420);
    });
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

function createFakeBrowser(baselineViewportHeight: number, innerHeight: number): FakeBrowserWindow {
    const listeners = new Map<string, Set<() => void>>();
    const visualViewport: FakeVisualViewport = {
        width: 480,
        height: baselineViewportHeight,
        offsetTop: 0,
        listeners: new Map(),
        addEventListener(name, listener) {
            const set = this.listeners.get(name) ?? new Set();
            set.add(listener);
            this.listeners.set(name, set);
        },
        removeEventListener(name, listener) {
            this.listeners.get(name)?.delete(listener);
        },
        dispatch(name) {
            for (const listener of this.listeners.get(name) ?? []) listener();
        },
    };
    return {
        innerHeight,
        visualViewport,
        listeners,
        addEventListener(name, listener) {
            const set = this.listeners.get(name) ?? new Set();
            set.add(listener);
            this.listeners.set(name, set);
        },
        removeEventListener(name, listener) {
            this.listeners.get(name)?.delete(listener);
        },
        dispatch(name) {
            for (const listener of this.listeners.get(name) ?? []) listener();
        },
    };
}

describe('useComposerKeyboardLayout web visual-viewport integrity', () => {
    beforeEach(() => {
        standardCleanup();
        webHookState.windowHeight = 800;
        delete (globalThis as Record<string, unknown>).window;
        delete (globalThis as Record<string, unknown>).document;
    });

    it('resolves the keyboard inset against the visual-viewport baseline, not a lying window.innerHeight', async () => {
        // Reproduces the Firefox Android mismatch seen on a real device: the layout viewport
        // (window.innerHeight) reports a taller window than the visual viewport can ever reach
        // even with no keyboard, so innerHeight - vv.height is a phantom ~90px that the old
        // formula counted as keyboard, floating the composer above the keyboard top.
        const baselineViewportHeight = 820;
        const keyboardViewportHeight = 533;
        const fakeWindow = createFakeBrowser(baselineViewportHeight, 846);
        (globalThis as Record<string, unknown>).window = fakeWindow;
        (globalThis as Record<string, unknown>).document = { activeElement: null };

        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.web');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        // Focus an editable so the keyboard gates open.
        const documentGlobal = globalThis.document as unknown as { activeElement: unknown };
        documentGlobal.activeElement = { tagName: 'textarea', getAttribute: () => null };
        act(() => {
            fakeWindow.dispatch('focusin');
            fakeWindow.visualViewport.dispatch('resize');
        });
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(0);

        // Keyboard opens: the visual viewport shrinks to the keyboard top.
        act(() => {
            fakeWindow.visualViewport.height = keyboardViewportHeight;
            fakeWindow.visualViewport.dispatch('resize');
        });

        // The true keyboard occupancy is baseline - keyboarded viewport. The old innerHeight
        // reference produced 313 (846 - 533), i.e. ~26 phantom px; the baseline reference must
        // produce 287 exactly.
        expect(hook.getCurrent().keyboardHeightLive.value).toBe(baselineViewportHeight - keyboardViewportHeight);
    });

    it('falls back to window.innerHeight when the scaffold first mounts with the keyboard already open', async () => {
        // No unoccluded visual viewport has ever been observed (e.g. deep-link to the new-session
        // screen with the keyboard still up), so there is no baseline to compare against. The old
        // innerHeight reference is the only signal; keep it rather than leaving the composer under
        // the keyboard.
        const keyboardViewportHeight = 533;
        const fakeWindow = createFakeBrowser(keyboardViewportHeight, 846);
        (globalThis as Record<string, unknown>).window = fakeWindow;
        (globalThis as Record<string, unknown>).document = { activeElement: { tagName: 'textarea', getAttribute: () => null } };

        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.web');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        expect(hook.getCurrent().keyboardHeightLive.value).toBe(846 - keyboardViewportHeight);
    });
});
