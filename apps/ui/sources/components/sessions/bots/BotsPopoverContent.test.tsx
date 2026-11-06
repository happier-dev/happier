import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
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
  AccountSettingsV2GetResponseSchema,
  ActionsSettingsV1Schema,
  CurrentCursorResponseSchema,
  V2SessionListResponseSchema,
} from '@happier-dev/protocol';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
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
import { primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { storage } from '@/sync/domains/state/storage';
import { replaceCollapsedGroupKeys } from '@/sync/domains/state/disclosureUiState';
import { ReorderSessionOrganizationRequestSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { PINNED_GROUP_KEY_V1 } from '@/sync/domains/session/listing/sessionListOrderingStateV1';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { treeRowId } from '@/components/sessions/shell/drop-resolution/treeRowId';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { writeSessionOrganizationGroupOrder } from '@/sync/ops/sessionOrganization/sessionOrganizationMutationOwner';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { AppRailBotEntry } from '@/components/navigation/shell/appRail/appRailModel';
import { t } from '@/text';

// The Account, ordinary list/index, Bot classification, rows and actions stay real. Only
// native/navigation adapters and the external transports are replaced.
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(await vi.importActual('react-native-web')),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const navigate = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { navigate } }).module);
// Auth/storage imports reach Socket.IO before the harness can install a doMock.
vi.mock('socket.io-client', async importOriginal =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal),
);
// Metro's deferred require is the loader boundary; the real Action executor remains underneath it.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

installDisconnectedServerSocketBoundary(socket => {
  socket.connect = vi.fn(() => {
    socket.connected = true;
    for (const listener of socket.listeners('connect')) listener();
    return socket;
  });
});

// No Home here answers a structural Session query: the roster reads the ordinary loaded rows.
const features = createRootLayoutFeaturesResponse({
  features: { sessions: { enabled: true } },
});
let connection:
  | Awaited<ReturnType<typeof restoreServerAccountForTest>>
  | undefined;
let persistedOrder: string[] | null = null;
let askFirst = false;
let serveHealthyOrdinarySnapshot = false;
let webLocks: WebLockManagerMockHandle | undefined;
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

