import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import {
  getActiveServerId,
  listServerProfiles,
  removeServerProfile,
  setActiveServerId,
} from '@/sync/domains/server/serverProfiles';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createReducer } from '@happier-dev/session-core/reducer';
import type { Message } from '@happier-dev/session-core/messages';
import { readReanimatedFrameCallbacks, resetReanimatedFrameCallbacks } from '@/dev/testkit/mocks/reanimated';

installDisconnectedServerSocketBoundary();
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock('expo-router/build/Route', () => ({ useRouteNode: () => null }));
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key) => key,
  }),
);
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
// The face's paint adapter is the platform boundary; the web one paints into the host canvas.
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
// Native Markdown is a third-party boundary; these rows render no Markdown.
vi.mock(
  'react-native-enriched-markdown/lib/module/web/streamingReveal.js',
  () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
  }),
);

const { storage } = await import('@/sync/domains/state/storageStore');
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { ModalProvider } = await import('@/modal/ModalProvider');
const { buildInboxSessionPresentation } =
  await import('@/activity/presentation/buildInboxSessionPresentation');
const { selectHomeCompletedBots } =
  await import('@/activity/presentation/selectHomeCompletedBots');
const { buildActivityOverviewFromCandidates } =
  await import('@/activity/attention/buildActivityOverviewSnapshot');
const { buildSessionActivityAttention } =
  await import('@/activity/attention/buildSessionActivityAttention');
const initialStorageState = storage.getState();

const SLOW_RENDER_TIMEOUT_MS = 240_000;
let harness: Awaited<ReturnType<typeof serveActionHomes>>;
let home = '';
const remoteResults = new Map<string, string | null>();
const initialServerId = getActiveServerId();
const initialProfileIds = new Set(
  listServerProfiles().map((profile) => profile.id),
);

/** A Session whose latest turn finished after the person last read it. */
function readySession(
  id: string,
  options: Readonly<{ bot: boolean; name: string; workflow?: boolean }>,
) {
  return createSessionFixture({
    id,
    serverId: home,
    encryptionMode: 'plain',
    active: false,
    presence: 1,
    seq: 4,
    latestTurnId: 'done',
    latestTurnStatus: 'completed',
    latestReadyEventSeq: 4,
    latestReadyEventAt: 500,
    sessionTurns: {
      v: 1,
      sessionId: id,
      updatedAt: 5,
      turns: [
        {
          turnId: 'done',
          startedAt: 1,
          updatedAt: 5,
          status: 'completed',
          transcriptAnchors: { finalAssistantMessageSeq: 4 },
          ...(options.workflow
            ? {
                workflowInvocation: {
                  runId: 'run-1',
                  invocationRecordId: 'record-1',
                },
              }
            : {}),
        },
      ],
    },
    metadata: {
      name: options.name,
      host: 'tester.local',
      path: '/Users/leeroy/repo',
      homeDir: '/Users/leeroy',
      machineId: 'machine-1',
      ...(options.bot ? { bot: { kind: 'bot' } } : {}),
    },
    viewer: {
      latestFailureSeq: null,
      readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: 4 },
      relevance: { relevant: true, reasons: ['owned_by_me'] },
      follow: { follows: false, notificationLevel: null },
      notification: { level: 'important', source: 'owner' },
      attention: {
        needsAttention: true,
        reasons: ['ready_after_read'],
        primary: 'ready_after_read',
        presentation: 'full',
      },
    },
  });
}

function transcript(id: string, text: string) {
  const message: Message = {
    kind: 'agent-text',
    id: `${id}-result`,
    seq: 4,
    createdAt: 4,
    localId: null,
    text,
  };
  return {
    messageIdsOldestFirst: [message.id],
    messagesById: { [message.id]: message },
    messagesMap: { [message.id]: message },
    reducerState: createReducer(),
    latestThinkingMessageId: null,
    latestThinkingMessageActivityAtMs: null,
    messagesVersion: 1,
    isLoaded: true,
  };
}

