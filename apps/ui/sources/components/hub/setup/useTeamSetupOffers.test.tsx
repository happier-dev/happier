import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createHomeHubArtifactPortV1 } from '@happier-dev/protocol/home';
import { renderHook, standardCleanup, teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const homes = createHomeGovernanceHarness();
// Only HTTP, socket and native storage boundaries are substituted. Directory,
// Home Artifact persistence and Action dispatch remain their production owners.
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { bindPresentUserActionConfirmation } = await import('@/sync/ops/actions/presentUserConfirmation');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { useTeamSetupPlan } = await import('@/components/teams/setup/useTeamSetupPlan');
const { useTeamSetupOffers } = await import('./useTeamSetupOffers');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let restoreActions: (() => void) | undefined;
afterEach(async () => {
    standardCleanup();
    restoreActions?.();
    restoreActions = undefined;
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
});

it('offers the latest eligible join per Home and retires it after an Action dismissal or completed setup', async () => {
    const serverUrl = 'https://team-home-offers.test';
    const serverId = await homes.addHome({ name: 'Studio', serverUrl, accountId: 'member', teamsEnabled: true, active: true });
    const otherHome = await homes.addHome({ name: 'Other', serverUrl: 'https://other-team-home.test', accountId: 'member', teamsEnabled: true });
    await homes.selectHomes([serverId, otherHome]);
    const logo = { path: 'public/teams/team-a/logo/image.png', url: 'https://team-home-offers.test/team-logo.png' };
    const capabilities = teamCapabilitiesFixture({});
    // Eleven memberships are the owner's observed Home census. The newest
    // join is deliberately not first in the alphabetically ordered directory.
    homes.answer(serverId, '/v1/teams/list', { body: { items: [
        ...Array.from({ length: 8 }, (_, index) => teamSummaryFixture({ id: `old-${index}`, name: 'A previous Team', viewerJoinedAt: index, hasSetup: true, capabilities })),
        teamSummaryFixture({ id: 'team-a', name: 'Same name', viewerJoinedAt: 100, hasSetup: true, logo, capabilities }),
        teamSummaryFixture({ id: 'empty-newest', name: 'New empty Team', viewerJoinedAt: 1000, hasSetup: false, capabilities }),
        teamSummaryFixture({ id: 'unknown-join', name: 'Z legacy Team', capabilities }),
    ], nextCursor: null } });
    homes.answer(otherHome, '/v1/teams/list', { body: { items: [
        teamSummaryFixture({ id: 'team-a', name: 'Same name', viewerJoinedAt: 200, hasSetup: true, capabilities }),
    ], nextCursor: null } });
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'member', request: homes.request });
    installHomeGovernanceBoundaries(homes);
    restoreActions = await installRealActionExecutorModuleLoader();
    const scope = { serverId, accountId: 'member' };
    storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope });
    const wrapper = ({ children }: React.PropsWithChildren) =>
        <InjectedAuthProvider credentials={connection!.credentials}>{children}</InjectedAuthProvider>;
    let hook = await renderHook(useTeamSetupOffers, { wrapper });
    await vi.waitFor(() => expect(hook.getCurrent().offers).toHaveLength(2));
    const a = hook.getCurrent().offers.find(row => row.address.serverId === serverId)!;
    const b = hook.getCurrent().offers.find(row => row.address.serverId === otherHome)!;
    expect(a.address.teamId).toBe('team-a');
    expect(b.address.teamId).toBe('team-a');
    expect(a.logo).toEqual(logo);
    expect(a.stepId).not.toBe(b.stepId);
    expect(homes.requests.filter(request => /setup|saved-secrets|credential-resources/.test(request.path))).toEqual([]);
    const agent = createDefaultActionExecutor();
    const agentContext = { surface: 'agent', authority: 'account_automation', serverId, expectedAccountId: 'member' } as const;
    expect(await agent.execute('home.hub.layout.get', {}, agentContext)).toMatchObject({
        ok: true, result: { hiddenSetupStepIds: [] },
    });
    await act(async () => { await hook.getCurrent().dismiss(a.address); });
    await vi.waitFor(() => expect(hook.getCurrent().offers.map(row => row.stepId)).toEqual([b.stepId]));
    expect(await agent.execute('home.hub.layout.get', {}, agentContext)).toMatchObject({
        ok: true, result: { hiddenSetupStepIds: [a.stepId] },
    });
    await act(async () => {
        expect(await agent.execute('home.hub.layout.update', { intent: { kind: 'setup_visibility', stepId: b.stepId, hidden: true } }, agentContext))
            .toMatchObject({ ok: true, result: { hiddenSetupStepIds: expect.arrayContaining([a.stepId, b.stepId]) } });
        expect(await agent.execute('home.hub.layout.update', { intent: { kind: 'setup_visibility', stepId: a.stepId, hidden: false } }, agentContext))
            .toMatchObject({ ok: true, result: { hiddenSetupStepIds: [b.stepId] } });
    });
    await hook.unmount();
    hook = await renderHook(useTeamSetupOffers, { wrapper });
    await vi.waitFor(() => expect(hook.getCurrent().offers.map(row => row.stepId)).toEqual([a.stepId]));

    const account = await captureLazyActionAccountContext(serverId);
    let setup: 'prepared' | 'notRequired' = 'prepared';
    const workspace = { serverId, machineId: 'machine', workspaceId: 'workspace', rootPath: '/repo' };
    const executor = createActionExecutor({
        // The selected Machine returns its actual Open receipt shape at the RPC boundary.
        projectsOpen: async () => ({ kind: 'opened', workspace, directory: '/repo', setup }),
        homeHubArtifacts: createHomeHubArtifactPortV1(account.homeHubArtifactTransport, { accountId: 'member' }),
    });
    const execute = createFrontDoorActionExecute({ ...executor,
        executeConfirmed: (id, input, context) => executor.execute(id, input, bindPresentUserActionConfirmation(id, input, context ?? {})),
    });
    const context = { serverId, surface: 'ui' as const, authority: 'present_user' as const, expectedAccountId: 'member' };
    const plan = await renderHook(() => useTeamSetupPlan(execute, context));
    const source = { id: 'repo', revision: 1, name: 'Repo' };
    const prepared = await plan.getCurrent().prepare({ target: { serverId, homeId: 'home', machineId: 'machine' },
        repositories: [{ id: source.id, input: { source: { kind: 'folder', path: '/repo' }, materialization: { kind: 'attach' } } }],
        isCurrent: () => true });
    try {
        if (!prepared?.ok) throw new Error('Team setup did not prepare');
        const run = { plan: prepared.plan, selection: { team: a.address, lifetime: account.accountLifetime, sources: [source] } };
        await act(async () => {
            const result = await plan.getCurrent().run(run);
            expect(result.repositories).toMatchObject([{ result: { ok: true, result: { kind: 'opened', setup: 'prepared' } } }]);
        });
        expect(await agent.execute('home.hub.layout.get', {}, agentContext)).toMatchObject({ ok: true, result: { hiddenSetupStepIds: [b.stepId] } });
        setup = 'notRequired';
        await act(async () => {
            const result = await plan.getCurrent().run(run);
            expect(result.repositories).toMatchObject([{ result: { ok: true, result: { kind: 'opened', setup: 'notRequired' } } }]);
        });
        await expect.poll(() => agent.execute('home.hub.layout.get', {}, agentContext)).toMatchObject({
            ok: true, result: { hiddenSetupStepIds: expect.arrayContaining([a.stepId, b.stepId]) },
        });
    } finally {
        await plan.unmount();
        account.dispose();
    }
    expect(homes.requests.filter(request => request.method !== 'GET' && /\/account\/settings$/.test(request.path))).toEqual([]);
    await hook.unmount();
});
