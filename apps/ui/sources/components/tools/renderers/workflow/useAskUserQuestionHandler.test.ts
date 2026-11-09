import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createDeferred, createRenderCommitCounter, createSessionFixture, renderHook, standardCleanup, useRenderCommitCounter } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createPlainSessionCurrentProjectionRecordFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createCompactSessionListRowFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { projectSessionDisplayV1, SessionDisplayProjectionV1Schema } from '@happier-dev/protocol/sessions';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { t } from '@/text';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
const { useAskUserQuestionHandler, useAskUserQuestionAnsweredByLabel } = await import('./useAskUserQuestionHandler');
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { fetchAndApplySessions } = await import('@/sync/engine/sessions/sessionSnapshot');
const { fetchAndApplySessionById } = await import('@/sync/engine/sessions/sessionById');
const { Encryption } = await import('@/sync/encryption/encryption');
const { hasAuthoritativeSessionRouteData, isHydratedSessionCurrentForListState } = await import('@/sync/domains/session/hasAuthoritativeSessionRouteData');
const initialState = storage.getState();
let activeScope: Awaited<ReturnType<typeof activateStorageAccountScope>> | null = null;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

function answerQuestionBootstrap(serverId: string) {
  homes.answer(serverId, '/v2/sessions', { body: { sessions: [], hasNext: false } });
  homes.answer(serverId, '/v2/sessions/active', { body: { sessions: [], hasNext: false } });
  homes.answer(serverId, '/v2/session-organization', { body: SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
    schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0, pins: [], folders: [], folderAssignments: [],
    tags: [], tagAssignments: [], orderEntries: [], labels: [],
  } }) });
}

beforeEach(async () => { await homes.reset(); storage.setState(initialState, true); });
afterEach(async () => { standardCleanup(); activeScope?.dispose(); activeScope = null; await connection?.dispose(); connection = null; });

