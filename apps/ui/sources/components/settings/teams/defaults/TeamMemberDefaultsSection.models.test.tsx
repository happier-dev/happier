import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { TeamCredentialResourceCatalogEntryV1Schema, TeamPolicySetInputV1Schema, TeamSummaryV1Schema } from '@happier-dev/protocol/teams';

import { createMachineFixture, renderScreen, standardCleanup, teamCapabilitiesFixture, teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit';
import { teamCredentialDisplayNameFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createProviderModelProjectionFixture, createProviderSettingsAccountHarness, createProviderSettingsHarness, installBundledProviderDeclarationsRpcBoundary, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { sessionModelSelectionKey } from '@/components/sessions/modelPicker/sessionModelSelectionKey';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

// Generated packaged artwork is an external build artifact, unrelated to catalog admission.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]), BUNDLED_PLUGIN_UI_APP_DECLARATIONS: Object.freeze([]),
    BUNDLED_PLUGIN_BRAND_MARKS: Object.freeze([]), BUNDLED_PLUGIN_PACKAGED_RESOURCES: Object.freeze([]),
}));
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
installSettingsViewCommonModuleMocks({ storage: 'real', text: () => vi.importActual('@/text'), modal: async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module });
const account = createProviderSettingsAccountHarness();
const declarations = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(declarations);
const { TeamNewMembersScreen } = await import('../newMembers/TeamNewMembersScreen');
const { ModalProvider, Modal } = await import('@/modal');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { t } = await import('@/text');

const agentTargetKey = 'agent:happier.agent.codex/codex';
const modelId = 'gpt-6.1-sol';
const nativeRef = { agentTargetKey, providerConnectionId: null, modelId };
const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'shared-codex', teamId: 'team-1', displayName: teamCredentialDisplayNameFixture('Shared Codex'),
    resourceRevision: 3, readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
    directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
    sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
    providerModels: [{ selection: { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: 'shared-codex',
        expectedResourceRevision: 3, deliveryMode: 'brokered', agentTargetKey, modelId },
        descriptor: { id: modelId, name: 'GPT-6.1-Sol' }, sourceRevision: 'catalog-1', availability: 'available',
        application: { agentTargetKey, implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
            endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' } }],
});

beforeEach(async () => {
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    declarations.reset();
    installBundledProviderDeclarationsRpcBoundary(declarations);
    declarations.setResponse(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, createProviderModelProjectionFixture({
        agentTargetKey, groups: [], teamCredentialResources: [resource],
    }));
    // Shape captured from the live Codex agents.models.list answer on QA #164.
    declarations.setResponse(RPC_METHODS.CAPABILITIES_INVOKE, { ok: true, result: {
        availableModels: [{ id: modelId, name: 'GPT-6.1-Sol' }], supportsFreeform: false, source: 'dynamic', observedAt: Date.now(),
    } });
});
afterEach(async () => {
    await act(async () => { Modal.hideAll(); });
    await standardCleanup();
    await account.reset();
});

it.each(['native', 'team'] as const)('offers the selected Machine and Team models from mounted Team defaults and preserves the %s choice', async source => {
    const { serverId } = await account.restore({ accountId: 'admin', currentAccount: true, waivedActions: ['providers.models.refresh'],
        machines: [createMachineFixture({ id: 'machine-5964', activeAt: Date.now(), storageMode: 'plain' })],
        settings: { experiments: true, featureToggles: { providers: true } },
        features: createRootLayoutFeaturesResponse({ features: { providers: { enabled: true }, teams: {
            enabled: true, credentialResources: { enabled: true },
        } } }),
    });
    const groups = { engineering: { permissionModeByAgentTargetKey: { [agentTargetKey]: 'read-only' as const } } };
    let team = teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: true }), policy: teamPolicyFixture({
        managedDefaultsStatus: 'available', managedDefaults: { team: { placement: { kind: 'machine', target: {
            serverId, machineId: 'machine-5964',
        } } }, groups },
    }) });
    const home = account.home;
    home.answer(serverId, '/v1/teams/get', { select: () => ({ body: team }) });
    home.answer(serverId, '/v1/teams/list', { select: () => ({ body: { items: [team], nextCursor: null } }) });
    home.answer(serverId, '/v1/teams/credential-resources/entitled/discover', { body: { resources: [resource], nextCursor: null, failures: [] } });
    home.answer(serverId, '/v1/teams/credential-resources/entitled/list', { body: { resources: [resource], nextCursor: null } });
    home.answer(serverId, '/v1/teams/policy/set', { select: input => {
        const request = TeamPolicySetInputV1Schema.parse(input);
        team = TeamSummaryV1Schema.parse({ ...team, policy: { ...team.policy, managedDefaults: request.managedDefaults } });
        return { body: team };
    } });

    // The real settings root owns Team loading and save/refetch; only the platform modal host is supplied.
    const screen = await renderScreen(<ModalProvider><TeamNewMembersScreen serverId={serverId} teamId="team-1" /></ModalProvider>);
    const rowId = 'team-new-members-defaults-agent:codex:model';
    const agent = () => screen.findAll(node => node.props.testID === 'team-new-members-defaults-agent:codex'
        && typeof node.props.onExpandedChange === 'function')[0];
    // Codex has no Team value, so it waits behind "Other Agents" (design review 2026-11-17).
    await openOtherAgents(screen, 'team-new-members-defaults');
    await waitForHomeGovernance(() => expect(agent()).toBeDefined());
    expect(declarations.state.requests.some(request => request.method === RPC_METHODS.CAPABILITIES_INVOKE)).toBe(false);
    await act(async () => { agent()!.props.onExpandedChange(true); });
    await screen.pressByTestIdAsync(rowId);
    const selection = resource.providerModels[0]!.selection;
    const optionId = 'model-picker-overlay-option:' + sessionModelSelectionKey(source === 'native' ? nativeRef : selection);
    await waitForHomeGovernance(() => {
        expect(screen.findByTestId(optionId), screen.getTextContent()).not.toBeNull();
        expect(screen.findByTestId(optionId)?.props.disabled).not.toBe(true);
    });
    await screen.pressByTestIdAsync(optionId);
    await waitForHomeGovernance(() => expect(home.requestsFor('/v1/teams/policy/set')).toHaveLength(1));
    const expected = source === 'native' ? { v: 1, ref: nativeRef } : { v: 2, ref: {
        source: 'team_resource', teamId: selection.teamId, resourceId: selection.resourceId,
        expectedResourceRevision: selection.expectedResourceRevision, deliveryMode: selection.deliveryMode, agentTargetKey, modelId,
    } };
    expect(team.policy.managedDefaults).toMatchObject({ team: { modelByAgentTargetKey: {
        [agentTargetKey]: { ...expected, updatedAt: expect.any(Number) },
    } }, groups });
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('GPT-6.1-Sol'));
});

