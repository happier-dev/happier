import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { teamCapabilitiesFixture, teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { TeamPolicySetInputV1Schema, TeamSummaryV1Schema } from '@happier-dev/protocol/teams';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Generated bundled assets are a build boundary; the Settings, preset projection,
// Action dispatch and persisted policy schemas below remain real.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]),
    BUNDLED_PLUGIN_UI_APP_DECLARATIONS: Object.freeze([]),
    BUNDLED_PLUGIN_BRAND_MARKS: Object.freeze([]),
    BUNDLED_PLUGIN_PACKAGED_RESOURCES: Object.freeze([]),
}));
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
installSettingsViewCommonModuleMocks({ storage: 'real', text: () => vi.importActual('@/text'), modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
} });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
vi.doUnmock('@/sync/domains/state/storage');
const { TeamSettingsScreen } = await import('./TeamSettingsScreen');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
let restoreWebGlobals: (() => void) | undefined;

beforeEach(async () => {
    (await import('@/sync/store/teams/teamsSnapshots')).resetTeamsSnapshotsForTests();
    (await import('@/sync/engine/teams/teamsDirectoryEngine')).resetTeamsDirectoryEngineForTests();
    (await import('@/sync/ops/teams/teamActionClient')).resetTeamActionClientForTests();
    await harness.reset();
    restoreWebGlobals = withPopoverWebGlobals();
});
afterEach(async () => {
    await standardCleanup();
    restoreWebGlobals?.();
});

it('selects a pool preset in mounted Team Settings, retains its name, and clears only the Team placement', async () => {
    const homeId = 'srv_team_defaults';
    const serverId = await harness.addHome({ name: 'Team Home', serverUrl: 'https://defaults.example',
        serverIdentityId: homeId, accountId: 'admin', currentAccount: true, teamsEnabled: true });
    await harness.selectHomes([serverId]);
    const preset = ManagedMachinePresetV1Schema.parse({ id: 'pool-preset', homeId, revision: 2, name: 'Team container',
        owner: { kind: 'team', teamId: 'team-1' }, controllerPoolId: '00000000-0000-4000-8000-000000000001',
        launch: { provider: { pluginId: 'happier.machine.docker', localId: 'docker' }, schemaVersion: 1,
            name: 'Member container', choices: { image: 'node:22-bookworm' } } });
    const groups = { engineering: { placement: { kind: 'machine' as const, target: { serverId, machineId: 'group-machine' } } } };
    let team = teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        policy: teamPolicyFixture({ managedDefaults: { team: {}, groups }, managedDefaultsStatus: 'available' }) });
    const listPath = '/v1/machines/presets/list';
    const policyPath = '/v1/teams/policy/set';
    harness.answer(serverId, '/v1/teams/get', { select: () => ({ body: team }) });
    harness.answer(serverId, listPath, { body: { kind: 'listed', presets: [preset,
        ManagedMachinePresetV1Schema.parse({ ...preset, id: 'personal-preset', owner: { kind: 'account', accountId: 'admin' } }),
        ManagedMachinePresetV1Schema.parse({ ...preset, id: 'other-team-preset', owner: { kind: 'team', teamId: 'other-team' } }),
        { ...preset, id: 'archived-preset', archivedAt: 1 },
        { id: 'setup-only', homeId, revision: 1, name: 'Tools', owner: preset.owner, setup: { scripts: [{ body: 'echo ready' }] } },
    ] } });
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset } });
    harness.answer(serverId, policyPath, { select: input => {
        const request = TeamPolicySetInputV1Schema.parse(input);
        team = TeamSummaryV1Schema.parse({ ...team, policy: { ...team.policy, managedDefaults: request.managedDefaults } });
        return { body: team };
    } });

    const screen = await renderScreen(<TeamSettingsScreen serverId={serverId} teamId="team-1" />);
    const menu = () => screen.findAllByType(DropdownMenu).find(node =>
        node.props.itemTrigger?.itemProps?.testID === 'team-settings-member-defaults-machine');
    await waitForHomeGovernance(() => expect(menu()).toBeDefined());
    expect(harness.requestsFor(listPath)).toHaveLength(0);
    await act(async () => menu()!.props.onOpenChange(true));
    const offerId = `managed-machine:${homeId}:preset:${preset.id}:${preset.revision}`;
    await waitForHomeGovernance(() => expect(menu()!.props.items.map((item: { id: string }) => item.id)).toContain(offerId));
    expect(menu()!.props.items.map((item: { id: string }) => item.id)).toEqual(['__none__', offerId]);
    await act(async () => menu()!.props.onSelect(offerId));
    await waitForHomeGovernance(() => expect(harness.requestsFor(policyPath)).toHaveLength(1));
    expect(harness.requestsFor(policyPath)[0]!.input).toMatchObject({ managedDefaults: {
        team: { placement: { kind: 'preset', homeId, presetId: preset.id } }, groups,
    } });
    expect(team.policy.managedDefaults).toMatchObject({ team: { placement: { kind: 'preset', homeId, presetId: preset.id } }, groups });
    await waitForHomeGovernance(() => expect(menu()!.props.selectedId).toBe(offerId));
    expect(menu()!.props.itemTrigger.subtitle).toContain(preset.name);
    await act(async () => menu()!.props.onSelect(offerId));
    expect(harness.requestsFor(policyPath)).toHaveLength(1);
    await act(async () => menu()!.props.onOpenChange(false));
    await waitForHomeGovernance(() => expect(menu()!.props.itemTrigger.subtitle).toContain(preset.name));
    expect(harness.requestsFor(listPath)).toHaveLength(1);
    expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(1);
    await act(async () => menu()!.props.onOpenChange(true));
    await waitForHomeGovernance(() => expect(menu()!.props.items.map((item: { id: string }) => item.id)).toContain(offerId));
    await act(async () => menu()!.props.onSelect('__none__'));
    await waitForHomeGovernance(() => expect(harness.requestsFor(policyPath)).toHaveLength(2));
    expect(harness.requestsFor(policyPath)[1]!.input).toMatchObject({ managedDefaults: { team: {}, groups } });
    await waitForHomeGovernance(() => expect(menu()!.props.selectedId).toBe('__none__'));
    expect(harness.requestsFor(listPath)).toHaveLength(2);
    expect(harness.requestsFor('/v1/machines/managed/list')).toHaveLength(0);
    expect(harness.requestsFor('/v1/machines/managed/acquire')).toHaveLength(0);
});