it.each([
  { kind: 'person', held: true, outcome: 'stopped' }, { kind: 'session', held: true, outcome: 'stopped' },
  { kind: 'person', held: false, outcome: 'stopped' }, { kind: 'session', held: false, outcome: 'stopped' },
  { kind: 'person', held: true, outcome: 'newer' }, { kind: 'session', held: false, outcome: 'refused' },
  { kind: 'session', held: true, outcome: 'shared' },
  { kind: 'session', held: true, outcome: 'publication' },
  { kind: 'session', held: false, outcome: 'answered' },
] as const)('keeps current full manager facts beside a cold compact display ($kind, held: $held, $outcome)', async ({ kind, held, outcome }) => {
  const serverUrl = 'https://question-cold-manager.test';
  const serverId = await homes.addHome({ name: 'Questions', serverUrl, accountId: 'alice', currentAccount: true });
  answerQuestionBootstrap(serverId);
  if (held && outcome !== 'newer') activeScope = await activateStorageAccountScope({ serverId, accountId: 'alice' }, storage);
  else {
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', request: async (path, init) => homes.request(path, init) });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
  }
  const record = createPlainSessionCurrentProjectionRecordFixture({ id: 'manager', activeAt: 1,
    metadata: { path: '/repo', host: 'test', name: 'Daily coordinator',
      sessionExplicitStopV1: { v: 1, cause: 'explicit_stop', requestId: 'stop', requestedAtMs: 1 } } });
  const display = projectSessionDisplayV1({ sharedMetadata: { v: 1 },
    ownerMetadata: { v: 1, workspace: { name: 'Daily coordinator', path: '/repo', host: 'test' } } });
  const projection = SessionDisplayProjectionV1Schema.parse({ v: 1, sourceMetadataVersion: record.metadataVersion, metadataLayoutVersion: 1,
    shared: { t: 'plain', v: { v: 1, audience: 'shared', purpose: 'session_shared_display', display: display.shared } },
    owner: { t: 'plain', v: { v: 1, audience: 'owner', purpose: 'session_owner_display', display: display.owner } } });
  const detailGate = createDeferred<void>();
  homes.answer(serverId, '/v2/sessions/manager', { status: outcome === 'refused' ? 403 : 200,
    body: outcome === 'refused' ? { error: 'forbidden' } : { session: record }, ...(!held ? { respondAfter: detailGate.promise } : {}) });
  const credentials = connection?.credentials ?? { token: createAccountTokenForTests('alice'), secret: '' };
  const accountCurrentness = createPlainAccountEncryptionCurrentnessFixture();
  const request = (path: string, init?: RequestInit) => homes.request(new URL(path, serverUrl), init);
  const managerReadCount = () => homes.requests.filter(request => new URL(request.path, serverUrl).pathname === '/v2/sessions/manager').length;
  const readRow = (id: string) => storage.getState().sessionListRowsByServerId[serverId]?.[id];
  const publishColdRow = async (row: ReturnType<typeof createCompactSessionListRowFixture>) => {
    homes.answer(serverId, '/v2/sessions', { body: { sessions: [row] } });
    await fetchAndApplySessions({ serverId, credentials, accountCurrentness, encryption: null, sessionDataKeys: new Map(),
    contentDemand: 'list-projection', sessionListBackgroundHydrationMaxRows: 0, request,
    getCurrentSessionListRenderable: readRow,
    applySessionListRenderables: rows => storage.getState().applyServerScopedSessionListRows(serverId, rows, { source: 'ordinary', mode: 'replace' }),
    applySessionListRenderablePatches: patches => storage.getState().applyServerScopedSessionListRowPatches(serverId, patches),
    applySessions: rows => storage.getState().applySessions(rows), log: { log() {} } });
  };
  await publishColdRow({ ...createCompactSessionListRowFixture(record), displayProjectionV1: projection });
  const coldRow = readRow(record.id)!;
  expect(coldRow.metadata?.name).toBe('Daily coordinator');
  expect(coldRow.workerQuestionHandling).toBeNull();
  expect(storage.getState().sessions.manager).toBeUndefined();
  if (held) {
    const full = await fetchAndApplySessionById({ serverId, sessionId: record.id, credentials, accountCurrentness,
      encryption: await Encryption.create(new Uint8Array(32).fill(7)), sessionDataKeys: new Map(), includeTurnsProjection: false, request,
      getExistingSession: id => storage.getState().sessions[id],
      applySessions: rows => storage.getState().applySessions(rows), log: { log() {} } });
    expect(full.ok).toBe(true);
    // A same-revision cold-list publication may settle after an exact full read.
    // The full document and the display row retain their independent real owners.
    storage.getState().applyServerScopedSessionListRows(serverId, [coldRow], { source: 'ordinary', mode: 'replace' });
    expect(hasAuthoritativeSessionRouteData(storage.getState().sessions.manager)).toBe(true);
    expect(isHydratedSessionCurrentForListState(storage.getState().sessions.manager!, readRow)).toBe(true);
  }
  if (outcome === 'publication') {
    const retained = storage.getState().sessions.manager!;
    storage.getState().applySessions([{ ...retained, updatedAt: retained.updatedAt + 1 }]);
    expect(storage.getState().sessions.manager!.updatedAt).toBe(retained.updatedAt);
    expect(isHydratedSessionCurrentForListState(retained, readRow)).toBe(false);
  }
  if (outcome === 'newer') {
    const fresh = createPlainSessionCurrentProjectionRecordFixture({ id: record.id, metadataVersion: 2, updatedAt: 2,
      metadata: { path: '/repo', host: 'test', name: 'Daily coordinator', work: { sessionRolesV1: {
        overrides: {}, sessionRoles: {}, notes: '', answersWorkerQuestions: false,
      } } } });
    homes.answer(serverId, '/v2/sessions/manager', { body: { session: fresh }, respondAfter: detailGate.promise });
    await publishColdRow({ ...createCompactSessionListRowFixture(fresh), displayProjectionV1: { ...projection, sourceMetadataVersion: 2 } });
    expect(isHydratedSessionCurrentForListState(storage.getState().sessions.manager!, readRow)).toBe(false);
  }
  if (outcome === 'shared') {
    const recipient = createPlainSessionByIdResponseFixture(createSessionFixture({ id: record.id, serverId,
      metadataLayoutVersion: 1, ownerMetadataView: null, access: createSessionAccessFixture('view') })).session;
    const shared = projectSessionDisplayV1({ sharedMetadata: { v: 1, summary: { text: 'Shared coordinator', updatedAt: 1 } } });
    await publishColdRow({ ...createCompactSessionListRowFixture(recipient), displayProjectionV1: {
      v: 1, sourceMetadataVersion: recipient.metadataVersion, metadataLayoutVersion: 1,
      shared: { t: 'plain', v: { v: 1, audience: 'shared', purpose: 'session_shared_display', display: shared.shared } },
    } });
    expect(isHydratedSessionCurrentForListState(storage.getState().sessions.manager!, readRow)).toBe(false);
  }
  const worker = createSessionFixture({ id: 'worker', serverId, manager: { sessionId: record.id } });
  storage.getState().applySessions([worker]);
  try {
    const useCardRead: () => ReturnType<typeof useAskUserQuestionHandler> | string = outcome === 'answered'
      ? () => useAskUserQuestionAnsweredByLabel({ kind: 'session', sessionId: record.id }, serverId)
      : () => useAskUserQuestionHandler(kind === 'person' ? { kind: 'person' } : { kind: 'session', sessionId: record.id }, serverId,
        { sessionId: worker.id, questionV1: { mode: 'wait', lasting: false } });
    const hook = await renderHook(useCardRead);
    if ((!held || outcome === 'newer') && outcome !== 'answered') {
      expect(hook.getCurrent()).toBeNull();
      await vi.waitFor(() => expect(managerReadCount()).toBeGreaterThan(held ? 1 : 0));
      await act(async () => { detailGate.resolve(); });
    }
    if (outcome === 'answered') {
      expect(hook.getCurrent()).toBe(t('workflows.run.answeredBy', { name: 'Daily coordinator' }));
      expect(managerReadCount()).toBe(0);
      expect(homes.requestsFor('/v2/sessions/read-batch')).toHaveLength(0);
      expect(storage.getState().sessions.manager).toBeUndefined();
    } else if (outcome === 'newer') {
      await vi.waitFor(() => expect(storage.getState().sessions.manager?.metadataVersion).toBe(2));
      expect(hook.getCurrent()).toBeNull();
    } else if (outcome === 'refused') {
      const { sync } = await import('@/sync/sync');
      await expect(sync.ensureSessionVisibleForMessageRoute(record.id, { serverId, hydrateMessages: false, includeTurnsProjection: false }))
        .resolves.toMatchObject({ kind: 'missing' });
      expect(storage.getState().sessions.manager).toBeUndefined();
      expect(hook.getCurrent()).toBeNull();
    } else {
      await vi.waitFor(() => expect(hook.getCurrent()).toEqual({ name: outcome === 'shared' ? 'Shared coordinator' : 'Daily coordinator',
        availability: outcome === 'shared' ? 'offline' : 'stopped' }));
    }
    expect(homes.requests.some(request => /\/v\d+\/sessions\/manager\/(?:messages|turns)/.test(request.path))).toBe(false);
    for (const request of homes.requestsFor('/v2/sessions/read-batch')) {
      expect(SessionReadBatchRequestV1Schema.parse(request.input)).toMatchObject({ includeTurns: false, includeMessages: false });
    }
    await hook.unmount();
  } finally {
    detailGate.resolve();
  }
});

