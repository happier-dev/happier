import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  renderHook,
  renderScreen,
  standardCleanup,
  teamCapabilitiesFixture,
  teamSummaryFixture,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const nav = vi.hoisted(() => ({ pushed: [] as unknown[] }));
// The router is the platform boundary: it records where Set up leads. The Teams directory, the
// offer owner and the Home layout dismissal run their production owners behind Home HTTP.
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  const router = createExpoRouterMock();
  router.spies.push.mockImplementation((href: unknown) => {
    nav.pushed.push(href);
  });
  return router.module;
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
const { useTeamSetupItems } = await import('./useTeamSetupItems');
let connection:
  | Awaited<ReturnType<typeof restoreServerAccountForTest>>
  | undefined;
let restoreActions: (() => void) | undefined;
afterEach(async () => {
  standardCleanup();
  nav.pushed.length = 0;
  restoreActions?.();
  restoreActions = undefined;
  await connection?.dispose();
  connection = undefined;
  await homes.reset();
});

it('draws the latest Team as one Set up block that opens its setup page and hides on dismiss', async () => {
  const serverUrl = 'https://team-setup-tiles.test';
  const serverId = await homes.addHome({
    name: 'Studio',
    serverUrl,
    accountId: 'member',
    teamsEnabled: true,
    active: true,
  });
  await homes.selectHomes([serverId]);
  const capabilities = teamCapabilitiesFixture({});
  homes.answer(serverId, '/v1/teams/list', {
    body: {
      items: [
        teamSummaryFixture({
          id: 'team-old',
          name: 'Acme Labs',
          viewerJoinedAt: 1,
          hasSetup: true,
          capabilities,
        }),
        teamSummaryFixture({
          id: 'team-new',
          name: 'Acme',
          viewerJoinedAt: 2,
          hasSetup: true,
          capabilities,
        }),
      ],
      nextCursor: null,
    },
  });
  connection = await restoreServerAccountForTest({
    serverUrl,
    accountId: 'member',
    request: homes.request,
  });
  installHomeGovernanceBoundaries(homes);
  restoreActions = await installRealActionExecutorModuleLoader();
  const scope = { serverId, accountId: 'member' };
  storage.setState({
    isDataReady: true,
    profileScope: scope,
    settingsScope: scope,
  });
  const wrapper = ({ children }: React.PropsWithChildren) => (
    <InjectedAuthProvider credentials={connection!.credentials}>
      {children}
    </InjectedAuthProvider>
  );

  const hook = await renderHook(() => useTeamSetupItems({ layout: 'card' }), {
    wrapper,
  });
  await vi.waitFor(() => expect(hook.getCurrent()).toHaveLength(1));
  const item = hook.getCurrent()[0]!;
  const testID = `hub-setup.team:${serverId}:team-new`;
  const tile = await renderScreen(
    wrapper({ children: item.renderTile({ open: () => {} }) }),
  );
  expect(tile.findByTestId(testID)).toBeTruthy();

  await tile.pressByTestIdAsync(`${testID}.action`);
  expect(nav.pushed).toEqual([
    `/teams/team-new/setup?serverId=${encodeURIComponent(serverId)}`,
  ]);

  await tile.pressByTestIdAsync(`${testID}.dismiss`);
  await vi.waitFor(() => expect(hook.getCurrent()).toHaveLength(0));
  await tile.unmount();
  await hook.unmount();
});
