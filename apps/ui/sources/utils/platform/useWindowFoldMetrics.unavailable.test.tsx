import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { useWindowFoldMetrics, WindowFoldMetricsProvider } from './useWindowFoldMetrics';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

describe('useWindowFoldMetrics without the optional native module', () => {
    it('keeps older installed iOS binaries usable without mounting an unavailable native view', async () => {
        const hook = await renderHook(useWindowFoldMetrics, { wrapper: WindowFoldMetricsProvider });
        expect(hook.getCurrent()).toBeNull();
        expect(hook.tree.root.findAllByType('HappierWindowFoldMetrics' as never)).toHaveLength(0);
        await hook.unmount();
    });
});
