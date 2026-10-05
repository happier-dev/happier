import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

import { useReduceTransparency } from './useReduceTransparency';

type PreferenceListener = (enabled: boolean) => void;
type MediaListener = (event: { matches: boolean }) => void;

const host = vi.hoisted(() => ({
    platform: 'web' as 'web' | 'ios',
    nativePreference: false,
    nativeListeners: new Set<PreferenceListener>(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { get OS() { return host.platform; } },
        AccessibilityInfo: {
            isReduceTransparencyEnabled: async () => host.nativePreference,
            addEventListener: (event: string, listener: PreferenceListener) => {
                if (event === 'reduceTransparencyChanged') host.nativeListeners.add(listener);
                return { remove: () => host.nativeListeners.delete(listener) };
            },
        },
    });
});

// matchMedia is the browser/OS boundary; the hook and its React lifecycle stay real.
function installMediaPreference(initial: boolean, legacy = false) {
    const listeners = new Set<MediaListener>();
    const media = {
        matches: initial,
        ...(legacy ? {
            addListener: (listener: MediaListener) => { listeners.add(listener); },
            removeListener: (listener: MediaListener) => { listeners.delete(listener); },
        } : {
            addEventListener: (_event: 'change', listener: MediaListener) => { listeners.add(listener); },
            removeEventListener: (_event: 'change', listener: MediaListener) => { listeners.delete(listener); },
        }),
    };
    vi.stubGlobal('window', {
        matchMedia: (query: string) => query === '(prefers-reduced-transparency: reduce)'
            ? media
            : { matches: false },
    });
    return {
        listeners,
        publish: (enabled: boolean) => {
            media.matches = enabled;
            for (const listener of listeners) listener({ matches: enabled });
        },
    };
}

describe('useReduceTransparency', () => {
    beforeEach(() => {
        host.platform = 'web';
        host.nativePreference = false;
    });

    afterEach(() => {
        standardCleanup();
        vi.unstubAllGlobals();
        host.nativeListeners.clear();
    });

    it('reads and follows the browser OS transparency preference and releases its watch', async () => {
        const media = installMediaPreference(true);
        const hook = await renderHook(() => useReduceTransparency());
        expect(hook.getCurrent()).toBe(true);

        await act(async () => { media.publish(false); });
        expect(hook.getCurrent()).toBe(false);
        await act(async () => { media.publish(true); });
        expect(hook.getCurrent()).toBe(true);

        await hook.unmount();
        expect(media.listeners.size).toBe(0);
    });

    it('follows legacy browser media-query changes and releases that watch', async () => {
        const media = installMediaPreference(false, true);
        const hook = await renderHook(() => useReduceTransparency());
        expect(hook.getCurrent()).toBe(false);
        await act(async () => { media.publish(true); });
        expect(hook.getCurrent()).toBe(true);
        await hook.unmount();
        expect(media.listeners.size).toBe(0);
    });

    it('does not infer Reduce Transparency from an unsupported or unmatched browser query', async () => {
        host.nativePreference = true;
        vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
        const hook = await renderHook(() => useReduceTransparency());
        expect(hook.getCurrent()).toBe(false);
    });

    it('keeps the preference false when the browser has no matchMedia', async () => {
        host.nativePreference = true;
        vi.stubGlobal('window', {});
        const hook = await renderHook(() => useReduceTransparency());
        expect(hook.getCurrent()).toBe(false);
    });

    it('preserves native AccessibilityInfo preference and live changes rather than browser values', async () => {
        host.platform = 'ios';
        host.nativePreference = true;
        const media = installMediaPreference(false);
        const hook = await renderHook(() => useReduceTransparency());
        expect(hook.getCurrent()).toBe(true);
        await act(async () => {
            for (const listener of host.nativeListeners) listener(false);
        });
        expect(hook.getCurrent()).toBe(false);
        await act(async () => { media.publish(true); });
        expect(hook.getCurrent()).toBe(false);
        await hook.unmount();
        expect(host.nativeListeners.size).toBe(0);
    });
});
