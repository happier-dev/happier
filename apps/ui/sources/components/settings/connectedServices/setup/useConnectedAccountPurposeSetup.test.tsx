import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { installBundledPluginUiDeclarationsForTests } from '@/dev/testkit/mocks/bundledPluginUiAssets';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/scm-github/src/manifest';
import { GITHUB_TRIAGE_ACTION_IDS_V1 } from '../../../../../../../packages/plugins/scm-github/src/triage/contribution';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_CONNECTED_ACCOUNT_SERVICE } from '../../../../../../../packages/plugins/scm-github/src/observations/githubProviderContracts';
import type { ConnectedAccountPurposeSetupRequest } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';

const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { useConnectedAccountPurposeSetup } = await import('./useConnectedAccountPurposeSetup');
const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
    await import('@/sync/domains/plugins/availability/projection');
const { storage } = await import('@/sync/domains/state/storage');
const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);

afterEach(async () => { await standardCleanup(); clearPluginAccountAvailabilityProjection(); await account.reset(); });

it.each(['plain', 'e2ee'] as const)('admits the GitHub source purpose in its %s Account without a Machine and rejects foreign scope or undeclared purposes', async mode => {
    onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
        packageName: '@happier-dev/plugins-scm-github', displayName: 'GitHub', entriesById: {}, normalizedManifest: manifest }]));
    const scope = await account.restore({ machines: [], ...(mode === 'e2ee' ? { e2eeSecret: new Uint8Array(32).fill(7) } : {}) });
    replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
    const reader = readPluginAccountAvailability(scope);
    const admitted = await reader.ensureCurrentAccountExecution(manifest.id);
    expect(admitted.kind).toBe('available');
    const connected = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service: GITHUB_CONNECTED_ACCOUNT_SERVICE, accountId: 'github-owner' },
        status: 'connected', authenticationModeId: 'pat', revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
        configurationReady: true, configurationRevision: null, displayName: 'Owner', scopes: [] });
    storage.getState().applyProfile({ ...storage.getState().profile, connectedAccountsV4: [connected] });
    let request: ConnectedAccountPurposeSetupRequest = { scope, purpose: {
        consumer: { pluginId: manifest.id, localId: GITHUB_TRIAGE_ACTION_IDS_V1.listInstances }, purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE } };
    const selected = vi.fn();
    const hook = await renderHook(() => useConnectedAccountPurposeSetup({ request, onSelected: selected, onClose() {} }));
    await vi.waitFor(() => expect(hook.getCurrent().unavailableReason).toBeNull());
    expect(hook.getCurrent().declaration).toMatchObject({ consumerKind: 'action', serviceRefs: [GITHUB_CONNECTED_ACCOUNT_SERVICE] });
    expect(hook.getCurrent().registry?.entries.some(entry => entry.service?.pluginId === manifest.id)).toBe(true);
    await act(async () => { expect(await hook.getCurrent().select({ kind: 'account', account: connected.ref })).toEqual(connected.ref); });
    expect(selected).toHaveBeenCalledWith(connected.ref, 'selected');
    expect(rpc.state.requests).toHaveLength(0);
    const ownRequest = request;
    request = { ...ownRequest, scope: { ...scope, accountId: 'another-account' } };
    await hook.rerender();
    expect(hook.getCurrent().unavailableReason).toBe('profile_account_mismatch');
    request = { ...ownRequest, purpose: { ...ownRequest.purpose, purpose: 'undeclared-purpose' } };
    await hook.rerender();
    expect(hook.getCurrent().unavailableReason).toBe('purpose_unavailable');
    request = { ...ownRequest, machineId: 'unavailable-machine' };
    await hook.rerender();
    expect(hook.getCurrent().unavailableReason).toBe('purpose_unavailable');
    request = ownRequest;
    await hook.rerender();
    expect(hook.getCurrent().unavailableReason).toBeNull();
    await hook.unmount();
});
