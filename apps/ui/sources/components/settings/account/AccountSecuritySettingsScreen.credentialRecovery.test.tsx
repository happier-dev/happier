import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const routerPush = vi.hoisted(() => vi.fn());
installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        params: {}, router: { push: routerPush },
    }).module,
});
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]),
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: Object.freeze([]),
}));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { AccountSecuritySettingsScreen } = await import('./AccountSecuritySettingsScreen');

beforeEach(() => installHomeGovernanceBoundaries(harness));
afterEach(async () => { standardCleanup(); await harness.reset(); routerPush.mockReset(); });

it('settles an absent credential through the real scope resolver and exposes Home recovery', async () => {
    await harness.addHome({ name: 'Personal Home', serverUrl: 'https://security-recovery.example.test', accountId: null });
    const screen = await renderScreen(
        <InjectedAuthProvider credentials={null}><AccountSecuritySettingsScreen /></InjectedAuthProvider>,
    );
    await vi.waitFor(() => expect(screen.findByTestId('settings-account-security-signed-out')).not.toBeNull());
    expect(screen.findByTestId('settings-account-security-home-switching')).toBeNull();
    // No authenticated Security reader is allowed to run after the resolver
    // settles absence. The shared presenter opens the Home step of setup.
    expect(harness.requestsFor('/v1/account/security')).toHaveLength(0);
    await screen.pressByTestIdAsync('settings-account-security-signed-out-action');
    expect(routerPush).toHaveBeenCalledWith('/?step=home');
});

it('keeps unreadable device credentials distinct from sign-out and retries through the scope owner', async () => {
    await harness.addHome({ name: 'Personal Home', serverUrl: 'https://security-unreadable.example.test', accountId: null });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl')
        .mockRejectedValueOnce(new Error('secure_storage_unavailable'));
    try {
        const screen = await renderScreen(
            <InjectedAuthProvider credentials={null}><AccountSecuritySettingsScreen /></InjectedAuthProvider>,
        );
        await vi.waitFor(() => expect(screen.findByTestId('settings-account-security-home-unavailable')).not.toBeNull());
        expect(screen.findByTestId('settings-account-security-signed-out')).toBeNull();
        await screen.pressByTestIdAsync('settings-account-security-home-unavailable-action');
        await vi.waitFor(() => expect(screen.findByTestId('settings-account-security-signed-out')).not.toBeNull());
        expect(routerPush).not.toHaveBeenCalled();
    } finally {
        credentialRead.mockRestore();
    }
});
