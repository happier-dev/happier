import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAwarenessListResultV1Schema} from '@happier-dev/protocol/sessions/awareness/action';
import { projectLegacySessionAccessCapabilitiesV1} from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { V2SessionRecordSchema, type V2SessionRecord } from '@happier-dev/protocol/sessions/control/contract';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { SessionListActionResultV1Schema } from '@happier-dev/protocol/sessions/awareness/action';
import { PluginUiJsonValueV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createDeferred, createSessionFixture, createSessionListRenderableSessionFixture, createSessionMessagesFixture } from '@/dev/testkit';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
vi.mock('socket.io-client', async original =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { loadAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { startConcurrentSessionCacheSync, stopConcurrentSessionCacheSync } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
const { isSessionListQueryHomeOnline, resolveOrdinarySessionListHomeOwner } = await import('@/sync/domains/session/listing/sessionListQueryRuntime');
const { resetSessionListPaneRetentionForTests } = await import('@/components/sessions/shell/sessionListPaneRetention');
const { listSessionsForVoiceTool } = await import('./sessionList');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const initialState = storage.getState();
const initialConcurrentFlag = process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;

function row(id = 's1', overrides: Partial<V2SessionRecord> = {}) {
  const session = createSessionFixture({ id, updatedAt: 100, active: true, metadata: {
    path: '/Users/leeroy/Documents/secret-workspace/payments', host: 'leeroy-mbp',
    summary: { text: 'Confidential billing rewrite', updatedAt: 0 },
  } });
  return V2SessionRecordSchema.parse({
    id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
    active: session.active, activeAt: session.activeAt, encryptionMode: session.encryptionMode,
    metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion,
    agentState: null, agentStateVersion: session.agentStateVersion, dataEncryptionKey: null,
    share: null, owner: 'viewer',
    effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
      capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'owner' }) },
    responsibleAccountId: null, responsibleAccount: null,
    viewer: {
      latestFailureSeq: null,
      readState: { state: 'not_started' }, relevance: { relevant: true, reasons: ['owned_by_me'] },
      attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
      follow: { follows: false, notificationLevel: null }, notification: { level: 'none', source: 'none' },
    },
    ...overrides,
  });
}

function ordinaryPage(sessions: readonly V2SessionRecord[], options: { hasNext?: boolean; nextCursor?: string | null } = {}) {
  return createSessionListSourceFixture({ sessions, hasNext: options.hasNext ?? false, nextCursor: options.nextCursor ?? null });
}

function queryPage(sessions: readonly V2SessionRecord[], options: {
  hasNext?: boolean; nextCursor?: string | null; attentionNextCursor?: string | null; attentionHasNext?: boolean;
} = {}) {
  return createSessionListSourceFixture({
    sessions, hasNext: false, nextCursor: null, attentionNextCursor: null, attentionHasNext: false, ...options,
  });
}

function seedSession(privacyOverrides: Partial<typeof settingsDefaults.voice.privacy>) {
  const settings = { ...storage.getState().settings, voice: {
    ...settingsDefaults.voice, privacy: { ...settingsDefaults.voice.privacy, ...privacyOverrides },
  } };
  const scope = storage.getState().settingsScope;
  if (!scope) throw new Error('Restored Account settings scope missing');
  const version = (loadAccountSettings(scope).version ?? 0) + 1;
  storage.getState().applySettingsForScope(scope, settings, version);
  home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version } });
  home.answer(serverId, '/v2/sessions', { body: ordinaryPage([row()]) });
}

function seedMountedMembership() {
  const state = storage.getState();
  state.applyServerScopedSessionListRows(serverId, [
    createSessionListRenderableSessionFixture({ id: 'mounted-ordinary' }),
  ], { source: 'ordinary', mode: 'replace' });
  state.applyServerScopedSessionListRows(serverId, [
    createSessionListRenderableSessionFixture({ id: 'mounted-archived', archivedAt: 1 }),
  ], { source: 'archived', mode: 'replace' });
  state.commitSessionListQueryMembership('mounted-query', {
    serverId, accountId: 'viewer', sessionIds: ['mounted-query-session'],
  });
}

function ordinaryReads() {
  return home.requests.filter(request => request.path.split('?')[0] === '/v2/sessions');
}