it.each([0, 1])('explains the stopped manager across layout %s scoped list and demanded full documents', async metadataLayoutVersion => {
  const serverUrl = 'https://question-list-manager.test';
  const serverId = await homes.addHome({ name: 'Questions', serverUrl, accountId: 'alice', currentAccount: true });
  answerQuestionBootstrap(serverId);
  connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', request: async (path, init) => homes.request(path, init) });
  const { sync } = await import('@/sync/sync');
  await sync.awaitBootstrapForegroundAcquisition();
  await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
  const ownerMetadata = { path: '/repo', host: 'test', name: 'Daily coordinator',
    sessionExplicitStopV1: { v: 1 as const, cause: 'explicit_stop' as const, requestId: 'stop', requestedAtMs: 1 } };
  const manager = createSessionFixture({ id: 'manager', serverId, presence: 1, metadataLayoutVersion,
    metadata: metadataLayoutVersion === 0 ? ownerMetadata : { path: '/repo', host: 'test' },
    ...(metadataLayoutVersion === 1 ? { ownerMetadataView: ownerMetadata } : {}) });
  const worker = createSessionFixture({ id: 'worker', serverId, manager: { sessionId: manager.id } });
  const initialManager = metadataLayoutVersion === 1
    ? { ...manager, metadataUndecided: true as const,
      ownerMetadataView: { path: '/repo', host: 'test', name: 'Daily coordinator' } }
    : manager;
  const detailGate = createDeferred<void>();
  homes.answer(serverId, '/v2/sessions/manager', { body: createPlainSessionByIdResponseFixture(manager),
    ...(metadataLayoutVersion === 1 ? { respondAfter: detailGate.promise } : {}) });
  storage.getState().applyServerScopedSessionListRows(serverId,
    [worker, initialManager].map(session => buildSessionListRenderableFromSession(session)), { source: 'ordinary', mode: 'replace' });
  expect(storage.getState().sessions.manager).toBeUndefined();
  try {
    const counter = createRenderCommitCounter();
    const hook = await renderHook(() => {
      useRenderCommitCounter(counter);
      return useAskUserQuestionHandler({ kind: 'person' }, serverId,
        { sessionId: worker.id, questionV1: { mode: 'wait', lasting: false } });
    });
    if (metadataLayoutVersion === 1) {
      // Owner visibility can arrive before its full metadata: absence in that
      // partial projection cannot establish the manager's answering preference.
      expect(hook.getCurrent()).toBeNull();
      await act(async () => { detailGate.resolve(); storage.getState().applyServerScopedSessionListRows(serverId,
        [worker, manager].map(session => buildSessionListRenderableFromSession(session)), { source: 'ordinary', mode: 'replace' }); });
    }
    await vi.waitFor(() => expect(hook.getCurrent()).toEqual({ name: 'Daily coordinator', availability: 'stopped' }));
    counter.reset();
    await act(async () => { storage.setState({ sessions: {
      ...storage.getState().sessions,
      worker: { ...worker, manager: { sessionId: 'stale-manager' } },
      unrelated: createSessionFixture({ id: 'unrelated', serverId }),
    } }); });
    expect(hook.getCurrent()).toEqual({ name: 'Daily coordinator', availability: 'stopped' });
    expect(counter.read()).toEqual({ renders: 0, commits: 0 });
    const olderMetadata = { path: '/repo', host: 'test', name: 'Daily coordinator' };
    await act(async () => { storage.getState().applyServerScopedSessionListRows(serverId,
      [worker, { ...manager, metadataVersion: 0, ...(metadataLayoutVersion === 1
        ? { ownerMetadataView: olderMetadata } : { metadata: olderMetadata }) }]
        .map(session => buildSessionListRenderableFromSession(session)), { source: 'ordinary', mode: 'replace' }); });
    expect(hook.getCurrent()).toEqual({ name: 'Daily coordinator', availability: 'stopped' });
    const disabledMetadata = { ...ownerMetadata, work: { sessionRolesV1: {
      overrides: {}, sessionRoles: {}, notes: '', answersWorkerQuestions: false,
    } } };
    homes.answer(serverId, '/v2/sessions/manager', { body: createPlainSessionByIdResponseFixture({ ...manager,
      metadataVersion: 2, ...(metadataLayoutVersion === 1 ? { ownerMetadataView: disabledMetadata } : { metadata: disabledMetadata }) }) });
    await act(async () => { storage.getState().applyServerScopedSessionListRows(serverId,
      [worker, { ...manager, metadataVersion: 2, ...(metadataLayoutVersion === 1
        ? { ownerMetadataView: disabledMetadata } : { metadata: disabledMetadata }) }]
        .map(session => buildSessionListRenderableFromSession(session)), { source: 'ordinary', mode: 'replace' }); });
    await vi.waitFor(() => expect(storage.getState().sessions.manager?.metadataVersion).toBe(2));
    expect(hook.getCurrent()).toBeNull();
    const foreign = await renderHook(() => useAskUserQuestionHandler({ kind: 'session', sessionId: manager.id }, 'foreign-home'));
    expect(foreign.getCurrent()).toBeNull();
    await hook.unmount(); await foreign.unmount();
  } finally {
    detailGate.resolve();
  }
});

