import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { PluginPortableReleaseManifestV1Schema } from '@happier-dev/protocol/plugins/availability';
import { resolvePluginActionConnectedAccountUseRequestsV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contributionKey';
import { projectConnectedAccountDescriptorV1 } from '@happier-dev/protocol/connect/connectedAccountUiProjectionV1';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { PLUGIN_MANIFEST } from '../../../../../../../packages/plugins/machine-cua/src/manifest';
import type { ConnectedAccountPurposeSetupRequest } from '@/sync/domains/connectedServices/connectedAccountPurposeSetup';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { useConnectedAccountPurposeSetup } = await import('./useConnectedAccountPurposeSetup');
const { storage } = await import('@/sync/domains/state/storage');

afterEach(async () => {
    await standardCleanup();
    await account.reset();
    rpc.reset();
});

it('keeps a pending Cua purpose loading until its Machine declaration makes the account selectable', async () => {
    rpc.reset();
    const manifest = PluginPortableReleaseManifestV1Schema.parse(PLUGIN_MANIFEST);
    const provisioner = manifest.contributes.machineProvisioners.find(entry => entry.id === 'byoc');
    if (!provisioner) throw new Error('Expected the Cua BYOC declaration');
    const connectedAccountPurposes = resolvePluginActionConnectedAccountUseRequestsV2(manifest, provisioner.actions.acquire)
        ?.map(({ request }) => ({ purpose: request.id, serviceRefs: request.scope.serviceRefs.map(reference =>
            qualifyPluginContributionReferenceV1(reference, manifest.id)) }));
    const response = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
        projection: { v: 2, generation: 1,
            installedPackagesById: { [manifest.id]: { id: manifest.id, displayName: manifest.displayName,
                version: manifest.version, enabled: true, source: { kind: 'bundled', locator: manifest.id } } },
            familiesById: {
                machineProvisioners: { family: 'machineProvisioners', entriesById: {
                    [`${manifest.id}/${provisioner.id}`]: { id: `${manifest.id}/${provisioner.id}`, pluginId: manifest.id,
                        pluginVersion: manifest.version, definition: provisioner, connectedAccountPurposes },
                } },
                connectedAccounts: { family: 'connectedAccounts', entriesById: Object.fromEntries(
                    manifest.contributes.connectedAccountDescriptors.map(descriptor => [`${manifest.id}/${descriptor.id}`,
                        projectConnectedAccountDescriptorV1({ descriptor, pluginId: manifest.id, serviceId: descriptor.id,
                            provenance: 'first_party', sourceKind: 'bundled',
                            availability: { state: 'available', reason: 'available' }, diagnostics: [] })])),
                },
            },
        },
    });
    // Hold only the daemon transport; projection admission and purpose resolution stay real.
    const projection = createDeferred<typeof response>();
    rpc.intercept(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, () => projection.promise);
    const scope = await account.restore({ currentAccount: true });
    // The app boot binds endpoint connectivity; this hook fixture supplies that transport fact.
    storage.setState({ endpointStatus: 'online' });
    const request: ConnectedAccountPurposeSetupRequest = { scope, machineId: rpc.state.machines[0]!.id,
        purpose: { consumer: { pluginId: manifest.id, localId: provisioner.id }, purpose: 'cloud-account' } };
    const service = { pluginId: manifest.id, localId: 'cloud-native' };
    const connected = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'cua-cloud' },
        status: 'connected', authenticationModeId: 'native', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationReady: true,
        configurationRevision: null, displayName: 'Cloud', scopes: [] });
    storage.getState().applyProfile({ ...storage.getState().profile, connectedAccountsV4: [connected] });
    const selected = vi.fn();
    const hook = await renderHook(() => useConnectedAccountPurposeSetup({ request, onSelected: selected, onClose() {} }));
    try {
        await vi.waitFor(() => expect(rpc.state.requests.some(request =>
            request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)).toBe(true));
        expect(hook.getCurrent().loading).toBe(true);
        expect(hook.getCurrent().unavailableReason).toBeNull();
        expect(hook.getCurrent().selectableServices).toEqual([]);

        await act(async () => { projection.resolve(response); });
        await vi.waitFor(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().unavailableReason).toBeNull();
        expect(hook.getCurrent().declaration).toMatchObject({ consumerKind: 'machineProvisioner', serviceRefs: [service] });
        expect(hook.getCurrent().selectableServices).toEqual([service]);
        expect(hook.getCurrent().selectionDisabled).toBe(false);
        expect(hook.getCurrent().registry).toMatchObject({ status: 'ready' });
        await act(async () => {
            expect(await hook.getCurrent().select({ kind: 'account', account: connected.ref })).toEqual(connected.ref);
        });
        expect(selected).toHaveBeenCalledWith(connected.ref, 'selected', undefined);
    } finally {
        projection.resolve(response);
        await hook.unmount();
    }
});