async function mountOtherHome() {
  const otherServerId = await home.addHome({ name: 'Other Home', serverUrl: 'https://voice-list-b.test', accountId: 'viewer', active: false });
  home.answer(otherServerId, '/v2/sessions', { body: ordinaryPage([]) });
  home.answer(otherServerId, '/v1/auth/ping', { body: { ok: true } });
  startConcurrentSessionCacheSync();
  await home.selectHomes([serverId, otherServerId]);
  await waitForHomeGovernance(() => {
    expect(resolveOrdinarySessionListHomeOwner(otherServerId)).toBe('concurrent');
    expect(isSessionListQueryHomeOnline(otherServerId)).toBe(true);
  });
  return otherServerId;
}

beforeEach(async () => {
  process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = '1';
  vi.stubGlobal('fetch', home.request);
  await home.reset();
  storage.setState(initialState, true);
  resetSessionListPaneRetentionForTests();
  serverId = await home.addHome({ name: 'Home A', serverUrl: 'https://voice-list-a.test', accountId: 'viewer' });
  home.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, { body: createPlainProjectAccountRowListFixture({
    workspaceRefs: [
      { id: 'anchor-checkout', serverId, projectKey: 'anchor', machineId: 'machine', rootPath: '/repo', createdAtMs: 1 },
      { id: 'other-checkout', serverId, projectKey: 'other', machineId: 'machine', rootPath: '/other', createdAtMs: 1 },
    ],
  }) });
  home.answer(serverId, '/v2/sessions', { body: ordinaryPage([]) });
  home.answer(serverId, '/v2/sessions/active', { body: ordinaryPage([]) });
  home.answer(serverId, '/v1/auth/ping', { body: { ok: true } });
  connection = await restoreServerAccountForTest({ serverUrl: 'https://voice-list-a.test', accountId: 'viewer',
    request: (url, init) => home.request(url, init) });
  installHomeGovernanceBoundaries(home);
  setRuntimeFetch(home.request);
  // Join the real bootstrap before a case publishes newer mounted membership.
  const { sync } = await import('@/sync/sync');
  await sync.resumeSync('manual');
  serverId = connection.home.id;
  storage.setState({ socketStatus: 'connected', sessions: {}, sessionMessages: {},
    sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
    archivedSessionListMembershipByServerId: {}, sessionListQueryMembershipByKey: {}, sessionListIndexByServerId: {} });
});

afterEach(async () => {
  stopConcurrentSessionCacheSync();
  await connection?.dispose();
  connection = undefined;
  await home.reset();
  resetSessionListPaneRetentionForTests();
  vi.unstubAllGlobals();
  if (initialConcurrentFlag === undefined) delete process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT;
  else process.env.EXPO_PUBLIC_HAPPY_MULTI_SERVER_CONCURRENT = initialConcurrentFlag;
  storage.setState(initialState, true);
});

