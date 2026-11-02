import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

// Presentation and native secure storage are boundaries; profiles, settings, selection and auth stay real.
const confirm = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm } }).module;
});
vi.mock('expo-secure-store', () => ({
    getItemAsync: async () => null,
    setItemAsync: async () => {},
    deleteItemAsync: async () => {},
}));

afterEach(() => {
    confirm.mockReset();
    vi.unstubAllEnvs();
});

async function renderController() {
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_NATIVE_SECURE_STORE_DEV_FALLBACK', 'false');
    vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `server-reset-${Date.now()}-${Math.random()}`);
    vi.stubEnv('EXPO_PUBLIC_HAPPY_PRECONFIGURED_SERVERS', JSON.stringify([
        { name: 'Cloud', url: 'https://api.happier.dev' },
    ]));
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const { AuthProvider } = await import('@/auth/context/AuthContext');
    const { useServerSettingsScreenController } = await import('./useServerSettingsScreenController');
    const ref: { current: ReturnType<typeof useServerSettingsScreenController> | null } = { current: null };
    function Probe() {
        ref.current = useServerSettingsScreenController();
        return null;
    }
    await renderScreen(<AuthProvider initialCredentials={null}><Probe /></AuthProvider>);
    return { profiles, ref };
}

describe('server settings reset availability', () => {
    it('does not prompt or clear the form when no reset target remains', async () => {
        const { profiles, ref } = await renderController();
        await act(async () => {
            ref.current?.onChangeUrl('https://new.example.test');
            ref.current?.onChangeName('My relay');
        });
        for (const profile of profiles.listServerProfiles()) profiles.removeServerProfile(profile.id);

        await act(async () => { await ref.current?.onResetServer(); });

        expect(confirm).not.toHaveBeenCalled();
        expect(profiles.listServerProfiles()).toEqual([]);
        expect(ref.current?.inputUrl).toBe('https://new.example.test');
        expect(ref.current?.inputName).toBe('My relay');
    });

    it('preserves the form when the last reset target is removed while confirmation is open', async () => {
        const { profiles, ref } = await renderController();
        expect(ref.current?.canResetServer).toBe(true);
        let resolveConfirmation: (value: boolean) => void = () => { throw new Error('confirmation not opened'); };
        confirm.mockImplementation(() => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; }));
        await act(async () => {
            ref.current?.onChangeUrl('https://new.example.test');
            ref.current?.onChangeName('My relay');
        });

        let reset: Promise<void> | undefined;
        await act(async () => { reset = ref.current?.onResetServer(); });
        expect(confirm).toHaveBeenCalled();
        for (const profile of profiles.listServerProfiles()) profiles.removeServerProfile(profile.id);
        await act(async () => {
            resolveConfirmation(true);
            await reset;
        });

        expect(profiles.listServerProfiles()).toEqual([]);
        expect(profiles.getActiveServerUrl()).toBe('');
        expect(ref.current?.inputUrl).toBe('https://new.example.test');
        expect(ref.current?.inputName).toBe('My relay');
    });
});
