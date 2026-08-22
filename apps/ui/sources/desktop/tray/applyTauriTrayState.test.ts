import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeDesktopHost = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/utils/platform/desktopHost', () => ({
    invokeDesktopHost,
}));

describe('applyTauriTrayState', () => {
    beforeEach(() => {
        invokeDesktopHost.mockClear();
    });

    it('passes the tray state under the state key expected by the native command', async () => {
        const { applyTauriTrayState } = await import('./applyTauriTrayState');

        const state = {
            status: 'healthy',
            label: 'Connected',
            detail: '3 machines online',
        } as const;

        await applyTauriTrayState(state);

        expect(invokeDesktopHost).toHaveBeenCalledWith('desktop_set_tray_state', { state });
    });
});
