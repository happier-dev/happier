import { createManagedCpuOptionsFixture, createManagedControllerMachineFixture as createMachineFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dimensions } from 'react-native';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen, renderHook, standardCleanup, flushHookEffects, pressTestInstanceAsync, reportPopoverContentLayout, withPopoverWebGlobals, createDeferred } from '@/dev/testkit';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MachineProvisionersListResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { PluginProjectedActionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, buildDeferredDaemonProjectionSections } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const route = vi.hoisted(() => ({ params: {} as Record<string, string | undefined>, replace: vi.fn(), push: vi.fn(), back: vi.fn(), dismissTo: vi.fn() }));
const nativeBoundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/components/widgets/nearViewport', async importOriginal => {
    const actual = await importOriginal<typeof import('@/components/widgets/nearViewport')>();
    const { createMeasuredNearViewportModuleMock } = await import('@/dev/testkit/mocks/nearViewport');
    return createMeasuredNearViewportModuleMock(actual);
});
vi.mock('@legendapp/list/react-native', async () => {
    const { createLegendListModuleMock } = await import('@/dev/testkit/mocks/legendList');
    return createLegendListModuleMock({ renderItems: true });
});
let projectionReply: ReturnType<typeof DaemonContributionRegistryProjectionDescribeResponseSchema.parse>;
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(nativeBoundary.rpc);
});
installApprovalCommonModuleMocks({ text: async () => vi.importActual<typeof import('@/text')>('@/text'),
    reactNative: async () => {
        const { createReactNativeWebMock, createMeasuredViewMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ View: createMeasuredViewMock({ width: 960, height: 600 }, testID => testID.endsWith(':stage')) });
    },
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module,
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: route, params: () => route.params }).module });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetMachineProjectionReadsForTests } = await import('@/sync/ops/machineContributionRegistryProjection');
// Compile the real singleton graph after its network boundaries are installed,
// outside a per-test lifecycle deadline on a cold executor.
await loadSyncSingletonForTests();
let restoreViewport: (() => void) | undefined;
let restorePopover: (() => void) | undefined;
let restoreCredentialRefresh: (() => Promise<unknown>) | undefined;
const controller = { machineId: 'host', installationId: 'installation' };
const otherController = { machineId: 'other-host', installationId: 'other-installation' };
const contribution = { pluginId: 'custom.compute', localId: 'vm' };
const cloudPurpose = { consumer: contribution, purpose: 'cloud-account' };
const cuaPurpose = { consumer: contribution, purpose: 'computer-access' };
// Identical account ids under different services are intentionally distinct qualified refs.
const cloud = { service: { pluginId: 'cloud.auth', localId: 'cloud' }, accountId: 'same-account' };
const otherCloud = { service: { pluginId: 'cloud.auth', localId: 'cloud' }, accountId: 'other-account' };
const cua = { service: { pluginId: 'cua.auth', localId: 'cua' }, accountId: 'same-account' };
const credentials = [{ purpose: cloudPurpose, account: cloud }, { purpose: cuaPurpose, account: cua }];
const provisioner = MachineProvisionersListResultV1Schema.parse({ controller, provisioners: [{ contribution, occurrenceId: 'occurrence', acquireExecutionTarget: 'daemon' as const, descriptor: {
    id: 'vm', title: 'Virtual machine', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
    launchSchema: { type: 'object', properties: { cpu: { type: 'integer', minimum: 1 } }, required: ['cpu'], additionalProperties: false },
    resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
    billing: { location: 'cloud', stoppedBilling: 'billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
    actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' },
}, credentialPurposes: [
    { purpose: cloudPurpose, options: [{ value: cloud, label: 'Cloud work' }, { value: otherCloud, label: 'Cloud personal' }] },
    { purpose: cuaPurpose, options: [{ value: cua, label: 'Computer access' }] },
] }] }).provisioners[0]!;

beforeEach(async () => {
    restorePopover = withPopoverWebGlobals();
    await harness.reset(); resetScopedHomeActionExecutorsForTests(); route.params = {}; route.replace.mockReset(); route.push.mockReset(); route.back.mockReset(); route.dismissTo.mockReset(); nativeBoundary.rpc.mockReset();
    clearDaemonMergedProjectionCacheForTests(); resetMachineProjectionReadsForTests();
    // An explicit controller choice is persisted through the sync singleton's settings writer.
    await loadSyncSingletonForTests();
    const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: contribution.pluginId, occurrenceId: 'options-occurrence',
        title: 'Native options', scopes: ['machine'], surfaces: ['cli', 'plugin'], execution: { target: 'daemon' }, available: true, dangerLevel: 'safe' });
    const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {}, diagnostics: [],
        installedPackagesById: { [action.pluginId]: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById['acme.review'], id: action.pluginId } },
        actionsById: { [buildQualifiedPluginContributionKey({ pluginId: action.pluginId, localId: action.id })]: action },
        familiesById: { machineProvisioners: { family: 'machineProvisioners', entriesById: {
            [buildQualifiedPluginContributionKey(contribution)]: { id: buildQualifiedPluginContributionKey(contribution), pluginId: contribution.pluginId,
                pluginVersion: '1.0.0', occurrenceId: 'occurrence', definition: provisioner.descriptor,
                connectedAccountPurposes: [{ purpose: cloudPurpose.purpose, serviceRefs: [cloud.service] }, { purpose: cuaPurpose.purpose, serviceRefs: [cua.service] }] },
        } }, connectedAccounts: { family: 'connectedAccounts', entriesById: Object.fromEntries([cloud, cua].map(account => [buildQualifiedPluginContributionKey(account.service), {
            id: account.service.localId, serviceId: account.service.localId, pluginId: account.service.pluginId, provenance: 'external', sourceKind: 'fixture',
            title: account.service.localId, occurrenceId: 'auth-occurrence', capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
            authentication: { defaultModeId: 'token', modes: [{ id: 'token', kind: 'manual', outcomeReconciliation: 'none',
                fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }] },
        }])) } },
    } });
    projectionReply = projection;
    nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
        ? projection : request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ ? { ok: true,
            inputSchema: { type: 'object', properties: { cpu: { type: 'integer', minimum: 1 } }, additionalProperties: false } } : { ok: false, code: 'unsupported' });
});
afterEach(async () => {
    // The mocked presentation host retains its module inventory across provider unmounts.
    const { Modal } = await import('@/modal');
    await act(async () => { Modal.hideAll(); });
    await standardCleanup();
    // Retire the real Home/credential lifetimes before global setup clears their backing stores.
    await harness.reset();
    restoreViewport?.(); restoreViewport = undefined;
    restorePopover?.(); restorePopover = undefined;
    await restoreCredentialRefresh?.(); restoreCredentialRefresh = undefined;
});