function seed(
  sessions: ReturnType<typeof readySession>[],
  messages: Record<string, ReturnType<typeof transcript>> = {},
) {
  storage.setState({
    profileScope: { serverId: home, accountId: 'me' },
    settingsScope: { serverId: home, accountId: 'me' },
    sessions: Object.fromEntries(
      sessions.map((session) => [session.id, session]),
    ),
    sessionMessages: messages,
    sessionListRowsByServerId: {
      [home]: Object.fromEntries(
        sessions.map((session) => [session.id, session]),
      ),
    },
    ordinarySessionListMembershipByServerId: {
      [home]: sessions.map((session) => session.id),
    },
    sessionListIndexByServerId: {},
    concurrentSessionListCacheByServerId: {},
    artifacts: {},
    friends: {},
    isDataReady: true,
  });
}

function nodesByTestId(tree: renderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(
    (node) =>
      typeof node.type === 'string' &&
      (node.props as { testID?: string }).testID === testID,
  );
}

function rowIds(tree: renderer.ReactTestRenderer): string[] {
  // Home ids may contain dots, so a row is the exact prefix followed by a bare Session id.
  const prefix = `home.completed-bots.${home}.`;
  return [...new Set(tree.root.findAll((node) => typeof node.type === 'string'
    && typeof (node.props as { testID?: unknown }).testID === 'string')
    .map((node) => (node.props as { testID: string }).testID)
    .filter((testID) => testID.startsWith(prefix) && !testID.slice(prefix.length).includes('.'))
    .map((testID) => testID.slice(prefix.length)))].sort();
}

function textOf(tree: renderer.ReactTestRenderer, testID: string): string {
  const [node] = nodesByTestId(tree, testID);
  const collect = (instance: renderer.ReactTestInstance): string =>
    instance.children.map((child) => typeof child === 'string' ? child : collect(child)).join(' ');
  return node ? collect(node) : '';
}

function readRequests() {
  return harness.requests
    .filter(({ path }) => /\/v2\/sessions\/[^/]+\/read-state$/.test(path))
    .map(({ path }) => path.split('/')[3])
    .sort();
}