it('explains a stopped manager for a person-handled question without changing its handler', async () => {
  const serverId = await homes.addHome({ name: 'Questions', serverUrl: 'https://question-manager.test', accountId: 'alice', currentAccount: true });
  activeScope = await activateStorageAccountScope({ serverId, accountId: 'alice' }, storage);
  const stop = { v: 1 as const, cause: 'explicit_stop' as const, requestId: 'stop', requestedAtMs: 1 };
  const manager = createSessionFixture({ id: 'manager', serverId, presence: 1,
    metadataLayoutVersion: 1, metadata: { path: '/repo', host: 'test' },
    ownerMetadataView: { path: '/repo', host: 'test', name: 'Daily coordinator', sessionExplicitStopV1: stop } });
  const currentHandler = { kind: 'person' as const };
  const questionV1 = { mode: 'wait' as const, lasting: false };
  const worker = createSessionFixture({ id: 'worker', serverId, manager: { sessionId: manager.id },
    agentState: { requests: { question: { tool: 'AskUserQuestion', arguments: {}, createdAt: 1, currentHandler, questionV1 } } } });
  storage.setState({ sessions: { worker, manager } });
  const source = { sessionId: worker.id, questionV1 };
  const hook = await renderHook(() => useAskUserQuestionHandler(currentHandler, serverId, source));
  expect(hook.getCurrent()).toEqual({ name: 'Daily coordinator', availability: 'stopped' });
  expect(storage.getState().sessions.worker?.agentState?.requests?.question?.currentHandler).toEqual({ kind: 'person' });

  // Resuming the manager cannot make it the handler of this already-routed question.
  await act(async () => { storage.setState({ sessions: { worker, manager: { ...manager, presence: 'online',
    ownerMetadataView: { path: '/repo', host: 'test', name: 'Daily coordinator' } } } }); });
  expect(hook.getCurrent()).toBeNull();
  expect(storage.getState().sessions.worker?.agentState?.requests?.question?.currentHandler).toEqual({ kind: 'person' });
  await hook.unmount();
});

