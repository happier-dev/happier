import * as React from 'react';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { renderHook, renderScreen, standardCleanup, teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainManagedMachinePresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { act } from 'react-test-renderer';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { useTeamSetupResources } = await import('@/components/teams/setup/useTeamSetupResources');

it('reopens an exact held checkout on cold Team Setup entry without offering a fresh Run', async () => {
    onTestFinished(await installRealActionExecutorModuleLoader());
    const serverId = await homes.addHome({ name: 'Setup Home', serverUrl: 'https://setup-cold-hold.example.test',
        serverIdentityId: 'srv_setup_cold_hold', accountId: 'member', currentAccount: true, teamsEnabled: true });
    const [{ storage }, { getActiveServerSnapshot }, { publishAppliedActiveServerSnapshot }, { resolveServerProfileScopeIdForIdentifier },
        { actionOperationStore }, { reconcileActionOperationsOnce }, { TeamSetupScreen }, { TeamSetupPlanProvider },
        { createFrontDoorActionExecute }, { ModalProvider }] = await Promise.all([
        import('@/sync/domains/state/storageStore'), import('@/sync/domains/server/serverRuntime'),
        import('@/sync/runtime/orchestration/appliedActiveServerRuntime'), import('@/sync/domains/server/serverProfiles'),
        import('@/sync/domains/actionOperations/actionOperationStore'), import('@/sync/domains/actionOperations/actionOperationRuntime'),
        import('./TeamSetupScreen'), import('./TeamSetupPlanProvider'),
        import('@/sync/ops/actions/frontDoorRuntimeActionExecutor'), import('@/modal'),
    ]);
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'member' };
    storage.getState().activateProfileScope(scope);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    onTestFinished(() => actionOperationStore.reset());
    const team = teamSummaryFixture({ id: 'cold-team', policy: teamPolicyFixture({ managedDefaults: null }) });
    homes.answer(serverId, '/v1/teams/get', { body: team });
    const summary = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: team.id });
    homes.answer(serverId, summary.path, { body: { teamId: team.id, kinds: [{ kind: 'projectSources', status: 'available', count: 2 }] } });
    const laterSource = { id: 'shared-later', revision: 1, name: 'Later checkout', audience: [], createdByAccountId: 'member',
        repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: 'team/later' }, protocol: 'https' } };
    const earlierSource = { ...laterSource, id: 'shared-earlier', name: 'Earlier checkout' };
    homes.answer(serverId, '/v1/projects/sources', { body: { ok: true, sources: [earlierSource, laterSource],
        coverage: { complete: true, nextCursor: null } } });
    const source = { sourceId: 'shared-later', revision: 1 };
    const machineId = 'member-machine';
    homes.answer(serverId, '/v1/machines/member-machine', { body: {
        machine: createPlainMachineRowFixture({ id: machineId, accountId: scope.accountId }),
    } });
    const checkout = { id: 'exact-checkout', serverId: scope.serverId, machineId, rootPath: '/checkout/later', source, createdAtMs: 1 };
    storage.getState().activateProjectAccountRowsScope(scope);
    storage.getState().applyProjectAccountRowsForScope(scope, { scope, status: 'ready', coverage: 'complete',
        workspaceRefs: [{ ...checkout, id: 'other-checkout', rootPath: '/other',
            source: { sourceId: earlierSource.id, revision: earlierSource.revision } }, checkout],
        relationships: [], organizations: [], revisionsByPhysicalKey: {} });
    const held = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'exact-hold', revision: 1,
        actionId: 'projects.prepare', state: 'accepted', title: 'Later checkout setup', createdAt: 2, cancellation: 'supported',
        scope: { accountId: scope.accountId, machineId }, domainRef: { kind: 'projectCommand', purpose: 'setup', serverId: scope.serverId,
            machineId, workspaceRefId: checkout.id, cwd: checkout.rootPath,
            sourceWorkspace: { serverId: scope.serverId, machineId, workspaceId: checkout.id, rootPath: checkout.rootPath } },
        setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'held-effect',
            reviewedEffect: { commands: [] } },
    });
    const screen = await renderScreen(<ModalProvider><TeamSetupPlanProvider execute={createFrontDoorActionExecute()}
        context={{ surface: 'ui', serverId, expectedAccountId: 'member' }}>
        <TeamSetupScreen serverId={serverId} teamId={team.id} />
    </TeamSetupPlanProvider></ModalProvider>);
    try {
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-setup-repository:shared-later')).not.toBeNull());
        const list = vi.fn(async () => ({ items: [held], nextCursor: null }));
        await act(async () => reconcileActionOperationsOnce({ scope: { ...scope, machineId }, list }));
        expect(screen.findByTestId('team-setup-run')).toBeNull();
        expect(screen.findByTestId('team-setup-repository-include:shared-earlier')).not.toBeNull();
        // The page opens on the Machine the hold waits on (none was chosen on this device): the rail stays with the
        // held review as its one pointer, every row says where it lives there, and the other include is locked.
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('/checkout/later'));
        expect(screen.getTextContent()).toContain('/other');
        expect(screen.findByTestId('team-setup-before')).not.toBeNull();
        expect(screen.findByTestId('team-setup-held')).not.toBeNull();
        expect(screen.findByTestId('team-setup-repository-include:shared-earlier')?.props.disabled).toBe(true);
        expect(screen.findByTestId('team-setup-repository-include:shared-later')).toBeNull();
        await screen.pressByTestIdAsync('team-setup-repository:shared-later');
        await waitForHomeGovernance(() => expect(screen.findByTestId('project-setup-session-review:exact-hold')).not.toBeNull());
        expect(list).toHaveBeenCalledOnce();
        expect(homes.requests.some(request => /\/actions\/(projects\.open|projects\.prepare)(?:\/|$)/.test(request.path))).toBe(false);
    } finally { await screen.unmount(); }
});

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
    { sources: 'repository and repository-free Sources', firstRepository: true, secondRepository: false },
    { sources: 'repository-only Sources', firstRepository: true, secondRepository: true },
    { sources: 'repository-free Sources only', firstRepository: false, secondRepository: false },
])('shows the admitted Project Source total in Joined and setup for $sources', async ({ firstRepository, secondRepository }) => {
    onTestFinished(await installRealActionExecutorModuleLoader());
    const serverId = await homes.addHome({ name: 'Joined Home', serverUrl: 'https://joined-resources.example.test',
        serverIdentityId: 'srv_joined_resources', accountId: 'member', currentAccount: true,
        teamsEnabled: true, credentialResourcesEnabled: true });
    homes.answer(serverId, TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1, {
        body: { resources: [], nextCursor: null, failures: [] },
    });
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
        { id: 'shared-app', revision: 1, name: 'Team application', audience: [], createdByAccountId: 'member',
            ...(firstRepository ? { repository } : {}) },
        { id: 'shared-tools', revision: 1, name: 'Team tools', audience: [], createdByAccountId: 'member',
            ...(secondRepository ? { repository } : {}) },
    ], coverage: { complete: true, nextCursor: null } } });
    const { TeamJoinedCard } = await import('@/components/teams/join/TeamJoinedCard');
    const { TeamJoinedSummary } = await import('@/components/teams/join/TeamJoinedSummary');
    const { t } = await import('@/text');
    const team = teamSummaryFixture({ id: address.teamId, policy: teamPolicyFixture({ managedDefaults: null }) });
    homes.answer(serverId, '/v1/teams/get', { body: team });
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    storage.getState().activateProfileScope({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'member' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const screen = await renderScreen(<TeamJoinedCard testID="joined" result={{ outcome: 'joined', teamId: address.teamId }}
        teamName={team.name} accountScope={lifetime.scope} onOpenTeam={() => {}}
        summary={<TeamJoinedSummary testID="joined-resources" context={{ scope: lifetime.scope, address, team, lifetime }} />} />);
    try {
        await waitForHomeGovernance(() => expect(screen.findByTestId('joined-resources-projectSources'), screen.getTextContent()).not.toBeNull());
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Team application'));
        expect(screen.getTextContent()).toContain('Team tools');
        expect(screen.getTextContent()).toContain(t('teams.join.summary.projectSources', { count: 2 }));
        expect(screen.getTextContent()).toMatch(/\b2\b/);
        expect(screen.getTextContent()).not.toContain(t('teams.join.summary.repositories', { count: 2 }));
        expect(screen.findByTestId('joined-resources-credentials')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('teams.join.summary.unavailable'));
        expect(homes.requestsFor(TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1)).toHaveLength(0);
        expect(screen.findByTestId('joined-resources-sessions')).toBeNull();
        expect(screen.findByTestId('joined-action')).not.toBeNull();
    } finally { await screen.unmount(); }
    const { TeamSetupScreen } = await import('./TeamSetupScreen');
    const { TeamSetupPlanProvider } = await import('./TeamSetupPlanProvider');
    const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
    const setup = await renderScreen(<TeamSetupPlanProvider execute={createFrontDoorActionExecute()} context={{ surface: 'ui', serverId, expectedAccountId: 'member' }}>
        <TeamSetupScreen serverId={serverId} teamId={team.id} />
    </TeamSetupPlanProvider>);
    try {
        const row = secondRepository ? 'team-setup-repository:shared-tools' : 'team-setup-source:shared-tools';
        await waitForHomeGovernance(() => expect(setup.findByTestId(row), setup.getTextContent()).not.toBeNull());
        await waitForHomeGovernance(() => expect(homes.requestsFor(TEAM_CREDENTIAL_RESOURCE_DISCOVERY_PATH_V1)).toHaveLength(1));
        expect(setup.findByTestId('team-setup-empty')).toBeNull();
        if (!secondRepository) expect(setup.findByTestId('team-setup-repository-include:shared-tools')).toBeNull();
    } finally { await setup.unmount(); await scopeHook.unmount(); }
});

