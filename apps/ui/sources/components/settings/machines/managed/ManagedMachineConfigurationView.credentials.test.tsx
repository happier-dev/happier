import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dimensions } from 'react-native';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen, standardCleanup, flushHookEffects, findTestInstanceByTypeContainingText, pressTestInstanceAsync } from '@/dev/testkit';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { MachineProvisionersListResultV1Schema } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';

const route = vi.hoisted(() => ({ replace: vi.fn() }));
const nativeBoundary = vi.hoisted(() => ({ rpc: vi.fn() }));
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
let restoreViewport: (() => void) | undefined;
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
const provisioner = MachineProvisionersListResultV1Schema.parse({ controller, provisioners: [{ contribution, occurrenceId: 'occurrence', descriptor: {
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
    await harness.reset(); resetScopedHomeActionExecutorsForTests(); route.replace.mockReset(); nativeBoundary.rpc.mockReset();
    clearDaemonMergedProjectionCacheForTests(); resetMachineProjectionReadsForTests();
    const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1280, height: 844, scale: 1, fontScale: 1 });
    restoreViewport = () => viewport.mockRestore();
    const action = PluginProjectedActionV2Schema.parse({ id: 'options', pluginId: contribution.pluginId, occurrenceId: 'options-occurrence',
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

async function setupHome() {
    const serverId = await harness.addHome({ name: 'Compute', serverUrl: 'https://credential-purposes.example', serverIdentityId: 'srv_credentials', accountId: 'owner', currentAccount: true });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ id: controller.machineId, installationId: controller.installationId }),
        createMachineFixture({ id: otherController.machineId, installationId: otherController.installationId })] } });
    harness.answer(serverId, '/v1/machines', { body: [controller, otherController].map(target => ({ id: target.machineId, kind: 'persistent',
        installationId: target.installationId, active: true, revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null,
        access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } })) });
    for (const [actionId, result] of [
        ['machines.provisioners.list', { controller, provisioners: [provisioner] }],
        ['machines.provisioners.check', { available: true }],
        ['machines.provisioners.options', { choices: [{ id: 'native', title: 'Native compute', launch: { cpu: 2 } }] }],
        ['machines.managed.acquire', { managedId: 'created' }],
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
    // Select paints a radiogroup, not the text/toggle controlTestID host.
    return credentialField(screen, purpose).findAll(node => typeof node.type === 'string' && node.props.role === 'radiogroup')[0];
}
async function pressCredentialOption(screen: Screen, purpose: string, label: string) {
    const option = findTestInstanceByTypeContainingText(credentialField(screen, purpose), 'Pressable', label);
    expect(option?.props.role ?? option?.props.accessibilityRole).toBe('radio');
    await pressTestInstanceAsync(option);
}
async function selectCredentials(screen: Screen) {
    expect(credentialControl(screen, 'cloud-account')).toBeDefined();
    await pressCredentialOption(screen, 'cloud-account', 'Cloud work');
    await pressCredentialOption(screen, 'computer-access', 'Computer access');
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.choice:native')).not.toBeNull());
    await act(async () => screen.pressByTestId('managed-config.choice:native'));
}
function actionInputs(actionId: string) {
    return harness.requestsFor(`/v1/actions/${actionId}`).map(request => ExternalActionRequestEnvelopeV1Schema.parse(request.input).input);
}

describe('managed provisioner credential purposes', () => {
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
        const saved = { id: 'saved-local', homeId: 'srv_credentials', revision: 1, name: 'Local recipe', owner: { kind: 'account', accountId: 'owner' }, controller,
            recipe: { provider: contribution, schemaVersion: 1, name: 'Local recipe', choices: { cpu: 2 } } };
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
        const onUse = vi.fn();
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)}
            initialController={controller} presetId={saved.id} onUse={onUse} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.use')?.props.disabled).toBe(false));
        expect(screen.tree.findAll(node => String(node.props.controlTestID ?? '').startsWith('managed-config.credential:'))).toHaveLength(0);
        expect(actionInputs('machines.provisioners.options')).toContainEqual(expect.objectContaining({ controller }));
        expect(actionInputs('machines.provisioners.options').every(input => !input || typeof input !== 'object' || !('credentials' in input))).toBe(true);
        await act(async () => screen.pressByTestId('managed-config.use'));
        expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ kind: 'preset', id: saved.id }),
            receipt: expect.objectContaining({ launch: saved.recipe }) }));
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
            recipe: { provider: contribution, schemaVersion: 1, name: 'Saved machine', choices: { cpu: 2 }, credentials } };
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId, execution: { ok: true,
                result: { controller, provisioners: [{ ...provisioner, credentialPurposes: undefined }] } } } };
        } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)}
            presetId={saved.id} presetOnly initialController={controller} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config' && node.props.receipt?.name === saved.recipe.name).length).toBeGreaterThan(0));
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
        const onUse = vi.fn();
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)}
            initialController={controller} {...(mode === 'use' ? { onUse } : {})} />);
        await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config' && node.props.receipt).length).toBeGreaterThan(0));
        await flushHookEffects();
        expect(credentialControl(screen, 'cloud-account')).toBeDefined();
        expect(screen.tree.findAll(node => node.props.controlTestID === 'managed-config.credential:computer-access' && typeof node.props.onChange === 'function')).toHaveLength(1);
        expect(credentialField(screen, 'cloud-account').props.options).toEqual(expect.arrayContaining([{ value: cloud, label: 'Cloud work' }, { value: otherCloud, label: 'Cloud personal' }]));
        expect(screen.findByTestId(`managed-config.${mode}`)?.props.disabled).toBe(true);
        await selectCredentials(screen);
        await waitForHomeGovernance(() => expect(screen.findByTestId(`managed-config.${mode}`)?.props.disabled).toBe(false));
        expect(actionInputs('machines.provisioners.check')).toContainEqual(expect.objectContaining({ controller, credentials }));
        expect(actionInputs('machines.provisioners.options')).toContainEqual(expect.objectContaining({ controller, credentials }));
        const receipt = screen.tree.findAll(node => node.props.testID === 'managed-config' && node.props.receipt)[0]?.props.receipt;
        expect(receipt.facts.filter((fact: { id: string }) => fact.id.startsWith('credential:'))).toHaveLength(2);
        expect(JSON.stringify(receipt.facts)).not.toContain('same-account');
        harness.answer(serverId, '/v1/machines/presets/create', { body: { kind: 'saved', preset: { id: 'saved', homeId: 'srv_credentials', revision: 1, name: 'Virtual machine',
            owner: { kind: 'account', accountId: 'owner' }, controller, recipe: { provider: contribution, schemaVersion: 1, name: 'Virtual machine', choices: { cpu: 2 }, credentials } } } });
        await act(async () => screen.pressByTestId('managed-config.save-preset'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1));
        expect(harness.requestsFor('/v1/machines/presets/create')[0]?.input).toMatchObject({ recipe: { credentials } });
        expect(actionInputs('machines.managed.acquire')).toHaveLength(0);
        await act(async () => screen.pressByTestId(`managed-config.${mode}`));
        if (mode === 'use') {
            expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ selection: expect.objectContaining({ launch: expect.objectContaining({ credentials }) }),
                receipt: expect.objectContaining({ launch: expect.objectContaining({ credentials }) }) }));
            expect(actionInputs('machines.managed.acquire')).toHaveLength(0);
        } else await waitForHomeGovernance(() => expect(actionInputs('machines.managed.acquire')).toContainEqual(expect.objectContaining({
            selection: expect.objectContaining({ launch: expect.objectContaining({ credentials }) }), reviewedFacts: expect.objectContaining({ launch: expect.objectContaining({ credentials }) }),
        })));
        await screen.unmount();
    });

    it('edits preset purposes and retires unsupported refs on controller catalog change without choosing a default', async () => {
        const serverId = await setupHome();
        const saved = { id: 'saved', homeId: 'srv_credentials', revision: 1, name: 'Saved machine', owner: { kind: 'account', accountId: 'owner' }, controller,
            recipe: { provider: contribution, schemaVersion: 1, name: 'Saved machine', choices: { cpu: 2 }, credentials } };
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
        const { ManagedMachineConfigurationView } = await import('./ManagedMachineConfigurationView');
        const screen = await renderScreen(<ManagedMachineConfigurationView serverId={serverId} provisioner={buildQualifiedPluginContributionKey(contribution)}
            presetId={saved.id} presetOnly initialController={controller} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.choice:native')).not.toBeNull());
        expect(credentialControl(screen, 'cloud-account')).toBeDefined();
        await pressCredentialOption(screen, 'cloud-account', 'Cloud personal');
        await waitForHomeGovernance(() => expect(actionInputs('machines.provisioners.options')).toContainEqual(expect.objectContaining({ credentials: [
            { purpose: cloudPurpose, account: otherCloud }, { purpose: cuaPurpose, account: cua },
        ] })));
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: { ...saved, revision: 2,
            recipe: { ...saved.recipe, credentials: [{ purpose: cloudPurpose, account: otherCloud }, { purpose: cuaPurpose, account: cua }] } } } });
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
        expect(harness.requestsFor('/v1/machines/presets/update')[0]?.input).toMatchObject({ patch: { recipe: { credentials: [
            { purpose: cloudPurpose, account: otherCloud }, { purpose: cuaPurpose, account: cua },
        ] } } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { select: value => {
            const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
            return { body: { v: 1, actionId: 'machines.provisioners.list', requestId: request.requestId, execution: { ok: true,
                result: { controller: otherController, provisioners: [{ ...provisioner, occurrenceId: 'new-occurrence', credentialPurposes: [
                    { purpose: cloudPurpose, options: [{ value: cloud, label: 'Cloud work' }] },
                ] }] } } } };
        } });
        await act(async () => screen.pressByTestId(`managed-config.controller:${otherController.machineId}`));
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
                execution: { ok: true, result: { choices: [{ id: 'native', title: 'Native compute', launch: { cpu: older ? 4 : 2 } }] } } } };
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