async function setupHome() {
    const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://credential-purposes.example', serverIdentityId: 'srv_credentials', accountId: 'owner', currentAccount: true });
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const features = createRootLayoutFeaturesResponse({ capabilities: { connectedServices: {
        credentialDelete: { revisionGuard: false }, qualifiedAccounts: { protocolVersion: 4 },
    } } });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    harness.answer(serverId, '/v1/features', { body: features });
    harness.answer(serverId, '/v1/features/authenticated', { body: features });
    const { storage } = await import('@/sync/domains/state/storage');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' };
    const machines = [createMachineFixture({ id: controller.machineId, installationId: controller.installationId, activeAt: Date.now() }),
        createMachineFixture({ id: otherController.machineId, installationId: otherController.installationId, activeAt: Date.now() })];
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])), isDataReady: true, endpointStatus: 'online',
        machineListByServerId: { [serverId]: machines }, machineListStatusByServerId: { [serverId]: 'idle' } });
    storage.setState({ profileScope: scope, settingsScope: scope, profile: { ...storage.getState().profile, id: 'owner', connectedAccountsV4: [cloud, otherCloud, cua].map(ref => QualifiedConnectedAccountProfileV4Schema.parse({
        ref, status: 'connected', kind: 'token', authenticationModeId: 'token', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationReady: true, configurationRevision: null, scopes: [],
    })) } });
    harness.answer(serverId, '/v1/account/entity-rows/connected-metadata/presentation', { body: {
        status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: [
            { v: 1, subject: { kind: 'account', account: cloud }, label: 'Cloud work' },
            { v: 1, subject: { kind: 'account', account: otherCloud }, label: 'Cloud personal' },
            { v: 1, subject: { kind: 'account', account: cua }, label: 'Computer access' },
        ] } },
    } });
    harness.answer(serverId, '/v1/machines', { body: [controller, otherController].map(target => ({ id: target.machineId, kind: 'persistent',
        installationId: target.installationId, active: true, revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
        access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })) });
    // Controller rows are read through the batched Machine reader (one exact Machine per id).
    for (const [index, target] of [controller, otherController].entries()) harness.answer(serverId, `/v1/machines/${target.machineId}`, { body: {
        machine: { ...createPlainMachineRowFixture({ id: target.machineId, accountId: 'owner', machine: machines[index] }), installationId: target.installationId } } });
    for (const [actionId, result] of [
        ['machines.provisioners.list', { controller, provisioners: [provisioner] }],
        ['machines.provisioners.check', { available: true }],
        ['machines.provisioners.options', createManagedCpuOptionsFixture([{ id: 'native', title: 'Native compute', cpu: 2 }])],
    ] as const) harness.answer(serverId, `/v1/actions/${actionId}`, { select: value => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result } } };
    } });
    return serverId;
}
type Screen = Awaited<ReturnType<typeof renderScreen>>;
function credentialField(screen: Screen, purpose: string) {
    const field = screen.tree.findAll(node => node.props.controlTestID === `managed-config.credential:${purpose}` && typeof node.props.onChange === 'function')[0];
    if (!field) throw new Error(`Missing credential selection for ${purpose}`);
    return field;
}
function credentialControl(screen: Screen, purpose: string) {
    // Select uses a dropdown for choices with secondary identity descriptions.
    return credentialField(screen, purpose).findAll(node => typeof node.type === 'string'
        && ((node.props.role ?? node.props.accessibilityRole) === 'radiogroup'
            || (node.props.role ?? node.props.accessibilityRole) === 'button'
                && (typeof node.props['aria-expanded'] === 'boolean' || typeof node.props.accessibilityState?.expanded === 'boolean')))[0];
}
async function pressCredentialOption(screen: Screen, purpose: string, label: string) {
    const findOption = () => screen.findAll(node => typeof node.type === 'string'
        && (node.props.role ?? node.props.accessibilityRole) === 'radio'
        && ((node.props['aria-label'] ?? node.props.accessibilityLabel) === label
            || node.findAll(child => typeof child.type === 'string').some(child => child.children.includes(label))))[0];
    if (!findOption()) {
        // One or long-labelled choices use the field's dropdown instead of inline segments.
        const trigger = credentialField(screen, purpose).findAll(node => typeof node.type === 'string'
            && (node.props.role ?? node.props.accessibilityRole) === 'button'
            && (node.props['aria-expanded'] === false || node.props.accessibilityState?.expanded === false))[0];
        expect(trigger).toBeDefined();
        await pressTestInstanceAsync(trigger);
        await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 200 }); });
    }
    const option = await waitForHomeGovernance(() => {
        const current = findOption();
        expect(current).toBeDefined();
        return current;
    });
    await pressTestInstanceAsync(option);
}
async function selectCredentials(screen: Screen) {
    expect(credentialControl(screen, 'cloud-account')).toBeDefined();
    await pressCredentialOption(screen, 'cloud-account', 'Cloud work');
    await pressCredentialOption(screen, 'computer-access', 'Computer access');
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.sizes:native'), screen.getTextContent()).not.toBeNull());
    await act(async () => screen.pressByTestId('managed-config.sizes:native'));
}
function actionInputs(actionId: string) {
    return harness.requestsFor(`/v1/actions/${actionId}`).map(request => {
        const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(request.input);
        return ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : request.input).input;
    });
}
async function renderAccountScreen(content: React.ReactElement) {
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { ModalProvider } = await import('@/modal');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://credential-purposes.example');
    return renderScreen(<InjectedAuthProvider credentials={credentials}><ModalProvider>{content}</ModalProvider></InjectedAuthProvider>);
}

async function dismissConnectSheet() {
    const { Modal } = await import('@/modal');
    const dismiss = vi.mocked(Modal.show).mock.calls.at(-1)?.[0].onRequestClose;
    expect(dismiss).toBeTypeOf('function');
    await act(async () => { dismiss?.(); });
}