async function renderSection(onCommit?: () => void, visibleIds?: ReadonlySet<string>) {
  const { HomeCompletedBots } = await import('./HomeCompletedBots');
  const { ItemList } = await import('@/components/ui/lists/ItemList');
  // The web face's pixel buffer is a DOM global this host renderer lacks.
  vi.stubGlobal('ImageData', class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
  // ItemList supplies the real viewport tracker. Its DOM content and face refs must have visible measurements.
  const content = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
  return (
    await renderScreen(
      <ModalProvider>
        {/* Home's page list: section headers and their actions take the page anatomy here. */}
        <ItemList>
          <React.Profiler id="home-completed-bots" onRender={() => onCommit?.()}>
            <HomeCompletedBots />
          </React.Profiler>
        </ItemList>
      </ModalProvider>,
      // Canvas paint and DOM geometry are the platform boundaries; viewport eligibility stays real.
      { createNodeMock: (node) => {
        if (node.type === 'canvas') return { getContext: () => ({ putImageData() {} }) };
        const testID = String(node.props.testID ?? '');
        const prefix = `home.completed-bots.${home}.`;
        const sessionId = testID.startsWith(prefix) ? testID.slice(prefix.length).split('.')[0] : null;
        const top = sessionId && visibleIds && !visibleIds.has(sessionId) ? 10_000 : 0;
        return { getBoundingClientRect: () => ({ left: 0, top, width: 800, height: 48 }),
          getInnerViewRef: () => content };
      } },
    )
  ).tree;
}

await loadSyncSingletonForTests();

describe('HomeCompletedBots', () => {
  beforeEach(async () => {
    remoteResults.clear();
    await loadSyncSingletonForTests();
    storage.setState(initialStorageState, true);
    harness = await serveActionHomes({
      homes: [
        { key: 'a', serverUrl: 'https://completed-bots.test', accountId: 'me' },
      ],
      route: ({ path }) => {
        const messages = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(path);
        if (messages) {
          const id = messages[1]!;
          const text = remoteResults.get(id);
          return Response.json({ messages: typeof text === 'string' ? [{ id: `${id}-result`, seq: 4,
            localId: null, createdAt: 4, updatedAt: 4, content: { t: 'plain', v: {
              role: 'agent', content: { type: 'output', data: { type: 'assistant', uuid: `${id}-result`,
                parentUuid: null, isSidechain: false,
                message: { role: 'assistant', content: [{ type: 'text', text }] } },
              },
            } },
          }] : [], hasMore: false });
        }
        if (path === '/v1/features' || path === '/v1/features/authenticated')
          return Response.json(
            createRootLayoutFeaturesResponse({
              features: {
                workflows: { enabled: false },
                automations: { enabled: false },
                social: { friends: { enabled: false } },
              },
            }),
          );
        if (path === '/v1/account/encryption/currentness')
          return Response.json(
            createPlainAccountEncryptionCurrentnessFixture(),
          );
        const read = /^\/v2\/sessions\/([^/]+)\/read-state$/.exec(path);
        if (!read) return undefined;
        const session = storage.getState().sessions[read[1]!];
        return Response.json({
          success: true,
          state: 'read',
          lastViewedSessionSeq: 4,
          didChange: true,
          viewer: {
            ...session!.viewer,
            readState: {
              state: 'tracking',
              lastViewedSessionSeq: 4,
              unreadSince: null,
            },
            attention: {
              needsAttention: false,
              reasons: [],
              primary: null,
              presentation: 'full',
            },
          },
        });
      },
    });
    home = harness.homes.a.id;
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(
      harness.homes.a.serverUrl,
    );
    if (!credentials)
      throw new Error('Expected the focused Home credential fixture');
    await (
      await import('@/sync/runtime/orchestration/connectionManager')
    ).restoreConnectionToActiveServer(credentials);
  });

  it('loads a cold visible completed Bot result without opening it, with one anchored message read', async () => {
    seed([readySession('cold', { bot: true, name: 'Release helper' })]);
    remoteResults.set('cold', 'The release notes are ready');
    const tree = await renderSection();
    await vi.waitFor(() => expect(textOf(tree, `home.completed-bots.${home}.cold`)).toContain('The release notes are ready'));
    const reads = harness.requests.filter(({ path }) => path.endsWith('/messages'));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.url.searchParams.get('limit')).toBe('1');
    expect(reads[0]!.url.searchParams.get('beforeSeq')).toBe('5');
    expect(storage.getState().sessionMessages.cold?.isLoaded).toBe(false);
    expect(readRequests()).toEqual([]);
  }, SLOW_RENDER_TIMEOUT_MS);

  it('reads only visible result rows in a large inventory and keeps a genuinely absent preview openable', async () => {
    const bots = Array.from({ length: 20 }, (_, n) => readySession(`bot-${n}`, { bot: true, name: `Helper ${n}` }));
    // Match the observed Account A census used by sessionDisplayBackfill.composed.test.ts (3,391 rows).
    const ordinary = Array.from({ length: 3_371 }, (_, n) => readySession(`ordinary-${n}`, { bot: false, name: `Work ${n}` }));
    seed([...bots, ...ordinary]);
    for (const bot of bots) remoteResults.set(bot.id, bot.id === 'bot-1' ? null : `Finished ${bot.id}`);
    const tree = await renderSection(undefined, new Set(['bot-0', 'bot-1']));
    await vi.waitFor(() => expect(textOf(tree, `home.completed-bots.${home}.bot-0`)).toContain('Finished bot-0'));
    const reads = harness.requests.filter(({ path }) => path.endsWith('/messages'));
    expect(reads.map(({ path }) => path.split('/')[3]).sort()).toEqual(['bot-0', 'bot-1']);
    expect(reads.every(({ url }) => url.searchParams.get('limit') === '1')).toBe(true);
    const unavailable = tree.root.findAll(node => node.props.testID === `home.completed-bots.${home}.bot-1`
      && typeof node.props.title === 'string')[0]!;
    expect(unavailable.props.subtitle).toBe('homeIndex.completedBotPreviewUnavailable');
    expect(unavailable.props.onPress).toBeTypeOf('function');
  }, SLOW_RENDER_TIMEOUT_MS);

  afterEach(async () => {
    await standardCleanup();
    await (
      await import('@/sync/runtime/orchestration/connectionManager')
    ).disconnectActiveServerConnection();
    await harness?.dispose();
    if (initialServerId) await setActiveServerId(initialServerId);
    if (home && !initialProfileIds.has(home)) await removeServerProfile(home);
    storage.setState(initialStorageState, true);
  });

  it(
    'lists exactly the ready Bots, keeps an unreadable result openable and marks only its own targets read',
    async () => {
      const triager = readySession('triager', {
        bot: true,
        name: 'Issue triager',
        workflow: true,
      });
      const metrics = readySession('metrics', { bot: true, name: 'Metrics', workflow: true });
      const ordinary = readySession('ordinary', {
        bot: false,
        name: 'Fix settings modal',
      });
      // The metrics transcript is not loaded on this device: its preview is unavailable.
      seed([triager, metrics, ordinary], {
        triager: transcript('triager', 'Triaged 9 new issues'),
      });
      const expected = selectHomeCompletedBots(
        buildInboxSessionPresentation({
          overview: buildActivityOverviewFromCandidates(
            [triager, metrics, ordinary].map((session) =>
              buildSessionActivityAttention({ session, nowMs: 1_000 }),
            ),
          ),
        }),
      );
      expect(
        expected.readySessions.map((candidate) => candidate.sessionId).sort(),
      ).toEqual(['metrics', 'triager']);

      resetReanimatedFrameCallbacks();
      const tree = await renderSection();
      expect(rowIds(tree)).toEqual(['metrics', 'triager']);
      const frames = () => readReanimatedFrameCallbacks().filter(record => record.handle.isActive && record.handle.callbackId !== -1);
      expect(frames()).toHaveLength(0);
      const face = nodesByTestId(tree, `home.completed-bots.${home}.triager`)[0]!;
      // Item also has a hover wrapper; the face owns the combined hover/press-in pointer surface.
      const hover = face.findAll(node => typeof node.type === 'string'
        && typeof node.props.onPointerEnter === 'function' && typeof node.props.onPointerDown === 'function')[0];
      expect(hover).toBeDefined();
      await act(async () => { hover!.props.onPointerEnter({ nativeEvent: { pointerType: 'mouse' } }); });
      expect(frames()).toHaveLength(1);
      await act(async () => {
        for (let n = 0; n < 120; n++) for (const record of frames())
          record.run({ timestamp: n * 16, timeSincePreviousFrame: 16, timeSinceFirstFrame: n * 16 });
      });
      expect(frames()).toHaveLength(0);
      expect(textOf(tree, `home.completed-bots.${home}.triager`)).toContain(
        'Triaged 9 new issues',
      );
      const metricsRow = tree.root.findAll(node => node.props.testID === `home.completed-bots.${home}.metrics`
        && typeof node.props.title === 'string')[0]!;
      expect(metricsRow.props.title).toBe('Metrics');
      // No preview is not no result: the row says so and stays the way in (Living PLAN "preview unavailable" and Open).
      expect(metricsRow.props.subtitle).toBe('homeIndex.completedBotPreviewUnavailable');
      expect(metricsRow.props.onPress).toBeTypeOf('function');
      // The turn names a run, but no loaded run supplies its name: no Habit label is invented.
      expect(
        textOf(tree, `home.completed-bots.${home}.triager.subtitle`),
      ).toBe('Issue triager');

      await act(async () => {
        storage.getState().upsertWorkflowRuns([
          workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'run-1', ownerAccountId: 'me' }),
            { kind: 'available', value: { title: 'Daily sweep' } }),
        ], { serverId: home, accountId: 'me' });
      });
      expect(textOf(tree, `home.completed-bots.${home}.metrics.subtitle`)).toBe('Daily sweep · homeIndex.completedBotPreviewUnavailable');
      expect(textOf(tree, `home.completed-bots.${home}.triager.subtitle`)).toBe('Issue triager · Daily sweep');

      await act(async () => {
        // The section's own control, wherever its button primitive puts the press handler.
        const [markAll] = tree.root.findAll((node) => (node.props as { testID?: string }).testID === 'home.completed-bots.mark_all_read'
          && typeof (node.props as { onPress?: unknown }).onPress === 'function');
        (markAll!.props as { onPress: () => void }).onPress();
      });
      await waitForHomeGovernance(() =>
        expect(readRequests()).toEqual(['metrics', 'triager']),
      );
      await waitForHomeGovernance(() =>
        expect(nodesByTestId(tree, 'home.completed-bots')).toHaveLength(0),
      );
      expect(readRequests()).not.toContain('ordinary');
    },
    SLOW_RENDER_TIMEOUT_MS,
  );

  it.each([
    { reason: 'network', readAvailability: 'disabled' },
    { reason: 'response', readAvailability: 'available' },
  ] as const)(
    'retains completed results with read $readAvailability after a classified $reason failure',
    async ({ reason }) => {
      seed([readySession('triager', { bot: true, name: 'Issue triager' })]);
      const tree = await renderSection();
      // Publish the admitted failed refresh after bootstrap settles; bootstrap owns its own observation.
      await act(async () => { storage.setState({ concurrentSessionListCacheByServerId: {
        [home]: { serverName: 'Completed Bots', listObservation: {
          phase: 'error', lastSuccessAt: 1, failure: { reason, code: null },
        } },
      } }); });
      expect(rowIds(tree)).toEqual(['triager']);
      const [markAll] = tree.root.findAll(node => node.props.testID === 'home.completed-bots.mark_all_read'
        && typeof node.props.onPress === 'function');
      expect(markAll!.props.disabled).toBe(reason === 'network');
      await act(async () => { markAll!.props.onPress(); });
      if (reason === 'network') {
        expect(readRequests()).toEqual([]);
        expect(rowIds(tree)).toEqual(['triager']);
      } else {
        await waitForHomeGovernance(() => expect(readRequests()).toEqual(['triager']));
        await waitForHomeGovernance(() => expect(nodesByTestId(tree, 'home.completed-bots')).toHaveLength(0));
      }
    },
    SLOW_RENDER_TIMEOUT_MS,
  );

  it(
    'is absent when no Bot result is unread',
    async () => {
      seed([
        readySession('ordinary', { bot: false, name: 'Fix settings modal' }),
      ]);
      const tree = await renderSection();
      expect(nodesByTestId(tree, 'home.completed-bots')).toHaveLength(0);
      expect(rowIds(tree)).toEqual([]);
    },
    SLOW_RENDER_TIMEOUT_MS,
  );

  it(
    'does not render for unrelated Session arrivals but publishes new completed Bots',
    async () => {
      const triager = readySession('triager', { bot: true, name: 'Issue triager' });
      const streamer = readySession('streamer', { bot: false, name: 'Fix settings modal' });
      seed([triager, streamer], { triager: transcript('triager', 'Triaged 9 new issues') });
      let commits = 0;
      const tree = await renderSection(() => { commits++; });
      await waitForHomeGovernance(() => expect(rowIds(tree)).toEqual(['triager']));
      // Let the row's own result demand settle first: count from a quiet section.
      let previous = -1;
      while (previous !== commits) {
        previous = commits;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
      }
      const settled = commits;
      // Tokens arrive on an unrelated Session: its transcript grows; no Home fact changes.
      for (let token = 1; token <= 5; token++) {
        await act(async () => {
          const messages = storage.getState().sessionMessages;
          storage.setState({ sessionMessages: { ...messages,
            streamer: { ...transcript('streamer', `partial ${token}`), messagesVersion: token + 1 } } });
        });
      }
      // A non-Bot row moves through the same Activity source, but changes no completed-Bot fact.
      for (let update = 1; update <= 5; update++) {
        await act(async () => {
          const state = storage.getState();
          const session = { ...state.sessions.streamer!,
            metadata: { ...state.sessions.streamer!.metadata!, name: `Unrelated Session ${update}` } };
          storage.setState({
            sessions: { ...state.sessions, streamer: session },
            sessionListRowsByServerId: { ...state.sessionListRowsByServerId,
              [home]: { ...state.sessionListRowsByServerId[home], streamer: session } },
          });
        });
      }
      expect(commits - settled).toBe(0);
      expect(rowIds(tree)).toEqual(['triager']);
      await act(async () => {
        const state = storage.getState();
        const session = { ...state.sessions.streamer!, viewer: undefined,
          active: true, presence: 'online' as const, thinking: true, thinkingAt: Date.now() - 1_000,
          latestTurnStatus: undefined, latestTurnStatusObservedAt: undefined,
          latestReadyEventSeq: undefined, latestReadyEventAt: undefined };
        storage.setState({ sessions: { ...state.sessions, streamer: session },
          sessionListRowsByServerId: { ...state.sessionListRowsByServerId,
            [home]: { ...state.sessionListRowsByServerId[home], streamer: session } } });
      });
      expect(commits - settled).toBe(0);
      await act(async () => {
        seed([triager, readySession('new-result', { bot: true, name: 'New completion' })], {
          triager: transcript('triager', 'Triaged 9 new issues'),
        });
      });
      await waitForHomeGovernance(() => expect(rowIds(tree)).toEqual(['new-result', 'triager']));
    },
    SLOW_RENDER_TIMEOUT_MS,
  );
});