it('shows a failed Team model catalog and reloads it without losing native choices', async () => {
    const { serverId } = await account.restore({ accountId: 'admin', currentAccount: true, waivedActions: ['providers.models.refresh'],
        machines: [createMachineFixture({ id: 'machine-5964', activeAt: Date.now(), storageMode: 'plain' })],
        settings: { experiments: true, featureToggles: { providers: true } },
        features: createRootLayoutFeaturesResponse({ features: { providers: { enabled: true }, teams: {
            enabled: true, credentialResources: { enabled: true },
        } } }),
    });
    const team = teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: true }), policy: teamPolicyFixture({
        managedDefaultsStatus: 'available', managedDefaults: { team: { placement: { kind: 'machine', target: {
            serverId, machineId: 'machine-5964',
        } } }, groups: {} },
    }) });
    account.home.answer(serverId, '/v1/teams/get', { body: team });
    account.home.answer(serverId, '/v1/teams/list', { body: { items: [team], nextCursor: null } });
    account.home.answer(serverId, '/v1/teams/credential-resources/entitled/discover', { body: { resources: [resource], nextCursor: null, failures: [] } });
    account.home.answer(serverId, '/v1/teams/credential-resources/entitled/list', { body: { resources: [resource], nextCursor: null } });
    let declarationsUnavailable = true;
    const healthyDeclarations = declarations.state.interceptors.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)!;
    // The physical daemon transport rejects declaration reads until Refresh succeeds.
    declarations.intercept(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, (request, next) => {
        if (declarationsUnavailable) return Promise.reject(new Error('Transport unavailable'));
        return healthyDeclarations(request, next);
    });
    const screen = await renderScreen(<ModalProvider><TeamNewMembersScreen serverId={serverId} teamId="team-1" /></ModalProvider>);
    const agent = () => screen.findAll(node => node.props.testID === 'team-new-members-defaults-agent:codex'
        && typeof node.props.onExpandedChange === 'function')[0];
    // Codex has no Team value, so it waits behind "Other Agents" (design review 2026-11-17).
    await openOtherAgents(screen, 'team-new-members-defaults');
    await waitForHomeGovernance(() => expect(agent()).toBeDefined());
    await act(async () => { agent()!.props.onExpandedChange(true); });
    await screen.pressByTestIdAsync('team-new-members-defaults-agent:codex:model');
    const nativeOptionId = 'model-picker-overlay-option:' + sessionModelSelectionKey(nativeRef);
    await waitForHomeGovernance(() => {
        expect(screen.findByTestId(nativeOptionId)).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('teams.errors.loadFailed'));
    });
    declarationsUnavailable = false;
    await screen.pressByTestIdAsync('model-picker-overlay-refresh');
    const teamOptionId = 'model-picker-overlay-option:' + sessionModelSelectionKey(resource.providerModels[0]!.selection);
    await waitForHomeGovernance(() => {
        expect(screen.findByTestId(teamOptionId)).not.toBeNull();
        expect(screen.findByTestId(teamOptionId)?.props.disabled).not.toBe(true);
        expect(screen.findByTestId(nativeOptionId)).not.toBeNull();
        expect(screen.getTextContent()).not.toContain(t('teams.errors.loadFailed'));
    });
});

