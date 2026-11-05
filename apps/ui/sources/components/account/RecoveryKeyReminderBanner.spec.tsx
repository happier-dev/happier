import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

import { createRootLayoutFeaturesResponse, renderScreen, standardCleanup } from '@/dev/testkit';
import { installAccountCommonModuleMocks } from './accountTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Platform/UI boundaries only; the hook, Item rows, auth host, device storage, feature client and
// HTTP client stay real below the network port.
const modal = vi.hoisted(() => ({ show: vi.fn() }));
installAccountCommonModuleMocks({
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { show: modal.show } }).module,
});

const legacyCredentials = { token: 'test-token', secret: Buffer.alloc(32, 7).toString('base64') };

/**
 * The reminder keeps one launch-wide state in its module (useRecoveryKeyReminder.ts) and reads the
 * device and server caches once, at its first render. A scenario that needs a fresh launch therefore
 * loads the real module graph again after `vi.resetModules()`; nothing is replaced.
 */
async function loadLaunchModules() {
    return {
        ...await import('@/utils/system/runtimeFetch'),
        ...await import('@/sync/domains/server/serverRuntime'),
        ...await import('@/sync/api/capabilities/serverFeaturesClient'),
        ...await import('@/auth/storage/tokenStorage'),
        ...await import('@/auth/context/AuthContext'),
        ...await import('./SecretKeyBackupModal'),
        ...await import('./RecoveryKeyReminderBanner'),
    };
}

// The first launch's graph loads during collection; a later fresh launch reuses its transforms.
const firstLaunchModules = await loadLaunchModules();

async function startLaunch(modules: typeof firstLaunchModules, serverUrl: string) {
    const {
        setRuntimeFetch, upsertServerProfileOnly, setActiveServer, getServerFeaturesSnapshot, TokenStorage,
        InjectedAuthProvider, SecretKeyBackupModal, RecoveryKeyReminderBanner,
    } = modules;
    const home = await upsertServerProfileOnly({ serverUrl, name: 'Reminder Home' });
    await setActiveServer({ serverId: home.id });
    await TokenStorage.setRecoveryKeyReminderDismissed(false);
    const banner = <InjectedAuthProvider credentials={legacyCredentials}><RecoveryKeyReminderBanner /></InjectedAuthProvider>;
    return { setRuntimeFetch, getServerFeaturesSnapshot, TokenStorage, SecretKeyBackupModal, banner };
}

afterEach(async () => {
    modal.show.mockReset();
    await standardCleanup();
    const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    resetRuntimeFetch();
});

describe('RecoveryKeyReminderBanner', () => {
    it('renders from cached visibility at first paint, opens the backup, and dismisses outside the row', async () => {
        const launch = await startLaunch(firstLaunchModules, 'https://reminder-cached.test');
        launch.setRuntimeFetch(async (url) => new URL(String(url)).pathname === '/v1/features'
            ? Response.json(createRootLayoutFeaturesResponse())
            : Response.json({ error: 'not_found' }, { status: 404 }));
        // The server's answer and the device's stored choice are already cached for this launch.
        await launch.getServerFeaturesSnapshot({ force: true });

        // A synchronous commit runs effects but no promise continuation, so the launch's async read
        // has not settled: only the cached first read can make the banner visible here.
        let firstPaint: renderer.ReactTestRenderer | undefined;
        act(() => { firstPaint = renderer.create(launch.banner); });
        expect(firstPaint?.root.findAll((node) => typeof node.type === 'string' && node.props.testID === 'recovery-key-reminder')).toHaveLength(1);
        act(() => { firstPaint?.unmount(); });

        const screen = await renderScreen(launch.banner);
        await screen.pressByTestIdAsync('recovery-key-reminder');
        expect(modal.show).toHaveBeenCalledWith(expect.objectContaining({
            component: launch.SecretKeyBackupModal,
            props: expect.objectContaining({ secret: legacyCredentials.secret }),
        }));

        const row = screen.findHostByTestId('recovery-key-reminder');
        const dismiss = screen.findHostByTestId('recovery-key-reminder-dismiss');
        // One line above the list: the backup it opens does the explaining.
        expect(screen.findByTestId('recovery-key-reminder')?.props.subtitle).toBeUndefined();
        let ancestor = dismiss?.parent ?? null;
        while (ancestor && ancestor !== row) ancestor = ancestor.parent;
        expect(ancestor).toBeNull();

        const stopPropagation = vi.fn();
        await act(async () => { await dismiss?.props.onPress({ stopPropagation }); });
        expect(stopPropagation).toHaveBeenCalled();
        expect(screen.findHostByTestId('recovery-key-reminder')).toBeNull();
        expect(await launch.TokenStorage.getRecoveryKeyReminderDismissed()).toBe(true);
    });

    it('stays hidden when the server features cannot be fetched', async () => {
        vi.resetModules();
        const launch = await startLaunch(await loadLaunchModules(), 'https://reminder-features-down.test');
        let featureRequests = 0;
        launch.setRuntimeFetch(async (url) => {
            if (new URL(String(url)).pathname !== '/v1/features') return Response.json({ error: 'not_found' }, { status: 404 });
            featureRequests += 1;
            return Response.json({ error: 'unavailable' }, { status: 503 });
        });

        const screen = await renderScreen(launch.banner);
        // Settle the launch's own feature read before judging visibility.
        await act(async () => { await launch.getServerFeaturesSnapshot(); });

        expect(featureRequests).toBeGreaterThan(0);
        expect(screen.findHostByTestId('recovery-key-reminder')).toBeNull();
        expect(await launch.TokenStorage.getRecoveryKeyReminderDismissed()).toBe(false);
        expect(modal.show).not.toHaveBeenCalled();
    });
});
