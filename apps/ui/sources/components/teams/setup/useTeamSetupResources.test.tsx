import * as React from 'react';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { renderHook, renderScreen, standardCleanup, teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit';
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
    const scopeHook = await renderHook(() => useServerCredentialAccountScopeBinding(serverId));
    await waitForHomeGovernance(() => expect(scopeHook.getCurrent().binding?.isCurrent()).toBe(true));
    const lifetime = scopeHook.getCurrent().binding!;
    const address = { serverId: lifetime.scope.serverId, teamId: 'setup-team' };
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

it.each([
    { sources: 'repository and repository-free Sources', secondRepository: false },
    { sources: 'repository-only Sources', secondRepository: true },
])('shows the admitted Project Source total and owner refusals inside Joined for $sources', async ({ secondRepository }) => {
    onTestFinished(await installRealActionExecutorModuleLoader());
    const serverId = await homes.addHome({ name: 'Joined Home', serverUrl: 'https://joined-resources.example.test',
        serverIdentityId: 'srv_joined_resources', accountId: 'member', currentAccount: true, teamsEnabled: true });
    const scopeHook = await renderHook(() => useServerCredentialAccountScopeBinding(serverId));
    await waitForHomeGovernance(() => expect(scopeHook.getCurrent().binding?.isCurrent()).toBe(true));
    const lifetime = scopeHook.getCurrent().binding!;
    const address = { serverId: lifetime.scope.serverId, teamId: 'joined-team' };
    const summary = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: address.teamId });
    homes.answer(serverId, summary.path, { body: { teamId: address.teamId, kinds: [
        { kind: 'projectSources', status: 'available', count: 2 },
        { kind: 'credentials', status: 'unavailable', count: null, reason: 'team_authentication_required' },
        { kind: 'sessions', status: 'available', count: 0 },
    ] } });
    const repository = { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'team/application' }, protocol: 'https' };
    homes.answer(serverId, '/v1/projects/sources', { body: { ok: true, sources: [
        { id: 'shared-app', revision: 1, name: 'Team application', audience: [], createdByAccountId: 'member', repository },
        { id: 'shared-tools', revision: 1, name: 'Team tools', audience: [], createdByAccountId: 'member',
            ...(secondRepository ? { repository } : {}) },
    ], coverage: { complete: true, nextCursor: null } } });
    const { TeamJoinedCard } = await import('@/components/teams/join/TeamJoinedCard');
    const { TeamJoinedSummary } = await import('@/components/teams/join/TeamJoinedSummary');
    const { t } = await import('@/text');
    const team = teamSummaryFixture({ id: address.teamId, policy: teamPolicyFixture({ managedDefaults: null }) });
    const screen = await renderScreen(<TeamJoinedCard testID="joined" result={{ outcome: 'joined', teamId: address.teamId }}
        teamName={team.name} accountScope={lifetime.scope} onOpenTeam={() => {}}
        summary={<TeamJoinedSummary testID="joined-resources" context={{ scope: lifetime.scope, address, team, lifetime }} />} />);
    try {
        await waitForHomeGovernance(() => expect(screen.findByTestId('joined-resources-projectSources'), screen.getTextContent()).not.toBeNull());
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Team application'));
        expect(screen.getTextContent()).toContain('Team tools');
        expect(screen.getTextContent()).toContain(t('teams.overview.shared.kinds.projectSources'));
        expect(screen.getTextContent()).toMatch(/\b2\b/);
        expect(screen.getTextContent()).not.toContain(t('teams.join.summary.repositories', { count: 2 }));
        expect(screen.findByTestId('joined-resources-credentials')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('teams.join.summary.unavailable'));
        expect(screen.findByTestId('joined-resources-sessions')).toBeNull();
        expect(screen.findByTestId('joined-action')).not.toBeNull();
    } finally { await screen.unmount(); await scopeHook.unmount(); }
});

it.each(['source_backend_unavailable', 'source_unavailable'] as const)(
    'keeps Team setup unknown until Sources settle and offers recovery for %s', async (failure) => {
        onTestFinished(await installRealActionExecutorModuleLoader());
        const serverId = await homes.addHome({ name: 'Setup Home', serverUrl: 'https://setup-state.example.test',
            serverIdentityId: 'srv_setup_state', accountId: 'member', currentAccount: true, teamsEnabled: true });
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        storage.getState().activateProfileScope({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'member' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const team = teamSummaryFixture({ id: 'setup-state-team', policy: teamPolicyFixture({ managedDefaults: null }) });
        homes.answer(serverId, '/v1/teams/get', { body: team });
        const summary = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: team.id });
        homes.answer(serverId, summary.path, { body: { teamId: team.id, kinds: [] } });
        let release!: () => void;
        const respondAfter = new Promise<void>(resolve => { release = resolve; });
        homes.answer(serverId, '/v1/projects/sources', { respondAfter, body: { ok: false, error: failure } });
        const { TeamSetupScreen } = await import('./TeamSetupScreen');
        const screen = await renderScreen(<TeamSetupScreen serverId={serverId} teamId={team.id} />);
        try {
            await waitForHomeGovernance(() => expect(homes.requests.some(request => request.path.split('?')[0] === '/v1/projects/sources'), screen.getTextContent()).toBe(true));
            await waitForHomeGovernance(() => expect(screen.findByTestId('team-setup-header')).not.toBeNull());
            expect(screen.findByTestId('team-setup-empty')).toBeNull();
            expect(screen.findByTestId('team-setup-sources-loading')).not.toBeNull();
            release();
            await waitForHomeGovernance(() => expect(screen.findByTestId('team-setup-sources-failed'), screen.getTextContent()).not.toBeNull());
            expect(screen.findByTestId('team-setup-empty')).toBeNull();
            homes.answer(serverId, '/v1/projects/sources', { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
            await screen.pressByTestIdAsync('team-setup-sources-failed-action');
            await waitForHomeGovernance(() => expect(screen.findByTestId('team-setup-empty'), screen.getTextContent()).not.toBeNull());
            expect(screen.findByTestId('team-setup-sources-loading')).toBeNull();
            expect(screen.findByTestId('team-setup-sources-failed')).toBeNull();
        } finally { release(); await screen.unmount(); }
    },
);