it('shows what an empty project field falls back to, whose it is, and names it on the clear row', async () => {
    const { serverId } = await account.restore({ accountId: 'admin', currentAccount: true, waivedActions: ['providers.models.refresh'],
        machines: [createMachineFixture({ id: 'machine-5964', activeAt: Date.now(), storageMode: 'plain' })],
        settings: { experiments: true, featureToggles: { providers: true } },
        features: createRootLayoutFeaturesResponse({ features: { providers: { enabled: true }, teams: { enabled: true } } }),
    });
    const { ProjectSessionDefaultsSection } = await import('./TeamMemberDefaultsSection');
    const save = vi.fn(async () => {});
    // The project's shared Source sets Codex to read-only; nothing is set For me.
    const context = { primaryTeamId: null, projectDefaults: { permissionModeByAgentTargetKey: { [agentTargetKey]: 'read-only' as const } } };
    const screen = await renderScreen(<ModalProvider><ProjectSessionDefaultsSection testID="defaults" serverId={serverId} teamId={null}
        defaults={{}} save={save} scope="personal-project" context={context} teamName="Acme" projectName="acme/web"
        editable busy={false} /></ModalProvider>);
    const agent = () => screen.findAll(node => node.props.testID === 'defaults-agent:codex'
        && typeof node.props.onExpandedChange === 'function')[0];
    await waitForHomeGovernance(() => expect(agent()).toBeDefined());
    await act(async () => { agent()!.props.onExpandedChange(true); });
    const source = t('teams.settings.memberDefaults.sourceTeamProject', { team: 'Acme', project: 'acme/web' });
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(source));
    const { getPermissionModeOptionsForAgentType } = await import('@/sync/domains/permissions/permissionModeOptions');
    const readOnly = getPermissionModeOptionsForAgentType('codex', 'settings').find(option => option.value === 'read-only')!.label;
    // The field shows the value a new session falls back to; the clear row names what it restores.
    const permissionMenu = screen.findAll(node => Array.isArray(node.props.items)
        && node.props.items.some((item: { testID?: string }) => item.testID === 'defaults-agent:codex:permission:none'))[0];
    expect(permissionMenu).toBeDefined();
    expect(permissionMenu!.props.items[0]).toMatchObject({ title: t('teams.settings.memberDefaults.useDefault', { value: readOnly }), subtitle: source });
    expect(permissionMenu!.props.itemTrigger.detailFormatter(permissionMenu!.props.items[0])).toBe(readOnly);
    expect(save).not.toHaveBeenCalled();
});

async function openOtherAgents(screen: Awaited<ReturnType<typeof renderScreen>>, prefix: string) {
    const others = () => screen.findAll(node => node.props.testID === `${prefix}-otherAgents`
        && typeof node.props.onExpandedChange === 'function')[0];
    await waitForHomeGovernance(() => expect(others()).toBeDefined());
    await act(async () => { others()!.props.onExpandedChange(true); });
}

it('lists only Agents with a value at some layer and keeps the rest behind one Other Agents row', async () => {
    const { serverId } = await account.restore({ accountId: 'admin', currentAccount: true, waivedActions: ['providers.models.refresh'],
        machines: [createMachineFixture({ id: 'machine-5964', activeAt: Date.now(), storageMode: 'plain' })],
        settings: { experiments: true, featureToggles: { providers: true } },
        features: createRootLayoutFeaturesResponse({ features: { providers: { enabled: true }, teams: { enabled: true } } }),
    });
    const { ProjectSessionDefaultsSection } = await import('./TeamMemberDefaultsSection');
    // Only Codex has a value (from the project's shared Source); nothing is set For me.
    const context = { primaryTeamId: null, projectDefaults: { permissionModeByAgentTargetKey: { [agentTargetKey]: 'read-only' as const } } };
    const screen = await renderScreen(<ModalProvider><ProjectSessionDefaultsSection testID="defaults" serverId={serverId} teamId={null}
        defaults={{}} save={vi.fn(async () => {})} scope="personal-project" context={context} teamName="Acme" projectName="acme/web"
        editable busy={false} /></ModalProvider>);
    const agentRows = () => screen.findAll(node => typeof node.props.testID === 'string' && /^defaults-agent:[^:]+$/.test(node.props.testID)
        && typeof node.props.onExpandedChange === 'function').map(node => node.props.testID as string)
        .filter((id, index, ids) => ids.indexOf(id) === index);
    await waitForHomeGovernance(() => expect(agentRows()).toEqual(['defaults-agent:codex']));
    // Collapsed, an Agent with nothing set here names the values it inherits (lab L11), not "None" or the source.
    const { getPermissionModeOptionsForAgentType } = await import('@/sync/domains/permissions/permissionModeOptions');
    const readOnly = getPermissionModeOptionsForAgentType('codex', 'settings').find(option => option.value === 'read-only')!.label;
    const header = screen.findAll(node => node.props.testID === 'defaults-agent:codex:header' && node.props.subtitle !== undefined)[0];
    expect(header?.props.subtitle).toBe(readOnly);
    await openOtherAgents(screen, 'defaults');
    await waitForHomeGovernance(() => expect(agentRows().length).toBeGreaterThan(1));
});
