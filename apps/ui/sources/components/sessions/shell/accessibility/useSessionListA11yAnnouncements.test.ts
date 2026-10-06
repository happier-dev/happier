import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { useSessionListA11yAnnouncements } from './useSessionListA11yAnnouncements';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        AccessibilityInfo: { announceForAccessibility: vi.fn() },
        Platform: { OS: 'ios' },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

describe('useSessionListA11yAnnouncements', () => {
    it('keeps the announcement API object stable across rerenders', async () => {
        const hook = await renderHook(() => useSessionListA11yAnnouncements());
        const initial = hook.getCurrent();

        await hook.rerender();

        expect(hook.getCurrent()).toBe(initial);
        await hook.unmount();
    });
});