describe('managed provisioner credential purposes', () => {
    it('presents Agent-default names before native options settle on cold mount and remount without admitting a launch', async () => {
        const serverId = await setupHome();
        const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
        const account = { service, accountId: 'agent-work' };
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profile: { ...storage.getState().profile, connectedAccountsV4: [
            ...storage.getState().profile.connectedAccountsV4,
            QualifiedConnectedAccountProfileV4Schema.parse({ ref: account, status: 'connected', kind: 'token', authenticationModeId: 'token',
                revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationReady: true, configurationRevision: null, scopes: [] }),
        ] } });
        harness.answer(serverId, '/v1/account/entity-rows/connected-accounts/purposes', { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [{
                purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
                target: { kind: 'account', account },
            }] } } } } });
        harness.answer(serverId, '/v1/account/entity-rows/connected-metadata/presentation', { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: { v: 1, entries: [
                { v: 1, subject: { kind: 'account', account: cloud }, label: 'Cloud work' },
                { v: 1, subject: { kind: 'account', account: otherCloud }, label: 'Cloud personal' },
                { v: 1, subject: { kind: 'account', account: cua }, label: 'Computer access' },
                { v: 1, subject: { kind: 'account', account }, label: 'Agent work' },
            ] } } } });
        const options = createDeferred<void>();
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { respondAfter: options.promise, body: { v: 1, actionId: request.actionId, requestId: request.requestId,
                execution: { ok: true, result: createManagedCpuOptionsFixture([{ id: 'native', title: 'Native compute', cpu: 2 }]) } } };
        } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const onUse = vi.fn();
        try {
            for (const mount of ['cold', 'remount']) {
                const screen = await renderAccountScreen(<ManagedMachineConfigurationView serverId={serverId}
                    provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={controller} onUse={onUse} />);
                try {
                    const agentName = () => {
                        const receipt = screen.tree.findAll(node => node.props.testID === 'managed-config' && node.props.receipt)[0]?.props.receipt;
                        return receipt?.facts.find((fact: { id: string }) => fact.id === 'agents')?.value;
                    };
                    // Account-default names do not depend on choosing native launch credentials.
                    await waitForHomeGovernance(() => expect(agentName(), mount).toBe('Agent work'));
                    await waitForHomeGovernance(() => expect(credentialControl(screen, 'cloud-account')).toBeDefined());
                    await pressCredentialOption(screen, 'cloud-account', 'Cloud work');
                    await pressCredentialOption(screen, 'computer-access', 'Computer access');
                    await waitForHomeGovernance(() => expect(actionInputs('machines.provisioners.options').length).toBeGreaterThan(0));
                    // Zero completed native options must still permit independent Account-name display.
                    expect(agentName(), mount).toBe('Agent work');
                    expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(true);
                    await act(async () => screen.pressByTestId('managed-config.use'));
                    expect(onUse).not.toHaveBeenCalled();
                    expect(actionInputs('machines.managed.acquire')).toHaveLength(0);
                } finally { await screen.unmount(); }
            }
        } finally { options.resolve(); }
    });

    it.each([
        { serviceTitle: 'Boat', service: { pluginId: 'happier.machine.boat', localId: 'boat-account' } },
        { serviceTitle: 'Hetzner', service: { pluginId: 'happier.machine.hetzner', localId: 'hetzner-account' } },
    ])('shows distinct personal names for two $serviceTitle accounts in the credential selector', async ({ serviceTitle, service }) => {
        const serverId = await setupHome();
        const names = ['Work', 'Personal'].map(name => `${serviceTitle} ${name}`);
        const accounts = names.map((_, index) => ({ service, accountId: `routing-account-${index}` }));
        const namedProvisioner = { ...provisioner, credentialPurposes: [
            { purpose: cloudPurpose, options: accounts.map(value => ({ value, label: serviceTitle })) },
            provisioner.credentialPurposes![1]!,
        ] };
        const families = projectionReply.projection.familiesById;
        const serviceDefinition = families.connectedAccounts.entriesById[buildQualifiedPluginContributionKey(cloud.service)]!;
        const machineDefinition = families.machineProvisioners.entriesById[buildQualifiedPluginContributionKey(contribution)]!;
        projectionReply = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ ...projectionReply, projection: {
            ...projectionReply.projection, familiesById: { ...families,
                connectedAccounts: { ...families.connectedAccounts, entriesById: { ...families.connectedAccounts.entriesById,
                    [buildQualifiedPluginContributionKey(service)]: { ...serviceDefinition, pluginId: service.pluginId,
                        id: service.localId, serviceId: service.localId, title: serviceTitle } } },
                machineProvisioners: { ...families.machineProvisioners, entriesById: { ...families.machineProvisioners.entriesById,
                    [buildQualifiedPluginContributionKey(contribution)]: { ...machineDefinition, connectedAccountPurposes: [
                        { purpose: cloudPurpose.purpose, serviceRefs: [service] },
                        { purpose: cuaPurpose.purpose, serviceRefs: [cua.service] },
                    ] } } },
            },
        } });
        nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? projectionReply : { ok: false, code: 'unsupported' });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
                execution: { ok: true, result: { controller, provisioners: [namedProvisioner] } } } };
        } });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profile: { ...storage.getState().profile, connectedAccountsV4: accounts.map(ref =>
            QualifiedConnectedAccountProfileV4Schema.parse({ ref, displayName: serviceTitle, status: 'connected', kind: 'token',
                authenticationModeId: 'token', revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
                configurationReady: true, configurationRevision: null, scopes: [] })) } });
        harness.answer(serverId, '/v1/account/entity-rows/connected-metadata/presentation', { body: {
            status: 'present', revision: 0, content: { t: 'plain', v: { v: 1, entries: accounts.map((account, index) =>
                ({ v: 1, subject: { kind: 'account', account }, label: names[index] })) } },
        } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderAccountScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={controller} />);
        await waitForHomeGovernance(() => expect(credentialField(screen, cloudPurpose.purpose)).toBeDefined());
        const trigger = credentialField(screen, cloudPurpose.purpose).findAll(node => typeof node.type === 'string'
            && (node.props.role ?? node.props.accessibilityRole) === 'button'
            && (node.props['aria-expanded'] === false || node.props.accessibilityState?.expanded === false))[0];
        if (trigger) {
            await pressTestInstanceAsync(trigger);
            await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 200 }); });
        }
        await waitForHomeGovernance(() => {
            const radios = screen.findAll(node => typeof node.type === 'string' && (node.props.role ?? node.props.accessibilityRole) === 'radio');
            for (const name of names) {
                const radio = radios.find(node => String(node.props['aria-label'] ?? node.props.accessibilityLabel).includes(name));
                expect(radio, `Missing accessible account name ${name}`).toBeDefined();
                const visibleText = radio!.findAll(node => typeof node.type === 'string').flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ');
                expect(visibleText).toContain(name);
            }
        });
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
        await screen.unmount();
    });
    it.each(['plain', 'reconnect', 'dismiss'] as const)('translates legacy %s Connect ingress over Credentials through the shared sheet', async ingress => {
        await setupHome();
        route.params = { service: buildQualifiedPluginContributionKey(cloud.service),
            ...(ingress === 'reconnect' ? { accountId: cloud.accountId } : {}) };
        const { ConnectedServiceConnectRoute } = await import('../../connectedServices/setup/ConnectedServiceConnectRoute');
        const { ConnectedServicesSettingsView } = await import('../../connectedServices/ConnectedServicesSettingsView');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { Modal } = await import('@/modal');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://credential-purposes.example');
        const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><ConnectedServiceConnectRoute /></InjectedAuthProvider>);
        await waitForHomeGovernance(() => expect(screen.findByTestId('connect-sheet:account')).not.toBeNull());
        expect(screen.findAllByType(ConnectedServicesSettingsView)).toHaveLength(1);
        const modal = vi.mocked(Modal.show).mock.calls.findLast(([config]) => config.chrome?.testID === 'connect-sheet')![0];
        expect(modal.props?.request).toMatchObject({ service: cloud.service,
            ...(ingress === 'reconnect' ? { account: cloud, intent: 'reconnect' } : {}) });
        await act(async () => {
            if (ingress === 'dismiss') modal.onRequestClose?.();
            else modal.props?.onResult({ kind: 'connected', account: cloud });
        });
        if (ingress === 'dismiss') {
            expect(route.back).toHaveBeenCalledTimes(1);
            expect(route.dismissTo).not.toHaveBeenCalled();
        } else expect(route.dismissTo).toHaveBeenCalledWith({ pathname: '/(app)/settings/connected-services',
            params: { connectedService: buildQualifiedPluginContributionKey(cloud.service), connectedAccount: cloud.accountId } });
        expect(route.push).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('keeps Machine demand absent until the setup controller reports it and retires it when the target changes', async () => {
        await setupHome();
        const { useConnectAccountSheetModel } = await import('@/components/settings/connectedServices/setup/useConnectAccountSheetModel');
        const hook = await renderHook(() => useConnectAccountSheetModel({ service: cloud.service }, () => undefined));
        expect(hook.getCurrent().machineRequired).toBe(false);
        await act(async () => hook.getCurrent().onMachineRequirementChange(true));
        expect(hook.getCurrent().machineRequired).toBe(true);
        await act(async () => hook.getCurrent().setTarget({ kind: 'catalog' }));
        expect(hook.getCurrent().machineRequired).toBe(false);
        await hook.unmount();
    });

    it('restricts saved accounts to the service selected from the generic Connect catalog', async () => {
        await setupHome();
        const { useConnectAccountSheetModel } = await import('@/components/settings/connectedServices/setup/useConnectAccountSheetModel');
        const hook = await renderHook(() => useConnectAccountSheetModel({}, () => undefined));
        expect(hook.getCurrent().target.kind).toBe('catalog');
        await act(async () => hook.getCurrent().setTarget({ kind: 'service', serviceKey: buildQualifiedPluginContributionKey(cloud.service) }));
        expect(hook.getCurrent().savedAccounts.map(profile => profile.ref)).toEqual([cloud, otherCloud]);
        await act(async () => hook.getCurrent().setTarget({ kind: 'service', serviceKey: buildQualifiedPluginContributionKey(cua.service) }));
        expect(hook.getCurrent().savedAccounts.map(profile => profile.ref)).toEqual([cua]);
        expect(hook.getCurrent().preselected).toEqual(cua);
        await hook.unmount();
        const explicit = await renderHook(() => useConnectAccountSheetModel({ service: cloud.service, account: cloud }, () => undefined));
        await act(async () => explicit.getCurrent().setTarget({ kind: 'catalog' }));
        await act(async () => explicit.getCurrent().setTarget({ kind: 'service', serviceKey: buildQualifiedPluginContributionKey(cua.service) }));
        expect(explicit.getCurrent().savedAccounts.map(profile => profile.ref)).toEqual([cua]);
        expect(explicit.getCurrent().initialMode).toBe('saved');
        expect(explicit.getCurrent().preselected).toEqual(cua);
        await explicit.unmount();
    });

    it('offers the matched Saved purpose choice when Connect opens without an explicit service', async () => {
        const serverId = await setupHome();
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const { presentConnectSheet } = await import('@/components/settings/connectedServices/setup/ConnectedServiceSetupModal');
        const screen = await renderAccountScreen(<></>);
        let result: ReturnType<typeof presentConnectSheet> | undefined;
        await act(async () => {
            result = presentConnectSheet({ purpose: cloudPurpose, purposeRequest: {
                scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' },
                machineId: controller.machineId, purpose: cloudPurpose,
            } });
        });
        await waitForHomeGovernance(() => expect(screen.findByTestId('connect-sheet:purpose')).not.toBeNull());
        expect(screen.findByTestId(`connected-account-purpose:${buildQualifiedPluginContributionKey(cloud.service)}`)).not.toBeNull();
        await dismissConnectSheet();
        await expect(result).resolves.toEqual({ kind: 'dismissed' });
        expect(harness.requestsFor('/v1/actions/connectedServices.purposes.default.set')).toHaveLength(0);
        await screen.unmount();
    });

    it.each(['setup', 'configurator'] as const)('settles a cold Connect handoff through %s without unrelated projection sections', async surface => {
        const serverId = await setupHome();
        // The real daemon framing producer keeps unrequested families absent. Legacy full
        // projection fixtures concealed this failure behind the configurator's warm read.
        const framed = buildDeferredDaemonProjectionSections({ ...projectionReply, projectionDigest: 'a'.repeat(64) });
        const sectionReads: string[] = [];
        const selections: string[] = [];
        nativeBoundary.rpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
            if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { ok: false, code: 'unsupported' };
            const payload = (await import('@happier-dev/protocol/daemon/contributionRegistryProjection'))
                .DaemonContributionRegistryProjectionDescribeRequestSchema.parse(request.payload);
            if (payload.selection) {
                selections.push(payload.selection);
                return projectionReply;
            }
            if (!('sectionRead' in payload) || !payload.sectionRead) return framed.manifest;
            const { sectionRead } = payload;
            const response = framed.read(sectionRead.digest, sectionRead.offset, sectionRead.includeDigests);
            // The transport batches requested sibling bodies in the primary reply.
            sectionReads.push(sectionRead.digest, ...(response && 'bodies' in response ? response.bodies.map(body => body.digest) : []));
            return response;
        });
        const { presentConnectSheet } = await import('../../connectedServices/setup/ConnectedServiceSetupModal');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const page = surface === 'setup' ? <></>
            : <ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)}
                initialController={controller} initialConnectPurpose={cloudPurpose.purpose} />;
        const screen = await renderAccountScreen(page);
        if (surface === 'setup') await act(async () => { void presentConnectSheet({ purposeRequest: {
            scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' },
            machineId: controller.machineId, purpose: cloudPurpose }, purpose: cloudPurpose }); });
        const chooser = `connected-account-purpose:${buildQualifiedPluginContributionKey(cloud.service)}`;
        await waitForHomeGovernance(() => expect(screen.findByTestId(chooser)).not.toBeNull());
        await flushHookEffects();
        expect(selections).toContain('connectedAccountAdmission');
        expect(screen.findByTestId('connected-account-purpose-unavailable')).toBeNull();
        if (surface === 'setup') expect(sectionReads).toEqual([]);
        expect(sectionReads).not.toContain(framed.manifest.sections.agentsById);
        const settledReads = nativeBoundary.rpc.mock.calls.length;
        const { storage } = await import('@/sync/domains/state/storage');
        await act(async () => storage.setState({ isDataReady: true }));
        await flushHookEffects();
        expect(nativeBoundary.rpc.mock.calls).toHaveLength(settledReads);
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
        await screen.unmount();
    });
    it.each([false, true])('connects a declared provisioner purpose to the same draft (credential refresh: %s)', async refreshCredential => {
        const serverId = await setupHome();
        let catalogReads = 0;
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            const current = ++catalogReads === 1 ? { ...provisioner, credentialPurposes: provisioner.credentialPurposes!.map(entry =>
                entry.purpose.purpose === cloudPurpose.purpose ? { ...entry, options: [] } : entry) } : provisioner;
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
                execution: { ok: true, result: { controller, provisioners: [current] } } } };
        } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderAccountScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={controller} initialOptionsSelectors={{ cpu: 2 }} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.connect:cloud-account')).not.toBeNull());
        expect(screen.findByTestId('managed-config.connect:cloud-account')).not.toBeNull();
        const { ManagedMachineConfigurator } = await import('./ManagedMachineConfigurator');
        const configurator = screen.tree.findByType(ManagedMachineConfigurator);
        const trigger = { getBoundingClientRect: () => ({ left: 160, top: 240, width: 320, height: 48 }) };
        await act(async () => screen.findHostByTestId('managed-config.connect:cloud-account')!.props.onPress({ currentTarget: trigger }));
        // Connecting stays over the configurator; its draft and mounted fields remain in place.
        expect(screen.findByTestId('managed-config')).not.toBeNull();
        expect(screen.tree.findByType(ManagedMachineConfigurator)).toBe(configurator);
        const { Modal } = await import('@/modal');
        const setup = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        expect(setup?.props?.request).toMatchObject({ service: cloud.service, purpose: cloudPurpose,
            anchor: { kind: 'view', ref: { current: trigger } },
            purposeRequest: { scope: { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'owner' },
                machineId: controller.machineId, purpose: cloudPurpose } });
        if (refreshCredential) {
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const current = await TokenStorage.getCredentialsForServerUrl('https://credential-purposes.example');
            expect(current).not.toBeNull();
            await act(async () => {
                // A refresh changes the bearer, not its canonical decoded Account claims.
                const refreshed = await TokenStorage.setCredentialsForServerUrlWithRollback('https://credential-purposes.example',
                    { serverId }, { token: `${current!.token}-refreshed` });
                expect(refreshed).not.toBeNull();
                restoreCredentialRefresh = () => refreshed!.rollback();
            });
            await flushHookEffects();
            expect(screen.findByTestId('connect-sheet:account')).not.toBeNull();
        }
        await waitForHomeGovernance(() => expect(screen.findByTestId('connected-account-purpose-unavailable')).toBeNull());
        await screen.pressByTestIdAsync(`connected-account-purpose:${buildQualifiedPluginContributionKey(cloud.service)}`);
        const { connectedAccountPurposeTargetChoiceId } = await import('@/sync/domains/connectedServices/connectedAccountPurposeTargetChoices');
        await screen.pressByTestIdAsync(`connected-account-purpose:${buildQualifiedPluginContributionKey(cloud.service)}:choice:${connectedAccountPurposeTargetChoiceId({ kind: 'account', account: cloud }, null)}`);
        expect(vi.mocked(Modal.alert).mock.calls).toEqual([]);
        expect(screen.findByTestId('connect-sheet:account')).toBeNull();
        expect(screen.tree.findByType(ManagedMachineConfigurator)).toBe(configurator);
        await waitForHomeGovernance(() => expect(credentialControl(screen, 'cloud-account')).toBeDefined());
        await pressCredentialOption(screen, 'computer-access', 'Computer access');
        await waitForHomeGovernance(() => expect(actionInputs('machines.provisioners.options')).toContainEqual(expect.objectContaining({
            controller, selectors: { cpu: 2 }, credentials,
        })));
        expect(harness.requestsFor('/v1/actions/connectedServices.purposes.default.set')).toHaveLength(0);
        expect(actionInputs('machines.managed.acquire')).toHaveLength(0);
        expect(route.push).not.toHaveBeenCalled();
        expect(route.replace).not.toHaveBeenCalled();
        await screen.unmount();
    });
    it('refuses a late Connected-account return after its setup was canceled without changing the draft', async () => {
        const serverId = await setupHome();
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const { Modal } = await import('@/modal');
        const screen = await renderAccountScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={controller} initialOptionsSelectors={{ cpu: 2 }} />);
        await waitForHomeGovernance(() => expect(credentialControl(screen, 'cloud-account')).toBeDefined());
        await pressCredentialOption(screen, 'computer-access', 'Computer access');
        await screen.pressByTestIdAsync('managed-config.connect:cloud-account');
        const returned = vi.mocked(Modal.show).mock.calls.at(-1)?.[0].props?.onResult;
        expect(returned).toBeTypeOf('function');
        await dismissConnectSheet();
        await act(async () => {
            if (typeof returned === 'function') returned({ kind: 'selected', account: cloud });
        });
        await flushHookEffects();
        expect(credentialField(screen, 'cloud-account').props.value).toBeUndefined();
        expect(credentialField(screen, 'computer-access').props.value).toEqual(cua);
        expect(actionInputs('machines.provisioners.options')).toHaveLength(0);
        expect(actionInputs('machines.managed.acquire')).toHaveLength(0);
        expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(0);
        expect(harness.requestsFor('/v1/actions/connectedServices.purposes.default.set')).toHaveLength(0);
        await screen.unmount();
    });
    it('presents the existing safe purpose refusal when a connected account disappears before selection', async () => {
        const serverId = await setupHome();
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const { ConnectedAccountPurposeTargetChooser } = await import('../../connectedServices/account/ConnectedAccountPurposeTargetChooser');
        const { Modal } = await import('@/modal');
        const { t } = await import('@/text');
        const { storage } = await import('@/sync/domains/state/storage');
        const screen = await renderAccountScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={controller} initialOptionsSelectors={{ cpu: 2 }} />);
        await waitForHomeGovernance(() => expect(credentialControl(screen, 'cloud-account')).toBeDefined());
        await screen.pressByTestIdAsync('managed-config.connect:cloud-account');
        const chooser = await waitForHomeGovernance(() => {
            const current = screen.tree.findAllByType(ConnectedAccountPurposeTargetChooser)
                .find(node => node.props.declaration.purpose === cloudPurpose.purpose);
            expect(current).toBeDefined();
            return current!;
        });
        const choose = chooser.props.onChange;
        await act(async () => storage.setState({ profile: { ...storage.getState().profile,
            connectedAccountsV4: storage.getState().profile.connectedAccountsV4.filter(account => account.ref.accountId !== cloud.accountId
                || account.ref.service.pluginId !== cloud.service.pluginId) } }));
        await act(async () => choose({ kind: 'account', account: cloud }));
        await waitForHomeGovernance(() => expect(vi.mocked(Modal.alert)).toHaveBeenCalledWith(
            t('common.error'), t('connectedServices.errors.accountServiceUnavailable'), [
                { text: t('approvals.technicalDetails'), onPress: expect.any(Function) },
                { text: t('common.ok'), style: 'cancel' },
            ]));
        expect(actionInputs('machines.managed.acquire')).toHaveLength(0);
        expect(harness.requestsFor('/v1/actions/connectedServices.purposes.default.set')).toHaveLength(0);
        await screen.unmount();
    });
    it('leads a purpose with no connected account with one Connect row named for its service, not a field or an error', async () => {
        const serverId = await setupHome();
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            const noCloud = { ...provisioner, credentialPurposes: provisioner.credentialPurposes!.map(entry =>
                entry.purpose.purpose === cloudPurpose.purpose ? { ...entry, options: [] } : entry) };
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId,
                execution: { ok: true, result: { controller, provisioners: [noCloud] } } } };
        } });
        // The provider declares a launch field: it has nothing to fill from until an account is connected.
        const describeProjection = nativeBoundary.rpc.getMockImplementation()!;
        nativeBoundary.rpc.mockImplementation(async (request: { method: string }) => {
            const result = await describeProjection(request);
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                const action = result.projection.actionsById[buildQualifiedPluginContributionKey({ pluginId: contribution.pluginId, localId: 'options' })];
                action.inputHints = { fields: [{ path: 'cpu', title: 'CPU cores', widget: 'integer', required: true }] };
            }
            return result;
        });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderAccountScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={controller} />);
        const connect = () => screen.tree.findAll(node => node.props.testID === 'managed-config.connect:cloud-account' && typeof node.props.onPress === 'function')[0];
        await waitForHomeGovernance(() => expect(connect()).toBeDefined());
        // The purpose id is plumbing: the row names the account by its service's title.
        expect(connect()!.props.subtitle).toBe('Cloud');
        expect(screen.tree.findAll(node => String(node.props.controlTestID ?? '') === 'managed-config.credential:cloud-account')).toHaveLength(0);
        expect(screen.tree.findAll(node => node.props.description === 'Connect an account to see what you can create.').length).toBeGreaterThan(0);
        // Nothing failed: there is no read to retry until an account is connected.
        expect(screen.findByTestId('managed-config.error')).toBeNull();
        expect(screen.findByTestId('managed-config.field:cpu')).toBeNull();
        await screen.unmount();
    });
    it('offers the account chooser only when the service has an account to choose', async () => {
        const serverId = await setupHome();
        const { storage } = await import('@/sync/domains/state/storage');
        // Nothing of the cloud service is connected yet: a brand-new account has nothing to choose from.
        storage.setState({ profile: { ...storage.getState().profile, connectedAccountsV4: storage.getState().profile.connectedAccountsV4.filter(account =>
            account.ref.service.pluginId !== cloud.service.pluginId) } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderAccountScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={controller} initialOptionsSelectors={{ cpu: 2 }} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.connect:cloud-account')).not.toBeNull());
        await screen.pressByTestIdAsync('managed-config.connect:cloud-account');
        const { PageHeader } = await import('@/components/ui/layout/PageHeader');
        await waitForHomeGovernance(() => expect(screen.tree.findAllByType(PageHeader)).toHaveLength(1));
        expect(screen.findByTestId(`connected-account-purpose:${buildQualifiedPluginContributionKey(cloud.service)}`)).toBeNull();
        await screen.unmount();
    });
    it('returns from Cancel unchanged and offers the exact revoked account for Reconnect without selecting it', async () => {
        const serverId = await setupHome();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profile: { ...storage.getState().profile, connectedAccountsV4: storage.getState().profile.connectedAccountsV4.map(account =>
            account.ref.service.pluginId === cloud.service.pluginId && account.ref.accountId === cloud.accountId
                ? { ...account, status: 'needs_reauth' as const } : account) } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderAccountScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={controller} initialOptionsSelectors={{ cpu: 2 }} />);
        await waitForHomeGovernance(() => expect(credentialControl(screen, 'cloud-account')).toBeDefined());
        await pressCredentialOption(screen, 'computer-access', 'Computer access');
        await screen.pressByTestIdAsync('managed-config.connect:cloud-account');
        const reconnect = `connected-account-purpose-reconnect:${buildQualifiedPluginContributionKey(cloud.service)}:${cloud.accountId}`;
        await waitForHomeGovernance(() => expect(screen.findByTestId(reconnect)).not.toBeNull());
        await screen.pressByTestIdAsync(reconnect);
        const { ConnectedServiceSetupPanel } = await import('../../connectedServices/setup/ConnectedServiceSetupPanel');
        expect(screen.tree.findByType(ConnectedServiceSetupPanel).props).toMatchObject({ target: {
            kind: 'reconnect', serviceKey: buildQualifiedPluginContributionKey(cloud.service), accountId: cloud.accountId,
        }, targetLocked: true, targetSelection: { selectedTarget: { machineId: controller.machineId } } });
        await dismissConnectSheet();
        await waitForHomeGovernance(() => expect(credentialField(screen, 'computer-access').props.value).toEqual(cua));
        expect(credentialField(screen, 'cloud-account').props.value).toBeUndefined();
        expect(actionInputs('machines.provisioners.options')).toHaveLength(0);
        expect(actionInputs('machines.managed.acquire')).toHaveLength(0);
        await screen.unmount();
    });
    it('preselects the current draft account in Connect and preserves it on dismissal', async () => {
        const serverId = await setupHome();
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const { Modal } = await import('@/modal');
        const screen = await renderAccountScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={controller} initialOptionsSelectors={{ cpu: 2 }} />);
        await waitForHomeGovernance(() => expect(credentialControl(screen, 'cloud-account')).toBeDefined());
        await pressCredentialOption(screen, 'cloud-account', 'Cloud work');
        await pressCredentialOption(screen, 'computer-access', 'Computer access');
        await screen.pressByTestIdAsync('managed-config.connect:cloud-account');
        const setup = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        expect(setup?.props?.request).toMatchObject({ account: cloud, purpose: cloudPurpose });
        expect(credentialField(screen, 'cloud-account').props.value).toEqual(cloud);
        await screen.pressByTestIdAsync(`connected-account-purpose:${buildQualifiedPluginContributionKey(cloud.service)}`);
        const picker = vi.mocked(Modal.show).mock.calls.at(-1)?.[0];
        const pickerId = vi.mocked(Modal.show).mock.results.at(-1)?.value;
        expect(pickerId).toBeTypeOf('string');
        await act(async () => {
            picker?.onRequestClose?.();
            if (typeof pickerId === 'string') Modal.hide(pickerId);
        });
        await act(async () => { setup?.onRequestClose?.(); });
        await flushHookEffects();
        expect(credentialField(screen, 'cloud-account').props.value).toEqual(cloud);
        expect(credentialField(screen, 'computer-access').props.value).toEqual(cua);
        expect(route.push).not.toHaveBeenCalled();
        expect(actionInputs('machines.managed.acquire')).toHaveLength(0);
        await screen.unmount();
    });
    it('lets a new launch choose credential-free selectors before connecting an account', async () => {
        const serverId = await setupHome();
        const local = { ...provisioner, descriptor: { ...provisioner.descriptor,
            credentialPurposeRequirements: [cloudPurpose, cuaPurpose].map(({ purpose }) => ({
                purpose, optionalWhen: { op: 'eq' as const, path: 'cpu', value: 2 },
            })) }, credentialPurposes: provisioner.credentialPurposes!.map(entry => ({ ...entry, options: [] })) };
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId, execution: { ok: true,
                result: { controller, provisioners: [local] } } } };
        } });
        const action = projectionReply.projection.actionsById[buildQualifiedPluginContributionKey({ pluginId: contribution.pluginId, localId: 'options' })]!;
        action.occurrenceId = local.occurrenceId;
        action.inputHints = { fields: [{ path: 'cpu', title: 'CPU cores', widget: 'integer', required: true }] };
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderAccountScreen(<ManagedMachineConfigurationView serverId={serverId}
            provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={controller} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.connect:cloud-account')).not.toBeNull());
        expect(actionInputs('machines.provisioners.options')).toHaveLength(0);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:cpu')).not.toBeNull());
        await act(async () => screen.changeTextByTestId('managed-config.field:cpu', '2'));
        await waitForHomeGovernance(() => expect(actionInputs('machines.provisioners.options')).toContainEqual(expect.objectContaining({ selectors: { cpu: 2 } })));
        expect(actionInputs('machines.provisioners.options').every(input => !input || typeof input !== 'object' || !('credentials' in input))).toBe(true);
        expect(screen.findByTestId('managed-config.connect:cloud-account')).not.toBeNull();
        const { t } = await import('@/text');
        expect(screen.tree.findAll(node => node.props.title === t('managedMachines.receipt.account')
            && node.props.description === t('common.optional'))).not.toHaveLength(0);
        // Returning to the credentialed variant restores the account requirement before another read.
        const reads = actionInputs('machines.provisioners.options').length;
        await act(async () => screen.changeTextByTestId('managed-config.field:cpu', '3'));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.connect:cloud-account')).not.toBeNull());
        expect(actionInputs('machines.provisioners.options')).toHaveLength(reads);
        await screen.unmount();
    });
    it('uses a qualified credentialless native variant through current catalog, options and the shared configuration view', async () => {
        const serverId = await setupHome();
        const local = { ...provisioner, descriptor: { ...provisioner.descriptor, credentialPurposeRequirements: [cloudPurpose, cuaPurpose].map(({ purpose }) => ({
            purpose, optionalWhen: { op: 'eq' as const, path: 'cpu', value: 2 },
        })) } };
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId, execution: { ok: true,
                result: { controller, provisioners: [local] } } } };
        } });
        const saved = { id: 'saved-local', homeId: 'srv_credentials', revision: 1, name: 'Local launch', owner: { kind: 'account', accountId: 'owner' }, controller,
            launch: { provider: contribution, schemaVersion: 1, name: 'Local launch', choices: { cpu: 2 } } };
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
        const onUse = vi.fn();
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)}
            initialController={controller} presetId={saved.id} onUse={onUse} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false));
        expect(credentialControl(screen, 'cloud-account')).toBeDefined();
        expect(credentialField(screen, 'cloud-account').props.field.required).toBe(false);
        expect(actionInputs('machines.provisioners.options')).toContainEqual(expect.objectContaining({ controller }));
        expect(actionInputs('machines.provisioners.options').every(input => !input || typeof input !== 'object' || !('credentials' in input))).toBe(true);
        await act(async () => screen.pressByTestId('managed-config.use'));
        expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ kind: 'preset', id: saved.id }),
            receipt: expect.objectContaining({ launch: saved.launch }) }));
        await screen.unmount();
    });
    it('keeps omitted controller-authorized purposes unavailable instead of assuming credentialless access', async () => {
        const serverId = await setupHome();
        const withoutPurposeAuthorization = { ...provisioner, credentialPurposes: undefined };
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId, execution: { ok: true,
                result: { controller, provisioners: [withoutPurposeAuthorization] } } } };
        } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)} initialController={controller} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config' && node.props.receipt).length).toBeGreaterThan(0));
        await flushHookEffects();
        expect(actionInputs('machines.provisioners.check')).toHaveLength(0);
        expect(actionInputs('machines.provisioners.options')).toHaveLength(0);
        expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
        expect(screen.findByTestId('managed-config.save-preset')?.props.disabled).toBe(true);
        await screen.unmount();
    });

    it('preserves a preset credential receipt when purpose authorization is unavailable without admitting new reads or mutations', async () => {
        const serverId = await setupHome();
        const saved = { id: 'saved', homeId: 'srv_credentials', revision: 1, name: 'Saved machine', owner: { kind: 'account', accountId: 'owner' }, controller,
            launch: { provider: contribution, schemaVersion: 1, name: 'Saved machine', choices: { cpu: 2 }, credentials } };
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId, execution: { ok: true,
                result: { controller, provisioners: [{ ...provisioner, credentialPurposes: undefined }] } } } };
        } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)}
            presetId={saved.id} presetOnly initialController={controller} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config' && node.props.receipt?.name === saved.launch.name).length).toBeGreaterThan(0));
        await flushHookEffects();
        const receipt = screen.tree.findAll(node => node.props.testID === 'managed-config' && node.props.receipt)[0]?.props.receipt;
        expect(receipt.facts.filter((fact: { id: string }) => fact.id.startsWith('credential:'))).toHaveLength(2);
        expect(JSON.stringify(receipt.facts)).not.toContain('same-account');
        expect(actionInputs('machines.provisioners.check')).toHaveLength(0);
        expect(actionInputs('machines.provisioners.options')).toHaveLength(0);
        expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
        await screen.unmount();
    });

    it.each(['create', 'use'] as const)('selects each authorized purpose once and carries exact refs through check, options, save and %s', async mode => {
        const serverId = await setupHome();
        if (mode === 'create') await answerExternalActionAccountForHome(harness, serverId, {
            ...controller, actionId: 'machines.managed.acquire', tokenEpoch: 0,
            execute: () => ({ managedId: 'created' }),
        });
        const onUse = vi.fn();
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)}
            initialController={controller} {...(mode === 'use' ? { onUse } : {})} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config' && node.props.receipt).length).toBeGreaterThan(0));
        await flushHookEffects();
        expect(credentialControl(screen, 'cloud-account')).toBeDefined();
        expect(screen.tree.findAll(node => node.props.controlTestID === 'managed-config.credential:computer-access' && typeof node.props.onChange === 'function')).toHaveLength(1);
        expect(credentialField(screen, 'cloud-account').props.options).toEqual(expect.arrayContaining([
            expect.objectContaining({ value: cloud, label: 'Cloud work' }),
            expect.objectContaining({ value: otherCloud, label: 'Cloud personal' }),
        ]));
        expect(screen.findByTestId(`managed-config.${mode}`)?.props.disabled).toBe(true);
        await selectCredentials(screen);
        await waitForHomeGovernance(() => expect(screen.findByTestId(`managed-config.${mode}`)?.props.disabled).toBe(false));
        expect(actionInputs('machines.provisioners.check')).toContainEqual(expect.objectContaining({ controller, credentials }));
        expect(actionInputs('machines.provisioners.options')).toContainEqual(expect.objectContaining({ controller, credentials }));
        const receipt = screen.tree.findAll(node => node.props.testID === 'managed-config' && node.props.receipt)[0]?.props.receipt;
        expect(receipt.facts.filter((fact: { id: string }) => fact.id.startsWith('credential:'))).toHaveLength(2);
        expect(JSON.stringify(receipt.facts)).not.toContain('same-account');
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'saved', preset: { id: 'saved', homeId: 'srv_credentials', revision: 1, name: 'Virtual machine',
            owner: { kind: 'account', accountId: 'owner' }, controller, launch: { provider: contribution, schemaVersion: 1, name: 'Virtual machine', choices: { cpu: 2 }, credentials } } } });
        await act(async () => screen.pressByTestId('managed-config.save-preset'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1));
        expect(harness.requestsFor('/v1/machines/presets/create')[0]?.input).toMatchObject({ launch: { credentials } });
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.saved')).not.toBeNull());
        await waitForHomeGovernance(() => expect(screen.findByTestId(`managed-config.${mode}`)?.props.disabled).toBe(false));
        expect(actionInputs('machines.managed.acquire')).toHaveLength(0);
        await act(async () => screen.pressByTestId(`managed-config.${mode}`));
        if (mode === 'use') {
            expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ launch: expect.objectContaining({ credentials }) }),
                receipt: expect.objectContaining({ launch: expect.objectContaining({ credentials }) }) }));
            expect(actionInputs('machines.managed.acquire')).toHaveLength(0);
        } else await waitForHomeGovernance(() => {
            expect(actionInputs('machines.managed.acquire')).toContainEqual(expect.objectContaining({
                selection: expect.objectContaining({ launch: expect.objectContaining({ credentials }) }), reviewedFacts: expect.objectContaining({ launch: expect.objectContaining({ credentials }) }),
            }));
            expect(route.replace).toHaveBeenCalledWith(expect.stringContaining('/settings/machines/managed/created?'));
        });
        await screen.unmount();
    });

    it('edits preset purposes and retires unsupported refs on controller catalog change without choosing a default', async () => {
        const serverId = await setupHome();
        const saved = { id: 'saved', homeId: 'srv_credentials', revision: 1, name: 'Saved machine', owner: { kind: 'account', accountId: 'owner' }, controller,
            launch: { provider: contribution, schemaVersion: 1, name: 'Saved machine', choices: { cpu: 2 }, credentials } };
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)}
            presetId={saved.id} presetOnly initialController={controller} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.sizes:native')).not.toBeNull());
        expect(credentialControl(screen, 'cloud-account')).toBeDefined();
        await pressCredentialOption(screen, 'cloud-account', 'Cloud personal');
        await waitForHomeGovernance(() => expect(actionInputs('machines.provisioners.options')).toContainEqual(expect.objectContaining({ credentials: [
            { purpose: cloudPurpose, account: otherCloud }, { purpose: cuaPurpose, account: cua },
        ] })));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: { ...saved, revision: 2,
            launch: { ...saved.launch, credentials: [{ purpose: cloudPurpose, account: otherCloud }, { purpose: cuaPurpose, account: cua }] } } } });
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
        expect(harness.requestsFor('/v1/machines/presets/update')[0]?.input).toMatchObject({ patch: { launch: { credentials: [
            { purpose: cloudPurpose, account: otherCloud }, { purpose: cuaPurpose, account: cua },
        ] } } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId, execution: { ok: true,
                result: { controller: otherController, provisioners: [{ ...provisioner, occurrenceId: 'new-occurrence', credentialPurposes: [
                    { purpose: cloudPurpose, options: [{ value: cloud, label: 'Cloud work' }] },
                ] }] } } } };
        } });
        // Change "Managed from" through the header chip's own selection (its popover list is the canonical picker).
        const chip = screen.tree.findAll(node => node.props.presentation === 'chip' && node.props.selection)[0]!;
        const target = chip.props.selection.candidates.find((candidate: { target: { machineId: string } }) => candidate.target.machineId === otherController.machineId).target;
        await act(async () => chip.props.selection.selectTarget(target));
        expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(true);
        await waitForHomeGovernance(() => expect(credentialField(screen, 'cloud-account').props.selection).toBeUndefined());
        expect(screen.tree.findAll(node => node.props.controlTestID === 'managed-config.credential:computer-access')).toHaveLength(0);
        expect(actionInputs('machines.managed.acquire')).toHaveLength(0);
        await pressCredentialOption(screen, 'cloud-account', 'Cloud work');
        await waitForHomeGovernance(() => expect(actionInputs('machines.provisioners.check')).toContainEqual(expect.objectContaining({ controller: otherController,
            credentials: [{ purpose: cloudPurpose, account: cloud }] })));
        const newControllerReads = actionInputs('machines.provisioners.check').filter(input => input && typeof input === 'object' && 'controller' in input
            && JSON.stringify(input.controller) === JSON.stringify(otherController));
        expect(JSON.stringify(newControllerReads)).not.toContain('other-account');
        expect(JSON.stringify(newControllerReads)).not.toContain('computer-access');
        await screen.unmount();
    });

    it('invalidates reviewed options immediately on a credential change and ignores an older native answer', async () => {
        const serverId = await setupHome();
        const onUse = vi.fn();
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)}
            initialController={controller} onUse={onUse} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config' && node.props.receipt).length).toBeGreaterThan(0));
        await flushHookEffects();
        expect(credentialControl(screen, 'cloud-account')).toBeDefined();
        await selectCredentials(screen);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false));
        let releaseOlderAnswer: (() => void) | undefined;
        const olderAnswer = new Promise<void>(resolve => { releaseOlderAnswer = resolve; });
        harness.answer(serverId, '/v1/actions/machines.provisioners.options', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            const older = JSON.stringify(request.input).includes('other-account');
            return { ...(older ? { respondAfter: olderAnswer } : {}), body: { v: 1, actionId: 'machines.provisioners.options', requestId: request.requestId,
                execution: { ok: true, result: createManagedCpuOptionsFixture([{ id: 'native', title: 'Native compute', cpu: older ? 4 : 2 }]) } } };
        } });
        await pressCredentialOption(screen, 'cloud-account', 'Cloud personal');
        expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(true);
        expect(screen.findByTestId('managed-config.save-preset')?.props.disabled).toBe(true);
        await waitForHomeGovernance(() => expect(actionInputs('machines.provisioners.options')).toContainEqual(expect.objectContaining({ credentials: [
            { purpose: cloudPurpose, account: otherCloud }, { purpose: cuaPurpose, account: cua },
        ] })));
        await pressCredentialOption(screen, 'cloud-account', 'Cloud work');
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false));
        await act(async () => releaseOlderAnswer?.());
        await flushHookEffects();
        expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false);
        await act(async () => screen.pressByTestId('managed-config.use'));
        expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ launch: expect.objectContaining({ credentials, choices: { cpu: 2 } }) }) }));
        expect(actionInputs('machines.managed.acquire')).toHaveLength(0);
        await screen.unmount();
    });
});
