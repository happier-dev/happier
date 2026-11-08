import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { MachineProvisionerContributionV1Schema, type MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createManagedControllerMachineFixture as createMachineFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { createMachineProvisionerOptionsFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { View } from 'react-native';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { CRABBOX_PLUGIN } from '../../../../../../../packages/plugins/machine-crabbox/src/manifest';
import { activate as activateCrabbox } from '../../../../../../../packages/plugins/machine-crabbox/src/activate';
import type { PluginApi, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), navigate: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});
let modalBoundary: ReturnType<typeof import('@/dev/testkit/mocks/modal')['createModalModuleMock']> | undefined;
installApprovalCommonModuleMocks({
    text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: boundary.navigate } }).module,
    // Native presentation is the boundary. Mount the real dialog and settle the real Interaction owner through its public control.
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modal = modalBoundary ??= createModalModuleMock({ renderCustomModals: true, settleTransientConfirmations: false });
        return modal.module;
    },
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetMachineProjectionReadsForTests } = await import('@/sync/ops/machineContributionRegistryProjection');
const { useDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/useDaemonMergedProjectionInputs');
beforeEach(async () => {
    await harness.reset(); resetScopedHomeActionExecutorsForTests(); clearDaemonMergedProjectionCacheForTests(); resetMachineProjectionReadsForTests();
    boundary.rpc.mockReset(); boundary.navigate.mockReset();
});
afterEach(standardCleanup);
function ProjectionReadiness(props: Readonly<{ serverId: string }>) {
    const projection = useDaemonMergedProjectionInputs({ sections: 'complete', serverId: props.serverId, machineId: 'controller' });
    return <View testID="managed-repair.projection" accessibilityLabel={projection.phase} accessibilityHint={projection.failureReason} />;
}

describe('mounted provisioner repair', () => {
    it.each(['picker', 'crabbox', 'configuration', 'missingWithoutRepair', 'repairUnavailable', 'configuration.repairUnavailable', 'projectionOffline', 'projectionTransportUnavailable'] as const)('runs the declared prerequisite repair from %s on the selected controller after confirmation and rechecks', async scenario => {
        const surface = scenario.startsWith('configuration') ? 'configuration' : 'picker';
        const repairUnavailable = scenario.endsWith('repairUnavailable');
        const projectionFailure = scenario === 'projectionOffline' ? 'machine-unavailable'
            : scenario === 'projectionTransportUnavailable' ? 'transport-unavailable' : undefined;
        const serverId = await harness.addHome({ name: 'Build', serverUrl: `https://build-${scenario}.example`, serverIdentityId: `srv_build_${scenario}`, accountId: 'owner', currentAccount: true });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
        onTestFinished(clearPluginAccountAvailabilityProjection);
        replacePluginAccountAvailabilityProjection({ scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' },
            snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const { storage } = await import('@/sync/domains/state/storage');
        const machine = createMachineFixture({ id: 'controller', installationId: 'installation', activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [serverId]: [machine] },
            machineListStatusByServerId: { [serverId]: 'idle' } });
        const isCrabbox = scenario === 'crabbox';
        const contribution = isCrabbox ? { pluginId: CRABBOX_PLUGIN.manifest.id, localId: 'crabbox' } : { pluginId: 'custom.compute', localId: 'native' };
        const action = { pluginId: contribution.pluginId, localId: isCrabbox ? 'install' : 'repair' };
        const repairInput = isCrabbox ? {} : { tool: 'native-vm' };
        let crabboxCheck: unknown;
        if (isCrabbox) {
            const handlers = new Map<string, ActionHandler>();
            // Registration and host dependency/Account services are the ABI boundaries;
            // the authored plugin check produces the prerequisite shown by the real UI.
            await activateCrabbox({ actions: { register(id: string, handler: ActionHandler) { handlers.set(id, handler); return { dispose() {} }; } },
                connectedAccounts: { register() {} } } as unknown as PluginApi);
            crabboxCheck = await handlers.get('check')!({}, { services: {
                connectedAccounts: { getBinding: async () => null },
                managedServices: { dependencies: { status: async () => ({ state: 'missing', id: 'crabbox-cli', supported: true }) } },
            } } as unknown as PluginInvocationContext);
        }
        const provisioner: MachineProvisionersListResultV1['provisioners'][number] = { contribution, occurrenceId: 'native-occurrence', credentialPurposes: [], acquireExecutionTarget: 'daemon' as const, descriptor: {
            id: contribution.localId, title: 'Native compute', icon: 'magic-wand', resourceKind: 'VM', schemaVersion: 1,
            launchSchema: { type: 'object', properties: {}, additionalProperties: false }, resourceSchema: { type: 'object', properties: {}, additionalProperties: false },
            platforms: ['darwin'], prerequisites: [], billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
            actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
        } };
        if (isCrabbox) {
            const descriptor = CRABBOX_PLUGIN.manifest.contributes.machineProvisioners?.find(entry => entry.id === contribution.localId);
            if (!descriptor) throw new Error('Crabbox provisioner declaration missing');
            provisioner.descriptor = MachineProvisionerContributionV1Schema.parse(descriptor);
        }
        const declaredRepair = isCrabbox ? CRABBOX_PLUGIN.manifest.contributes.actions?.find(entry => entry.id === action.localId) : undefined;
        const projectedAction = PluginProjectedActionV2Schema.parse({ id: action.localId, pluginId: action.pluginId, occurrenceId: 'repair-occurrence',
            title: 'Repair native compute', scopes: ['global'], surfaces: ['ui'], execution: repairUnavailable
                ? { target: 'client', client: { artifactId: 'repair-client', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] }
                : { target: 'daemon' }, available: true,
            dangerLevel: 'writesLocal', confirmation: { title: 'Repair native compute?', body: 'This changes the selected computer.' },
            ...(declaredRepair ? { id: declaredRepair.id, title: declaredRepair.title, scopes: declaredRepair.scopes,
                surfaces: declaredRepair.surfaces, execution: declaredRepair.execution,
                dangerLevel: declaredRepair.dangerLevel, confirmation: declaredRepair.confirmation } : {}) });
        const optionsId = provisioner.descriptor.actions.options;
        if (!optionsId) throw new Error('The repair fixture declares a native options role');
        const optionsIdentity = { pluginId: contribution.pluginId, localId: optionsId };
        const projectedOptions = PluginProjectedActionV2Schema.parse({ id: optionsIdentity.localId, pluginId: optionsIdentity.pluginId,
            occurrenceId: 'options-occurrence', title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'],
            execution: { target: 'daemon' }, available: true, dangerLevel: 'safe' });
        const projectionResponse = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
            installedPackagesById: { [action.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: action.pluginId } },
            actionsById: { [buildQualifiedPluginContributionKey(action)]: projectedAction,
                [buildQualifiedPluginContributionKey(optionsIdentity)]: projectedOptions },
        } });
        let repaired = false;
        boundary.rpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                if (scenario === 'projectionOffline') throw createRpcCallError({ error: 'machine_unavailable', errorCode: RPC_ERROR_CODES.FORBIDDEN,
                    failureCause: { phase: 'rpc.admission.machine', errorClass: 'Error', errorCode: 'machine_unavailable', httpStatus: 403 } });
                if (scenario === 'projectionTransportUnavailable') throw createRpcCallError({ error: 'Reply unavailable', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE });
                return projectionResponse;
            }
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) return { ok: true,
                inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
            if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) { repaired = true; return { ok: true, result: { repaired: true } }; }
            return { ok: false, code: 'unsupported' };
        });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId, execution: { ok: true, result: {
                controller: { machineId: 'controller', installationId: 'installation' }, provisioners: [provisioner],
            } } } };
        } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.check', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.check', requestId: request.requestId, execution: { ok: true, result: repaired ? { available: true } : isCrabbox ? crabboxCheck : {
                available: false, prerequisites: [{ requirement: { kind: 'systemTool', id: 'native-vm' }, status: 'unavailable',
                  ...(scenario === 'missingWithoutRepair' ? {} : { repairAction: { action, input: { tool: 'native-vm' } } }) }],
            } } } };
        } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId, execution: { ok: true, result: createMachineProvisionerOptionsFixture() } } };
        } });
        const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const { ModalProvider } = await import('@/modal');
        const screen = await renderScreen(<ModalProvider><ListPresentationProvider value="page"><ProjectionReadiness serverId={serverId} />{surface === 'picker' ? <MachineProvisionerPicker serverId={serverId}
            scope={{ controller: { machineId: 'controller', installationId: 'installation' }, machine, hasCandidates: true, machineList: 'settled', chip: null }} />
            : <ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)}
                initialController={{ machineId: 'controller', installationId: 'installation' }} />}</ListPresentationProvider></ModalProvider>);
        // Both public entry points receive the page's selected controller; automatic selection is a separate contract.
        const card = surface === 'picker' ? `managed-picker.provisioners.${provisioner.descriptor.billing.location}.${buildQualifiedPluginContributionKey(contribution)}.action`
            : 'managed-config.repair:systemTool:native-vm';
        if (scenario === 'missingWithoutRepair') {
            await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.card?.id === buildQualifiedPluginContributionKey(contribution)
                && node.props.card?.status?.tone === 'none' && node.props.card?.action?.disabled === true).length).toBeGreaterThan(0));
            expect(boundary.navigate).not.toHaveBeenCalled();
            await screen.unmount();
            return;
        }
        // A sent check is not a settled surface. Press only the actual declared repair, not its prior Choose action.
        await waitForHomeGovernance(() => {
            if (surface === 'picker') {
                const cards = screen.tree.findAll(node => Array.isArray(node.props.cards)).flatMap(node => node.props.cards)
                    .map(card => ({ id: card.id, action: card.action.kind, tone: card.status.tone, label: card.status.label }));
                expect(cards, JSON.stringify({ cards, states: screen.tree.findAll(node => node.props.diagnosticCode)
                    .map(node => ({ testID: node.props.testID, code: node.props.diagnosticCode, title: node.props.title })),
                    requests: harness.requests.map(request => request.path) })).toContainEqual(expect.objectContaining({
                    id: buildQualifiedPluginContributionKey(contribution), action: 'repair', tone: 'none' }));
            }
            else expect(screen.findByTestId(card) !== null || screen.findByTestId('managed-config.error') !== null
                || screen.findByTestId('managed-config.catalog')?.props.kind === 'error').toBe(true);
        });
        const repairControl = screen.findByTestId(card) ? card : card.replace(/\.action$/, '');
        expect({ repairRow: screen.findByTestId(repairControl) !== null,
            catalog: screen.tree.findAll(node => node.props.testID === 'managed-config.catalog').map(node => ({ kind: node.props.kind, code: node.props.diagnosticCode })),
            error: screen.tree.findAll(node => node.props.testID === 'managed-config.error').map(node => ({ kind: node.props.kind, title: node.props.title })) }).toMatchObject({ repairRow: true });
        await waitForHomeGovernance(() => expect(boundary.rpc.mock.calls.some(([request]) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)).toBe(true));
        await waitForHomeGovernance(() => expect(['ready', 'unsupported', 'error']).toContain(screen.findByTestId('managed-repair.projection')?.props.accessibilityLabel));
        expect(screen.findByTestId('managed-repair.projection')?.props).toMatchObject(projectionFailure
            ? { accessibilityLabel: 'error', accessibilityHint: projectionFailure }
            : { accessibilityLabel: 'ready', accessibilityHint: undefined });
        const checksBeforeRepair = harness.requestsFor('/v1/actions/machines.provisioners.check').length;
        await act(async () => { void screen.pressByTestId(repairControl); });
        if (projectionFailure) {
            const failureId = `managed-picker.provisioners.local.${buildQualifiedPluginContributionKey(contribution)}.repairFailure`;
            await waitForHomeGovernance(() => expect(screen.findByTestId(failureId)).not.toBeNull());
            const { t } = await import('@/text');
            const failureCards = screen.tree.findAll(node => node.props.testID === failureId && node.props.diagnosticCode === projectionFailure);
            expect(failureCards.length).toBeGreaterThan(0);
            expect(failureCards.some(node => node.props.title === t('settingsProviders.detail.machineOffline')))
                .toBe(projectionFailure === 'machine-unavailable');
            expect(boundary.rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)).toHaveLength(0);
            await screen.unmount();
            return;
        }
        if (repairUnavailable) {
            const failureId = surface === 'picker'
                ? `managed-picker.provisioners.local.${buildQualifiedPluginContributionKey(contribution)}.repairFailure` : 'managed-config.repairFailure';
            await waitForHomeGovernance(() => expect(screen.findByTestId(failureId)).not.toBeNull());
            expect(screen.findByTestId('managed-picker.unavailable')).toBeNull();
            expect(screen.findByTestId('managed-config.error')).toBeNull();
            expect(screen.tree.findAll(node => node.props.testID === failureId
                && node.props.diagnosticCode === 'plugin_surface_client_action_unavailable').length).toBeGreaterThan(0);
            expect(boundary.rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)).toHaveLength(0);
            expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toHaveLength(checksBeforeRepair);
            await screen.unmount();
            return;
        }
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(screen.findByTestId('app-shell-confirmation-confirm') !== null || boundary.navigate.mock.calls.length > 0
                || screen.findByTestId('managed-picker.unavailable') !== null || screen.findByTestId('managed-config.error') !== null).toBe(true);
        });
        expect(screen.findByTestId('managed-picker.unavailable')?.props.diagnosticCode).toBeUndefined();
        expect({ confirmReady: screen.findByTestId('app-shell-confirmation-confirm') !== null, navigation: boundary.navigate.mock.calls,
            error: screen.tree.findAll(node => node.props.testID === 'managed-picker.unavailable').map(node => node.props.diagnosticCode) })
            .toEqual({ confirmReady: true, navigation: [], error: [] });
        expect(boundary.rpc.mock.calls.filter(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)).toHaveLength(0);
        await act(async () => { void screen.pressByTestId('app-shell-confirmation-confirm'); });
        await waitForHomeGovernance(() => expect(repaired || screen.findByTestId('managed-picker.unavailable') !== null
            || screen.findByTestId('managed-config.error') !== null).toBe(true));
        expect(screen.findByTestId('managed-picker.unavailable')?.props.diagnosticCode
            ?? screen.findByTestId('managed-config.error')?.props.diagnosticCode).toBeUndefined();
        expect(repaired).toBe(true);
        const invocation = boundary.rpc.mock.calls.find(([request]) => request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE)?.[0];
        expect(invocation).toMatchObject({ machineId: 'controller', serverId: resolveServerProfileScopeIdForIdentifier(serverId), payload: { qualifiedActionId: buildQualifiedPluginContributionKey(action),
            expectedContributorOccurrenceId: 'repair-occurrence', executionSurface: 'ui', input: repairInput, presentUserIntent: 'confirmed' } });
        await waitForHomeGovernance(() => {
            expect(harness.requestsFor('/v1/actions/machines.provisioners.check').length).toBeGreaterThan(checksBeforeRepair);
            if (surface === 'picker') expect(screen.tree.findAll(node => node.props.card?.id === buildQualifiedPluginContributionKey(contribution)
                && node.props.card?.status?.tone === 'ready' && node.props.card?.action?.kind === 'choose').length).toBeGreaterThan(0);
            else {
                expect(screen.findByTestId('managed-config')).not.toBeNull();
                expect(screen.findByTestId(card)).toBeNull();
                expect(screen.findByTestId('managed-config.error')).toBeNull();
            }
        });
        expect(harness.requests.some(request => request.path.endsWith('/acquire'))).toBe(false);
        expect(boundary.navigate).not.toHaveBeenCalled();
        await screen.unmount();
    });
});
