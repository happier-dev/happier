import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { buildHomeHubArtifactIdV1 } from '@happier-dev/protocol/home';
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

it('offers the latest join per Home without setup reads and never reveals older joins on dismissal', async () => {
    const serverUrl = 'https://team-home-offers.test';
    const serverId = await homes.addHome({ name: 'Studio', serverUrl, accountId: 'member', teamsEnabled: true, active: true });
    const otherHome = await homes.addHome({ name: 'Other', serverUrl: 'https://other-team-home.test', accountId: 'member', teamsEnabled: true });
    await homes.selectHomes([serverId, otherHome]);
    const logo = { path: 'public/teams/team-a/logo/image.png', url: 'https://team-home-offers.test/team-logo.png' };
    const capabilities = teamCapabilitiesFixture({});
    // Eleven memberships are the owner's observed Home census. The newest
    // join is deliberately not first in the alphabetically ordered directory.
    homes.answer(serverId, '/v1/teams/list', { body: { items: [
        ...Array.from({ length: 9 }, (_, index) => teamSummaryFixture({ id: `old-${index}`, name: 'A previous Team', viewerJoinedAt: index, capabilities })),
        teamSummaryFixture({ id: 'team-a', name: 'Same name', viewerJoinedAt: 100, logo, capabilities }),
        teamSummaryFixture({ id: 'unknown-join', name: 'Z legacy Team', capabilities }),
    ], nextCursor: null } });
    homes.answer(otherHome, '/v1/teams/list', { body: { items: [
        teamSummaryFixture({ id: 'team-a', name: 'Same name', viewerJoinedAt: 200, capabilities }),
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
    await act(async () => { await hook.getCurrent().dismiss(a.address); });
    await vi.waitFor(() => expect(hook.getCurrent().offers.map(row => row.stepId)).toEqual([b.stepId]));
    expect(homes.artifacts(serverId).readPlainBody(buildHomeHubArtifactIdV1('member'))).toContain(a.stepId);
    await hook.unmount();
    hook = await renderHook(useTeamSetupOffers, { wrapper });
    await vi.waitFor(() => expect(hook.getCurrent().offers.map(row => row.stepId)).toEqual([b.stepId]));
    await hook.unmount();
});