it('offers owned and foreign-shared Machines and renders the typed refusal for an unusable default', async () => {
    const serverId = await harness.addHome({ name: 'Team Home', serverUrl: 'https://defaults-refused.example',
        accountId: 'admin', currentAccount: true, teamsEnabled: true });
    await harness.selectHomes([serverId]);
    const team = teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: true }),
        policy: teamPolicyFixture({ managedDefaults: { team: {}, groups: {} }, managedDefaultsStatus: 'available' }) });
    harness.answer(serverId, '/v1/teams/get', { body: team });
    harness.answer(serverId, '/v1/teams/policy/set', { status: 400,
        body: { error: 'managed_default_machine_not_member_usable' } });
    const { createMachineFixture } = await import('@/dev/testkit');
    const { createPlainSharedMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const shared = createPlainSharedMachineRowFixture({ id: 'admin-shared-machine', custodianAccountId: 'custodian' });
    // TH ruling: the whole accessible inventory is a candidate; only the server
    // decides whether every member can use the selection when policy is saved.
    const owned = createMachineFixture({ id: 'admin-owned-machine', isShared: false,
        active: true, activeAt: Date.now(), storageMode: 'plain' });
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    await publishMachineInventoryForTest({ serverId, accountId: 'admin' }, [createMachineFixture({
        id: shared.id, isShared: true, active: true, activeAt: Date.now(), storageMode: 'plain', access: shared.access,
    }), owned]);
    const screen = await renderScreen(<TeamSettingsScreen serverId={serverId} teamId="team-1" />);
    const menu = () => screen.findAllByType(DropdownMenu).find(node =>
        node.props.itemTrigger?.itemProps?.testID === 'team-settings-member-defaults-machine');
    await waitForHomeGovernance(() => expect(menu()).toBeDefined());
    await act(async () => menu()!.props.onOpenChange(true));
    await waitForHomeGovernance(() => expect(menu()!.props.items.some((item: { id: string }) => item.id === 'admin-shared-machine')).toBe(true));
    expect(menu()!.props.items.map((item: { id: string }) => item.id)).toContain(owned.id);
    await act(async () => menu()!.props.onSelect(owned.id));
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/teams/policy/set')).toHaveLength(1));
    expect(harness.requestsFor('/v1/teams/policy/set')[0]!.input).toMatchObject({ managedDefaults: {
        team: { placement: { kind: 'machine', target: { serverId, machineId: owned.id } } }, groups: {},
    } });
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain("Members can't use this Machine. Share it with the Team, or pick another."));
    expect(menu()!.props.selectedId).toBe('__none__');
});
