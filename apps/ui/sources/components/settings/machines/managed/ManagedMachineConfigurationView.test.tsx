import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderHook, renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { findAllHostTestInstances } from '@/dev/testkit/render/renderScreen';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { Dimensions } from 'react-native';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

const route = vi.hoisted(() => ({ replace: vi.fn() }));
const nativeBoundary = vi.hoisted(() => ({ rpc: vi.fn() }));
let restoreViewport: (() => void) | undefined;
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(nativeBoundary.rpc);
});
installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: route }).module });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetMachineProjectionReadsForTests } = await import('@/sync/ops/machineContributionRegistryProjection');
const { PLUGIN_MANIFEST: modalManifest } = await import('../../../../../../../packages/plugins/machine-modal/src/manifest');
const { ModalLaunchV1Schema } = await import('../../../../../../../packages/plugins/machine-modal/src/machine/schemas');
beforeEach(async () => {
    await harness.reset(); resetScopedHomeActionExecutorsForTests(); route.replace.mockReset(); nativeBoundary.rpc.mockReset();
    clearDaemonMergedProjectionCacheForTests(); resetMachineProjectionReadsForTests();
    const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: provisioner.contribution.pluginId, occurrenceId: 'options-occurrence',
        title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'], execution: { target: 'daemon' }, available: true, dangerLevel: 'safe' });
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
        installedPackagesById: { [action.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: action.pluginId } },
        actionsById: { [buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.id })]: action },
    } });
    nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
        ? projection : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ ? { ok: true, inputSchema: { type: 'object', properties: {}, additionalProperties: false } } : { ok: false, code: 'unsupported' });
});
afterEach(() => { standardCleanup(); restoreViewport?.(); restoreViewport = undefined; });
const defaultController = { machineId: 'host', installationId: 'installation' };
const provisioner: MachineProvisionersListResultV1['provisioners'][number] = {
    contribution: { pluginId: 'custom.compute', localId: 'vm' }, occurrenceId: 'occurrence', acquireExecutionTarget: 'daemon' as const, credentialPurposes: [], descriptor: {
    id: 'vm', title: 'Virtual machine', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
    launchSchema: { type: 'object', properties: { cpu: { type: 'integer', minimum: 1 } }, required: ['cpu'], additionalProperties: false },
    resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
    billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
    actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
} };

