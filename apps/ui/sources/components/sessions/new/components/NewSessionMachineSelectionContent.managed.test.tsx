import * as React from 'react';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { createManagedControllerMachineFixture as createMachineFixture, createManagedCpuOptionsFixture, createDelegatedManagedPresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

const nativeBoundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(nativeBoundary.rpc);
});

installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetMachineProjectionReadsForTests } = await import('@/sync/ops/machineContributionRegistryProjection');
beforeEach(async () => {
    await harness.reset(); resetScopedHomeActionExecutorsForTests(); nativeBoundary.rpc.mockReset();
    clearDaemonMergedProjectionCacheForTests(); resetMachineProjectionReadsForTests();
});
afterEach(() => standardCleanup());

describe('ordinary managed machine picker demand', () => {
    it('opens a pool-backed preset directly and carries its preset selection without resolving or reading a controller', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner', currentAccount: true });
        const descriptor = { id: 'vm', title: 'Virtual machine', icon: 'server' as const, resourceKind: 'VM' as const,
            schemaVersion: 1, launchSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
            resourceSchema: { type: 'object' as const, properties: {}, additionalProperties: false }, platforms: ['linux' as const], prerequisites: [],
            enrollmentRole: 'sandbox' as const, billing: { location: 'cloud' as const, stoppedBilling: 'billed' as const },
            retention: { supportedIntents: ['delete' as const] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' } };
        const exact = createDelegatedManagedPresetFixture({ preset: { id: 'pooled', homeId: 'srv_compute', revision: 2, name: 'Build guest',
            owner: { kind: 'account', accountId: 'owner' }, controller: { machineId: 'host', installationId: 'installation' },
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Build guest', choices: {} } },
            descriptor, custodianAccountId: 'owner', installationPublicKey: encodeBase64(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey, 'base64url') });
        if (exact.delegatedAcquire?.kind !== 'ready') throw new Error('Expected public review');
        const preset = ManagedMachinePresetV1Schema.parse({ ...exact, controller: undefined,
            controllerPoolId: '6be84651-2df7-4125-aac4-0d093217b198', delegatedAcquire: { ...exact.delegatedAcquire,
                controller: undefined, reviewedFacts: { ...exact.delegatedAcquire.reviewedFacts, controller: undefined } } });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset] } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset } });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applyMachines([], true, { sourceServerId: serverId, sourceAccountId: 'owner' });
        storage.getState().markMachineListSettled(serverId);
        const onSelectManagedMachine = vi.fn();
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const { ModalProvider } = await import('@/modal');
        const screen = await renderScreen(<ModalProvider><NewSessionMachineSelectionContent groups={[]} selectedMachine={null}
            selectedServerId={serverId} recentMachines={[]} favoriteMachines={[]} onSelectMachine={vi.fn()}
            onSelectScopedMachine={vi.fn()} onSelectManagedMachine={onSelectManagedMachine} testIdPrefix="pool-picker" showSearch={false} /></ModalProvider>);
        await waitForHomeGovernance(() => expect(screen.findByTestId('pool-picker-managed-machine:srv_compute:preset:pooled:2')).not.toBeNull());
        await act(async () => screen.pressByTestId('pool-picker-managed-machine:srv_compute:preset:pooled:2'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false));
        // The reviewed preset fixes its choices: the review never claims there are none beside an enabled Use.
        const { t } = await import('@/text');
        expect(screen.getTextContent()).not.toContain(t('managedMachines.options.empty', { provider: 'Virtual machine' }));
        await act(async () => screen.pressByTestId('managed-config.use'));
        expect(onSelectManagedMachine.mock.calls[0]?.[0]).toMatchObject({ selection: { kind: 'preset', homeId: 'srv_compute', id: 'pooled', revision: 2 } });
        expect(onSelectManagedMachine.mock.calls[0]?.[0].receipt.controller).toBeUndefined();
        expect(harness.requests.filter(request => request.path.includes('machines.provisioners') || request.path.includes('pools/resolve')
            || request.path.includes('pools/list') || request.path.includes('machines.managed.acquire'))).toHaveLength(0);
        expect(nativeBoundary.rpc).not.toHaveBeenCalled();
        await screen.unmount();
    });
    it('mounts current-Home presets and one-off rows beside published artifacts without acquiring', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner', currentAccount: true });
        const preset = { id: 'launch', homeId: 'srv_compute', revision: 2, name: 'Build guest',
            owner: { kind: 'account', accountId: 'owner' }, controller: { machineId: 'host', installationId: 'installation' },
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Build guest', choices: { cpu: 2 } } };
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset, { ...preset, id: 'archived', archivedAt: 1 }] } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset } });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: { serverId, accountId: 'owner' } });
        storage.getState().applyMachines([createMachineFixture({ id: 'host', installationId: 'installation' })], true,
            { sourceServerId: serverId, sourceAccountId: 'owner' });
        storage.getState().markMachineListSettled(serverId);
        const provisioner: MachineProvisionersListResultV1['provisioners'][number] = {
            contribution: preset.launch.provider, occurrenceId: 'occurrence', credentialPurposes: [], acquireExecutionTarget: 'daemon', descriptor: {
            id: 'vm', title: 'Virtual machine', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: { cpu: { type: 'integer' } }, required: ['cpu'], additionalProperties: false },
            resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
            billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
        } };
        // Only the daemon RPC transport is replaced; the real projected-options
        // owner still validates the declaration, occurrence and returned schema.
        const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: provisioner.contribution.pluginId,
            occurrenceId: provisioner.occurrenceId, title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'],
            execution: { target: 'daemon' }, available: true, dangerLevel: 'safe' });
        const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
            installedPackagesById: { [action.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: action.pluginId } },
            actionsById: { [buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.id })]: action },
        } });
        nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? projection : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
                ? { ok: true, inputSchema: { type: 'object', properties: {}, additionalProperties: false } } : { ok: false, code: 'unsupported' });
        for (const [actionId, result] of [['machines.provisioners.list', { controller: preset.controller, provisioners: [provisioner] }],
            ['machines.provisioners.check', { available: true }],
            ['machines.provisioners.options', createManagedCpuOptionsFixture([{ id: 'small', title: 'Small', cpu: 2 }])]] as const) {
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        }
        const onSelectManagedMachine = vi.fn();
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const { ModalProvider, Modal } = await import('@/modal');
        const screen = await renderScreen(<ModalProvider><NewSessionMachineSelectionContent groups={[]} selectedMachine={null}
            selectedServerId={serverId} recentMachines={[]} favoriteMachines={[]}
            managedPlacementPreset={{ kind: 'preset', homeId: 'srv_compute', presetId: 'launch' }}
            onSelectMachine={vi.fn()} onSelectScopedMachine={vi.fn()} onSelectManagedMachine={onSelectManagedMachine}
            temporaryComputers={[{ serverId, artifactTarget: 'darwin-arm64', selected: false, workspace: null, onSelect: vi.fn() }]}
            testIdPrefix="mixed-picker" showSearch={false} /></ModalProvider>);
        await vi.dynamicImportSettled();
        await flushHookEffects();
        // The demanded reader must be mounted. This fails directly when the picker
        // has no producer, before waiting for the genuine network result to render.
        expect(harness.requestsFor('/v2/account/settings').length).toBeGreaterThan(0);
        await waitForHomeGovernance(() => expect(screen.findByTestId('mixed-picker-managed-machine:srv_compute:preset:launch:2')).not.toBeNull());
        expect(screen.findByTestId('mixed-picker-managed-machine:srv_compute:preset:launch:2')?.props.accessibilityState).toMatchObject({ selected: true });
        expect(screen.findByTestId('mixed-picker-managed-machine:srv_compute:one-off')).not.toBeNull();
        expect(screen.findByTestId('mixed-picker-managed-machine:srv_compute:preset:archived:2')).toBeNull();
        expect(screen.findByTestId(`mixed-picker-temporary-computer:${serverId}:darwin-arm64`)).not.toBeNull();
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(1);
        await act(async () => screen.pressByTestId('mixed-picker-managed-machine:srv_compute:preset:launch:2'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled,
            JSON.stringify({ catalog: screen.findByTestId('managed-config.catalog')?.props.diagnosticCode,
                error: screen.findByTestId('managed-config.error')?.props.diagnosticCode,
                requests: harness.requests.map(request => request.path) })).toBe(false));
        expect(onSelectManagedMachine).not.toHaveBeenCalled();
        expect(harness.requests.some(request => request.path.includes('machines.managed.acquire'))).toBe(false);
        await act(async () => screen.pressByTestId('managed-config.use'));
        expect(onSelectManagedMachine.mock.calls[0]?.[0]).toMatchObject({
            selection: { kind: 'preset', homeId: 'srv_compute', id: 'launch', revision: 2 }, archiveEffect: 'keep' });
        await act(async () => screen.pressByTestId('mixed-picker-managed-machine:srv_compute:preset:launch:2'));
        await act(async () => Modal.hideAll());
        expect(onSelectManagedMachine).toHaveBeenCalledOnce();
        expect(harness.requests.some(request => request.path.includes('machines.managed.acquire'))).toBe(false);
        await screen.unmount();
    });

    it('hides new-machine offers when the acquiring Account disables creation', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: false } }, version: 1 } });
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const screen = await renderScreen(<NewSessionMachineSelectionContent groups={[]} selectedMachine={null}
            selectedServerId={serverId} recentMachines={[]} favoriteMachines={[]}
            onSelectMachine={vi.fn()} onSelectScopedMachine={vi.fn()} onSelectManagedMachine={vi.fn()}
            testIdPrefix="mixed-picker" showSearch={false} />);
        await vi.dynamicImportSettled();
        await flushHookEffects();
        expect(harness.requestsFor('/v2/account/settings').length).toBeGreaterThan(0);
        expect(screen.findByTestId('mixed-picker-managed-machine:srv_compute:one-off')).toBeNull();
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(0);
        await screen.unmount();
    });

    it('withdraws old Account launch names while replacement Account settings and launchs are pending', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner', currentAccount: true });
        const preset = { id: 'private-launch', homeId: 'srv_compute', revision: 2, name: 'Old Account private guest',
            owner: { kind: 'account', accountId: 'owner' }, controller: { machineId: 'host', installationId: 'installation' },
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: { cpu: 2 } } };
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset] } });
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const screen = await renderScreen(<NewSessionMachineSelectionContent groups={[]} selectedMachine={null}
            selectedServerId={serverId} recentMachines={[]} favoriteMachines={[]}
            onSelectMachine={vi.fn()} onSelectScopedMachine={vi.fn()} onSelectManagedMachine={vi.fn()}
            testIdPrefix="switch-picker" showSearch={false} />);
        await vi.dynamicImportSettled();
        await waitForHomeGovernance(() => expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:preset:private-launch:2')).not.toBeNull());
        const previousSettingsReads = harness.requestsFor('/v2/account/settings').length;
        const previousPresetReads = harness.requestsFor('/v1/machines/presets/list').length;
        let releaseSettings!: () => void;
        let releasePresets!: () => void;
        const pendingSettings = new Promise<void>(resolve => { releaseSettings = resolve; });
        const pendingPresets = new Promise<void>(resolve => { releasePresets = resolve; });
        const replacement = { ...preset, id: 'replacement-launch', name: 'New Account guest', owner: { kind: 'account', accountId: 'replacement' } };
        harness.answer(serverId, '/v2/account/settings', { body: { content: null, version: 0 }, respondAfter: pendingSettings });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [replacement] }, respondAfter: pendingPresets });
        try {
            await act(async () => harness.switchAccount(serverId, 'replacement'));
            await waitForHomeGovernance(() => expect(harness.requestsFor('/v2/account/settings').length).toBeGreaterThan(previousSettingsReads));
            expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:preset:private-launch:2')).toBeNull();
            expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:one-off')).toBeNull();
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(previousPresetReads);
            await act(async () => releaseSettings());
            await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/list').length).toBeGreaterThan(previousPresetReads));
            expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:preset:private-launch:2')).toBeNull();
            expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:preset:replacement-launch:2')).toBeNull();
            await act(async () => releasePresets());
            await waitForHomeGovernance(() => expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:preset:replacement-launch:2')).not.toBeNull());
            expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:preset:private-launch:2')).toBeNull();
        } finally {
            releaseSettings(); releasePresets(); await screen.unmount();
        }
    });
});