it('does not attach manager handling to lasting questions, disabled managers or another Home', async () => {
  const serverId = await homes.addHome({ name: 'Questions', serverUrl: 'https://question-exclusions.test', accountId: 'alice', currentAccount: true });
  activeScope = await activateStorageAccountScope({ serverId, accountId: 'alice' }, storage);
  const manager = createSessionFixture({ id: 'manager', serverId, presence: 1,
    metadata: { path: '/repo', host: 'test', name: 'Daily coordinator',
      work: { sessionRolesV1: { v: 1, overrides: {}, answersWorkerQuestions: false } } } });
  const worker = createSessionFixture({ id: 'worker', serverId, manager: { sessionId: manager.id } });
  storage.setState({ sessions: { worker, manager } });
  const disabled = await renderHook(() => useAskUserQuestionHandler({ kind: 'person' }, serverId,
    { sessionId: worker.id, questionV1: { mode: 'wait', lasting: false } }));
  expect(disabled.getCurrent()).toBeNull();
  await disabled.unmount();
  await act(async () => { storage.setState({ sessions: { worker, manager: { ...manager,
    metadata: { path: '/repo', host: 'test', name: 'Daily coordinator' } } } }); });
  const lasting = await renderHook(() => useAskUserQuestionHandler({ kind: 'person' }, serverId,
    { sessionId: worker.id, questionV1: { mode: 'wait', lasting: true } }));
  expect(lasting.getCurrent()).toBeNull();
  const foreign = await renderHook(() => useAskUserQuestionHandler({ kind: 'session', sessionId: manager.id }, 'foreign-home'));
  expect(foreign.getCurrent()).toBeNull();
  await lasting.unmount(); await foreign.unmount();
});
