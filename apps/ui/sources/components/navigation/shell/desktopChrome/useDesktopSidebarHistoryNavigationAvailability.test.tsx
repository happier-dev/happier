import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
    });
});

type FakeHistoryEntry = Readonly<{
    state: unknown;
    url?: string | URL | null;
}>;

function createFakeHistory(): Pick<History, 'length' | 'state' | 'pushState' | 'replaceState' | 'back' | 'forward'> {
    const entries: FakeHistoryEntry[] = [{ state: null }];
    let index = 0;

    return {
        get length() {
            return entries.length;
        },
        get state() {
            return entries[index]?.state ?? null;
        },
        pushState(state: unknown, _unused: string, url?: string | URL | null) {
            entries.splice(index + 1);
            entries.push({ state, url });
            index = entries.length - 1;
        },
        replaceState(state: unknown, _unused: string, url?: string | URL | null) {
            entries[index] = { state, url };
        },
        back() {
            index = Math.max(0, index - 1);
        },
        forward() {
            index = Math.min(entries.length - 1, index + 1);
        },
    };
}

describe('useDesktopSidebarHistoryNavigationAvailability', () => {
    let originalHistoryDescriptor: PropertyDescriptor | undefined;
    let originalAddEventListenerDescriptor: PropertyDescriptor | undefined;
    let originalRemoveEventListenerDescriptor: PropertyDescriptor | undefined;
    let originalDispatchEventDescriptor: PropertyDescriptor | undefined;
    let eventTarget: EventTarget;

    beforeEach(() => {
        originalHistoryDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'history');
        originalAddEventListenerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
        originalRemoveEventListenerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
        originalDispatchEventDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'dispatchEvent');
        eventTarget = new EventTarget();

        Object.defineProperty(globalThis, 'history', {
            configurable: true,
            value: createFakeHistory(),
        });
        Object.defineProperty(globalThis, 'addEventListener', {
            configurable: true,
            value: eventTarget.addEventListener.bind(eventTarget),
        });
        Object.defineProperty(globalThis, 'removeEventListener', {
            configurable: true,
            value: eventTarget.removeEventListener.bind(eventTarget),
        });
        Object.defineProperty(globalThis, 'dispatchEvent', {
            configurable: true,
            value: eventTarget.dispatchEvent.bind(eventTarget),
        });
    });

    afterEach(() => {
        for (const [key, descriptor] of [
            ['history', originalHistoryDescriptor],
            ['addEventListener', originalAddEventListenerDescriptor],
            ['removeEventListener', originalRemoveEventListenerDescriptor],
            ['dispatchEvent', originalDispatchEventDescriptor],
        ] as const) {
            if (descriptor) {
                Object.defineProperty(globalThis, key, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, key);
            }
        }
    });

    it('tracks back and forward availability for same-window history entries', async () => {
        const { useDesktopSidebarHistoryNavigationAvailability } = await import('./useDesktopSidebarHistoryNavigationAvailability');
        const hook = await renderHook(() => useDesktopSidebarHistoryNavigationAvailability(), {
            flushOptions: { cycles: 1, turns: 1 },
        });

        expect(hook.getCurrent()).toEqual({
            canNavigateBack: false,
            canNavigateForward: false,
        });

        await act(async () => {
            globalThis.history.pushState({}, '', '/settings');
        });
        await hook.rerender();
        expect(hook.getCurrent()).toEqual({
            canNavigateBack: true,
            canNavigateForward: false,
        });

        await act(async () => {
            globalThis.history.pushState({}, '', '/new');
        });
        await hook.rerender();
        expect(hook.getCurrent()).toEqual({
            canNavigateBack: true,
            canNavigateForward: false,
        });

        await act(async () => {
            globalThis.history.back();
            globalThis.dispatchEvent(new Event('popstate'));
        });
        await hook.rerender();
        expect(hook.getCurrent()).toEqual({
            canNavigateBack: true,
            canNavigateForward: true,
        });

        await act(async () => {
            globalThis.history.forward();
            globalThis.dispatchEvent(new Event('popstate'));
        });
        await hook.rerender();
        expect(hook.getCurrent()).toEqual({
            canNavigateBack: true,
            canNavigateForward: false,
        });
    });
});