describe('mounted managed configurator', () => {
    it('keeps an in-flight options schema read through the merged projection reload for the same Action occurrence', async () => {
        const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: provisioner.contribution.pluginId,
            occurrenceId: 'options-occurrence', title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'],
            execution: { target: 'daemon' }, available: true, dangerLevel: 'safe' });
        const projection = { ...EMPTY_PLUGIN_UI_PROJECTION,
            actionsById: { [buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.id })]: action } };
        const binding = {
            serverId: 'server-a', accountId: 'owner', revision: 1, scope: { serverId: 'server-a', accountId: 'owner' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }),
        } satisfies ServerCredentialAccountScopeBinding;
        const signals: AbortSignal[] = [];
        nativeBoundary.rpc.mockImplementation(async (request: { method: string; signal?: AbortSignal }) => {
            if (request.method !== RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: false, code: 'unsupported' };
            if (request.signal) signals.push(request.signal);
            return await new Promise(() => {});
        });
        const { useManagedProvisionerOptionsInput } = await import('./useManagedProvisionerOptionsInput');
        const hook = await renderHook(({ projectionReady }: { projectionReady: boolean }) => useManagedProvisionerOptionsInput({
            binding, controller: defaultController, provisioner, projection, projectionReady,
        }), { initialProps: { projectionReady: true } });
        expect(signals).toHaveLength(1);
        await hook.rerender({ projectionReady: false });
        expect(signals[0]?.aborted).toBe(false);
        await hook.unmount();
    });
    it('says why an unavailable provisioner cannot create here in the check\u2019s own words, with its next step', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://unavailable-check.example',
            serverIdentityId: 'srv_unavailable_check', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const local = { ...provisioner, descriptor: { ...provisioner.descriptor, billing: { location: 'local', stoppedBilling: 'not-billed' } } };
        const status = { key: 'custom.compute.status.notInstalled', fallback: 'Not installed \u00b7 install the tool' };
        for (const [actionId, result] of [['machines.provisioners.list', { controller: defaultController, provisioners: [local] }],
            ['machines.provisioners.check', { available: false, code: 'tool_unavailable', status }], ['machines.provisioners.options', { choices: [] }]] as const)
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(local.contribution)} initialController={defaultController} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.unavailable')).not.toBeNull());
        expect(screen.getTextContent()).toContain(status.fallback);
        await screen.unmount();
    });
    it('reads as loading, not as a verdict, while a named controller waits for the machine list to sync', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://unsynced-list.example',
            serverIdentityId: 'srv_unsynced_list', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />);
        await flushHookEffects();
        const catalogState = () => screen.tree.findAll(node => node.props.testID === 'managed-config.catalog').map(node => node.props.kind);
        expect(catalogState()).toContain('loading');
        expect(catalogState()).not.toContain('empty');
        // Once the Home's list has really synced without the named controller, the empty verdict is true.
        await act(async () => {
            storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'idle' } });
        });
        await flushHookEffects();
        expect(catalogState()).toContain('empty');
        await screen.unmount();
    });
    it('names the controller it could not read and offers Retry when the catalog read fails, instead of a bare refusal', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://unreadable-controller.example',
            serverIdentityId: 'srv_unreadable_controller', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { status: 503, body: { code: 'service_unavailable' } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />);
        const errorCards = () => screen.tree.findAll(node => node.props.testID === 'managed-config.catalog' && node.props.kind === 'error');
        await waitForHomeGovernance(() => expect(errorCards().length).toBeGreaterThan(0));
        expect(errorCards()[0]!.props.action?.label).toBeTruthy();
        expect(String(errorCards()[0]!.props.title)).toContain('tester.local');
        await screen.unmount();
    });
    it('refuses a schema-less options Action without probing native options or losing the configurator', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://missing-options-schema.example',
            serverIdentityId: 'srv_missing_options_schema', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const read = nativeBoundary.rpc.getMockImplementation();
        nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
            ? { ok: true } : read?.(request));
        for (const [actionId, result] of [['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
            ['machines.provisioners.check', { available: true }]] as const)
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.error')).not.toBeNull());
        expect(nativeBoundary.rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: defaultController.machineId,
            method: RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ, payload: { machineId: defaultController.machineId,
                expectedOccurrenceId: 'options-occurrence',
                qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: provisioner.contribution.pluginId, localId: 'options' }) } }));
        expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
        expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toEqual([]);
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
        await screen.unmount();
    });
    it('settles an options schema read that never answers at the RPC deadline, then reads again from the same error card', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://silent-options-schema.example',
            serverIdentityId: 'srv_silent_options_schema', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const read = nativeBoundary.rpc.getMockImplementation();
        let schemaReads = 0;
        const schemaReadSignals: AbortSignal[] = [];
        // The daemon takes the schema request and never answers it (a host under load).
        nativeBoundary.rpc.mockImplementation(async (request: { method: string; signal?: AbortSignal }) => {
            if (request.method !== RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return read?.(request);
            schemaReads++;
            if (request.signal) schemaReadSignals.push(request.signal);
            return new Promise(() => {});
        });
        let checks = 0;
        for (const [actionId, result] of [['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
            ['machines.provisioners.check', { available: true }], ['machines.provisioners.options', { choices: [] }]] as const)
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: async value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                // The first check answers; a retry meets a host that has gone quiet again.
                if (actionId === 'machines.provisioners.check' && checks++ > 0) await new Promise(() => {});
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const { t } = await import('@/text');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
                provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />);
            await act(async () => { await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS / 2); });
            expect(schemaReads).toBe(1);
            expect(screen.getTextContent()).toContain(t('managedMachines.options.loading', { provider: 'Virtual machine' }));
            expect(screen.findByTestId('managed-config.error')).toBeNull();
            await act(async () => { await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS / 2); });
            expect(screen.findByTestId('managed-config.error')).not.toBeNull();
            expect(screen.getTextContent()).not.toContain(t('managedMachines.options.loading', { provider: 'Virtual machine' }));
            // Retry reads again: while it runs the page says it is checking, with the last failure withdrawn.
            await act(async () => { screen.pressByTestId('managed-config.error-action'); });
            await act(async () => { await vi.advanceTimersByTimeAsync(0); });
            expect(schemaReads).toBe(2);
            expect(screen.findByTestId('managed-config.error')).toBeNull();
            expect(screen.getTextContent()).toContain(t('managedMachines.options.loading', { provider: 'Virtual machine' }));
            await act(async () => { await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS); });
            expect(screen.findByTestId('managed-config.error')).not.toBeNull();
            // Retry also reloads the merged projection. Its temporary loading phase retains this
            // exact Action occurrence and must not cancel the replacement schema read.
            expect(schemaReadSignals).toHaveLength(2);
            expect(schemaReadSignals[1]?.aborted).toBe(false);
            await screen.unmount();
        } finally { vi.useRealTimers(); }
    });
    it('stops saying it is checking choices once the check and the options schema both ran out their budget', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://silent-everything.example',
            serverIdentityId: 'srv_silent_everything', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const read = nativeBoundary.rpc.getMockImplementation();
        nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
            ? new Promise(() => {}) : read?.(request));
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
                execution: { ok: true, result: { controller: defaultController, provisioners: [provisioner] } } } };
        } });
        // A loaded host answers neither the check nor the schema read.
        harness.answer(serverId, '/v1/actions/machines.provisioners.check', { respondAfter: new Promise<void>(() => {}) });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const { t } = await import('@/text');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
                provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />);
            // One budget in, nothing is left to wait for: the page already says so, not "checking" beside it.
            await act(async () => { await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1_000); });
            expect(screen.findByTestId('managed-config.error')).not.toBeNull();
            expect(screen.getTextContent()).not.toContain(t('managedMachines.options.loading', { provider: 'Virtual machine' }));
            await screen.unmount();
        } finally { vi.useRealTimers(); }
    });
    it('does not keep checking choices once the controller\u2019s plugin projection has failed', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://failed-projection.example',
            serverIdentityId: 'srv_failed_projection', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const read = nativeBoundary.rpc.getMockImplementation();
        nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) throw new Error('rpc_failed');
            return read?.(request);
        });
        for (const [actionId, result] of [['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
            ['machines.provisioners.check', { available: true }], ['machines.provisioners.options', { choices: [] }]] as const)
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.error')).not.toBeNull());
        expect(screen.findByTestId('managed-config.error-action')).not.toBeNull();
        await screen.unmount();
    });
    it('puts a failed read where the choices would be instead of a column of empty fields', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://failed-read-blank-fields.example',
            serverIdentityId: 'srv_failed_read_blank_fields', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: provisioner.contribution.pluginId, occurrenceId: 'options-occurrence',
            title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'], execution: { target: 'daemon' }, available: true, dangerLevel: 'safe',
            inputHints: { fields: [{ path: 'instance', title: 'Instance name', widget: 'text', required: true }] } });
        const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
            installedPackagesById: { [action.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: action.pluginId } },
            actionsById: { [buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.id })]: action },
        } });
        nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? projection : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
                ? { ok: true, inputSchema: { type: 'object', properties: { instance: { type: 'string' } }, additionalProperties: false } } : { ok: false, code: 'unsupported' });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
                execution: { ok: true, result: { controller: defaultController, provisioners: [provisioner] } } } };
        } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.check', { status: 500, body: { code: 'unavailable' } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.error')).not.toBeNull());
        // The required field has nothing in it and the read that would fill its choices failed: no empty box to fill.
        expect(screen.findByTestId('managed-config.field:instance')).toBeNull();
        expect(screen.findByTestId('managed-config.error-action')).not.toBeNull();
        await screen.unmount();
    });
    it('leaves the phone summary without a dash while no price is known', async () => {
        const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        restoreViewport = () => viewport.mockRestore();
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://unpriced-summary.example',
            serverIdentityId: 'srv_unpriced_summary', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        for (const [actionId, result] of [['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
            ['machines.provisioners.check', { available: true }], ['machines.provisioners.options', { choices: [] }]] as const)
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.summary')).not.toBeNull());
        const summary = screen.findByTestId('managed-config.summary')?.props.accessibilityLabel;
        expect(summary).toContain('Virtual machine');
        expect(summary).not.toContain('\u2014');
        await screen.unmount();
    });
    it('offers retained wake for a resume-only provisioner and preserves the choice in composer intent', async () => {
        const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
        restoreViewport = () => viewport.mockRestore();
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://resume-wake.example',
            serverIdentityId: 'srv_resume_wake', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const resumable = { ...provisioner, descriptor: { ...provisioner.descriptor,
            retention: { supportedIntents: ['resume', 'stop', 'delete'] } } };
        for (const [actionId, result] of [['machines.provisioners.list', { controller: defaultController, provisioners: [resumable] }],
            ['machines.provisioners.check', { available: true }],
            ['machines.provisioners.options', { choices: [{ id: 'resumable', title: 'Resumable compute', launch: { cpu: 2 } }] }]] as const)
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        const onUse = vi.fn();
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} onUse={onUse} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.choice:resumable')).not.toBeNull());
        await screen.pressByTestIdAsync('managed-config.choice:resumable');
        const wakeSwitch = 'managed-config.receipt:keep:wake:switch';
        expect(screen.findByTestId(wakeSwitch)).not.toBeNull();
        await act(async () => screen.findByTestId(wakeSwitch)?.props.onValueChange(true));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('managed-config.use');
        expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ wakeOnAcceptedMessage: true }),
            receipt: expect.objectContaining({ wakeOnAcceptedMessage: true }) }));
        await screen.unmount();
    });
    it('keeps a local VM receipt free of a bill before any choice exists (UIR5c)', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://local-empty-receipt.example',
            serverIdentityId: 'srv_local_empty_receipt', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const local = { ...provisioner, descriptor: { ...provisioner.descriptor, billing: { location: 'local', stoppedBilling: 'not-billed' } } };
        for (const [actionId, result] of [['machines.provisioners.list', { controller: defaultController, provisioners: [local] }],
            ['machines.provisioners.check', { available: true }], ['machines.provisioners.options', { choices: [] }]] as const)
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const { t } = await import('@/text');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(local.contribution)} initialController={defaultController} />);
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('managedMachines.price.noBill')));
        expect(screen.getTextContent()).not.toContain(t('managedMachines.price.unavailable', { provider: 'Virtual machine' }));
        await screen.unmount();
    });
    it('does not call an untouched recipe "no choices": the required fields are what it awaits, and once filled a truly empty answer says so', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://untouched-recipe.example',
            serverIdentityId: 'srv_untouched_recipe', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const local = { ...provisioner, descriptor: { ...provisioner.descriptor, billing: { location: 'local', stoppedBilling: 'not-billed' } } };
        const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: provisioner.contribution.pluginId, occurrenceId: 'options-occurrence',
            title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'], execution: { target: 'daemon' }, available: true, dangerLevel: 'safe',
            inputHints: { fields: [{ path: 'instance', title: 'Instance name', widget: 'text', required: true }] } });
        const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
            installedPackagesById: { [action.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: action.pluginId } },
            actionsById: { [buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.id })]: action },
        } });
        nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? projection : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ
                ? { ok: true, inputSchema: { type: 'object', properties: { instance: { type: 'string' } }, additionalProperties: false } } : { ok: false, code: 'unsupported' });
        for (const [actionId, result] of [['machines.provisioners.list', { controller: defaultController, provisioners: [local] }],
            ['machines.provisioners.check', { available: true }], ['machines.provisioners.options', { choices: [] }]] as const)
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const { t } = await import('@/text');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(local.contribution)} initialController={defaultController} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:instance')).not.toBeNull());
        await waitForHomeGovernance(() => expect(harness.requests.some(request => request.path === '/v1/actions/machines.provisioners.options')).toBe(true));
        await flushHookEffects({ cycles: 10 });
        const emptyNotice = t('managedMachines.options.empty', { provider: 'Virtual machine' });
        expect(screen.getTextContent()).not.toContain(emptyNotice);
        await act(async () => screen.changeTextByTestId('managed-config.field:instance', 'studio'));
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(emptyNotice));
        await screen.unmount();
    });
    it('discloses conditional cloud quotes and lets coupled native dimensions be staged without acquiring', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://conditional-quotes.example',
            serverIdentityId: 'srv_conditional_quotes', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const nativeFacts = { size: { id: 'small', title: 'Small' }, image: { id: 'linux', title: 'Linux' }, location: { id: 'west', title: 'West' } };
        const prices = (amount: string) => [{ amount, currency: 'EUR', unit: 'hour', source: 'native', observedAt: 10 }];
        const choices = [{ id: 'west-small', title: 'West small', launch: { cpu: 2 }, nativeFacts, prices: prices('1') },
            { id: 'west-other-network', title: 'West other network', launch: { cpu: 3 }, nativeFacts, prices: prices('2') },
            { id: 'east-other-image', title: 'East other image', launch: { cpu: 4 }, prices: prices('3'), nativeFacts: {
                ...nativeFacts, image: { id: 'other', title: 'Other image' }, location: { id: 'east', title: 'East' } } },
            { id: 'windows', title: 'Windows', available: false, nativeFacts: { ...nativeFacts, image: { id: 'windows', title: 'Windows' } } }];
        for (const [actionId, result] of [['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
            ['machines.provisioners.check', { available: true }], ['machines.provisioners.options', { choices }]] as const)
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const { t } = await import('@/text');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={defaultController} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.images:linux')).not.toBeNull());
        await act(async () => screen.pressByTestId('managed-config.images:linux'));
        const sizes = screen.tree.findAll(node => node.props.testID === 'managed-config.sizes' && typeof node.props.onChange === 'function')[0];
        await act(async () => sizes?.props.onChange('small'));
        await act(async () => screen.pressByTestId('managed-config.locations:west'));
        expect(screen.getTextContent()).toContain(t('managedMachines.price.unavailable', { provider: 'Virtual machine' }));
        // A choice says why it can't be picked: one never offered here, one only not with the other picks.
        expect(screen.getTextContent()).toContain(t('managedMachines.options.notOffered', { provider: 'Virtual machine' }));
        expect(screen.getTextContent()).toContain(t('managedMachines.options.unavailableWithChoices'));
        expect(screen.getTextContent()).not.toContain(t('managedMachines.options.unavailable'));
        await act(async () => screen.pressByTestId('managed-config.images:other'));
        expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
        await act(async () => screen.pressByTestId('managed-config.locations:east'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
        await screen.unmount();
    });
    it('keeps the actual Modal timeout as one editable field inside Ends and revalidates its exact native launch', async () => {
        const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
        restoreViewport = () => viewport.mockRestore();
        const serverId = await harness.addHome({ name: 'Modal compute', serverUrl: 'https://modal-duration.example',
            serverIdentityId: 'srv_modal_duration', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        const controller = { machineId: 'host', installationId: 'installation' };
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: controller.machineId, installationId: controller.installationId })] } });
        const descriptor = modalManifest.contributes.machineProvisioners?.[0];
        if (!descriptor) throw new Error('The actual Modal manifest must declare its provisioner');
        const optionsDeclaration = modalManifest.contributes.actions?.find(action => action.id === descriptor.actions.options);
        if (!optionsDeclaration?.inputSchema || !optionsDeclaration.inputHints) throw new Error('The actual Modal options declaration must publish its schema and fields');
        const contribution = { pluginId: modalManifest.id, localId: descriptor.id };
        const modal = { contribution, occurrenceId: 'modal-provisioner', acquireExecutionTarget: 'daemon' as const, descriptor, credentialPurposes: [] };
        const action = PluginProjectedActionV2Schema.parse({ id: optionsDeclaration.id, pluginId: modalManifest.id,
            occurrenceId: 'modal-options', title: optionsDeclaration.title, scopes: optionsDeclaration.scopes,
            surfaces: optionsDeclaration.surfaces, execution: optionsDeclaration.execution,
            dangerLevel: optionsDeclaration.dangerLevel, inputHints: optionsDeclaration.inputHints, available: true });
        const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
            installedPackagesById: { [modalManifest.id]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: modalManifest.id } },
            actionsById: { [buildQualifiedPluginContributionKey({ pluginId: modalManifest.id, localId: optionsDeclaration.id })]: action },
        } });
        nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? projection : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ ? { ok: true, inputSchema: optionsDeclaration.inputSchema } : { ok: false, code: 'unsupported' });
        const launch = ModalLaunchV1Schema.parse({ appReference: 'reviewed-app', imageReference: 'reviewed-image',
            resources: { cpu: 0.5, memoryMb: 1024 }, timeoutMs: 7_200_000 });
        const saved = { id: 'modal-preset', homeId: 'srv_modal_duration', revision: 1, name: 'Saved Modal',
            owner: { kind: 'account', accountId: 'owner' }, controller,
            recipe: { provider: contribution, schemaVersion: descriptor.schemaVersion, name: 'Saved Modal', choices: launch } };
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
        for (const [actionId, result] of [
            ['machines.provisioners.list', { controller, provisioners: [modal] }], ['machines.provisioners.check', { available: true }],
        ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
        } });
        const capturedSelectors: unknown[] = [];
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)) throw new Error('The native options input must be an object');
            const selectors = Reflect.get(request.input, 'selectors');
            capturedSelectors.push(selectors);
            const complete = ModalLaunchV1Schema.safeParse(selectors);
            const selected = complete.success ? complete.data : null;
            return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId, execution: { ok: true,
                result: { choices: selected ? [{ id: 'reviewed', title: selected.appReference, launch: selected,
                    nativeFacts: { image: { id: selected.imageReference, title: selected.imageReference },
                        size: { id: `${selected.resources.cpu}:${selected.resources.memoryMb}`, title: `${selected.resources.cpu} CPU · ${selected.resources.memoryMb} MiB`,
                            cpuCores: selected.resources.cpu, memoryBytes: selected.resources.memoryMb * 1024 * 1024 },
                        duration: { id: String(selected.timeoutMs), title: `${selected.timeoutMs / 1000} s`, afterMs: selected.timeoutMs } } }] : [] } } } };
        } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(contribution)} presetId={saved.id} presetOnly initialController={controller} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.nativeDuration?.choices?.length > 0).length).toBeGreaterThan(0));
        const keep = screen.tree.findAll(node => node.props.finiteOnly && node.props.nativeDuration?.choices?.length > 0)[0];
        expect(keep?.props.nativeDuration).toMatchObject({ value: String(launch.timeoutMs), choices: [{ id: String(launch.timeoutMs) }] });
        expect(screen.findByTestId('managed-config.receipt:keep:retention')).not.toBeNull();
        expect(screen.findByTestId('managed-config.field:appReference')).not.toBeNull();
        expect(screen.findByTestId('managed-config.field:resources.cpu')).not.toBeNull();
        const timeoutField = 'managed-config.field:timeoutMs';
        expect(findAllHostTestInstances(screen.tree, node => node.props.testID === timeoutField).length).toBe(1);
        expect(keep ? findAllHostTestInstances(keep, node => node.props.testID === timeoutField).length : 0).toBe(1);
        expect(screen.tree.findAll(node => node.props.items?.some((item: { id: string }) => item.id === String(launch.timeoutMs))
            && typeof node.props.onSelect === 'function')).toHaveLength(0);
        const updated = { ...launch, timeoutMs: 1_800_000 };
        await act(async () => screen.changeTextByTestId(timeoutField, String(updated.timeoutMs)));
        await waitForHomeGovernance(() => expect(capturedSelectors).toContainEqual(updated));
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.finiteOnly
            && node.props.nativeDuration?.choices?.some((choice: { id: string }) => choice.id === String(updated.timeoutMs))).length).toBeGreaterThan(0));
        expect(screen.findByTestId(timeoutField)?.props.value).toBe(String(updated.timeoutMs));
        expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
        const sizes = screen.tree.findAll(node => node.props.testID === 'managed-config.sizes' && typeof node.props.onChange === 'function')[0];
        const images = screen.tree.findAll(node => node.props.testID === 'managed-config.images' && typeof node.props.onChange === 'function')[0];
        await act(async () => { sizes?.props.onChange(`${launch.resources.cpu}:${launch.resources.memoryMb}`); });
        await act(async () => { images?.props.onChange(launch.imageReference); });
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: { ...saved, revision: 2,
            recipe: { ...saved.recipe, choices: updated } } } });
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
        const update = harness.requestsFor('/v1/machines/presets/update')[0]?.input;
        expect(update).toMatchObject({ patch: { recipe: { choices: updated } } });
        expect(harness.requests.some(request => request.path.endsWith('machines.managed.acquire'))).toBe(false);
        await screen.unmount();
    });
    it('discloses the first labelled native rate in the compact summary without computing a total', async () => {
        const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
        restoreViewport = () => viewport.mockRestore();
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://compact-prices.example', serverIdentityId: 'srv_compact_prices', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: provisioner.contribution.pluginId, occurrenceId: 'options-occurrence',
            title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'], execution: { target: 'daemon' }, available: true, dangerLevel: 'safe' });
        const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
            installedPackagesById: { [action.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: action.pluginId } },
            actionsById: { [buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.id })]: action },
        } });
        nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? projection : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ ? { ok: true, inputSchema: { type: 'object', properties: {}, additionalProperties: false } } : { ok: false, code: 'unsupported' });
        const prices = [{ amount: '0.005', currency: 'EUR', unit: 'hour', source: 'native-compute', observedAt: 10, label: 'Compute' },
            { amount: '0.0008', currency: 'EUR', unit: 'hour', source: 'native-network', observedAt: 10, label: 'IPv4' }];
        for (const [actionId, result] of [['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }], ['machines.provisioners.check', { available: true }],
            ['machines.provisioners.options', { choices: [{ id: 'native', title: 'Native compute', launch: { cpu: 2 }, prices }] }]] as const)
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)}
            initialController={{ machineId: 'host', installationId: 'installation' }} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.choice:native')).not.toBeNull());
        await act(async () => screen.pressByTestId('managed-config.choice:native'));
        const summary = screen.findByTestId('managed-config.summary')?.props.accessibilityLabel;
        expect(summary).toContain('Compute');
        expect(summary).toContain('0.005');
        expect(summary).toContain('€');
        expect(summary).toContain((await import('@/text')).t('managedMachines.price.perHour'));
        expect(summary).not.toContain('0.0058');
        await screen.unmount();
    });
    it.each(['entered', 'project-supplied'] as const)('uses %s selectors in the shared native field/configuration continuation without acquiring', async mode => {
        const capturedSelectors: unknown[] = [];
        // The wide receipt exposes both real actions; compact anatomy is covered separately.
        const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
        restoreViewport = () => viewport.mockRestore();
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://native-input.example', serverIdentityId: 'srv_native_input', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const optionsSchema = { type: 'object', properties: {
            runtimeId: { type: 'string', enum: ['qemu'] }, imageId: { type: 'string', minLength: 1 },
            size: { type: 'object', properties: { cpu: { type: 'integer', minimum: 1 }, memoryBytes: { type: 'integer', minimum: 1 },
                diskBytes: { type: 'integer', minimum: 1 } }, required: ['cpu', 'memoryBytes', 'diskBytes'], additionalProperties: false },
        }, additionalProperties: false };
        const native = { ...provisioner, descriptor: { ...provisioner.descriptor, launchSchema: {
            ...optionsSchema, properties: { ...optionsSchema.properties, on: { type: 'string', enum: ['local'] } },
            required: ['on', 'runtimeId', 'imageId', 'size'],
        } } };
        const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: provisioner.contribution.pluginId, occurrenceId: 'options-occurrence',
            title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'], execution: { target: 'daemon' }, available: true, dangerLevel: 'safe',
            inputHints: { fields: [
                { path: 'runtimeId', title: 'Runtime', widget: 'text' }, { path: 'imageId', title: 'Image', widget: 'text' },
                { path: 'size.cpu', title: 'CPU', widget: 'integer' }, { path: 'size.memoryBytes', title: 'Memory bytes', widget: 'integer' },
                { path: 'size.diskBytes', title: 'Disk bytes', widget: 'integer' },
            ] } });
        const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
            installedPackagesById: { [action.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: action.pluginId } },
            actionsById: { [buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.id })]: action },
        } });
        nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? projection : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ ? { ok: true, inputSchema: optionsSchema } : { ok: false, code: 'unsupported' });
        for (const [actionId, result] of [['machines.provisioners.list', { controller: defaultController, provisioners: [native] }], ['machines.provisioners.check', { available: true }]] as const)
            harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
                const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
                return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
            } });
        const launch = { on: 'local', runtimeId: 'qemu', imageId: 'linux', size: { cpu: 4, memoryBytes: 4294967296, diskBytes: 85899345920 } };
        const prices = [{ amount: '0.005', currency: 'EUR', unit: 'hour', source: 'native-compute', observedAt: 10, label: 'Compute' },
            { amount: '0.0008', currency: 'EUR', unit: 'hour', source: 'native-network', observedAt: 10, label: 'IPv4' }];
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            const input = request.input as { selectors?: unknown };
            capturedSelectors.push(input.selectors);
            const complete = pluginJsonValuesEqual(input.selectors, { runtimeId: launch.runtimeId, imageId: launch.imageId, size: launch.size });
            return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId, execution: { ok: true,
                result: { choices: complete ? [{ id: 'native-linux', title: 'Native Linux', launch, prices }] : [] } } } };
        } });
        const onUse = vi.fn();
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)}
            initialController={{ machineId: 'host', installationId: 'installation' }} onUse={onUse}
            initialOptionsSelectors={mode === 'project-supplied' ? { runtimeId: launch.runtimeId, imageId: launch.imageId, size: launch.size } : undefined} />);
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.options').length).toBeGreaterThan(0));
        if (mode === 'project-supplied') expect(capturedSelectors).toContainEqual({ runtimeId: launch.runtimeId, imageId: launch.imageId, size: launch.size });
        expect(screen.findByTestId('managed-config.field:size.cpu')).not.toBeNull();
        for (const [path, value] of mode === 'entered' ? [['runtimeId', 'qemu'], ['imageId', 'linux'], ['size.cpu', '4'], ['size.memoryBytes', '4294967296'], ['size.diskBytes', '85899345920']] as const : []) {
            await act(async () => screen.changeTextByTestId(`managed-config.field:${path}`, value));
        }
        await flushHookEffects();
        expect(capturedSelectors.at(-1)).toEqual({ runtimeId: launch.runtimeId, imageId: launch.imageId, size: launch.size });
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.choice:native-linux')).not.toBeNull());
        await act(async () => screen.pressByTestId('managed-config.choice:native-linux'));
        expect(screen.findByTestId('managed-config.save-preset')).not.toBeNull();
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.save-preset')?.props.disabled).toBe(false));
        await act(async () => screen.pressByTestId('managed-config.use'));
        expect(capturedSelectors).toContainEqual({ runtimeId: 'qemu', imageId: 'linux', size: launch.size });
        expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ launch: expect.objectContaining({ choices: launch }) }) }));
        expect(harness.requests.some(request => request.path.endsWith('machines.managed.acquire'))).toBe(false);
        await act(async () => screen.changeTextByTestId('managed-config.field:size.cpu', '0'));
        expect(screen.findByTestId('managed-config.use')).not.toBeNull();
        expect(screen.findByTestId('managed-config.save-preset')).not.toBeNull();
        expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(true);
        expect(screen.findByTestId('managed-config.save-preset')?.props.disabled).toBe(true);
        await act(async () => {
            screen.pressByTestId('managed-config.use');
            screen.pressByTestId('managed-config.save-preset');
        });
        expect(onUse).toHaveBeenCalledTimes(1);
        expect(harness.requestsFor('/v1/actions/machines.presets.create')).toHaveLength(0);
        await screen.unmount();
    });
    it('uses the one finite Ends control to choose the exact declared native duration before committing composer intent', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://duration.example', serverIdentityId: 'srv_duration', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const finite = { ...provisioner, descriptor: { ...provisioner.descriptor, retention: { supportedIntents: ['delete'], finiteOnly: true } } };
        for (const [actionId, result] of [
            ['machines.provisioners.list', { controller: defaultController, provisioners: [finite] }], ['machines.provisioners.check', { available: true }],
            ['machines.provisioners.options', { choices: [
                { id: 'short', title: 'Short', launch: { cpu: 2 }, nativeFacts: { duration: { id: 'short', title: '1 hour', afterMs: 3_600_000 } } },
                { id: 'long', title: 'Long', launch: { cpu: 4 }, nativeFacts: { duration: { id: 'long', title: '2 hours', afterMs: 7_200_000 } } },
            ] }],
        ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
        } });
        const onUse = vi.fn();
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)}
            initialController={{ machineId: 'host', installationId: 'installation' }} onUse={onUse} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.finiteOnly && node.props.nativeDuration?.choices?.length === 2).length).toBeGreaterThan(0));
        const control = screen.tree.findAll(node => node.props.finiteOnly && node.props.nativeDuration?.choices?.length === 2)[0];
        await act(async () => control?.props.nativeDuration.onChange('long'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false));
        await act(async () => screen.pressByTestId('managed-config.use'));
        expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ launch: expect.objectContaining({ choices: { cpu: 4 } }) }),
            receipt: expect.objectContaining({ nativeFacts: { duration: { id: 'long', title: '2 hours', afterMs: 7_200_000 } },
                retention: { kind: 'unused', afterMs: 3_600_000, effect: 'delete' }, wakeOnAcceptedMessage: false }) }));
        expect(harness.requests.some(request => request.path.endsWith('machines.managed.acquire'))).toBe(false);
        const current = createMachineFixture({ id: 'host', installationId: 'replacement-installation' });
        if (!current.metadata) throw new Error('Canonical machine fixture metadata is required');
        const replacement = createMachineFixture({ id: 'host', installationId: 'replacement-installation',
            metadata: { ...current.metadata, host: 'Replacement controller' } });
        await act(async () => storage.setState({ machineListByServerId: { [serverId]: [replacement] } }));
        const { t } = await import('@/text');
        const receipts = screen.tree.findAll(node => node.props.model?.facts?.some((fact: { id: string }) => fact.id === 'controller'));
        expect(receipts.length).toBeGreaterThan(0);
        for (const receipt of receipts) expect(receipt.props.model.facts.find((fact: { id: string }) => fact.id === 'controller')?.value).toBe(t('common.unknown'));
        await screen.unmount();
    });
    it('mounts the contributed size, image and location controls over complete native choices and keeps reviewed facts together', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://dimensions.example', serverIdentityId: 'srv_dimensions', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const nativeFacts = { size: { id: 'small', title: 'Small', cpuCores: 2, memoryBytes: 4294967296, diskBytes: 85899345920 }, image: { id: 'linux', title: 'Linux' }, location: { id: 'west', title: 'West' } };
        for (const [actionId, result] of [
            ['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }], ['machines.provisioners.check', { available: true }],
            ['machines.provisioners.options', { choices: [{ id: 'small-linux-west', title: 'Small Linux West', launch: { cpu: 2 }, nativeFacts }] }],
        ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
        } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} initialController={{ machineId: 'host', installationId: 'installation' }} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config.sizes').length).toBeGreaterThan(0));
        const sizes = screen.tree.findAll(node => node.props.testID === 'managed-config.sizes' && typeof node.props.onChange === 'function')[0];
        expect(sizes?.props.sizes[0]).toMatchObject({ id: 'small', name: 'Small', cpu: '2' });
        await act(async () => sizes?.props.onChange('small'));
        // Picking among the returned choices is local: the answer on screen is not asked for again, and the controller's
        // projection is described once for this visit, not per click.
        const reads = () => ({ options: harness.requests.filter(request => request.path === '/v1/actions/machines.provisioners.options').length,
            describes: nativeBoundary.rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE).length });
        const beforeClicks = reads();
        expect(beforeClicks.describes).toBe(1);
        expect(screen.tree.findAll(node => node.props.testID === 'managed-config.images').length).toBeGreaterThan(0);
        expect(screen.tree.findAll(node => node.props.testID === 'managed-config.locations').length).toBeGreaterThan(0);
        const images = screen.tree.findAll(node => node.props.testID === 'managed-config.images' && typeof node.props.onChange === 'function')[0];
        const locations = screen.tree.findAll(node => node.props.testID === 'managed-config.locations' && typeof node.props.onChange === 'function')[0];
        await act(async () => images?.props.onChange('linux'));
        await act(async () => locations?.props.onChange('west'));
        await flushHookEffects({ cycles: 5 });
        expect(reads()).toEqual(beforeClicks);
        expect(screen.tree.findAll(node => node.props.model?.facts?.some((fact: { id: string; value: string }) => fact.id === 'image' && fact.value === 'Linux')).length).toBeGreaterThan(0);
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        await screen.unmount();
    });
    it('describes a local machine\u2019s location as where it runs, not as a distance to the person', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://local-location.example', serverIdentityId: 'srv_local_location', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        const local = { ...provisioner, descriptor: { ...provisioner.descriptor, billing: { location: 'local', stoppedBilling: 'not-billed' } } };
        const nativeFacts = { image: { id: 'linux', title: 'Linux' }, location: { id: 'runc', title: 'runc' } };
        for (const [actionId, result] of [
            ['machines.provisioners.list', { controller: defaultController, provisioners: [local] }], ['machines.provisioners.check', { available: true }],
            ['machines.provisioners.options', { choices: [{ id: 'runc:linux', title: 'Linux (runc)', launch: { cpu: 2 }, nativeFacts }] }],
        ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
        } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const { t } = await import('@/text');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(local.contribution)} initialController={defaultController} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.locations')).not.toBeNull());
        expect(screen.getTextContent()).not.toContain(t('managedMachines.config.locationDescription'));
        await screen.unmount();
    });
    it('uses a reviewed one-off as composer intent without admitting a resource', async () => {
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation' })] } });
        for (const [actionId, result] of [
            ['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
            ['machines.provisioners.check', { available: true }],
            ['machines.provisioners.options', { choices: [{ id: 'small', title: 'Small', launch: { cpu: 2 } }] }],
        ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
        } });
        const onUse = vi.fn();
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)}
            initialController={{ machineId: 'host', installationId: 'installation' }} onUse={onUse} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config.choice:small').length).toBeGreaterThan(0));
        await act(async () => screen.pressByTestId('managed-config.choice:small'));
        await act(async () => screen.pressByTestId('managed-config.use'));
        expect(onUse).toHaveBeenCalledWith(expect.objectContaining({
            selection: { kind: 'one-off', homeId: 'srv_compute',
                launch: { provider: provisioner.contribution, schemaVersion: 1, name: 'Virtual machine', choices: { cpu: 2 } },
                controller: { machineId: 'host', installationId: 'installation' },
                retention: expect.any(Object), wakeOnAcceptedMessage: expect.any(Boolean) },
            archiveEffect: 'keep', receipt: expect.objectContaining({ optionStatus: 'current' }),
        }));
        expect(harness.requests.some(request => request.path.endsWith('machines.managed.acquire'))).toBe(false);
        await screen.unmount();
    });
    it('shows the captured Account creation-disabled lifecycle banner even when provisioners are unavailable', async () => {
        const target = await harness.addHome({ name: 'No creation', serverUrl: 'https://no-creation.example', serverIdentityId: 'srv_no_creation', accountId: 'owner' });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        harness.answer(target, '/v2/account/settings', { body: { content: { t: 'plain', v: { managedMachineCreationEnabled: false } }, version: 1 } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={target} provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config.catalog' && node.props.kind !== 'loading').length).toBeGreaterThan(0));
        expect(screen.tree.findAll(node => node.props.testID === 'managed-config.creation-disabled').length).toBeGreaterThan(0);
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        await screen.unmount();
    });
    it('reviews a one-off deadline, omits it from a saved preset, and preserves it after failed Create', async () => {
        const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
        restoreViewport = () => viewport.mockRestore();
        const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://compute.example', serverIdentityId: 'srv_compute', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        const metadata = createMachineFixture().metadata;
        if (!metadata) throw new Error('The canonical controller fixture has no metadata');
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: 'host', installationId: 'installation', activeAt: Date.now(), metadata: { ...metadata, host: 'Build host', platform: 'linux' } })] },
            machineListStatusByServerId: { [serverId]: 'idle' } });
        for (const [actionId, result] of [
            ['machines.provisioners.list', { controller: defaultController, provisioners: [provisioner] }],
            ['machines.provisioners.check', { available: true }],
            ['machines.provisioners.options', { choices: [{ id: 'small', title: 'Small', launch: { cpu: 2 } }] }],
        ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
        } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(provisioner.contribution)} />);
        // The Home's one controller ("Build host") is preselected, so its choices load without a controller pick.
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config.choice:small').length).toBeGreaterThan(0));
        await act(async () => screen.pressByTestId('managed-config.choice:small'));
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        // A one-off machine has no audience or running limit: those belong to the preset editor.
        expect(screen.findByTestId('managed-config.audience')).toBeNull();
        expect(screen.findByTestId('managed-config.limit')).toBeNull();
        const keep = 'managed-config.receipt:keep';
        const deadline = { kind: 'deadline', at: new Date(2099, 0, 2, 18, 30).getTime(), effect: 'stop', interrupts: true };
        expect(screen.findByTestId(`${keep}:choice:deadline`)).not.toBeNull();
        expect(screen.findByTestId(`${keep}:deadline:confirm`)).toBeNull();
        await screen.pressByTestIdAsync(`${keep}:choice:deadline`);
        await act(async () => screen.changeTextByTestId(`${keep}:deadline-date-input`, '2099-01-02'));
        await act(async () => screen.changeTextByTestId(`${keep}:deadline-time-input`, '18:30'));
        expect(screen.findByTestId(`${keep}:deadline:interrupts`)).not.toBeNull();
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
        expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(0);
        await screen.pressByTestIdAsync(`${keep}:deadline:confirm`);
        expect(screen.findByTestId('managed-config.receipt:secondary-note')).not.toBeNull();
        const saved = { id: 'saved', homeId: 'srv_compute', revision: 1, name: 'Virtual machine', owner: { kind: 'account', accountId: 'owner' },
            recipe: { provider: provisioner.contribution, schemaVersion: 1, name: 'Virtual machine', choices: { cpu: 2 } }, controller: { machineId: 'host', installationId: 'installation' } };
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'saved', preset: saved } });
        await act(async () => screen.pressByTestId('managed-config.save-preset'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1));
        expect(harness.requestsFor('/v1/machines/presets/create')[0]?.input).toMatchObject({
            recipe: saved.recipe, controller: saved.controller, wakeOnAcceptedMessage: true,
        });
        expect(harness.requestsFor('/v1/machines/presets/create')[0]?.input).not.toHaveProperty('retention');
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        harness.answer(serverId, '/v1/actions/machines.managed.acquire', { status: 403, body: { code: 'permission_denied' } });
        harness.answer(serverId, '/v1/machines', { body: [{ id: 'host', kind: 'persistent', installationId: 'installation',
            active: false, revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } }] });
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config.error').length).toBeGreaterThan(0));
        expect(ExternalActionRequestEnvelopeV1Schema.parse(harness.requestsFor('/v1/actions/machines.managed.acquire')[0]?.input).input)
            .toMatchObject({ selection: { retention: deadline, wakeOnAcceptedMessage: true }, reviewedFacts: { retention: deadline } });
        expect(screen.tree.findAll(node => node.props.testID === 'managed-config.choice:small' && node.props.selected === true).length).toBeGreaterThan(0);
        harness.answer(serverId, '/v1/actions/machines.managed.acquire', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { status: 409, body: { error: 'invalid_request', code: 'target_unavailable', requestId: request.requestId,
                managedAdmission: { managedId: 'waiting-managed' } } };
        } });
        await act(async () => screen.pressByTestId('managed-config.create'));
        await flushHookEffects();
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(2);
        expect(route.replace).toHaveBeenCalledWith(`/settings/machines/managed/waiting-managed?serverId=${encodeURIComponent(resolveServerProfileScopeIdForIdentifier(serverId))}`);
        await screen.unmount();
    });
});
