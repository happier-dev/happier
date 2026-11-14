import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderHook } from '@/dev/testkit';

const native = vi.hoisted(() => ({
    pending: null as unknown,
    listener: null as null | (() => void),
    finishListening: null as null | (() => void),
    delayedRegistration: false,
    unlisten: vi.fn(),
    invoke: vi.fn(),
}));
const push = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push } }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
// The asynchronous native IPC/event transport is the system boundary; navigation remains real.
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
    invokeTauri: (...args: unknown[]) => native.invoke(...args),
    listenTauriEvent: async (_event: string, listener: () => void) => {
        if (native.delayedRegistration) {
            await new Promise<void>((resolve) => { native.finishListening = resolve; });
        }
        native.listener = listener;
        return native.unlisten;
    },
}));

import { useDesktopNotificationClickRouting } from './useDesktopNotificationClickRouting';

describe('useDesktopNotificationClickRouting', () => {
    beforeEach(() => {
        push.mockClear();
        native.pending = null;
        native.listener = null;
        native.finishListening = null;
        native.delayedRegistration = false;
        native.unlisten.mockReset();
        native.invoke.mockReset().mockImplementation(async () => {
            const data = native.pending;
            native.pending = null;
            return data;
        });
    });
    afterEach(() => { vi.restoreAllMocks(); });

    it('consumes a click arriving while listener registration is pending', async () => {
        native.delayedRegistration = true;
        const hook = await renderHook(useDesktopNotificationClickRouting);
        // No event can reach JavaScript yet. The shell retains the click.
        native.pending = { sessionId: 'during-startup' };
        native.finishListening?.();
        await flushHookEffects();
        expect(push).toHaveBeenCalledExactlyOnceWith('/session/during-startup');
        await hook.unmount();
    });

    it('opens a pending click once when the same click also wakes the live listener', async () => {
        native.pending = { sessionId: 'one-click' };
        const hook = await renderHook(useDesktopNotificationClickRouting);
        native.listener?.();
        await flushHookEffects();
        expect(push).toHaveBeenCalledExactlyOnceWith('/session/one-click');
        await hook.unmount();
    });

    it('takes live clicks from native pending data rather than the event payload', async () => {
        const hook = await renderHook(useDesktopNotificationClickRouting);
        native.pending = { sessionId: 'live-click' };
        native.listener?.();
        await flushHookEffects();
        expect(push).toHaveBeenCalledExactlyOnceWith('/session/live-click');
        await hook.unmount();
    });

    it('does not route a pending response that settles after unmount', async () => {
        let finishRead: ((value: unknown) => void) | undefined;
        native.invoke.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
        const hook = await renderHook(useDesktopNotificationClickRouting);
        await hook.unmount();
        finishRead?.({ sessionId: 'retired-window' });
        await flushHookEffects();
        expect(push).not.toHaveBeenCalled();
        expect(native.unlisten).toHaveBeenCalledTimes(1);
    });

    it('disposes a listener whose registration settles after unmount', async () => {
        native.delayedRegistration = true;
        const hook = await renderHook(useDesktopNotificationClickRouting);
        await hook.unmount();
        native.finishListening?.();
        await flushHookEffects();
        expect(native.unlisten).toHaveBeenCalledTimes(1);
        expect(push).not.toHaveBeenCalled();
    });

    it('reports native read failures without navigating', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        native.invoke.mockRejectedValue(new Error('IPC unavailable'));
        const hook = await renderHook(useDesktopNotificationClickRouting);
        await flushHookEffects();
        expect(warning).toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
