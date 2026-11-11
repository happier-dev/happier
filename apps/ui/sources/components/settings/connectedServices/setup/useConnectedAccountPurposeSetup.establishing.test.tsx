import { afterEach, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import type { ConnectedAccountPurposeSetupRequest } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';

const machineRuntime = {
    pluginUiProjection: null,
    pluginBrowserProjection: null,
    phase: 'establishing' as const,
    unavailableReasonCode: undefined,
    interactionEnabled: false,
    machineId: 'machine-1',
    serverId: 'server-1',
    platform: 'web' as const,
    accountLifetime: null,
    connectedAccountProjection: null,
    installedPackagesProjection: null,
};

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => machineRuntime,
}));

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { useConnectedAccountPurposeSetup } = await import('./useConnectedAccountPurposeSetup');

afterEach(async () => {
    await standardCleanup();
    await account.reset();
});

it('does not classify an establishing machine projection as an unavailable purpose', async () => {
    const scope = await account.restore({ machines: [], currentAccount: true });
    const request: ConnectedAccountPurposeSetupRequest = {
        scope,
        machineId: 'machine-1',
        purpose: { consumer: { pluginId: 'happier.machine.cua', localId: 'byoc' }, purpose: 'cloud-account' },
    };
    const hook = await renderHook(() => useConnectedAccountPurposeSetup({ request, onClose() {} }));

    expect(hook.getCurrent().loading).toBe(true);
    expect(hook.getCurrent().unavailableReason).toBeNull();
    await hook.unmount();
});