describe('listSessionsForVoiceTool privacy', () => {
  it('lists Session candidates through the mounted plugin Action dispatcher', async () => {
    seedSession({ shareSessionSummary: false });
    const { dispatchPluginSurfaceAction } = await import('@/components/plugins/surfaces/pluginSurfaceActionDispatch');
    const executor = createDefaultActionExecutor();
    const result = await dispatchPluginSurfaceAction({
      action: 'session.list',
      input: { view: 'awareness', limit: 100 },
      callerPluginId: 'acme.session-picker',
      callerContributionLocalId: 'picker',
      callerBinding: {
        pluginId: 'acme.session-picker', contributionLocalId: 'picker', occurrenceId: 'picker-current',
        materializationRef: { pluginId: 'acme.session-picker', machineId: 'machine-1', materializationId: 'picker-installed' },
      },
      hostAction: { execute: executor.execute, context: { serverId } },
    });
    if (!result.ok) throw new Error(`Mounted Session listing refused: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ ok: true, result: {
      view: 'awareness', projectionVersion: 1,
      sessions: [{ sessionId: 's1', title: 'Confidential billing rewrite' }],
    } });
    const autonomous = await dispatchPluginSurfaceAction({
      action: 'session.list', input: { limit: 100, includeLastMessagePreview: false },
      callerPluginId: 'acme.session-picker', invocationSurface: 'agent',
      invocation: { kind: 'clientPluginAction', clientActionBinding: {
        pluginId: 'acme.session-picker', contributionLocalId: 'picker', occurrenceId: 'picker-current',
        materializationRef: { pluginId: 'acme.session-picker', machineId: 'machine-1', materializationId: 'picker-installed' },
      } },
      hostAction: { execute: executor.execute, context: { serverId } },
    });
    expect(autonomous).toMatchObject({ ok: false, reason: 'unsupported_action' });
  });

  it('pages the selected Home at its server cursor and retries a failed older page without changing mounted membership', async () => {
    seedSession({ shareSessionSummary: true });
    seedMountedMembership();
    home.answer(serverId, '/v2/sessions?limit=1', {
      body: ordinaryPage([row('recent')], { hasNext: true, nextCursor: 'older-page' }),
    });
    const before = storage.getState();
    const first = await listSessionsForVoiceTool({ serverId, limit: 1, includeLastMessagePreview: false });
    SessionListActionResultV1Schema.parse(first);
    PluginUiJsonValueV1Schema.parse(first);
    expect(first).toMatchObject({ sessions: [{ id: 'recent' }], nextCursor: 'older-page', hasNext: true });
    home.answer(serverId, '/v2/sessions?limit=1&cursor=older-page', { status: 503, body: {} });
    await expect(listSessionsForVoiceTool({ serverId, limit: 1, cursor: 'older-page' }))
      .resolves.toMatchObject({ ok: false });
    home.answer(serverId, '/v2/sessions?limit=1&cursor=older-page', { body: ordinaryPage([row('older')]) });
    const second = await listSessionsForVoiceTool({ serverId, limit: 1, cursor: 'older-page' });
    SessionListActionResultV1Schema.parse(second);
    PluginUiJsonValueV1Schema.parse(second);
    expect(second).toMatchObject({ sessions: [{ id: 'older' }], nextCursor: null, hasNext: false });
    expect(storage.getState().ordinarySessionListMembershipByServerId).toEqual(before.ordinarySessionListMembershipByServerId);
    expect(storage.getState().archivedSessionListMembershipByServerId).toEqual(before.archivedSessionListMembershipByServerId);
    expect(storage.getState().sessionListQueryMembershipByKey).toEqual(before.sessionListQueryMembershipByKey);
  });

  it('publishes a valid scoped Session summary when presence and a requested retained preview are unavailable', async () => {
    seedSession({ shareSessionSummary: true });
    const result = await listSessionsForVoiceTool({ serverId, includeLastMessagePreview: true });
    const parsed = SessionListActionResultV1Schema.parse(result);
    expect(parsed).toMatchObject({ sessions: [{ id: 's1', presence: null }] });
    expect(PluginUiJsonValueV1Schema.parse(result)).toMatchObject({ sessions: [{ id: 's1' }] });
    expect(parsed.sessions[0]).not.toHaveProperty('lastMessagePreview');
  });

  it('publishes numeric last-seen presence as the canonical offline state through the Action boundary', async () => {
    seedSession({ shareSessionSummary: true });
    storage.getState().applySessions([createSessionFixture({ id: 's1', serverId, presence: 0 })]);
    const result = await createDefaultActionExecutor().execute('session.list',
      { view: 'summary', includeLastMessagePreview: false }, { serverId });
    expect(result).toMatchObject({ ok: true, result: { sessions: [{ id: 's1', presence: 'offline' }] } });
    if (!result.ok) throw new Error(`Numeric Session presence was refused: ${JSON.stringify(result)}`);
    SessionListActionResultV1Schema.parse(result.result);
  });

  it('offers canonical names and puts unopened Project Sessions first while retaining other Home choices', async () => {
    const sessionId = 'project-services';
    expect(storage.getState().sessions[sessionId]).toBeUndefined();
    home.answer(serverId, '/v2/sessions/query', { body: queryPage([row('other-project'), row(sessionId, {
      metadata: JSON.stringify({ path: '/repo', host: 'test', projectId: 'anchor', workspaceId: 'anchor-checkout' }),
    }), row('unnamed', { metadata: JSON.stringify({ path: '', host: 'test' }) })]) });
    const result = await createDefaultActionExecutor().execute('action.options.resolve', {
      consumer: { kind: 'widget', surface: { serverId, accountId: 'viewer', owner: { kind: 'project', projectId: 'anchor' } },
        definition: { kind: 'builtin', id: 'local_services' } }, fieldPath: 'session',
    }, { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'viewer' });
    expect(result).toMatchObject({ ok: true, result: { options: [
      expect.objectContaining({ value: { serverId, sessionId }, label: 'repo' }),
      expect.objectContaining({ value: { serverId, sessionId: 'other-project' }, label: 'Confidential billing rewrite' }),
      expect.objectContaining({ value: { serverId, sessionId: 'unnamed' }, label: 'Untitled session' }),
    ] } });
    expect(home.requestsFor('/v2/sessions/query').at(-1)?.input).toMatchObject({ includeInactive: true, scope: 'all_accessible' });
  });

  it('narrows Project reads before summary or awareness disclosure and retains pagination', async () => {
    seedSession({ shareSessionSummary: true });
    home.answer(serverId, '/v2/sessions', { body: ordinaryPage([
      row('s1', { metadata: JSON.stringify({ path: '/repo', host: 'test', projectId: 'anchor', workspaceId: 'anchor-checkout' }) }),
      row('other', { metadata: JSON.stringify({ path: '/other', host: 'test', projectId: 'other', workspaceId: 'other-checkout' }) }),
      row('foreign', { owner: 'foreign', ownerAccountId: 'foreign',
        metadata: JSON.stringify({ path: '/repo', host: 'test', projectId: 'anchor', workspaceId: 'anchor-checkout' }) }),
      row('recipient', { share: { accessLevel: 'view', canApprovePermissions: false },
        metadataLayoutVersion: 1,
        effectiveAccess: { v: 1, level: 'view', sources: [{ kind: 'direct', shareId: 'share-1' }],
          capabilities: projectLegacySessionAccessCapabilitiesV1({ level: 'view' }) },
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: { path: '/repo', host: 'test', projectId: 'anchor', workspaceId: 'anchor-checkout' } })) }),
      row('locked', { metadata: 'null' }),
      // Stamped with checkout `anchor-checkout`'s own key before it joined the Project.
      row('joined', { projectKey: 'anchor-checkout', metadata: JSON.stringify({ path: '/repo', host: 'test' }) }),
    ], { nextCursor: 'next', hasNext: true }) });
    const project = { serverId, projectKey: 'anchor' };
    const result = await listSessionsForVoiceTool({ project });
    // Foreign/shared rows cannot borrow the viewer's private checkout census; the locked row is unknown too.
    expect(result).toMatchObject({ project, sessions: [{ id: 's1' }, { id: 'joined' }], nextCursor: 'next', hasNext: true, projectFilterUnavailableCount: 3 });
    if (!('sessions' in result)) throw new Error('Expected Project session list');
    expect(result.sessions).toHaveLength(2);
    expect(await listSessionsForVoiceTool({ project, serverId: 'foreign-home' })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
  });

  it('applies the Bot facet to authorized hydrated rows while reporting locked candidates and continuations', async () => {
    seedSession({ shareSessionSummary: true });
    home.answer(serverId, '/v2/sessions/query', { body: queryPage([
      row('s1', { metadata: JSON.stringify({ bot: { kind: 'bot' }, path: '/repo', host: 'test' }) }),
      row('ordinary', { metadata: JSON.stringify({ summary: { text: 'Bot', updatedAt: 0 }, path: '/repo', host: 'test' }) }),
      row('locked', { metadata: 'null' }),
    ], { nextCursor: 'next', hasNext: true, attentionNextCursor: 'attention', attentionHasNext: true }) });
    const result = await listSessionsForVoiceTool({ query: SessionListQueryV1Schema.parse({
      v: 1, storage: 'active', includeInactive: true, scope: 'my_work', attention: 'any', audiences: [], tagIds: [], bot: 'bot', includeAttention: true,
    }) });
    expect(result).toMatchObject({ sessions: [{ id: 's1' }], botFilterUnavailableCount: 1,
      nextCursor: 'next', hasNext: true, attentionNextCursor: 'attention', attentionHasNext: true });
    if (!('sessions' in result)) throw new Error('Expected Bot session list');
    expect(result.sessions).toHaveLength(1);
  });

  it('preserves another Home row timestamp and never attaches the active Home transcript with the same id', async () => {
    seedSession({ shareRecentMessages: true, shareSessionSummary: true });
    const otherServerId = await mountOtherHome();
    home.answer(otherServerId, '/v2/sessions', { body: ordinaryPage([row('s1', {
      updatedAt: 7, active: false, metadata: JSON.stringify({ path: '/repo', host: 'test', summary: { text: 'Other session', updatedAt: 7 } }),
    })]) });
    const message = { id: 'message-1', kind: 'user-text', text: 'Active Home private transcript', createdAt: 100, localId: null } as const;
    storage.setState({ sessionMessages: { s1: createSessionMessagesFixture({
      messageIdsOldestFirst: [message.id], messagesById: { [message.id]: message }, isLoaded: true,
    }) } });
    const result = await listSessionsForVoiceTool({ includeLastMessagePreview: true });
    if ('view' in result || !result.ok) throw new Error('Expected summary session list');
    expect(result.sessions.find(session => session.serverId === otherServerId)).toMatchObject({ id: 's1', updatedAt: 7 });
    expect(result.sessions.find(session => session.serverId === otherServerId)).not.toHaveProperty('lastMessagePreview');
    expect(result.sessions.find(session => session.serverId === getActiveServerSnapshot().serverId))
      .toMatchObject({ lastMessagePreview: { text: message.text } });
  });

  it('pages equal Session ids from different Homes without dropping either qualified address', async () => {
    seedSession({ shareSessionSummary: true });
    const otherServerId = await mountOtherHome();
    home.answer(otherServerId, '/v2/sessions', { body: ordinaryPage([row('s1', { active: false })]) });
    const first = await listSessionsForVoiceTool({ limit: 1 });
    if ('view' in first || !first.ok) throw new Error('Expected first summary page');
    const second = await listSessionsForVoiceTool({ limit: 1, cursor: first.nextCursor });
    if ('view' in second || !second.ok) throw new Error('Expected second summary page');
    expect([...first.sessions, ...second.sessions].map(session => `${session.serverId}:${session.id}`).sort())
      .toEqual([`${serverId}:s1`, `${otherServerId}:s1`].sort());
    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).toBeNull();
  });

  it('reads the released delimiter cursor while publishing only qualified structured cursors', async () => {
    seedSession({ shareSessionSummary: true });
    home.answer(serverId, '/v2/sessions', { body: ordinaryPage([row(), row('s0', { updatedAt: 90, active: false })]) });
    const result = await listSessionsForVoiceTool({ limit: 1, cursor: '100:s1' });
    if ('view' in result || !result.ok) throw new Error('Expected summary page');
    expect(result.sessions.map(session => session.id)).toEqual(['s0']);
    expect(result.nextCursor).toBeNull();
  });

  it('advertises continuation only for remaining rows and projects only the requested page', async () => {
    seedSession({ shareSessionSummary: true });
    const records = Array.from({ length: 4 }, (_, index) => row(`cost-${index}`, {
      updatedAt: 100 - index,
    }));
    home.answer(serverId, '/v2/sessions', { body: ordinaryPage(records) });
    const all = await listSessionsForVoiceTool({ limit: records.length });
    const first = await listSessionsForVoiceTool({ limit: 1 });
    if ('view' in all || !all.ok || 'view' in first || !first.ok) throw new Error('Expected summary pages');
    expect(all.sessions).toHaveLength(records.length);
    expect(all.nextCursor).toBeNull();
    expect(first.sessions).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    // The payload grows by returned rows, never by the full underlying corpus.
    const rowBytes = all.sessions.map(session => new TextEncoder().encode(JSON.stringify(session)).byteLength);
    expect(new TextEncoder().encode(JSON.stringify(first.sessions)).byteLength).toBe(rowBytes[0] + 2);
    expect(new TextEncoder().encode(JSON.stringify(all.sessions)).byteLength)
      .toBe(rowBytes.reduce((sum, bytes) => sum + bytes, 0) + records.length + 1);
    expect(all.sessions.every(session => !('metadata' in session) && !('lastMessagePreview' in session))).toBe(true);
    console.info(JSON.stringify({ voiceListCost: { rows: records.length,
      resultBytes: new TextEncoder().encode(JSON.stringify(all)).byteLength,
      firstPageBytes: new TextEncoder().encode(JSON.stringify(first)).byteLength } }));
  });

  it('uses the admitted corpus for the basic list and reports incomplete coverage', async () => {
    seedSession({ shareSessionSummary: true });
    const otherServerId = await mountOtherHome();
    storage.getState().applyServerScopedSessionListRows(serverId, [
      createSessionListRenderableSessionFixture({ id: 'stale', updatedAt: 999 }),
    ], { source: 'rowOnly', mode: 'replace' });
    home.answer(serverId, '/v2/sessions', { body: ordinaryPage([row('admitted', { updatedAt: 30 })]) });
    home.answer(otherServerId, '/v2/sessions', { status: 503, body: {} });
    const membership = storage.getState().ordinarySessionListMembershipByServerId;
    const result = await listSessionsForVoiceTool({});
    if ('view' in result || !result.ok) throw new Error('Expected summary session list');
    expect(result.sessions.map(session => session.id)).toEqual(['admitted']);
    expect(result.sessions).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'stale' })]));
    expect(result).toMatchObject({ coverage: 'incomplete' });
    expect(storage.getState().ordinarySessionListMembershipByServerId).toEqual(membership);
  });

  it('omits the session summary title when shareSessionSummary is disabled', async () => {
    seedSession({ shareSessionSummary: false });
    const result = await listSessionsForVoiceTool({});
    if ('view' in result || !result.ok) throw new Error('Expected summary session list');
    expect(JSON.stringify(result)).not.toContain('Confidential billing rewrite');
    expect(result.sessions[0]?.id).toBe('s1');
  });

  it('keeps the session summary title when shareSessionSummary is enabled', async () => {
    seedSession({ shareSessionSummary: true });
    const result = await listSessionsForVoiceTool({});
    if ('view' in result || !result.ok) throw new Error('Expected summary session list');
    expect(result.sessions[0]?.title).toBe('Confidential billing rewrite');
  });

  it('omits the location label because shareFilePaths is hardened off for the voice transport', async () => {
    seedSession({ shareSessionSummary: true, shareFilePaths: true });
    const result = await listSessionsForVoiceTool({});
    if ('view' in result || !result.ok) throw new Error('Expected summary session list');
    expect(result.sessions[0]).not.toHaveProperty('locationLabel');
    expect(JSON.stringify(result)).not.toContain('payments');
  });

  it('uses row-only ingestion for ad-hoc awareness reads so membership owners stay untouched', async () => {
    seedSession({ shareSessionSummary: true });
    seedMountedMembership();
    const before = storage.getState();
    expect(before.sessionListRowsByServerId[serverId]?.s1).toBeUndefined();
    const result = await listSessionsForVoiceTool({ view: 'awareness' });
    expect(result).toMatchObject({ view: 'awareness', nextCursor: null, hasNext: false, sessions: [{ sessionId: 's1' }] });
    expect(Object.keys(result).sort()).toEqual(['hasNext', 'nextCursor', 'projectionVersion', 'sessions', 'view']);
    expect(result).not.toHaveProperty('queryVersion');
    expect(storage.getState().sessionListRowsByServerId[serverId]?.s1?.metadata?.summaryText).toBe('Confidential billing rewrite');
    expect(storage.getState().ordinarySessionListMembershipByServerId).toEqual(before.ordinarySessionListMembershipByServerId);
    expect(storage.getState().archivedSessionListMembershipByServerId).toEqual(before.archivedSessionListMembershipByServerId);
    expect(storage.getState().sessionListQueryMembershipByKey).toEqual(before.sessionListQueryMembershipByKey);
    expect(storage.getState().sessions.s1).toBeUndefined();
  });

  it('uses row-only ingestion for ad-hoc strict-query reads so mounted query membership is unchanged', async () => {
    seedSession({ shareSessionSummary: true });
    seedMountedMembership();
    const query = SessionListQueryV1Schema.parse({ v: 1, storage: 'active', includeInactive: false,
      attention: 'any', scope: 'my_work', audiences: [], tagIds: [] });
    home.answer(serverId, '/v2/sessions/query', { body: queryPage([row()]) });
    const before = storage.getState();
    const result = await listSessionsForVoiceTool({ query });
    expect(result).toMatchObject({ ok: true, queryVersion: 1, sessions: [{ id: 's1' }], attentionNextCursor: null, attentionHasNext: false });
    expect(storage.getState().sessionListRowsByServerId[serverId]?.s1).toBeDefined();
    expect(storage.getState().ordinarySessionListMembershipByServerId).toEqual(before.ordinarySessionListMembershipByServerId);
    expect(storage.getState().archivedSessionListMembershipByServerId).toEqual(before.archivedSessionListMembershipByServerId);
    expect(storage.getState().sessionListQueryMembershipByKey).toEqual(before.sessionListQueryMembershipByKey);
    expect(home.requestsFor('/v2/sessions/query').at(-1)?.input).toMatchObject(query);
  });

  it('preserves Lane 07 attention continuation in strict-query awareness', async () => {
    seedSession({ shareSessionSummary: true });
    const query = SessionListQueryV1Schema.parse({ v: 1, storage: 'active', includeInactive: false,
      attention: 'needs_my_attention', scope: 'my_work', audiences: [], tagIds: [], includeAttention: true });
    home.answer(serverId, '/v2/sessions/query', { body: queryPage([row()], { attentionNextCursor: 'attention-next', attentionHasNext: true }) });
    const result = await listSessionsForVoiceTool({ view: 'awareness', query });
    expect(result).toMatchObject({ view: 'awareness', nextCursor: null, hasNext: false,
      attentionNextCursor: 'attention-next', attentionHasNext: true });
    expect(Object.keys(result).sort()).toEqual(['attentionHasNext', 'attentionNextCursor', 'hasNext', 'nextCursor', 'projectionVersion', 'sessions', 'view']);
    expect(SessionAwarenessListResultV1Schema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it('reports a cancelled awareness request as cancelled rather than a stale Home response', async () => {
    seedSession({ shareSessionSummary: true });
    const controller = new AbortController();
    const response = createDeferred<void>();
    // Isolate this acquisition at the HTTP boundary: the mounted ordinary refresh
    // keeps its own answer and must not publish the cancelled tool's fixture row.
    const path = '/v2/sessions?limit=1';
    home.answer(serverId, path, { body: ordinaryPage([row('cancelled')]), respondAfter: response.promise });
    const readsBefore = home.requestsFor(path).length;
    const result = listSessionsForVoiceTool({ view: 'awareness', limit: 1, signal: controller.signal });
    await waitForHomeGovernance(() => expect(home.requestsFor(path).length).toBeGreaterThan(readsBefore));
    controller.abort();
    response.resolve();
    await expect(result).resolves.toMatchObject({ ok: false, errorCode: 'tool_cancelled' });
    expect(storage.getState().sessionListRowsByServerId[serverId]?.cancelled).toBeUndefined();
    const admitted = await listSessionsForVoiceTool({ view: 'awareness', limit: 1 });
    expect(SessionAwarenessListResultV1Schema.parse(admitted)).toMatchObject({ sessions: [{ sessionId: 'cancelled' }] });
    expect(storage.getState().sessionListRowsByServerId[serverId]?.cancelled).toBeDefined();
  });

  it('still reports a superseded Home page as a stale response when nothing was cancelled', async () => {
    seedSession({ shareSessionSummary: true });
    const response = createDeferred<void>();
    const bodyRead = createDeferred<void>();
    const controller = new AbortController();
    // Hold the genuine Fetch body. The HTTP lifetime owner supplies its own
    // Response implementation, so spying on the platform text() misses this read.
    home.answer(serverId, '/v2/sessions', { select: () => {
      bodyRead.resolve();
      return { body: ordinaryPage([row('retired')]), bodyAfter: response.promise };
    } });
    try {
      const result = listSessionsForVoiceTool({ view: 'awareness', signal: controller.signal });
      await bodyRead.promise;
      await connection?.dispose();
      connection = undefined;
      response.resolve();
      await expect(result).resolves.toMatchObject({ ok: false, errorCode: 'stale_response' });
      expect(controller.signal.aborted).toBe(false);
      expect(storage.getState().sessionListRowsByServerId[serverId]?.retired).toBeUndefined();
    } finally {
      response.resolve();
    }
  });
});
