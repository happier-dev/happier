import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeTauri = vi.hoisted(() => vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null));

vi.mock('@/utils/platform/tauri', () => ({
    invokeTauri,
}));

describe('applyTauriTrayState', () => {
    beforeEach(() => {
        invokeTauri.mockClear();
    });

    it('passes the tray state under the state key expected by the native command', async () => {
        const { applyTauriTrayState } = await import('./applyTauriTrayState');

        const state = {
            label: 'Connected',
            detail: '3 machines online',
            labels: {} as never,
            services: { status: 'pending' },
            serviceAutostart: null,
            appLockEnabled: false,
            taskParams: {},
        } as const;

        await expect(applyTauriTrayState(state)).resolves.toBeNull();

        expect(invokeTauri).toHaveBeenCalledWith('desktop_set_tray_state', { state });
    });

    it('hands back only a screen the native side can ask for', async () => {
        const { applyTauriTrayState } = await import('./applyTauriTrayState');
        const state = { label: 'x', detail: 'y', labels: {} as never, services: { status: 'pending' }, serviceAutostart: null, appLockEnabled: false, taskParams: {} } as const;

        invokeTauri.mockResolvedValueOnce('settings');
        await expect(applyTauriTrayState(state)).resolves.toBe('settings');
        invokeTauri.mockResolvedValueOnce('elsewhere');
        await expect(applyTauriTrayState(state)).resolves.toBeNull();
    });

    it('hands back the relay a tray row\'s Open picked, by the relay the row names (D11-3)', async () => {
        const { applyTauriTrayState } = await import('./applyTauriTrayState');
        const state = { label: 'x', detail: 'y', labels: {} as never, services: { status: 'pending' }, serviceAutostart: null, appLockEnabled: false, taskParams: {} } as const;

        invokeTauri.mockResolvedValueOnce('relay:https://work.example.com');
        await expect(applyTauriTrayState(state)).resolves.toEqual({ relayUrl: 'https://work.example.com' });
        invokeTauri.mockResolvedValueOnce('relay:');
        await expect(applyTauriTrayState(state)).resolves.toBeNull();
    });
});
