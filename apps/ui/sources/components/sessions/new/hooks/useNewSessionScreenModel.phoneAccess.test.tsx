import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createMachineFixture,
  renderHook,
  standardCleanup,
  teamSummaryFixture,
  teamPolicyFixture,
  teamCapabilitiesFixture,
} from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installNewSessionScreenModelCommonModuleMocks } from './newSessionScreenModelTestHelpers';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { SessionAccessEditorProps } from '@/components/sessions/access/sessionAccessEditorTypes';

// This model never renders Markdown; only the external rendering dependency is replaced.
vi.mock(
  'react-native-enriched-markdown/lib/module/web/streamingReveal.js',
  () => ({ splitStreamingRevealTextParts: () => [] }),
);
installNewSessionScreenModelCommonModuleMocks({
  routerConfig: { pathname: '/', params: {} },
  // A phone: the window width is the platform boundary that selects the compact composer layout.
  reactNative: async () => {
    const { createReactNativeWebMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      useWindowDimensions: () => ({
        width: 390,
        height: 844,
        scale: 3,
        fontScale: 1,
      }),
    });
  },
});
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { upsertAndActivateServer } =
  await import('@/sync/domains/server/serverRuntime');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } =
  await import('@/sync/runtime/orchestration/connectionManager');
const { useNewSessionScreenModel } = await import('./useNewSessionScreenModel');
const { prepareSessionDraftPersistenceStorage } =
  await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { applyTeamProjection, resetTeamsSnapshotsForTests } =
  await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } =
  await import('@/sync/engine/teams/teamsDirectoryEngine');

beforeEach(async () => {
  network.resetRequests();
  storage.setState(storage.getInitialState(), true);
  resetTeamsSnapshotsForTests();
  await prepareSessionDraftPersistenceStorage();
});
afterEach(async () => {
  standardCleanup();
  resetTeamsDirectoryEngineForTests();
  resetTeamsSnapshotsForTests();
  await disconnectActiveServerConnection();
});
afterAll(() => network.dispose());

// Native QA (mac-outer, docked phone composer): "+" → Session access opened a launch-surface overlay boxed into the
// 175 pt docked host, so the access editor had ~40 pt and no options. On a phone, as everywhere, the editor opens in
// the composer's own popover: the "+" menu row pushes it like "Runs through", and nothing overlays the launch surface.
describe('Session access on a phone-width New Session composer', () => {
  it('opens its editor in the composer popover rather than a launch-surface overlay', async () => {
    const home = await network.addHome('https://phone-access.test', 'member-p');
    const team = teamSummaryFixture({
      policy: teamPolicyFixture({}),
      viewerRole: 'member',
      capabilities: teamCapabilitiesFixture({}),
    });
    network.setHttpResponder(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/features')
        return Response.json(
          createRootLayoutFeaturesResponse({
            features: { teams: { enabled: true } },
          }),
        );
      if (path === '/v1/teams/list')
        return Response.json({ items: [team], nextCursor: null });
      if (path === '/v1/teams/get') return Response.json(team);
      return null;
    });
    await upsertAndActivateServer({ serverUrl: home.serverUrl });
    await restoreConnectionToActiveServer({ token: home.token });
    const scope = { serverId: home.id, accountId: 'member-p' };
    await vi.waitFor(() =>
      expect(storage.getState().settingsScope).toEqual(scope),
    );
    storage.setState({
      profileScope: scope,
      settingsScope: scope,
      settings: { ...settingsDefaults, useEnhancedSessionWizard: false },
    });
    storage
      .getState()
      .applyMachines(
        [
          createMachineFixture({
            id: 'machine-1',
            active: true,
            storageMode: 'plain',
          }),
        ],
        false,
        { sourceServerId: home.id },
      );
    applyTeamProjection({
      scope,
      address: { serverId: home.id, teamId: 'team-1' },
      observedAt: 1,
      team,
    });
    const model = await renderHook(() =>
      useNewSessionScreenModel({ draftId: 'phone-access' }),
    );
    const current = () => {
      const value = model.getCurrent();
      if (value.variant !== 'simple') throw new Error('Expected Home composer');
      return value;
    };
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          current().simpleProps.agentInputExtraActionChips?.some(
            (chip) => chip.key === 'session-access',
          ),
        ).toBe(true),
      );
    });
    const chip = current().simpleProps.agentInputExtraActionChips!.find(
      (chip) => chip.key === 'session-access',
    )!;
    // The "+" menu row pushes the editor inside the menu instead of leaving it for another surface.
    expect(chip.collapsedAction).toBeUndefined();
    const render = chip.collapsedContentPopover?.renderContent;
    if (typeof render !== 'function')
      throw new Error('Expected the access editor in the composer popover');
    const editor = render({ requestClose: () => {}, maxHeight: 600 });
    expect(React.isValidElement<SessionAccessEditorProps>(editor)).toBe(true);
        await model.unmount();
  });
});
