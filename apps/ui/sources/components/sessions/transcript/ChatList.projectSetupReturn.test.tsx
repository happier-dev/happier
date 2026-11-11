import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createTestSessionTranscriptSource, renderWithSessionTranscriptSource } from '@/dev/testkit/sessionTranscriptSource';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import type { PluginUiNewSessionSeedOriginV1 } from '@happier-dev/protocol/plugins/ui';
import {
  installTranscriptCommonModuleMocks,
  resetTranscriptCommonModuleMockState,
} from './transcriptTestHelpers';

installTranscriptCommonModuleMocks({ storage: importOriginal => importOriginal() });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await installRealActionExecutorModuleLoader();

const shared = vi.hoisted(() => ({ navigation: [] as unknown[] }));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  initialWindowMetrics: null,
}));

// The native recycler is a platform boundary; the real footer and the Project return owner run beneath it.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@legendapp/list/react-native')>();
  const { createCapturingLegendListMock } =
    await import('@/dev/testkit/mocks/legendList');
  return createCapturingLegendListMock({ original: actual }).module;
});

vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({
    router: {
      push: (value: unknown) => {
        shared.navigation.push(value);
      },
    },
  }).module;
});

await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { ChatList } = await import('./ChatList');
const { ProjectSetupDraftHeader } = await import('@/components/projects/projectSetup/ProjectSetupReturn');
const { renderScreen } = await import('@/dev/testkit');

let scope: { serverId: string; accountId: string };
let origin: PluginUiNewSessionSeedOriginV1;

beforeEach(async () => {
  await loadSyncSingletonForTests();
  // A graph imported before the endpoint mocks still uses the real HTTP owner.
  // Answer its actual byte transport too, through the same Home responses.
  const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
  setRuntimeFetch((url, init) => homes.request(url, init));
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      Number(setTimeout(() => callback(Date.now()), 0)),
    );
    vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
      clearTimeout(handle),
    );
  }
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Project return', serverUrl: 'https://project-return.test', accountId: 'account-1' });
  homes.answer(serverId, '/v2/cursor', { body: { cursor: '0' } });
  const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
  await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://project-return.test')!.token! });
  scope = { serverId, accountId: 'account-1' };
  origin = { kind: 'project', accountId: scope.accountId, page: 'scripts',
    workspace: { serverId, workspaceId: 'w1', machineId: 'm1', rootPath: '/repo/feature' } };
});

afterEach(async () => {
  await standardCleanup();
  const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
  await disconnectActiveServerConnection();
  const { resetRuntimeFetch } = await import('@/utils/system/runtimeFetch');
  resetRuntimeFetch();
  await homes.reset();
  resetTranscriptCommonModuleMockState();
  storage.setState(storage.getInitialState(), true);
  vi.unstubAllGlobals();
  shared.navigation = [];
});

/** The original checkout is an admitted Account Project row, read through the real `projects.list`. */
async function admitOriginCheckout() {
  homes.answer(scope.serverId, 'POST /v1/account/project-rows/list', {
    body: createPlainProjectAccountRowListFixture({ workspaceRefs: [{
      id: 'w1', serverId: scope.serverId, machineId: 'm1', rootPath: '/repo/feature',
      createdAtMs: 1, projectKey: 'p1',
    }] }),
  });
  const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
  const census = await createDefaultActionExecutor().execute('projects.list', { serverId: scope.serverId }, {
    surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId,
  });
  expect(census, JSON.stringify(census)).toMatchObject({ ok: true });
}

async function renderOriginSession(sessionOrigin: PluginUiNewSessionSeedOriginV1) {
  const session = createSessionFixture({
    serverId: scope.serverId,
    metadata: {
      path: '/elsewhere',
      host: 'other',
      machineId: 'm2',
      work: { authoringOriginV1: sessionOrigin },
    } as never,
    active: false,
  });
  await admitOriginCheckout();
  storage.setState({
    sessions: { [session.id]: session },
    profileScope: scope,
  });
  const source = createTestSessionTranscriptSource({ sessionId: session.id });
  return renderWithSessionTranscriptSource(
    <ChatList
      session={session}
      sessionSurfaceKey={JSON.stringify([scope.serverId, session.id])}
    />,
    source,
  );
}

describe('ChatList Project setup return', () => {
  it('returns a Session started from Changes to that comparison, never to Scripts', async () => {
    const screen = await renderOriginSession({ ...origin, page: 'changes', comparisonId: 'cmp-1' });
    await vi.waitFor(() =>
      expect(screen.findByTestId('project-setup-return.changes')).not.toBeNull(),
    );
    expect(screen.findByTestId('project-setup-return.scripts')).toBeNull();
    await act(async () => {
      screen.pressByTestId('project-setup-return.changes');
    });
    const [changes] = shared.navigation.map(String);
    expect(changes).toContain('/projects/w1/changes');
    expect(changes).toContain('comparisonId=cmp-1');
  });

  it('ends a setup Session with Back to Scripts and Review changes for its original checkout', async () => {
    const screen = await renderOriginSession(origin);
    await vi.waitFor(() =>
      expect(
        screen.findByTestId('project-setup-return.scripts'),
      ).not.toBeNull(),
    );
    await act(async () => {
      screen.pressByTestId('project-setup-return.scripts');
    });
    await act(async () => {
      screen.pressByTestId('project-setup-return.changes');
    });

    const [scripts, changes] = shared.navigation.map(String);
    expect(scripts).toContain('/projects/w1/scripts');
    expect(changes).toContain('/projects/w1/changes');
    // Never the launch Machine or folder.
    expect(`${scripts} ${changes}`).not.toContain('elsewhere');
  });

  it('draws nothing for an ordinary Session', async () => {
    const session = createSessionFixture({ metadata: null, active: false });
    storage.setState({
      sessions: { [session.id]: session },
      profileScope: scope,
    });
    const source = createTestSessionTranscriptSource({ sessionId: session.id });
    const screen = await renderWithSessionTranscriptSource(
      <ChatList
        session={session}
        sessionSurfaceKey={JSON.stringify(['server-1', session.id])}
      />,
      source,
    );
    expect(screen.findByTestId('project-setup-return')).toBeNull();
  });
});

describe('Project authoring draft header', () => {
  async function renderHeader(draftOrigin: PluginUiNewSessionSeedOriginV1) {
    await admitOriginCheckout();
    storage.setState({ profileScope: scope });
    return renderScreen(<ProjectSetupDraftHeader origin={draftOrigin} />);
  }

  it('titles a setup draft as setting up its checkout', async () => {
    const screen = await renderHeader(origin);
    await vi.waitFor(() => expect(screen.findByTestId('project-setup-draft-origin')).not.toBeNull());
    expect(screen.findByTestId('project-setup-draft-origin.header')).not.toBeNull();
  });

  it('says only where an Explain or Ask draft came from, never that it sets the project up', async () => {
    const screen = await renderHeader({ ...origin, page: 'changes', comparisonId: 'cmp-1' });
    await vi.waitFor(() => expect(screen.findByTestId('project-setup-draft-origin')).not.toBeNull());
    expect(screen.findByTestId('project-setup-draft-origin.header')).toBeNull();
  });
});