describe('Bots roster', () => {
  beforeAll(loadSyncSingletonForTests);
  beforeEach(async () => {
    webLocks = installWebLockManagerMock();
    persistedOrder = null;
    askFirst = false;
    serveHealthyOrdinarySnapshot = false;
    artifacts.clear();
    navigate.mockClear();
    connection = await restoreServerAccountForTest({
      serverUrl: 'https://bots-roster.example.test',
      serverIdentityId: 'srv_bots-roster',
      accountId: 'account-a',
      request: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/health') return Response.json({ status: 'ok' });
        if (path === '/v1/features') return Response.json(features);
        if (serveHealthyOrdinarySnapshot && (path === '/v2/sessions' || path === '/v2/sessions/active')) return Response.json(V2SessionListResponseSchema.parse({
          sessions: [], nextCursor: null, hasNext: false,
        }));
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
    expect(screen.findByTestId('bots-roster.offline')).not.toBeNull();
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

  it('does not rescan expanded roster membership for unrelated store publications', async () => {
    const serverId = connection!.home.id;
    const now = Date.now();
    const population = Array.from({ length: 16 }, (_, index) =>
      createSessionListRenderableSessionFixture({ id: `measured-bot-${index}`, activeAt: now,
        metadata: { path: '/project', name: `Measured Bot ${index}`, bot: { kind: 'bot' } },
        ...(index === 0 ? { managedSessions: { total: 1, working: 0, stalled: 0, needsYou: 0, finished: 0, attentionPrimary: null } } : {}) }));
    population.push(createSessionListRenderableSessionFixture({ id: 'measured-child',
      metadata: { path: '/project' }, manager: { sessionId: 'measured-bot-0' } }));
    population.push(...Array.from({ length: 983 }, (_, index) =>
      createSessionListRenderableSessionFixture({ id: perfFixtureId(4, 'session', index), metadata: { path: '/project' } })));
    replaceCollapsedGroupKeys({});
    storage.getState().applyServerScopedSessionListRows(serverId, population, { source: 'ordinary', mode: 'replace' });
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
    let commits = 0;
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <React.Profiler id="measured-bots-roster" onRender={() => { commits += 1; }}>
        <BotsPopoverContent close={() => {}} maxHeight={520} />
      </React.Profiler>
    </InjectedAuthProvider>);
    await flushHookEffects({ cycles: 3 });
    await pressNativeBoundary(screen, 'session-row-reports-disclosure:measured-bot-0');
    await flushHookEffects({ cycles: 3 });
    expect(screen.findByTestId('session-list-item-measured-child')).not.toBeNull();
    const mountedRows = population.filter(row => screen.findByTestId(`session-list-item-${row.id}`) !== null).length;
    rowMapEnumerations = 0;
    metadataReads = 0;
    commits = 0;
    // Isolate this synchronous arrival batch from valid age-clock and bootstrap arrivals.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    onTestFinished(() => { vi.useRealTimers(); });
    let notifications = 0;
    const stopCountingNotifications = storage.subscribe(() => { notifications += 1; });
    const beforeSettings = storage.getState();
    try {
      act(() => {
        for (let index = 0; index < 10; index += 1) {
          storage.getState().applySettingsLocal({ wrapLinesInDiffs: index % 2 === 0 });
        }
      });
    } finally {
      stopCountingNotifications();
      vi.useRealTimers();
    }
    expect(storage.getState().sessions).toBe(beforeSettings.sessions);
    expect(storage.getState().sessionListRowsByServerId).toBe(beforeSettings.sessionListRowsByServerId);
    const unrelated = { notifications, commits, rowMapEnumerations, metadataReads };
    commits = 0;
    const updated = population.map(row => row.id === 'measured-bot-0'
      ? { ...row, updatedAt: now + 1, metadata: { ...row.metadata!, name: 'Measured Bot updated' } } : row);
    await act(async () => {
      storage.getState().applyServerScopedSessionListRows(serverId, updated, { source: 'ordinary', mode: 'replace' });
    });
    await flushHookEffects({ cycles: 3 });
    expect(screen.getTextContent()).toContain('Measured Bot updated');
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
    expect(unrelated.notifications).toBe(10);
    expect(unrelated.rowMapEnumerations).toBe(0);
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

  it('orders Bots needs-you, then working, then most recent, and says nothing about an idle Bot beyond its age', async () => {
    const serverId = connection!.home.id;
    const now = Date.now();
    const hour = 3_600_000;
    const bot = { path: '/project', bot: { kind: 'bot' as const } };
    storage.getState().applyServerScopedSessionListRows(serverId, [
      createSessionListRenderableSessionFixture({ id: 'idle-old', meaningfulActivityAt: now - 20 * hour, active: false, activeAt: now - 20 * hour, updatedAt: now - 20 * hour, metadata: { ...bot, name: 'Docs gardener' } }),
      createSessionListRenderableSessionFixture({ id: 'idle-new', meaningfulActivityAt: now - 3 * hour, active: false, activeAt: now - 3 * hour, updatedAt: now - 3 * hour, metadata: { ...bot, name: 'Deps' } }),
      createSessionListRenderableSessionFixture({ id: 'working', meaningfulActivityAt: now, active: true, thinking: true, thinkingAt: now, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now, activeAt: now, updatedAt: now, metadata: { ...bot, name: 'Release captain' } }),
      createSessionListRenderableSessionFixture({ id: 'needs-you', meaningfulActivityAt: now - hour, active: true, activeAt: now, updatedAt: now, hasPendingPermissionRequests: true, pendingRequestObservedAt: now, metadata: { ...bot, name: 'Flake hunter' } }),
      createSessionListRenderableSessionFixture({ id: 'offline-blocked', presence: now - 2 * hour, pendingBlockedCount: 1, activeAt: now - 2 * hour, metadata: { ...bot, name: 'Release notebook' } }),
      createSessionListRenderableSessionFixture({ id: 'offline-failed', presence: now - 2 * hour, latestTurnStatus: 'failed', activeAt: now - 2 * hour, metadata: { ...bot, name: 'Library companion' } }),
      createSessionListRenderableSessionFixture({ id: 'offline-working', presence: now - 2 * hour, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now, activeAt: now - 2 * hour, metadata: { ...bot, name: 'A pinned companion' } }),
    ], { source: 'ordinary', mode: 'replace' });

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
    await flushHookEffects({ cycles: 3 });
    expectUniqueRows();
    expect(screen.getTextContent()).toContain(`${t('bots.roster.needsYou', { count: 2 })} · ${t('bots.roster.working', { count: 1 })}`);
    // The row's age already says when it was last active; an idle Bot adds no "Last seen" line.
    expect(text).not.toContain('Last seen');
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
    expect(screen.findByTestId('session-list-item-ordinary')).toBeNull();
    expect(screen.findByTestId('bots-roster.partial')).toBeNull();
    expect(screen.findByTestId('bots-roster.unreadable')).toBeNull();
  });

  it('explains unreadable candidates neutrally without offering an ineffective retry', async () => {
    serveHealthyOrdinarySnapshot = true;
    const { sync } = await import('@/sync/sync');
    await sync.refreshSessions({ awaitSessionListHydration: true });
    storage.getState().applyServerScopedSessionListRows(connection!.home.id, [
      createSessionListRenderableSessionFixture({ id: 'known-bot', metadata: { path: '/project', bot: { kind: 'bot' } } }),
      createSessionListRenderableSessionFixture({ id: 'locked-candidate', metadata: null,
        encryptedContentAvailability: 'encrypted_content_unavailable' }),
    ], { source: 'ordinary', mode: 'replace' });
    const { BotsPopoverContent } = await import('./BotsPopoverContent');
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <BotsPopoverContent close={() => {}} maxHeight={520} />
    </InjectedAuthProvider>);
    await vi.waitFor(async () => {
      await flushHookEffects();
      expect(screen.findByTestId('bots-roster.unreadable')).not.toBeNull();
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
    expect(screen.findByTestId('session-row-reports-chip:lead-bot')).not.toBeNull();
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
    expect(screen.findByTestId('session-row-reports-chip:archived-only-bot')).toBeNull();
    expect(screen.findByTestId('session-row-reports-disclosure:mixed-bot')).not.toBeNull();
    expect(screen.findByTestId('session-row-reports-chip:mixed-bot')).not.toBeNull();
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
    const bot: AppRailBotEntry = { id: 'bot-first', sessionId: 'first-bot', serverId, avatarId: 'first',
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

  it.each(['list', 'rail'] as const)('keeps an Ask-first %s move pending until the captured Home approval settles', async projection => {
    const serverId = resolveServerProfileScopeIdForIdentifier(connection!.home.id);
    const ids = ['first-bot', 'list-only', 'last-bot'];
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
    const bot: AppRailBotEntry = { id: 'bot-first', sessionId: 'first-bot', serverId, avatarId: 'first',
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
    await vi.waitFor(() => expect(artifacts.list()).toHaveLength(1));
    await flushHookEffects({ cycles: 3 });
    const artifactId = artifacts.list()[0]!.id;
    expect(ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!))).toMatchObject({
      status: 'open', actionId: 'session.organization.move',
      actionArgs: { scope: { serverId, accountId: 'account-a' }, ...(projection === 'rail' ? { projection: 'rail' } : {}) },
      executionOriginV1: { serverId },
    });
    expect(persistedOrder).toBeNull();
    expect(settled).toBe(false);
    await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!))).toMatchObject({
      status: 'executed', execution: { ok: true, result: { status: 'applied' } },
    });
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(persistedOrder).toEqual(['list-only', 'last-bot', 'first-bot']);
    if (projection === 'list') await expect(pending).resolves.toEqual({ status: 'applied' });
    await hook.unmount();
  });

  it('settles an overflow Bot move on its captured Home after More closes', async () => {
    const serverId = resolveServerProfileScopeIdForIdentifier(connection!.home.id);
    const ids = ['first-bot', 'last-bot'];
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
    const { Modal } = await import('@/modal');
    const alert = vi.spyOn(Modal, 'alert');
    const catalogEntries = buildAppRailEntries(resolveCompactAppDestinations({
      builtins: { externalSessions: false, inbox: false, workflows: false, friends: false }, pages: [],
    }));
    const entries = { app: catalogEntries.app.filter(entry => entry.activation === 'botsRoster'), plugins: [], account: [],
      bots: rows.map((session, index): AppRailBotEntry => ({ id: `overflow-${index}`, serverId, sessionId: session.id, avatarId: session.id, session })) };
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
      await vi.waitFor(() => expect(artifacts.list()).toHaveLength(1));
      const artifactId = artifacts.list()[0]!.id;
      expect(ApprovalRequestV2Schema.parse(JSON.parse(artifacts.readPlainBody(artifactId)!))).toMatchObject({
        status: 'open', actionArgs: { projection: 'rail', scope: { serverId, accountId: 'account-a' } },
        executionOriginV1: { serverId, accountId: 'account-a' },
      });
      expect(persistedOrder).toBeNull();
      expect(alert).not.toHaveBeenCalled();
      await click('app-rail-more.trigger');
      await expect(decideApprovalAsInbox(serverId, artifactId, 'approve')).resolves.toMatchObject({ ok: true, result: { status: 'executed' } });
      await vi.waitFor(() => expect(persistedOrder).toEqual(['last-bot', 'first-bot']));
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
