import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, renderHook } from '@/dev/testkit';
import { installOptionalNativeModuleForTests } from '@/dev/expoModulesCoreStub';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';

const native = vi.hoisted(() => ({ platformOS: 'ios' as 'ios' | 'android' | 'web' }));

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, {
        Platform: { get OS() { return native.platformOS; } },
    });
});

// Use the canonical Expo native boundary; normalization, context, and event wiring remain real.
const restoreNativeModule = installOptionalNativeModuleForTests('HappierWindowFoldMetrics', {});
const { useWindowFoldMetrics, WindowFoldMetricsProvider } = await import('./useWindowFoldMetrics');
afterAll(restoreNativeModule);

describe('useWindowFoldMetrics', () => {
    beforeEach(() => { native.platformOS = 'ios'; });

    it('publishes native fold, resize, and removal events with zero consumer work for equal geometry', async () => {
        const counter = createRenderCommitCounter();
        const hook = await renderHook(() => {
            useRenderCommitCounter(counter);
            return useWindowFoldMetrics();
        }, { wrapper: WindowFoldMetricsProvider });
        expect(hook.getCurrent()).toBeNull();
        const observer = hook.tree.root.findByType('HappierWindowFoldMetrics' as never);
        const emit = async (nativeEvent: unknown) => {
            await act(async () => { observer.props.onMetricsChange({ nativeEvent }); });
        };
        const payload = { width: 951, height: 669, divisions: [{ x: 475, y: 0, width: 1, height: 669 }] };
        await emit(payload);
        expect(hook.getCurrent()).toEqual({ ...payload, hasFoldDivision: true, verticalBarEdge: null });
        const previous = hook.getCurrent();
        counter.reset();
        for (let index = 0; index < 20; index += 1) await emit(structuredClone(payload));
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        expect(hook.getCurrent()).toBe(previous);
        await emit({ ...payload, width: 1000 });
        expect(hook.getCurrent()?.width).toBe(1000);
        const folded = { width: 466, height: 678, divisions: [], verticalBarEdge: 'trailing' };
        await emit(folded);
        expect(hook.getCurrent()).toEqual({ ...folded, hasFoldDivision: false });
        const rail = hook.getCurrent();
        counter.reset();
        for (let index = 0; index < 20; index += 1) await emit(structuredClone(folded));
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        expect(hook.getCurrent()).toBe(rail);
        await emit({ ...folded, verticalBarEdge: 'leading' });
        expect(hook.getCurrent()?.verticalBarEdge).toBe('leading');
        await emit(null);
        expect(hook.getCurrent()).toBeNull();
        await hook.unmount();
    });

    it('keeps separately mounted windows independent', async () => {
        const first = await renderHook(useWindowFoldMetrics, { wrapper: WindowFoldMetricsProvider });
        const second = await renderHook(useWindowFoldMetrics, { wrapper: WindowFoldMetricsProvider });
        const observer = first.tree.root.findByType('HappierWindowFoldMetrics' as never);
        await act(async () => { observer.props.onMetricsChange({ nativeEvent: { width: 466, height: 678, divisions: [] } }); });
        expect(first.getCurrent()?.width).toBe(466);
        expect(second.getCurrent()).toBeNull();
        await first.unmount();
        await second.unmount();
    });

    it.each(['android', 'web'] as const)('returns null without a native observer on %s', async (platform) => {
        native.platformOS = platform;
        const hook = await renderHook(useWindowFoldMetrics, { wrapper: WindowFoldMetricsProvider });
        expect(hook.getCurrent()).toBeNull();
        expect(hook.tree.root.findAllByType('HappierWindowFoldMetrics' as never)).toHaveLength(0);
        await hook.unmount();
    });
});
