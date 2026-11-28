/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import * as React from 'react';
import { act as domAct } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-test-renderer';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installWebLockManagerMock, type WebLockManagerMockHandle } from '@/auth/storage/tokenStorage.web.testHelpers';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import {
  AccountSettingsV2GetResponseSchema} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import {
  ActionsSettingsV1Schema} from '@happier-dev/protocol/actions/actionSettings';
import {
  CurrentCursorResponseSchema,
} from '@happier-dev/protocol/changes';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createLockedEncryptedSessionByIdResponseFixture, createPlainSessionByIdResponseFixture, createSessionFixture, createSessionListRenderableSessionFixture, createSessionOwnerViewerFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionFromListRenderable } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { perfFixtureId } from '../../../../../../packages/tests/src/testkit/stress/scenarios/perfProfile';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen, type RenderScreenResult } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storage';
import { replaceCollapsedGroupKeys } from '@/sync/domains/state/disclosureUiState';
import { ReorderSessionOrganizationRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import { encodeV2SessionListCursorV1 } from '@happier-dev/protocol/sessions/control/contract';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { Modal } from '@/modal';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { treeRowId } from '@/components/sessions/shell/drop-resolution/treeRowId';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { writeSessionOrganizationGroupOrder } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { AppRailBotEntry } from '@/components/navigation/shell/appRail/appRailModel';
import { t } from '@/text';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

// The Account, ordinary list/index, Bot classification, rows and actions stay real. Only
// native/navigation adapters and the external transports are replaced.
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(await vi.importActual('react-native-web')),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
// Bot faces paint through a platform adapter; the web one paints into a host canvas (none in this renderer).
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { navigate } }).module);
// Auth/storage imports reach Socket.IO before the harness can install a doMock.
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal),
);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