it('keeps the admitted Joined summary in place while Home refreshes it', async () => {
    onTestFinished(await installRealActionExecutorModuleLoader());
    const serverId = await homes.addHome({ name: 'Joined Home', serverUrl: 'https://joined-refresh.example.test',
        serverIdentityId: 'srv_joined_refresh', accountId: 'member', currentAccount: true, teamsEnabled: true });
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'member' };
    storage.getState().activateProfileScope(scope);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const address = { serverId: scope.serverId, teamId: 'joined-team' };
    const summary = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: address.teamId });
    homes.answer(serverId, summary.path, { body: {
        teamId: address.teamId, kinds: [{ kind: 'sessions', status: 'available', count: 1 }],
    } });
    homes.answer(serverId, '/v1/projects/sources', { body: { ok: true, sources: [], coverage: { complete: true, nextCursor: null } } });
    const { TeamJoinedSummaryForTeam } = await import('@/components/teams/join/TeamJoinedSummary');
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const { t } = await import('@/text');
    const team = teamSummaryFixture({ id: address.teamId, policy: teamPolicyFixture({ managedDefaults: null }) });
    homes.answer(serverId, '/v1/teams/get', { body: team });
    const screen = await renderScreen(<TeamJoinedSummaryForTeam testID="joined-resources" scope={scope} teamId={address.teamId} />);
    let finishRefresh!: () => void;
    const respondAfter = new Promise<void>(resolve => { finishRefresh = resolve; });
    try {
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('teams.join.summary.sessions', { count: 1 })));
        const readsBeforeRefresh = homes.requestsFor(summary.path).length;
        homes.answer(serverId, summary.path, { respondAfter, body: {
            teamId: address.teamId, kinds: [{ kind: 'sessions', status: 'available', count: 2 }],
        } });
        await act(async () => publishHomeAccountChange(scope.serverId));
        await waitForHomeGovernance(() => expect(homes.requestsFor(summary.path)).toHaveLength(readsBeforeRefresh + 1));
        expect(screen.getTextContent()).toContain(t('teams.join.summary.sessions', { count: 1 }));
        finishRefresh();
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('teams.join.summary.sessions', { count: 2 })));
    } finally {
        finishRefresh();
        await screen.unmount();
    }
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
        const { TeamSetupPlanProvider } = await import('./TeamSetupPlanProvider');
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const screen = await renderScreen(<TeamSetupPlanProvider execute={createFrontDoorActionExecute()} context={{ surface: 'ui', serverId, expectedAccountId: 'member' }}>
            <TeamSetupScreen serverId={serverId} teamId={team.id} />
        </TeamSetupPlanProvider>);
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
