import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { useSessionListA11yAnnouncements } from './useSessionListA11yAnnouncements';

vi.mock('react-native', () => ({
    AccessibilityInfo: { announceForAccessibility: vi.fn() },
    Platform: {
        OS: 'ios',
        select: (value: Record<string, unknown>) => value.ios ?? value.default,
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('useSessionListA11yAnnouncements', () => {
    it('keeps the announcement API object stable across rerenders', async () => {
        const hook = await renderHook(() => useSessionListA11yAnnouncements());
        const initial = hook.getCurrent();

        await hook.rerender();

        expect(hook.getCurrent()).toBe(initial);
        await hook.unmount();
    });
});
