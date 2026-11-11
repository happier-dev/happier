import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigateToSessionRoute = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
const useEffectMock = vi.hoisted(() => vi.fn((effect: () => unknown) => { effect(); }));

vi.mock('react', async (importOriginal) => ({
    ...(await importOriginal<typeof import('react')>()),
    useEffect: useEffectMock,
}));
vi.mock('expo-router', () => ({ router: { navigate: vi.fn(), push: vi.fn() } }));
vi.mock('@/hooks/session/navigateToSessionRoute', () => ({ navigateToSessionRoute }));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
    listenTauriEvent: async (event: string, handler: (payload: unknown) => void) => {
        listeners.set(event, handler);
        return () => listeners.delete(event);
    },
}));

describe('useDesktopNotificationClickRouting', () => {
    beforeEach(() => {
        navigateToSessionRoute.mockClear();
        listeners.clear();
    });

    it('opens the session named by a clicked desktop notification', async () => {
        const { useDesktopNotificationClickRouting } = await import('./useDesktopNotificationClickRouting');
        useDesktopNotificationClickRouting();
        await Promise.resolve();

        listeners.get('desktop-notification-clicked')?.({ sessionId: 'session-1' });
        expect(navigateToSessionRoute).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
    });

    it('ignores a click without a session', async () => {
        const { useDesktopNotificationClickRouting } = await import('./useDesktopNotificationClickRouting');
        useDesktopNotificationClickRouting();
        await Promise.resolve();

        listeners.get('desktop-notification-clicked')?.({ sessionId: null });
        expect(navigateToSessionRoute).not.toHaveBeenCalled();
    });
});
