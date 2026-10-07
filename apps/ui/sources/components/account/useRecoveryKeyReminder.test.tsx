import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createRootLayoutFeaturesResponse, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { setActiveServer, upsertServerProfileOnly } from '@/sync/domains/server/serverRuntime';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { useRecoveryKeyReminder } from './useRecoveryKeyReminder';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

afterEach(() => {
    standardCleanup();
    resetRuntimeFetch();
});

describe('useRecoveryKeyReminder', () => {
    it('offers only a real legacy sign-in key, shares completion, and lets a hub carry the reminder', async () => {
        setRuntimeFetch(async (url) => new URL(String(url)).pathname === '/v1/features'
            ? Response.json(createRootLayoutFeaturesResponse())
            : Response.json({ error: 'not_found' }, { status: 404 }));
        const home = await upsertServerProfileOnly({ serverUrl: 'https://recovery-reminder.test', name: 'Test Home' });
        await setActiveServer({ serverId: home.id });
        // Real device-local persistence and credential classification run below the injected host.
        await TokenStorage.setRecoveryKeyReminderDismissed(false);
        const legacyCredentials = { token: 'test-token', secret: Buffer.alloc(32, 7).toString('base64') } satisfies AuthCredentials;
        let credentials: AuthCredentials = { token: legacyCredentials.token };
        function AccountShell({ children }: React.PropsWithChildren) {
            return <InjectedAuthProvider credentials={credentials}>{children}</InjectedAuthProvider>;
        }
        const banner = await renderHook(() => useRecoveryKeyReminder({ surface: 'banner' }), { wrapper: AccountShell });
        await flushHookEffects({ cycles: 3 });
        expect(banner.getCurrent()).toMatchObject({ needed: false, step: null, secret: null });

        credentials = legacyCredentials;
        await banner.rerender();
        expect(banner.getCurrent()).toMatchObject({ needed: true, step: 'pending', secret: legacyCredentials.secret });

        const tile = await renderHook(() => useRecoveryKeyReminder({ surface: 'hubTile' }), { wrapper: AccountShell });
        expect(tile.getCurrent().needed).toBe(true);
        expect(banner.getCurrent().needed).toBe(false);

        await tile.unmount();
        expect(banner.getCurrent().needed).toBe(true);

        const status = await renderHook(() => useRecoveryKeyReminder(), { wrapper: AccountShell });
        await act(async () => { await status.getCurrent().markSaved(); });
        expect(banner.getCurrent()).toMatchObject({ needed: false, step: 'done', secret: null });
        expect(status.getCurrent()).toMatchObject({ needed: false, step: 'done', secret: null });
        expect(await TokenStorage.getRecoveryKeyReminderDismissed()).toBe(true);

        // Dismissing an already handled key preserves the same shared completion and persistence.
        await act(async () => { await banner.getCurrent().dismiss(); });
        expect(status.getCurrent().step).toBe('done');
        expect(await TokenStorage.getRecoveryKeyReminderDismissed()).toBe(true);
    });
});
