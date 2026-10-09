import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';

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
    it('mounts current-Home presets and one-off rows beside published artifacts without acquiring', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner', currentAccount: true });
        const preset = { id: 'recipe', homeId: 'srv_compute', revision: 2, name: 'Build guest',
            owner: { kind: 'account', accountId: 'owner' }, controller: { machineId: 'host', installationId: 'installation' },
            recipe: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Build guest', choices: { cpu: 2 } } };
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset, { ...preset, id: 'archived', archivedAt: 1 }] } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset } });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const provisioner = { contribution: preset.recipe.provider, occurrenceId: 'occurrence', credentialPurposes: [], descriptor: {
            id: 'vm', title: 'Virtual machine', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: { cpu: { type: 'integer' } }, required: ['cpu'], additionalProperties: false },
            resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
            billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', destroy: 'destroy' },
        } };
        // Only the daemon RPC transport is replaced; the real projected-options
        // owner still validates the declaration, occurrence and returned schema.
        const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: provisioner.contribution.pluginId,
            occurrenceId: 'options-occurrence', title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'],
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
            ['machines.provisioners.options', { choices: [{ id: 'small', title: 'Small', launch: { cpu: 2 } }] }]] as const) {
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
            onSelectMachine={vi.fn()} onSelectScopedMachine={vi.fn()} onSelectManagedMachine={onSelectManagedMachine}
            temporaryComputers={[{ serverId, artifactTarget: 'darwin-arm64', selected: false, workspace: null, onSelect: vi.fn() }]}
            testIdPrefix="mixed-picker" showSearch={false} /></ModalProvider>);
        await vi.dynamicImportSettled();
        await flushHookEffects();
        // The demanded reader must be mounted. This fails directly when the picker
        // has no producer, before waiting for the genuine network result to render.
        expect(harness.requestsFor('/v2/account/settings').length).toBeGreaterThan(0);
        await waitForHomeGovernance(() => expect(screen.findByTestId('mixed-picker-managed-machine:srv_compute:preset:recipe:2')).not.toBeNull());
        expect(screen.findByTestId('mixed-picker-managed-machine:srv_compute:one-off')).not.toBeNull();
        expect(screen.findByTestId('mixed-picker-managed-machine:srv_compute:preset:archived:2')).toBeNull();
        expect(screen.findByTestId(`mixed-picker-temporary-computer:${serverId}:darwin-arm64`)).not.toBeNull();
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(1);
        await act(async () => screen.pressByTestId('mixed-picker-managed-machine:srv_compute:preset:recipe:2'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false));
        expect(onSelectManagedMachine).not.toHaveBeenCalled();
        expect(harness.requests.some(request => request.path.includes('machines.managed.acquire'))).toBe(false);
        await act(async () => screen.pressByTestId('managed-config.use'));
        expect(onSelectManagedMachine).toHaveBeenCalledWith(expect.objectContaining({
            selection: { kind: 'preset', homeId: 'srv_compute', id: 'recipe', revision: 2 }, archiveEffect: 'keep' }));
        await act(async () => screen.pressByTestId('mixed-picker-managed-machine:srv_compute:preset:recipe:2'));
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

    it('withdraws old Account recipe names while replacement Account settings and recipes are pending', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner', currentAccount: true });
        const preset = { id: 'private-recipe', homeId: 'srv_compute', revision: 2, name: 'Old Account private guest',
            owner: { kind: 'account', accountId: 'owner' }, controller: { machineId: 'host', installationId: 'installation' },
            recipe: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: { cpu: 2 } } };
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset] } });
        const { NewSessionMachineSelectionContent } = await import('./NewSessionMachineSelectionContent');
        const screen = await renderScreen(<NewSessionMachineSelectionContent groups={[]} selectedMachine={null}
            selectedServerId={serverId} recentMachines={[]} favoriteMachines={[]}
            onSelectMachine={vi.fn()} onSelectScopedMachine={vi.fn()} onSelectManagedMachine={vi.fn()}
            testIdPrefix="switch-picker" showSearch={false} />);
        await vi.dynamicImportSettled();
        await waitForHomeGovernance(() => expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:preset:private-recipe:2')).not.toBeNull());
        const previousSettingsReads = harness.requestsFor('/v2/account/settings').length;
        const previousPresetReads = harness.requestsFor('/v1/machines/presets/list').length;
        let releaseSettings!: () => void;
        let releasePresets!: () => void;
        const pendingSettings = new Promise<void>(resolve => { releaseSettings = resolve; });
        const pendingPresets = new Promise<void>(resolve => { releasePresets = resolve; });
        const replacement = { ...preset, id: 'replacement-recipe', name: 'New Account guest', owner: { kind: 'account', accountId: 'replacement' } };
        harness.answer(serverId, '/v2/account/settings', { body: { content: null, version: 0 }, respondAfter: pendingSettings });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [replacement] }, respondAfter: pendingPresets });
        try {
            await act(async () => harness.switchAccount(serverId, 'replacement'));
            await waitForHomeGovernance(() => expect(harness.requestsFor('/v2/account/settings').length).toBeGreaterThan(previousSettingsReads));
            expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:preset:private-recipe:2')).toBeNull();
            expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:one-off')).toBeNull();
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(previousPresetReads);
            await act(async () => releaseSettings());
            await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/list').length).toBeGreaterThan(previousPresetReads));
            expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:preset:private-recipe:2')).toBeNull();
            expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:preset:replacement-recipe:2')).toBeNull();
            await act(async () => releasePresets());
            await waitForHomeGovernance(() => expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:preset:replacement-recipe:2')).not.toBeNull());
            expect(screen.findByTestId('switch-picker-managed-machine:srv_compute:preset:private-recipe:2')).toBeNull();
        } finally {
            releaseSettings(); releasePresets(); await screen.unmount();
        }
    });
});