installDisconnectedServerSocketBoundary(socket => {
  socket.connect = vi.fn(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
});

// Transform the real roster graph during collection, after installing its transport boundary.
// A cold source import belongs outside the first interaction test's runtime budget.
await import('./BotsPopoverContent');

// No Home here answers a structural Session query: the roster reads the ordinary loaded rows.
const features = createRootLayoutFeaturesResponse({
  features: { sessions: { enabled: true } },
});
// One case opts its Home into structural queries and holds the Bot query open, as a cold load does.
const queryFeatures = createRootLayoutFeaturesResponse({
  features: { sessions: { enabled: true, filteredListing: { enabled: true } } },
});
let holdBotQuery = false;
let queriedBots: ReturnType<typeof createSessionFixture>[] | null = null;
let queriedCursors: Array<string | null> = [];
const botPageCursor = encodeV2SessionListCursorV1('bot-page-two');
let connection:
  | Awaited<ReturnType<typeof restoreServerAccountForTest>>
  | undefined;
let persistedOrder: string[] | null = null;
let askFirst = false;
let serveHealthyOrdinarySnapshot = false;
let ordinarySessions: ReturnType<typeof createSessionFixture>[] = [];
let webLocks: WebLockManagerMockHandle | undefined;
let transportRequests: Array<{ method: string; path: string }> = [];
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
const actionApprovalSettings = () => askFirst ? {
  actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.organization.move': { approvalRequiredSurfaces: ['ui'] } } }),
} : {};

// Renderer rows drive RN's native press callback; the DOM keyboard case below dispatches real events.
async function pressNativeBoundary(screen: RenderScreenResult, testID: string) {
  const control = [...screen.findAllByTestId(testID)].reverse().find(node => typeof node.type !== 'string' && typeof node.props.onPress === 'function');
  if (!control) throw new Error(`missing_native_press_boundary:${testID}`);
  await act(async () => { await control.props.onPress(); });
}

async function describeRosterState(screen: RenderScreenResult) {
  const { readOrdinarySessionListHomeState, getSessionListQueryHomeAvailability } = await import('@/sync/domains/session/listing/sessionListQueryRuntime');
  const serverId = resolveServerProfileScopeIdForIdentifier(connection!.home.id);
  const availability = getSessionListQueryHomeAvailability(serverId);
  return JSON.stringify({
    text: screen.getTextContent(), socketStatus: storage.getState().socketStatus, availability,
    ordinary: readOrdinarySessionListHomeState({ serverId, requestedQueryKey: 'roster-failure-diagnostic',
      online: availability === 'pending' ? null : availability === 'online' }),
  });
}

describe('Bots roster', () => {
  beforeAll(loadSyncSingletonForTests);
  beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    persistedOrder = null;
    askFirst = false;
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(false);
    serveHealthyOrdinarySnapshot = false;
    ordinarySessions = [];
    holdBotQuery = false;
    queriedBots = null;
    queriedCursors = [];
    artifacts.clear();
    transportRequests = [];
    navigate.mockClear();
    connection = await restoreServerAccountForTest({
      serverUrl: 'https://bots-roster.example.test',
      serverIdentityId: 'srv_bots-roster',
      accountId: 'account-a',
      request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        transportRequests.push({ method: init?.method ?? 'GET', path });
        if (path === '/health') return Response.json({ status: 'ok' });
        if (queriedBots && path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'account-a' }));
        if (path === '/v1/features') return Response.json(holdBotQuery || queriedBots ? queryFeatures : features);
        if (path === '/v2/sessions/read-batch') return null;
        if (queriedBots && path === '/v2/sessions/query') {
          const cursor = JSON.parse(String(init?.body)).cursor ?? null;
          queriedCursors.push(cursor);
          const lastPage = cursor === botPageCursor;
          const page = lastPage ? queriedBots.slice(1) : queriedBots.slice(0, 1);
          return Response.json({
            sessions: page.map(session => ({ ...createPlainSessionByIdResponseFixture(session).session,
              meaningfulActivityAt: session.meaningfulActivityAt, viewer: createSessionOwnerViewerFixture(session),
            })),
            nextCursor: lastPage ? null : botPageCursor, hasNext: !lastPage,
            attentionNextCursor: null, attentionHasNext: false,
          });
        }
        if (holdBotQuery && path === '/v2/sessions/query') return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
        // The unavailable bootstrap is a network outage. An HTTP refusal is a
        // settled list error and correctly outranks disconnected presence.
        if (!serveHealthyOrdinarySnapshot && (path === '/v2/sessions' || path === '/v2/sessions/active')) {
          throw new TypeError('Network request failed');
        }
        if (serveHealthyOrdinarySnapshot && (path === '/v2/sessions' || path === '/v2/sessions/active')) {
          const sessions = path === '/v2/sessions/active' ? ordinarySessions.filter(session => session.active) : ordinarySessions;
          return Response.json({ sessions: await Promise.all(sessions.map(async session =>
            (session.encryptionMode === 'e2ee'
              ? await createLockedEncryptedSessionByIdResponseFixture(session)
              : createPlainSessionByIdResponseFixture(session)).session)), nextCursor: null, hasNext: false });
        }
        const sessionId = /^\/v2\/sessions\/([^/]+)$/.exec(path)?.[1];
        const session = sessionId ? [...ordinarySessions, ...(queriedBots ?? [])].find(row => row.id === decodeURIComponent(sessionId)) : undefined;
        if (session) return Response.json(session.encryptionMode === 'e2ee'
          ? await createLockedEncryptedSessionByIdResponseFixture(session)
          : createPlainSessionByIdResponseFixture(session));
        if (serveHealthyOrdinarySnapshot && path === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({
          snapshot: { schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0,
            pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] },
        }));
        if (path === '/v2/cursor')
          return Response.json(
            CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }),
          );
        if (path === '/v1/account/encryption/currentness')
          return Response.json(
            createPlainAccountEncryptionCurrentnessFixture(),
          );
        if (path === '/v1/account/encryption')
          return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v2/account/settings')
          return Response.json(
            AccountSettingsV2GetResponseSchema.parse({
              content: { t: 'plain', v: { hideInactiveSessions: true, ...actionApprovalSettings() } },
              version: 1,
            }),
          );
        if (path === '/v2/session-organization/order') {
          const input = ReorderSessionOrganizationRequestSchema.parse(JSON.parse(String(init?.body)));
          persistedOrder = input.entries.map(entry => entry.itemKey);
          return Response.json({ orderEntries: input.entries.map(entry => ({ ...entry, scopeKind: input.scopeKind, scopeKey: input.scopeKey })) });
        }
        const artifactResponse = artifacts.handle(`${path}${new URL(String(url)).search}`, init);
        if (artifactResponse) return artifactResponse;
        return new Response('{}', { status: 404 });
      },
    });
    const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
    await updateEffectiveHomeViewState(current => ({
      ...current,
      activeTargetKind: 'server',
      activeTargetId: resolveServerProfileScopeIdForIdentifier(connection!.home.id),
    }), { scope: 'tab' });
    primeServerFeaturesSnapshot({
      serverId: connection.home.id,
      snapshot: { status: 'ready', features },
    });
    storage.getState().clearSessionOrganizationForServer(resolveServerProfileScopeIdForIdentifier(connection.home.id));
  });
  afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
    webLocks?.restore();
    webLocks = undefined;
  });

  it('publishes Bot markers at one awareness deadline after heartbeat-only arrivals leave order and badges unchanged', async () => {
    const { useOrderedBots, useBotsSummary, useBotActivity } = await import('./botsSummary');
    const { readSessionStatusNextRefreshAtMs } = await import('@/utils/sessions/sessionUtils');
    const serverId = resolveServerProfileScopeIdForIdentifier(connection!.home.id);
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const bot = createSessionListRenderableSessionFixture({ id: 'clock-bot', active: true, activeAt: now,
      presence: 'online', thinking: true, thinkingAt: now,
      meaningfulActivityAt: now, metadata: { path: '/project', bot: { kind: 'bot' } } });
    storage.getState().applyServerScopedSessionListRows(serverId, [bot], { source: 'ordinary', mode: 'replace' });
    let commits = 0;
    const hook = await renderHook(() => {
      const ordered = useOrderedBots();
      const summary = useBotsSummary();
      const activity = useBotActivity({ serverId, sessionId: bot.id });
      React.useLayoutEffect(() => { commits++; });
      return { ordered, summary, activity };
    });
    try {
      const first = hook.getCurrent();
      expect(first.activity).toBe('working');
      commits = 0;
      for (let index = 1; index <= 12; index++) await act(async () => {
        storage.getState().applyServerScopedSessionListRowPatches(serverId, [{ sessionId: bot.id, patch: { activeAt: now + index } }]);
      });
      const raw = storage.getState().sessionListBotRowsByServerId[serverId]![bot.id]!;
      expect(raw.activeAt).toBe(now + 12);
      expect(hook.getCurrent().ordered).toBe(first.ordered);
      expect(hook.getCurrent().summary).toBe(first.summary);
      expect(commits).toBe(0);
      const deadline = readSessionStatusNextRefreshAtMs(raw, now + 12)!;
      expect(deadline).toBeGreaterThan(now);
      await act(async () => { vi.advanceTimersByTime(deadline - now); });
      expect(hook.getCurrent().activity).toBe('quiet');
      expect(hook.getCurrent().ordered[0]?.activity).toBe('quiet');
      expect(commits).toBe(1);
      commits = 0;
      await act(async () => { vi.advanceTimersByTime(300_000); });
      expect(commits).toBe(0);
      await act(async () => {
        storage.getState().applyServerScopedSessionListRows(serverId, [{ ...raw, seq: raw.seq + 1,
          viewer: createSessionViewerFixture({ attention: { needsAttention: true, reasons: ['permission_required'], primary: 'permission_required', presentation: 'full' } }),
        }], { source: 'ordinary', mode: 'replace' });
      });
      expect(hook.getCurrent().activity).toBe('needsYou');
      expect(hook.getCurrent().summary.needsYou).toBe(1);
      expect(commits).toBe(1);
    } finally {
      await hook.unmount();
      vi.useRealTimers();
    }
  });

  it.each([false, true])('settles an unreachable Home without a first roster or feature response and names the Home (address-only: %s)', async addressOnly => {
    const { adoptHomeProfile, getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
    await adoptHomeProfile({ source: 'manual', descriptor: {
      serverUrl: connection!.home.serverUrl,
      homeServerIdentityId: connection!.home.serverIdentityId ?? undefined,
      displayName: addressOnly ? 'bots-roster.example.test' : 'Test Home',
    } });
    expect(getServerProfileById(connection!.home.id)?.name).toBe(addressOnly ? 'bots-roster.example.test' : 'Test Home');
    storage.setState({ socketStatus: 'disconnected' });
    primeServerFeaturesSnapshot({
      serverId: connection!.home.id,
      snapshot: { status: 'error', reason: 'network' },
    });
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <BotsPopoverContent close={() => {}} maxHeight={520} />
    </InjectedAuthProvider>);
    await flushHookEffects({ cycles: 3 });
    expect(screen.findByTestId('bots-roster.offline'), await describeRosterState(screen)).not.toBeNull();
    expect(screen.findByTestId('bots-roster.loading')).toBeNull();
    expect(screen.findByTestId('bots-roster.empty')).toBeNull();
    expect(screen.getTextContent()).toContain(addressOnly ? 'This Home' : 'Test Home');
    expect(screen.getTextContent()).not.toContain('bots-roster.example.test');

    // The open roster must observe the published name without changing its Home id.
    await act(async () => {
      primeServerFeaturesSnapshot({
        serverId: connection!.home.id,
        snapshot: { status: 'ready', features: {
          ...features, homePresentation: { v: 1, displayName: 'Research Home' },
        } },
      });
    });
    expect(screen.getTextContent()).toContain('Research Home');
    expect(screen.getTextContent()).not.toContain('Test Home');
    await act(async () => {
      primeServerFeaturesSnapshot({ serverId: connection!.home.id, snapshot: { status: 'error', reason: 'network' } });
      await adoptHomeProfile({ source: 'manual', descriptor: {
        serverUrl: connection!.home.serverUrl,
        homeServerIdentityId: connection!.home.serverIdentityId ?? undefined,
        displayName: 'Studio Home',
      } });
    });
    expect(screen.getTextContent()).toContain('Studio Home');
    expect(screen.getTextContent()).not.toContain('Research Home');
  });

  it('keeps the same shared Bot membership as Home after the ordinary roster query settles empty', async () => {
    const serverId = resolveServerProfileScopeIdForIdentifier(connection!.home.id);
    queriedBots = [];
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: queryFeatures } });
    storage.getState().applyServerScopedSessionListRows(serverId, [
      createSessionListRenderableSessionFixture({ id: 'shared-bot', ownerAccountId: 'other-account',
        origin: { kind: 'none' }, accessLevel: 'view', metadataLayoutVersion: 1,
        viewer: createSessionViewerFixture(),
        metadata: { path: '/repo', bot: { kind: 'bot' }, botFace: { seed: 'shared-face' } } }),
    ], { source: 'rowOnly', mode: 'append' });
    const { useOrderedBots } = await import('./botsSummary');
    const home = await renderHook(() => useOrderedBots());
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <BotsPopoverContent close={() => {}} maxHeight={520} />
    </InjectedAuthProvider>);
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(queriedCursors).toEqual([null, botPageCursor]);
      expect(screen.findByTestId('bots-roster.loading')).toBeNull();
    });
    expect(home.getCurrent().map(bot => bot.sessionId)).toEqual(['shared-bot']);
    expect(screen.findByTestId('session-list-item-shared-bot')).not.toBeNull();
    expect(storage.getState().sessionListRowsByServerId[serverId]?.['shared-bot']?.viewer?.follow.follows).toBe(false);
  });

  it('lists every Bot, inactive ones too, as ordinary Session rows with New bot and Ask Happier beneath', async () => {
    const serverId = connection!.home.id;
    const now = Date.now();
    storage.getState().applySettingsLocal({ hideInactiveSessions: true });
    storage
      .getState()
      .applyServerScopedSessionListRows(
        serverId,
        [
          createSessionListRenderableSessionFixture({
            id: 'inactive-bot',
            active: false,
            metadata: { path: '/project', bot: { kind: 'bot' } },
          }),
          createSessionListRenderableSessionFixture({
            id: 'active-bot',
            active: true,
            activeAt: now,
            updatedAt: now,
            metadata: { path: '/project', bot: { kind: 'bot' } },
          }),
          createSessionListRenderableSessionFixture({
            id: 'ordinary',
            active: true,
            activeAt: now,
            updatedAt: now,
            metadata: { path: '/project' },
          }),
        ],
        { source: 'ordinary', mode: 'replace' },
      );

    const close = vi.fn();
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={null}><BotsPopoverContent close={close} maxHeight={520} /></InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 3 });

    expect(screen.findByTestId('session-list-item-active-bot')).not.toBeNull();
    expect(
      screen.findByTestId('session-list-item-inactive-bot'),
    ).not.toBeNull();
    expect(screen.findByTestId('session-list-item-ordinary')).toBeNull();
    expect(screen.findByTestId('bots-roster.new-bot')).not.toBeNull();
    expect(screen.findByTestId('bots-roster.ask-happier')).not.toBeNull();
    expect(storage.getState().socketStatus).toBe('connected');
    expect(screen.findByTestId('bots-roster.offline')).toBeNull();

    // Opening a Bot opens its Session and closes the roster that hosted it.
    await pressNativeBoundary(screen, 'session-list-item-active-bot');
    expect(close).toHaveBeenCalled();
    expect(JSON.stringify(navigate.mock.calls[0]?.[0])).toContain('active-bot');
  });

  it('picks the Bot that wears a pet: Bot rows only, no roster actions, and the chosen Bot takes the pet', async () => {
    const serverId = connection!.home.id;
    const now = Date.now();
    storage.getState().applyServerScopedSessionListRows(serverId, [
      createSessionListRenderableSessionFixture({ id: 'wearing-bot', active: true, activeAt: now, updatedAt: now,
        metadata: { path: '/project', bot: { kind: 'bot' } } }),
    ], { source: 'ordinary', mode: 'replace' });
    const close = vi.fn();
    const pet = { kind: 'builtIn' as const, petId: 'milo' };
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const { useBotFaceWearRequest } = await import('./botFaceWearIntent');
    const taken: unknown[] = [];
    function WearingHeader() {
      useBotFaceWearRequest('wearing-bot', (wear) => { taken.push(wear); });
      return null;
    }
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={null}>
        <BotsPopoverContent close={close} maxHeight={520} wearPet={{ pet, name: 'Milo' }} />
        <WearingHeader />
      </InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 3 });
    expect(screen.findByTestId('session-list-item-wearing-bot')).not.toBeNull();
    expect(screen.findByTestId('bots-roster.new-bot')).toBeNull();
    expect(screen.findByTestId('bots-roster.ask-happier')).toBeNull();
    expect(screen.getTextContent()).toContain('Milo');
    await pressNativeBoundary(screen, 'session-list-item-wearing-bot');
    expect(close).toHaveBeenCalled();
    expect(taken).toEqual([pet]);
  });

  it('does not rescan expanded roster membership for hydrated message arrivals or unrelated publications', async () => {
    const serverId = connection!.home.id;
    const now = Date.now();
    const population = Array.from({ length: 16 }, (_, index) =>
      createSessionListRenderableSessionFixture({ id: `measured-bot-${index}`, activeAt: now,
        metadata: { path: '/project', name: `Measured Bot ${index}`, bot: { kind: 'bot' } },
        ...(index === 0 ? { managedSessions: { total: 1, working: 0, stalled: 0, needsYou: 0, finished: 0, attentionPrimary: null } } : {}) }));
    population.push(createSessionListRenderableSessionFixture({ id: 'measured-child',
      metadata: { path: '/project' }, manager: { sessionId: 'measured-bot-0' } }));
    const unrelatedPopulation = Array.from({ length: 983 }, (_, index) =>
      createSessionListRenderableSessionFixture({ id: perfFixtureId(4, 'session', index), metadata: { path: '/project' } }));
    population.push(...unrelatedPopulation);
    replaceCollapsedGroupKeys({});
    storage.getState().applyServerScopedSessionListRows(serverId, population, { source: 'ordinary', mode: 'replace' });
    storage.getState().applySessions([createSessionFixture({
      ...buildSessionFromListRenderable(population[0]!, { serverId }), seq: 0,
    })]);
    const homeKey = resolveServerProfileScopeIdForIdentifier(serverId);
    let rowMapEnumerations = 0;
    let metadataReads = 0;
    const originalRows = storage.getState().sessionListRowsByServerId[homeKey]!;
    const countedRows = new Proxy(Object.fromEntries(Object.entries(originalRows).map(([key, row]) => [key,
      new Proxy(row, { get(target, property, receiver) {
        if (property === 'metadata') metadataReads += 1;
        return Reflect.get(target, property, receiver);
      } }),
    ])), { ownKeys(target) { rowMapEnumerations += 1; return Reflect.ownKeys(target); } });
    storage.setState(state => ({ sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [homeKey]: countedRows } }));
    let relationshipInventoryEnumerations = 0;
    let unrelatedRelationReads = 0;
    const unrelatedIds = new Set(unrelatedPopulation.map(row => row.id));
    const relations = storage.getState().sessionRelationsByServerId;
    const countedRelations = new Proxy(relations[homeKey]!, {
      ownKeys(target) {
        relationshipInventoryEnumerations += 1;
        return Reflect.ownKeys(target);
      },
      get(target, property, receiver) {
        if (typeof property === 'string' && unrelatedIds.has(property)) unrelatedRelationReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    // Observe the real published inventory without changing its values or publishing new facts.
    // This sees keys/values/entries, spreads, for-in and keyed reads without classifying call stacks.
    Object.defineProperty(relations, homeKey, { value: countedRelations, enumerable: true, configurable: true, writable: true });
    let commits = 0;
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <React.Profiler id="measured-bots-roster" onRender={() => { commits += 1; }}>
        <BotsPopoverContent close={() => {}} maxHeight={520} />
      </React.Profiler>
    </InjectedAuthProvider>);
    await flushHookEffects({ cycles: 3 });
    relationshipInventoryEnumerations = 0;
    unrelatedRelationReads = 0;
    await pressNativeBoundary(screen, 'session-row-reports-disclosure:measured-bot-0');
    await flushHookEffects({ cycles: 3 });
    expect(screen.findByTestId('session-list-item-measured-child')).not.toBeNull();
    // Opening the real disclosure rebuilds topology without a Session/list producer write.
    expect(relationshipInventoryEnumerations).toBeGreaterThan(0);
    expect(unrelatedRelationReads).toBeGreaterThan(0);
    const mountedRows = population.filter(row => screen.findByTestId(`session-list-item-${row.id}`) !== null).length;
    rowMapEnumerations = 0;
    metadataReads = 0;
    relationshipInventoryEnumerations = 0;
    unrelatedRelationReads = 0;
    commits = 0;
    // Isolate this synchronous arrival batch from valid age-clock and bootstrap arrivals.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    onTestFinished(() => { vi.useRealTimers(); });
    let notifications = 0;
    const stopCountingNotifications = storage.subscribe(() => { notifications += 1; });
    const beforeArrivals = storage.getState();
    try {
      act(() => {
        for (let index = 0; index < 10; index += 1) {
          storage.getState().applySettingsLocal({ wrapLinesInDiffs: index % 2 === 0 });
          storage.getState().applyMessages('measured-bot-0', [{
            id: `roster-ordinary-${index}`, seq: index + 1, localId: null, createdAt: now + index,
            role: 'user', isSidechain: false, content: { type: 'text', text: 'Continue' },
          }]);
        }
      });
    } finally {
      stopCountingNotifications();
      vi.useRealTimers();
    }
    expect(storage.getState().sessions['measured-bot-0']?.seq).toBe(10);
    expect(storage.getState().sessions).not.toBe(beforeArrivals.sessions);
    expect(storage.getState().sessionRelationsByServerId).toBe(beforeArrivals.sessionRelationsByServerId);
    const unrelated = { notifications, commits, relationshipInventoryEnumerations, unrelatedRelationReads, rowMapEnumerations, metadataReads };
    expect(unrelated.relationshipInventoryEnumerations).toBe(0);
    expect(unrelated.unrelatedRelationReads).toBe(0);
    commits = 0;
    const updated = population.map(row => row.id === 'measured-bot-0'
      ? { ...row, updatedAt: now + 1, metadata: { ...row.metadata!, name: 'Measured Bot updated' } }
      : row.id === 'measured-child' ? { ...row, updatedAt: now + 1, metadata: { ...row.metadata!, name: 'Managed report updated' } } : row);
    await act(async () => {
      storage.getState().applyServerScopedSessionListRows(serverId, updated, { source: 'ordinary', mode: 'replace' });
    });
    await flushHookEffects({ cycles: 3 });
    expect(screen.getTextContent()).toContain('Measured Bot updated');
    expect(screen.getTextContent()).toContain('Managed report updated');
    const ownBotCommits = commits;
    await act(async () => {
      storage.getState().applyServerScopedSessionListRows(serverId, updated.map(row => row.id === 'measured-child'
        ? { ...row, manager: null, seq: row.seq + 1, updatedAt: now + 2 } : row), { source: 'ordinary', mode: 'replace' });
    });
    expect(screen.findByTestId('session-list-item-measured-child')).toBeNull();
    await act(async () => {
      storage.getState().applyServerScopedSessionListRows(serverId, updated.map(row => row.id === 'measured-child'
        ? { ...row, seq: row.seq + 2, updatedAt: now + 3 } : row), { source: 'ordinary', mode: 'replace' });
    });
    expect(screen.findByTestId('session-list-item-measured-child')).not.toBeNull();
    // Public snapshot writes use the same relationship owner as ordinary Session/list ingress.
    const retainedSnapshot = storage.getState();
    const attachedRows = retainedSnapshot.sessionListRowsByServerId[homeKey]!;
    const detachedRows = { ...attachedRows,
      'measured-child': { ...attachedRows['measured-child']!, manager: null } };
    let relationshipPublications = 0;
    const stopRelationshipPublications = storage.subscribe((next, previous) => {
      if (next.sessionRelationsByServerId[homeKey] !== previous.sessionRelationsByServerId[homeKey]) relationshipPublications += 1;
    });
    try {
      await act(async () => { storage.setState({ sessionListRowsByServerId: {
        ...retainedSnapshot.sessionListRowsByServerId, [homeKey]: detachedRows,
      } }); });
      expect(relationshipPublications).toBe(1);
      expect(storage.getState().sessionRelationsByServerId[homeKey]?.['measured-child']?.managerSessionId).toBeNull();
      expect(storage.getState().sessionListRowsByServerId[homeKey]?.['measured-child']).toBe(detachedRows['measured-child']);
      expect(storage.getState().sessionListRowsByServerId[homeKey]?.['measured-bot-0']).toBe(attachedRows['measured-bot-0']);
      expect(screen.findByTestId('session-list-item-measured-child')).toBeNull();
      await act(async () => { storage.setState({ sessionListRowsByServerId: retainedSnapshot.sessionListRowsByServerId }); });
      expect(relationshipPublications).toBe(2);
      expect(storage.getState().sessionRelationsByServerId[homeKey]?.['measured-child']?.managerSessionId).toBe('measured-bot-0');
      expect(screen.findByTestId('session-list-item-measured-child')).not.toBeNull();
      await act(async () => { storage.setState({ sessions: {}, sessionListRowsByServerId: {} }); });
      expect(relationshipPublications).toBe(3);
      expect(storage.getState().sessionRelationsByServerId[homeKey]).toEqual({});
      expect(screen.findByTestId('session-list-item-measured-child')).toBeNull();
      await act(async () => { storage.setState(retainedSnapshot, true); });
      expect(relationshipPublications).toBe(4);
      expect(storage.getState().sessions).toBe(retainedSnapshot.sessions);
      expect(storage.getState().sessionListRowsByServerId).toBe(retainedSnapshot.sessionListRowsByServerId);
      expect(storage.getState().sessionRelationsByServerId[homeKey]?.['measured-child']?.managerSessionId).toBe('measured-bot-0');
      expect(screen.findByTestId('session-list-item-measured-child')).not.toBeNull();
    } finally {
      stopRelationshipPublications();
      await act(async () => { storage.setState(retainedSnapshot, true); });
    }
    await screen.unmount();
    const { createBotsSummaryReader } = await import('./botsSummary');
    const readSummary = createBotsSummaryReader([homeKey]);
    const closedRows = { ...storage.getState().sessionListRowsByServerId, [homeKey]: countedRows };
    const summary = readSummary(closedRows, now);
    rowMapEnumerations = 0;
    metadataReads = 0;
    for (let index = 0; index < 10; index += 1) expect(readSummary({ ...closedRows }, now)).toBe(summary);
    const closed = { rowMapEnumerations, metadataReads };
    console.info('PERF_D4_BOTS_COUNTS', JSON.stringify({ candidates: population.length, mountedRows, unrelated, ownBotCommits, closed }));
    expect(unrelated.notifications).toBeGreaterThanOrEqual(20);
  });

  it.each([1, 1000])('Living Bots counts rail/roster arrivals with %i Sessions and 121 Machines', async sessionCount => {
    const serverId = resolveServerProfileScopeIdForIdentifier(connection!.home.id);
    const now = Date.now();
    const bot = createSessionListRenderableSessionFixture({ id: 'cost-bot', activeAt: now,
      metadata: { path: '/project', name: 'Cost Bot', bot: { kind: 'bot' }, botFace: { seed: 'before' } } });
    const population = [bot, ...Array.from({ length: sessionCount - 1 }, (_, index) =>
      createSessionListRenderableSessionFixture({ id: `cost-ordinary-${index}`, metadata: { path: '/project' } }))];
    storage.getState().applySettingsLocal({ botMotion: 'still' });
    storage.getState().applyServerScopedSessionListRows(serverId, population, { source: 'ordinary', mode: 'replace' });
    const machines = Array.from({ length: 121 }, (_, index) => createMachineFixture({ id: `cost-machine-${index}` }));
    storage.getState().applyMachines(machines, false, { sourceServerId: serverId });
    storage.getState().applySessions([createSessionFixture({ ...buildSessionFromListRenderable(bot, { serverId }), seq: 0 })]);
    storage.getState().setSessionPinOptimistic(serverId, bot.id,
      { sessionId: bot.id, sortKey: null, pinnedAt: 1, listPinned: false, railPinned: true });
    const { AppRailBotPin, useAppRailBotHomes } = await import('@/components/navigation/shell/appRail/AppRailBots');
    const { buildAppRailEntries } = await import('@/components/navigation/shell/appRail/appRailModel');
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    function Rail() {
      const homes = useAppRailBotHomes();
      return <>{buildAppRailEntries([], { botHomes: homes }).bots.map(entry => entry.session === null ? null :
        <AppRailBotPin key={entry.id} bot={entry} animateEntry={false} />)}</>;
    }
    const commits = { rail: 0, roster: 0 };
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <React.Profiler id="living-bots-rail" onRender={() => { commits.rail++; }}><Rail /></React.Profiler>
      <React.Profiler id="living-bots-roster" onRender={() => { commits.roster++; }}>
        <BotsPopoverContent close={() => {}} maxHeight={520} />
      </React.Profiler>
    </InjectedAuthProvider>);
    await flushHookEffects({ cycles: 3 });
    commits.rail = 0; commits.roster = 0;
    const { readSessionBotFaceFacts, areSessionBotFaceFactsEqual } = await import('./face/sessionBotFaceFacts');
    const readFace = (state: ReturnType<typeof storage.getState>) => {
      const row = state.sessionListRowsByServerId[serverId]?.[bot.id];
      return row ? readSessionBotFaceFacts(row, serverId) : null;
    };
    let facePublications = 0;
    let botRowPublications = 0;
    const stop = storage.subscribe((state, previous) => {
      if (state.sessionListBotRowsByServerId !== previous.sessionListBotRowsByServerId) botRowPublications++;
      if (!areSessionBotFaceFactsEqual(readFace(state), readFace(previous))) facePublications++;
    });
    try {
      const requestStart = transportRequests.length;
      // Count each synchronous source arrival separately, without admitting
      // unrelated asynchronous Home bootstrap/age-clock updates between them.
      for (let index = 0; index < 12; index++) act(() => {
        if (sessionCount > 1) storage.getState().applyServerScopedSessionListRowPatches(serverId,
          [{ sessionId: `cost-ordinary-${index}`, patch: { activeAt: now + index } }]);
        storage.getState().applyMachines(machines.map((machine, i) => i === index
          ? { ...machine, activeAt: now + index } : machine), false, { sourceServerId: serverId });
      });
      const unrelated = { ...commits, facePublications };
      expect(unrelated).toEqual({ rail: 0, roster: 0, facePublications: 0 });
      for (let index = 0; index < 12; index++) act(() => {
        storage.getState().applyMessages(bot.id, [{ id: `cost-message-${index}`, seq: index + 1,
          localId: null, createdAt: now + index, role: 'agent', isSidechain: false,
          content: [{ type: 'text', text: 'Working', uuid: `cost-message-${index}`, parentUUID: null }] }]);
      });
      expect(storage.getState().sessions[bot.id]?.seq).toBe(12);
      const turns = { ...commits, facePublications, botRowPublications, faceWrites: transportRequests.slice(requestStart)
        .filter(request => request.method === 'PATCH' && request.path.startsWith('/v2/sessions/')).length };
      expect(turns.faceWrites).toBe(0);
      expect(turns.facePublications).toBe(0);
      commits.rail = 0; commits.roster = 0;
      act(() => { storage.getState().applyServerScopedSessionListRowPatches(serverId, [{ sessionId: bot.id,
        patch: { metadataVersion: 2, metadata: { ...bot.metadata!, botFace: { seed: 'after' } } } }]); });
      expect(facePublications).toBe(1);
      expect(screen.getTextContent()).toContain('Cost Bot');
      expect(commits.rail).toBeGreaterThan(0);
      expect(commits.roster).toBeGreaterThan(0);
      console.info('LIVING_BOTS_ARRIVALS', JSON.stringify({ sessions: sessionCount, machines: machines.length,
        arrivals: 12, unrelated, turns, faceChange: { ...commits, facePublications } }));
    } finally { stop(); await screen.unmount(); }
  });

  it('orders Bots needs-you, then working, then most recent, and says nothing about an idle Bot beyond its age', async () => {
    const serverId = connection!.home.id;
    const now = Date.now();
    const hour = 3_600_000;
    const bot = { path: '/project', bot: { kind: 'bot' as const } };
    storage.getState().applyServerScopedSessionListRows(serverId, [
      createSessionListRenderableSessionFixture({ id: 'idle-old', meaningfulActivityAt: now - 20 * hour, active: false, activeAt: now, updatedAt: now - 20 * hour, metadata: { ...bot, name: 'Docs gardener' } }),
      createSessionListRenderableSessionFixture({ id: 'idle-new', meaningfulActivityAt: now - 3 * hour, active: false, activeAt: now - 20 * hour, updatedAt: now - 3 * hour, metadata: { ...bot, name: 'Deps' } }),
      createSessionListRenderableSessionFixture({ id: 'working', meaningfulActivityAt: now, active: true, thinking: true, thinkingAt: now, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now, activeAt: now, updatedAt: now, metadata: { ...bot, name: 'Release captain' } }),
      createSessionListRenderableSessionFixture({ id: 'needs-you', meaningfulActivityAt: now - hour, active: true, activeAt: now, updatedAt: now, hasPendingPermissionRequests: true, pendingRequestObservedAt: now, metadata: { ...bot, name: 'Flake hunter' } }),
      createSessionListRenderableSessionFixture({ id: 'offline-blocked', presence: now - 2 * hour, pendingBlockedCount: 1, activeAt: now - 2 * hour, metadata: { ...bot, name: 'Release notebook' } }),
      createSessionListRenderableSessionFixture({ id: 'offline-failed', presence: now - 2 * hour, latestTurnStatus: 'failed', activeAt: now - 2 * hour, metadata: { ...bot, name: 'Library companion' } }),
      createSessionListRenderableSessionFixture({ id: 'offline-working', presence: now - 2 * hour, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now, activeAt: now - 2 * hour, metadata: { ...bot, name: 'A pinned companion' } }),
    ], { source: 'ordinary', mode: 'replace' });

    storage.getState().applySettingsLocal({ sessionListAttentionPlacementV1: 'both' });
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={null}><BotsPopoverContent close={() => {}} maxHeight={520} /></InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 3 });

    const text = screen.getTextContent();
    const order = ['Flake hunter', 'Release captain', 'Deps', 'Docs gardener'].map(name => text.indexOf(name));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A blocked delivery is canonical Needs you even while its Machine is offline.
    expect(text).toContain(`${t('bots.roster.needsYou', { count: 2 })} · ${t('bots.roster.working', { count: 1 })}`);
    const expectUniqueRows = () => {
      for (const id of ['idle-old', 'idle-new', 'working', 'needs-you', 'offline-blocked', 'offline-failed', 'offline-working']) {
        expect(screen.findAllHostsByTestId(`session-list-item-${id}`), id).toHaveLength(1);
      }
    };
    expectUniqueRows();
    await act(async () => { storage.getState().applySettingsLocal({ sessionListAttentionPlacementV1: 'top' }); });
    await flushHookEffects({ cycles: 3 });
    expectUniqueRows();
    expect(screen.getTextContent()).toContain(`${t('bots.roster.needsYou', { count: 2 })} · ${t('bots.roster.working', { count: 1 })}`);
    // The row's age already says when it was last active; an idle Bot adds no "Last seen" line.
    expect(text).not.toContain('Last seen');
  });

  it('publishes the pushed intake pause to the roster and closed rail without dimming an offline Bot', async () => {
    const { useOrderedBots, useBotsSummary } = await import('./botsSummary');
    const serverId = resolveServerProfileScopeIdForIdentifier(connection!.home.id);
    const now = Date.now();
    const metadata = { path: '/project', bot: { kind: 'bot' as const } };
    const paused = createSessionListRenderableSessionFixture({ id: 'paused', botPausedAt: now, metadata });
    const offline = createSessionListRenderableSessionFixture({ id: 'offline', active: false, presence: 0, metadata });
    storage.getState().applyServerScopedSessionListRows(serverId, [paused, offline], { source: 'ordinary', mode: 'replace' });
    const hook = await renderHook(() => ({ roster: useOrderedBots(), rail: useBotsSummary() }));
    onTestFinished(() => hook.unmount());
    const isMonochrome = (id: string) => {
      const key = sessionAddressKey({ serverId, sessionId: id });
      const { roster, rail } = hook.getCurrent();
      const faces = [roster.find(row => row.key === key)?.face, rail.faces.find(row => row.key === key)?.face];
      expect(faces.every(face => face !== undefined)).toBe(true);
      return faces.map(face => face?.monochrome === true);
    };
    expect(isMonochrome('paused')).toEqual([true, true]);
    expect(isMonochrome('offline')).toEqual([false, false]);
    await act(async () => {
      storage.getState().applyServerScopedSessionListRowPatches(serverId, [{ sessionId: paused.id, patch: { botPausedAt: null } }]);
    });
    expect(isMonochrome('paused')).toEqual([false, false]);
  });

  it('orders the paged Bot query by meaningful activity and retains its second-page row', async () => {
    const serverId = connection!.home.id;
    const now = Date.now();
    serveHealthyOrdinarySnapshot = true;
    queriedBots = [
      createSessionFixture({ id: 'query-old', meaningfulActivityAt: now - 20_000, activeAt: now,
        metadata: { path: '/project', host: 'test', name: 'Queried older', bot: { kind: 'bot' } } }),
      createSessionFixture({ id: 'query-new', meaningfulActivityAt: now - 10_000, activeAt: now - 30_000,
        metadata: { path: '/project', host: 'test', name: 'Queried newer', bot: { kind: 'bot' } } }),
    ];
    const { sync } = await import('@/sync/sync');
    await sync.refreshProfile();
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: queryFeatures } });
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <BotsPopoverContent close={() => {}} maxHeight={520} />
    </InjectedAuthProvider>);
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.findByTestId('session-list-item-query-new'), JSON.stringify({ cursors: queriedCursors, text: screen.getTextContent() })).not.toBeNull();
    });
    const text = screen.getTextContent();
    expect(text.indexOf('Queried newer')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Queried older')).toBeGreaterThan(text.indexOf('Queried newer'));
    expect(queriedCursors).toContain(botPageCursor);
  });

  it('keeps saying it is loading while the Bot query is still answering, without settled-roster lines', async () => {
    const serverId = connection!.home.id;
    holdBotQuery = true;
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: queryFeatures } });
    const bot = { path: '/project', bot: { kind: 'bot' as const } };
    storage.getState().applyServerScopedSessionListRows(serverId, [createSessionListRenderableSessionFixture({
      id: 'quiet-known', active: false, activeAt: Date.now() - 3_600_000, updatedAt: Date.now() - 3_600_000,
      metadata: { ...bot, name: 'Deps' } })], { source: 'ordinary', mode: 'replace' });

    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={null}><BotsPopoverContent close={() => {}} maxHeight={520} /></InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 3 });

    expect(screen.findByTestId('bots-roster.empty')).toBeNull();
    expect(screen.findByTestId('bots-roster.loading'), await describeRosterState(screen)).not.toBeNull();
    // Readiness and the needs-you summary describe a settled roster; a roster still arriving makes neither claim.
    expect(screen.findByTestId('bots-roster.readiness')).toBeNull();
  });

  it('states readiness once for the whole roster and reads nothing until the person checks', async () => {
    serveHealthyOrdinarySnapshot = true;
    const now = Date.now();
    const bot = { path: '/project', bot: { kind: 'bot' as const } };
    ordinarySessions = ['Deps', 'Docs gardener'].map((name, index) =>
      createSessionFixture({ id: `quiet-${index}`, active: false, activeAt: now - 3_600_000, updatedAt: now - 3_600_000, metadata: { ...bot, host: 'test', name } }));
    const { sync } = await import('@/sync/sync');
    await sync.refreshSessions({ awaitSessionListHydration: true });

    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={null}><BotsPopoverContent close={() => {}} maxHeight={520} /></InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 3 });

    const notChecked = t('session.collaboration.readiness.rosterNotChecked');
    expect(screen.getTextContent().split(notChecked)).toHaveLength(2);
    // A line about the whole roster leads it from the header; it never sits over the list's last row.
    expect(screen.getTextContent().indexOf(notChecked)).toBeLessThan(screen.getTextContent().indexOf('Deps'));
    expect(screen.findAllHostsByTestId('bots-roster.readiness-check')).toHaveLength(1);
    expect(screen.findByTestId('bots-roster.readiness:quiet-0')).toBeNull();

    await pressNativeBoundary(screen, 'bots-roster.readiness-check');
    await flushHookEffects({ cycles: 3 });
    expect(screen.getTextContent()).not.toContain(notChecked);
    expect(screen.findByTestId('bots-roster.readiness-check')).toBeNull();
    for (const id of ['quiet-0', 'quiet-1']) expect(screen.findByTestId(`bots-roster.readiness:${id}`), id).not.toBeNull();
  });

  it('keeps the readiness Check reach inside its own line, so a finger on it never lands on New bot below', async () => {
    serveHealthyOrdinarySnapshot = true;
    const now = Date.now();
    const bot = { path: '/project', bot: { kind: 'bot' as const } };
    ordinarySessions = ['Deps', 'Docs gardener'].map((name, index) =>
      createSessionFixture({ id: `quiet-${index}`, active: false, activeAt: now - 3_600_000, updatedAt: now - 3_600_000, metadata: { ...bot, host: 'test', name } }));
    const { sync } = await import('@/sync/sync');
    await sync.refreshSessions({ awaitSessionListHydration: true });

    const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
    const { View } = await import('react-native');
    const { layoutHitArea } = await import('@/dev/testkit/harness/hitFrameReach');
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(
      <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
        <InjectedAuthProvider credentials={null}><BotsPopoverContent close={() => {}} maxHeight={520} /></InjectedAuthProvider>
      </HappierUiPlatformProvider>,
    );
    await flushHookEffects({ cycles: 3 });

    const lineView = screen.findAllByTestId('bots-roster.readiness').find(node => node.type === View);
    expect(lineView).toBeTruthy();
    const line = ([] as unknown[]).concat(lineView!.props.style).flat(Infinity)
      .reduce<{ paddingVertical?: number }>((all, part) => ({ ...all, ...(part as object) }), {});
    const check = await layoutHitArea(() => screen.findAllByTestId('bots-roster.readiness-check')
      .reverse().find(node => typeof node.props.onLayout === 'function'), { width: 40, height: 16 });
    // The line's own padding is the free space above and below; past it sit the roster and the footer actions.
    expect(check.insets.top).toBeLessThanOrEqual(Number(line.paddingVertical));
    expect(check.insets.bottom).toBeLessThanOrEqual(Number(line.paddingVertical));
    expect(check.insets.bottom).toBeGreaterThan(0);
  });

  it('invites a first Bot when there is none, without apologising', async () => {
    const serverId = connection!.home.id;
    serveHealthyOrdinarySnapshot = true;
    const { sync } = await import('@/sync/sync');
    // Await the canonical page acquisition, not the invalidation queue's next
    // retry cycle after this fixture's deliberately unavailable bootstrap.
    await sync.refreshSessions({ awaitSessionListHydration: true });
    storage
      .getState()
      .applyServerScopedSessionListRows(
        serverId,
        [
          createSessionListRenderableSessionFixture({
            id: 'ordinary',
            active: true,
            metadata: { path: '/project' },
          }),
        ],
        { source: 'ordinary', mode: 'replace' },
      );
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={null}><BotsPopoverContent close={() => {}} maxHeight={520} /></InjectedAuthProvider>,
    );
    const { readOrdinarySessionListHomeState, getSessionListQueryHomeAvailability } = await import('@/sync/domains/session/listing/sessionListQueryRuntime');
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    await vi.waitFor(async () => {
      await flushHookEffects();
      const availability = getSessionListQueryHomeAvailability(scopeId);
      expect(screen.findByTestId('bots-roster.empty'), JSON.stringify({
        availability, socketStatus: storage.getState().socketStatus,
        ordinary: readOrdinarySessionListHomeState({ serverId: scopeId, requestedQueryKey: 'empty-roster-diagnostic',
          online: availability === 'pending' ? null : availability === 'online' }),
        text: screen.getTextContent(),
      })).not.toBeNull();
    });
    expect(screen.findByTestId('bots-roster.empty.new-bot')).not.toBeNull();
    // From a template… is the same menu row as the filled roster's footer, never a bare link that reads as a label.
    const { ActionListSection } = await import('@/components/ui/lists/ActionListSection');
    expect(screen.findAllByType(ActionListSection).flatMap(node => node.props.actions).map(action => action?.id)).toContain('from-template');
    expect(screen.findByTestId('session-list-item-ordinary')).toBeNull();
    expect(screen.findByTestId('bots-roster.partial')).toBeNull();
    expect(screen.findByTestId('bots-roster.unreadable')).toBeNull();
  });

  it('with no Bots, offers the roster\'s own empty row and New bot wearing the pet', async () => {
    serveHealthyOrdinarySnapshot = true;
    const { sync } = await import('@/sync/sync');
    await sync.refreshSessions({ awaitSessionListHydration: true });
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(
      <InjectedAuthProvider credentials={null}>
        <BotsPopoverContent close={() => {}} maxHeight={520} wearPet={{ pet: { kind: 'builtIn', petId: 'milo' }, name: 'Milo' }} />
      </InjectedAuthProvider>,
    );
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.findByTestId('bots-roster.wear.new-bot')).not.toBeNull();
    });
    expect(screen.findByTestId('bots-roster.empty')).not.toBeNull();
    expect(screen.findByTestId('bots-roster.from-template')).toBeNull();
  });

  it('explains unreadable candidates neutrally without offering an ineffective retry', async () => {
    serveHealthyOrdinarySnapshot = true;
    ordinarySessions = [
      createSessionFixture({ id: 'known-bot', metadata: { path: '/project', host: 'test', bot: { kind: 'bot' } } }),
      createSessionFixture({ id: 'locked-candidate', encryptionMode: 'e2ee', metadata: null,
        encryptedContentAvailability: 'encrypted_content_unavailable' }),
    ];
    const { sync } = await import('@/sync/sync');
    await sync.refreshSessions({ awaitSessionListHydration: true });
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <BotsPopoverContent close={() => {}} maxHeight={520} />
    </InjectedAuthProvider>);
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.findByTestId('bots-roster.unreadable'), await describeRosterState(screen)).not.toBeNull();
    });
    expect(screen.findByTestId('session-list-item-known-bot')).not.toBeNull();
    expect(screen.findByTestId('bots-roster.partial')).toBeNull();
    expect(screen.findByTestId('bots-roster.unreadable-action')).toBeNull();
  });

  it('discloses ordinary child Sessions under a Bot using the server total and the shared local fold choice', async () => {
    const serverId = connection!.home.id;
    replaceCollapsedGroupKeys({});
    storage.getState().applyServerScopedSessionListRows(serverId, [
      createSessionListRenderableSessionFixture({ id: 'lead-bot', metadata: { path: '/project', bot: { kind: 'bot' } },
        managedSessions: { total: 9, working: 0, stalled: 0, needsYou: 0, finished: 0, attentionPrimary: null } }),
      createSessionListRenderableSessionFixture({ id: 'child-session', metadata: { path: '/project' },
        manager: { sessionId: 'lead-bot' } }),
      createSessionListRenderableSessionFixture({ id: 'child-bot', metadata: { path: '/project', bot: { kind: 'bot' } },
        manager: { sessionId: 'lead-bot' } }),
      createSessionListRenderableSessionFixture({ id: 'unrelated', metadata: { path: '/project' } }),
    ], { source: 'ordinary', mode: 'replace' });
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <BotsPopoverContent close={() => {}} maxHeight={520} />
    </InjectedAuthProvider>);
    await flushHookEffects({ cycles: 3 });
    expect(screen.findByTestId('session-row-progress-chip:lead-bot')).not.toBeNull();
    expect(screen.getTextContent()).toContain('9');
    expect(screen.findByTestId('session-list-item-child-session')).toBeNull();
    expect(screen.findByTestId('session-list-item-child-bot')).toBeNull();
    // The Home fixture publishes Settings v1 independently of disclosure interactions.
    await waitForHomeGovernance(() => expect(storage.getState().settingsVersion).toBe(1));
    const settingsPublications = vi.fn();
    const stopSettingsPublications = storage.subscribe((next, previous) => {
      if (next.localSettings !== previous.localSettings || next.settings !== previous.settings) settingsPublications({
        local: Object.keys(next.localSettings).filter(key => Reflect.get(next.localSettings, key) !== Reflect.get(previous.localSettings, key)),
        account: Object.keys(next.settings).filter(key => Reflect.get(next.settings, key) !== Reflect.get(previous.settings, key)),
      });
    });
    onTestFinished(stopSettingsPublications);
    await pressNativeBoundary(screen, 'session-row-reports-disclosure:lead-bot');
    await flushHookEffects({ cycles: 3 });
    expect(screen.findByTestId('session-list-item-child-session')).not.toBeNull();
    expect(screen.findByTestId('session-list-item-child-bot')).not.toBeNull();
    expect(screen.findByTestId('session-list-item-unrelated')).toBeNull();
    await pressNativeBoundary(screen, 'session-row-reports-disclosure:lead-bot');
    expect(screen.findByTestId('session-list-item-child-session')).toBeNull();
    expect(settingsPublications.mock.calls).toEqual([]);
  });

  it('offers no sub-session disclosure for a Bot whose only report is archived, and counts the rest otherwise', async () => {
    const serverId = connection!.home.id;
    storage.getState().applyServerScopedSessionListRows(serverId, [
      createSessionListRenderableSessionFixture({ id: 'archived-only-bot', metadata: { path: '/project', bot: { kind: 'bot' } },
        managedSessions: { total: 1, working: 0, stalled: 0, needsYou: 0, archived: 1, finished: 0, attentionPrimary: null } }),
      createSessionListRenderableSessionFixture({ id: 'mixed-bot', metadata: { path: '/project', bot: { kind: 'bot' } },
        managedSessions: { total: 3, working: 0, stalled: 0, needsYou: 0, archived: 1, finished: 0, attentionPrimary: null } }),
    ], { source: 'ordinary', mode: 'replace' });
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <BotsPopoverContent close={() => {}} maxHeight={520} />
    </InjectedAuthProvider>);
    await flushHookEffects({ cycles: 3 });
    expect(screen.findByTestId('session-row-reports-disclosure:archived-only-bot')).toBeNull();
    expect(screen.findByTestId('session-row-progress-chip:archived-only-bot')).toBeNull();
    expect(screen.findByTestId('session-row-reports-disclosure:mixed-bot')).not.toBeNull();
    expect(screen.findByTestId('session-row-progress-chip:mixed-bot')).not.toBeNull();
    expect(screen.getTextContent()).toContain('2');
    expect(screen.getTextContent()).not.toContain('3');
  });

  it('moves a rail Bot with the keyboard through qualified Action admission and the mounted organization writer', async () => {
    const serverId = resolveServerProfileScopeIdForIdentifier(connection!.home.id);
    const ids = ['first-bot', 'list-only', 'last-bot'];
    storage.getState().applyServerScopedSessionListRows(serverId, ids.map(id => createSessionListRenderableSessionFixture({
      id, metadata: { path: '/project', ...(id === 'list-only' ? {} : { bot: { kind: 'bot' as const } }) },
    })), { source: 'ordinary', mode: 'replace' });
    ids.forEach((sessionId, index) => {
      const record = storage.getState().setSessionPinOptimistic(serverId, sessionId, {
        sessionId, sortKey: null, pinnedAt: index, listPinned: true, railPinned: sessionId !== 'list-only',
      });
      storage.getState().commitSessionOrganizationOptimistic(record);
    });
    const bot: AppRailBotEntry = { id: 'bot-first', sessionId: 'first-bot', serverId, face: { seed: 'first', face: null },
      session: createSessionListRenderableSessionFixture({ id: 'first-bot', metadata: { path: '/project', bot: { kind: 'bot' } } }) };
      const { AppRailBotPin } = await import('@/components/navigation/shell/appRail/AppRailBots');
      const { useSessionListRailOrganizationAction } = await import('@/components/sessions/shell/useSessionListRailOrganizationAction');
      function RailWithoutColumn() {
        useSessionListRailOrganizationAction([serverId]);
        return <AppRailBotPin bot={bot} animateEntry={false} nextBotSessionId="last-bot" />;
      }
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        await domAct(async () => root.render(<InjectedAuthProvider credentials={connection!.credentials}>
          <RailWithoutColumn />
        </InjectedAuthProvider>));
        const button = container.querySelector<HTMLElement>('[data-testid="app-rail:bot-first"]');
        expect(button).not.toBeNull();
        await domAct(async () => {
          button!.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
        });
        await flushHookEffects({ frames: 1 });
        expect(button!.getAttribute('aria-expanded')).toBe('true');
        await domAct(async () => {
          button!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }));
        });
        await vi.waitFor(() => expect(persistedOrder).toEqual(['list-only', 'last-bot', 'first-bot']));
        expect(navigate).not.toHaveBeenCalled();
      } finally {
        await domAct(async () => root.unmount());
        container.remove();
      }
  });

  it.each(['list', 'rail'] as const)('keeps an Ask-first %s move pending until the person confirms', async projection => {
    const serverId = resolveServerProfileScopeIdForIdentifier(connection!.home.id);
    const ids = ['first-bot', 'list-only', 'last-bot'];
    const confirmation = createDeferred<boolean>();
    vi.mocked(Modal.confirm).mockReturnValueOnce(confirmation.promise);
    askFirst = true;
    storage.getState().applySettingsLocal(actionApprovalSettings());
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' } });
    storage.getState().applyServerScopedSessionListRows(serverId, ids.map(id => createSessionListRenderableSessionFixture({
      id, metadata: { path: '/project', ...(id === 'list-only' ? {} : { bot: { kind: 'bot' as const } }) },
    })), { source: 'ordinary', mode: 'replace' });
    ids.forEach((sessionId, index) => {
      const record = storage.getState().setSessionPinOptimistic(serverId, sessionId, {
        sessionId, sortKey: null, pinnedAt: index, listPinned: true, railPinned: sessionId !== 'list-only',
      });
      storage.getState().commitSessionOrganizationOptimistic(record);
    });
    const { useAppRailBotReorder } = await import('@/components/navigation/shell/appRail/useAppRailBotReorder');
    const { useSessionListRailOrganizationAction } = await import('@/components/sessions/shell/useSessionListRailOrganizationAction');
    const { useSessionListEntityDragDrop } = await import('@/components/sessions/shell/useSessionListEntityDragDrop');
    const items: SessionListIndexItem[] = [
      { type: 'header', headerKind: 'pinned', title: 'Pinned', groupKey: PINNED_GROUP_KEY_V1, serverId },
      ...ids.map(sessionId => ({ type: 'session' as const, serverId, sessionId, groupKind: 'pinned' as const,
        groupKey: PINNED_GROUP_KEY_V1, pinned: true })),
    ];
    const bot: AppRailBotEntry = { id: 'bot-first', sessionId: 'first-bot', serverId, face: { seed: 'first', face: null },
      session: createSessionListRenderableSessionFixture({ id: 'first-bot', metadata: { path: '/project', bot: { kind: 'bot' } } }) };
    const hook = await renderHook(() => {
      // The two current mounted projections share the real Action and approval owners below HTTP.
      if (projection === 'rail') {
        useSessionListRailOrganizationAction([serverId]);
        return { kind: 'rail' as const, ...useAppRailBotReorder(bot) };
      }
      return { kind: 'list' as const, ...useSessionListEntityDragDrop({
        getListBounds: () => null,
        resolvePointerGeometry: () => ({ result: { instruction: { kind: 'idle' }, visual: { kind: 'none' } }, geometry: { kind: 'none' } }),
        getCommitContext: mutationScope => ({ latestItems: items, sessionFoldersV1: { v: 1, folders: [] },
          sessionListGroupOrderV1: { [PINNED_GROUP_KEY_V1]: ids.map(sessionId => sessionAddressKey({ serverId, sessionId })) },
          manualSessionOrderingEnabled: true, sessionListOrderingModeV1: 'custom', now: Date.now,
          setSessionFoldersV1: async () => { throw new Error('unexpected_folder_write'); },
          setSessionFolderAssignment: async () => { throw new Error('unexpected_assignment_write'); },
          setSessionListGroupOrderV1: async next => {
            if (!mutationScope) throw new Error('missing_captured_scope');
            await writeSessionOrganizationGroupOrder({ scope: mutationScope, next,
              orderItemAddressByItemKey: Object.fromEntries(ids.map(sessionId => [sessionAddressKey({ serverId, sessionId }), {
                itemKind: 'session' as const, serverId, sessionId,
              }])) });
          },
        }),
      }) };
    }, { wrapper: ({ children }) => <InjectedAuthProvider credentials={connection!.credentials}>{children}</InjectedAuthProvider> });
    await flushHookEffects({ cycles: 3 });
    if (projection === 'rail') await vi.waitFor(() => {
      const mounted = hook.getCurrent();
      expect(mounted.kind === 'rail' && mounted.available).toBe(true);
    });
    let settled = false;
    let pending!: Promise<unknown>;
    act(() => {
      const mounted = hook.getCurrent();
      if (mounted.kind === 'rail') pending = mounted.move('last-bot', 'bottom');
      else {
        const source = mounted.prepareSource({ sourceRowId: treeRowId.session(serverId, 'first-bot') });
        if (!source || !mounted.targetId) throw new Error('missing_mounted_list');
        pending = mounted.runtime.perform(source.sourceId, mounted.targetId, {
          sourceRowId: treeRowId.session(serverId, 'first-bot'), sourceKind: 'leaf', instructionKind: 'reorder-after',
          targetRowId: treeRowId.session(serverId, 'last-bot'), containerId: PINNED_GROUP_KEY_V1,
          parentRowId: null, depth: 0, edge: 'bottom',
        });
      }
      void pending.then(() => { settled = true; });
    });
    await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledTimes(1));
    expect(persistedOrder).toBeNull();
    expect(settled).toBe(false);
    await act(async () => { confirmation.resolve(true); });
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(persistedOrder).toEqual(['list-only', 'last-bot', 'first-bot']);
    expect(artifacts.list()).toEqual([]);
    if (projection === 'list') await expect(pending).resolves.toEqual({ status: 'applied' });
    await hook.unmount();
  });

  it('settles an overflow Bot move on its captured Home after More closes', async () => {
    const serverId = resolveServerProfileScopeIdForIdentifier(connection!.home.id);
    const ids = ['first-bot', 'last-bot'];
    const confirmation = createDeferred<boolean>();
    vi.mocked(Modal.confirm).mockReturnValueOnce(confirmation.promise);
    askFirst = true;
    storage.getState().applySettingsLocal(actionApprovalSettings());
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' } });
    const rows = ids.map(id => createSessionListRenderableSessionFixture({
      id, metadata: { path: '/project', bot: { kind: 'bot' } },
    }));
    storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' });
    ids.forEach((sessionId, index) => {
      const record = storage.getState().setSessionPinOptimistic(serverId, sessionId, {
        sessionId, sortKey: null, pinnedAt: index, listPinned: true, railPinned: true,
      });
      storage.getState().commitSessionOrganizationOptimistic(record);
    });
    const { AppRailSurface } = await import('@/components/navigation/shell/appRail/AppRail');
    const { buildAppRailEntries } = await import('@/components/navigation/shell/appRail/appRailModel');
    const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { useSessionListRailOrganizationAction } = await import('@/components/sessions/shell/useSessionListRailOrganizationAction');
    const alert = vi.spyOn(Modal, 'alert');
    const catalogEntries = buildAppRailEntries(resolveCompactAppDestinations({
      builtins: { externalSessions: false, inbox: false, workflows: false, friends: false }, pages: [],
    }));
    const entries = { app: catalogEntries.app.filter(entry => entry.activation === 'botsRoster'), plugins: [], account: [],
      bots: rows.map((session, index): AppRailBotEntry => ({ id: `overflow-${index}`, serverId, sessionId: session.id, face: { seed: session.id, face: null }, session })) };
    // Layout is the browser boundary: notify real RNW's observer of the short rail, without replacing a UI owner.
    let notifyLayout: ((entries: Array<{ target: Element }>) => void) | undefined;
    const priorObserver = window.ResizeObserver;
    class LayoutObserver {
      constructor(callback: (entries: Array<{ target: Element }>) => void) { notifyLayout = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: LayoutObserver });
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return new DOMRect(56, 40, 240, 44);
    });
    function ShortRail() {
      useSessionListRailOrganizationAction([serverId]);
      return <AppRailSurface entries={entries} activeId={null} onOpen={() => {}}
        preferences={{ orderedIds: [], placements: { 'app-rail-usage': 'hidden', 'app-rail-machines': 'hidden', 'app-rail-account': 'hidden' } }}
        renderFooter={() => null} />;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const click = async (testID: string) => {
      const control = document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
      expect(control).not.toBeNull();
      await domAct(async () => control!.click());
      await flushHookEffects({ frames: 1 });
    };
    try {
      await domAct(async () => root.render(<InjectedAuthProvider credentials={connection!.credentials}><ShortRail /></InjectedAuthProvider>));
      const rail = container.querySelector<HTMLElement>('[data-testid="app-rail"]')!;
      Object.defineProperties(rail, { offsetHeight: { configurable: true, value: 48 }, offsetWidth: { configurable: true, value: 56 } });
      await domAct(async () => { notifyLayout?.([{ target: rail }]); await new Promise(resolve => setTimeout(resolve, 0)); });
      await click('app-rail-more.trigger');
      await click('app-rail-more:overflow-0');
      await click('dropdown-option-move-down_overflow-0');
      await vi.waitFor(() => expect(Modal.confirm).toHaveBeenCalledTimes(1));
      expect(persistedOrder).toBeNull();
      expect(alert).not.toHaveBeenCalled();
      await click('app-rail-more.trigger');
      await domAct(async () => { confirmation.resolve(true); });
      await vi.waitFor(() => expect(persistedOrder).toEqual(['last-bot', 'first-bot']));
      expect(artifacts.list()).toEqual([]);
      expect(alert).not.toHaveBeenCalled();
    } finally {
      await domAct(async () => root.unmount());
      container.remove();
      alert.mockRestore();
      geometry.mockRestore();
      Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: priorObserver });
    }
  });
});
