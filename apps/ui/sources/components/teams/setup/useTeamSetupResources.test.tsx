import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { renderHook, standardCleanup, teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainManagedMachinePresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useTeamSetupResources } = await import('@/components/teams/setup/useTeamSetupResources');

beforeEach(async () => { await homes.reset(); });
afterEach(async () => { standardCleanup(); await homes.reset(); });

it.each([
    { name: 'Team preset', groupIds: [], expected: 'team-preset' },
    { name: 'applicable Group preset', groupIds: ['engineering'], expected: 'group-preset' },
    { name: 'conflicting Groups fall back to Team', groupIds: ['engineering', 'support'], expected: 'team-preset' },
])('opens the $name through the ordinary preset owner', async ({ groupIds, expected }) => {
    onTestFinished(await installRealActionExecutorModuleLoader());
    const serverId = await homes.addHome({ name: 'Setup Home', serverUrl: 'https://setup-resources.example.test',
        serverIdentityId: 'srv_setup_resources', accountId: 'member', currentAccount: true, teamsEnabled: true });
    const address = { serverId, teamId: 'setup-team' };
    const scopeHook = await renderHook(() => useServerCredentialAccountScopeBinding(serverId));
    await waitForHomeGovernance(() => expect(scopeHook.getCurrent().binding?.isCurrent()).toBe(true));
    const lifetime = scopeHook.getCurrent().binding!;
    const summary = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: address.teamId });
    homes.answer(serverId, summary.path, { body: { teamId: address.teamId, kinds: [] } });
    homes.answer(serverId, '/v1/projects/sources', { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
    homes.answer(serverId, '/v1/machines/presets/recipient-census', {
        body: { kind: 'ready', contentEncryptionMode: 'plain', recipients: [] },
    });
    homes.answer(serverId, '/v1/machines/presets/get', { select: input => ({ body: { kind: 'found',
        preset: createPlainManagedMachinePresetFixture({
            id: String(Reflect.get(Object(input), 'id')), homeId: 'srv_setup_resources', revision: 1, name: 'Suggested setup',
            owner: { kind: 'account', accountId: 'member' },
            launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' },
        }),
    } }) });
    const team = teamSummaryFixture({ id: address.teamId, managedDefaultsGroupIds: groupIds,
        policy: teamPolicyFixture({ managedDefaultsStatus: 'available', managedDefaults: {
            team: { placement: { kind: 'preset', homeId: 'srv_setup_resources', presetId: 'team-preset' } },
            groups: {
                engineering: { placement: { kind: 'preset', homeId: 'srv_setup_resources', presetId: 'group-preset' } },
                support: { placement: { kind: 'preset', homeId: 'srv_setup_resources', presetId: 'support-preset' } },
            },
        } }),
    });
    const hook = await renderHook(() => useTeamSetupResources({ scope: lifetime.scope, address, team, lifetime }));
    try {
        await waitForHomeGovernance(() => expect(hook.getCurrent().preset?.state.value?.id).toBe(expected));
        expect(homes.requestsFor('/v1/teams/get')).toEqual([]);
    } finally { await hook.unmount(); await scopeHook.unmount(); }
});
