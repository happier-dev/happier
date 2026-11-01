import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useWindowFoldMetrics, WindowFoldMetricsProvider } from './useWindowFoldMetrics';

const native = vi.hoisted(() => ({
    platformOS: 'ios' as 'ios' | 'android' | 'web',
    emitters: new Set<(payload: unknown) => void>(),
}));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        Platform: { get OS() { return native.platformOS; } },
    });
});

// Only the Expo/UIKit view boundary is substituted; context and normalization stay real.
vi.mock('expo-modules-core', async () => {
    const React = await import('react');
    function NativeObserver({ onMetricsChange }: { onMetricsChange: (event: { nativeEvent: unknown }) => void }) {
        React.useEffect(() => {
            const emit = (payload: unknown) => onMetricsChange({ nativeEvent: payload });
            native.emitters.add(emit);
            return () => { native.emitters.delete(emit); };
        }, [onMetricsChange]);
        return null;
    }
    return {
        requireOptionalNativeModule: () => ({}),
        requireNativeViewManager: () => NativeObserver,
    };
});

describe('useWindowFoldMetrics', () => {
    beforeEach(() => { native.platformOS = 'ios'; });

    it('publishes fold/resize/removal updates without rerendering consumers for unchanged native geometry', async () => {
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useWindowFoldMetrics();
        }, { wrapper: WindowFoldMetricsProvider });
        const payload = { width: 951, height: 669, divisions: [{ x: 475, y: 0, width: 1, height: 669 }] };
        await act(async () => { for (const emit of native.emitters) emit(payload); });
        expect(hook.getCurrent()).toEqual({ ...payload, hasFoldDivision: true, verticalBarEdge: null });
        const previous = hook.getCurrent();
        const previousRenders = renders;
        await act(async () => { for (const emit of native.emitters) emit(structuredClone(payload)); });
        expect(hook.getCurrent()).toBe(previous);
        expect(renders).toBe(previousRenders);
        const folded = { width: 466, height: 678, divisions: [] };
        await act(async () => { for (const emit of native.emitters) emit(folded); });
        expect(hook.getCurrent()).toEqual({ ...folded, hasFoldDivision: false, verticalBarEdge: null });
        await act(async () => { for (const emit of native.emitters) emit(null); });
        expect(hook.getCurrent()).toBeNull();
        await hook.unmount();
        expect(native.emitters.size).toBe(0);
    });

    it('keeps separate window providers independent', async () => {
        const first = await renderHook(useWindowFoldMetrics, { wrapper: WindowFoldMetricsProvider });
        const emitFirst = [...native.emitters][0];
        const second = await renderHook(useWindowFoldMetrics, { wrapper: WindowFoldMetricsProvider });
        await act(async () => { emitFirst?.({ width: 466, height: 678, divisions: [] }); });
        expect(first.getCurrent()?.width).toBe(466);
        expect(second.getCurrent()).toBeNull();
        await first.unmount();
        await second.unmount();
    });

    it.each(['android', 'web'] as const)('returns no fold and mounts no native observer on %s', async (platform) => {
        native.platformOS = platform;
        const hook = await renderHook(useWindowFoldMetrics, { wrapper: WindowFoldMetricsProvider });
        expect(hook.getCurrent()).toBeNull();
        expect(native.emitters.size).toBe(0);
        await hook.unmount();
    });
});
