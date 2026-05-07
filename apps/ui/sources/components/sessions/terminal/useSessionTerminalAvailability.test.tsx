import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const useFeatureEnabledSpy = vi.hoisted(() => vi.fn());
const usePreferredServerIdForSessionSpy = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (...args: unknown[]) => useFeatureEnabledSpy(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: (sessionId: string) => usePreferredServerIdForSessionSpy(sessionId),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'desktop',
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: () => 'sidebar',
}));

describe('useSessionTerminalAvailability', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        useFeatureEnabledSpy.mockReset();
        usePreferredServerIdForSessionSpy.mockReset();
        useFeatureEnabledSpy.mockReturnValue(true);
        usePreferredServerIdForSessionSpy.mockReturnValue('server-session');
    });

    it('scopes embedded terminal availability to the viewed session server', async () => {
        const { useSessionTerminalAvailability } = await import('./useSessionTerminalAvailability');

        const hook = await renderHook(() => useSessionTerminalAvailability({ sessionId: 'session-1' }));

        expect(usePreferredServerIdForSessionSpy).toHaveBeenCalledWith('session-1');
        expect(useFeatureEnabledSpy).toHaveBeenCalledWith('terminal.embeddedPty', {
            scopeKind: 'spawn',
            serverId: 'server-session',
        });
        expect(hook.getCurrent().sidebarTabAvailable).toBe(true);
    });
});
