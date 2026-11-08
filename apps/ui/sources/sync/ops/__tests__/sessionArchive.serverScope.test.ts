import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';

describe('sessionArchiveWithServerScope', () => {

  it('reads the archive response from its prepared API Home without retargeting to focus', async () => {
    realArchiveBoundary.resetRequests();
    const owner = await realArchiveBoundary.addHome('https://prepared-archive.example', 'prepared-archive');
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    realArchiveBoundary.setHttpResponder(async input => new URL(String(input)).pathname === '/v2/sessions/prepared/archive'
      ? Response.json({ success: true, archivedAt: 10 }) : null);
    apiSocket.initialize({ endpoint: owner.serverUrl, token: owner.token, serverId: owner.id,
      generation: getActiveServerSnapshot().generation }, null);
    try {
      const response = await apiSocket.request('/v2/sessions/prepared/archive', { method: 'POST' }, { retry: 'none' });
      expect(await response.json()).toEqual({ success: true, archivedAt: 10 });
      expect(realArchiveBoundary.httpRequests.filter(({ url }) => new URL(url).pathname.endsWith('/archive'))).toEqual([
        { url: `${owner.serverUrl}/v2/sessions/prepared/archive`, token: `Bearer ${owner.token}`, method: 'POST' },
      ]);
    } finally { apiSocket.disconnect(); }
  });

  it('uses the saved Home credential for an explicit remote archive', async () => {
    realArchiveBoundary.resetRequests();
    const owner = await realArchiveBoundary.addHome('https://explicit-archive.example', 'explicit-archive');
    const { sessionArchiveWithServerScope } = await import('../sessions');
    realArchiveBoundary.setHttpResponder(async input => new URL(String(input)).pathname === '/v2/sessions/explicit/archive'
      ? Response.json({ success: true, archivedAt: 11 }) : null);
    await expect(sessionArchiveWithServerScope('explicit', { serverId: owner.id })).resolves.toEqual({ success: true, archivedAt: 11 });
    expect(realArchiveBoundary.httpRequests.filter(({ url }) => new URL(url).pathname.endsWith('/archive'))).toEqual([
      { url: `${owner.serverUrl}/v2/sessions/explicit/archive`, token: `Bearer ${owner.token}`, method: 'POST' },
    ]);
  });

  it('surfaces a session-active conflict immediately without repeating the archive', async () => {
    realArchiveBoundary.resetRequests();
    const owner = await realArchiveBoundary.addHome('https://conflict-archive.example', 'conflict-archive');
    const { sessionArchiveWithServerScope } = await import('../sessions');
    realArchiveBoundary.setHttpResponder(async input => new URL(String(input)).pathname === '/v2/sessions/conflict/archive'
      ? Response.json({ error: 'session-active' }, { status: 409 }) : null);
    await expect(sessionArchiveWithServerScope('conflict', { serverId: owner.id })).resolves.toMatchObject({ success: false, code: 'session_active' });
    expect(realArchiveBoundary.httpRequests.filter(({ url }) => new URL(url).pathname.endsWith('/archive'))).toHaveLength(1);
  });
});

// Load the actual operation graph during collection, outside bounded test bodies.
// Every case shares the canonical Home/Account and network boundary fixture.
const realArchiveBoundary = await (async () => {
  const boundary = await (await import('@/dev/testkit/harness/sessionOpsNetworkBoundary')).installSessionOpsNetworkBoundary();
  await import('../sessions');
  await import('@/components/sessions/sessionStopArchiveFlow');
  return boundary;
})();

afterAll(async () => {
  const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
  await resetServerReachabilitySupervisors();
  await realArchiveBoundary.dispose();
});

describe('archive routing from canonical session-list rows', () => {
  const boundary = realArchiveBoundary;
  beforeEach(() => { boundary.resetRequests(); });

  it.each(['archive', 'unarchive'] as const)('retains the Home database refusal through the real %s path without replaying it', async action => {
    const owner = await boundary.addHome(`https://database-refusal-${action}.example`, `database-refusal-${action}`);
    const { storage } = await import('@/sync/domains/state/storage');
    const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { sessionArchiveWithServerScope, sessionUnarchiveWithServerScope } = await import('../sessions');
    const { archiveSessionWithPendingState } = await import('@/components/sessions/sessionStopArchiveFlow');
    const sessionId = `database-refusal-${action}`;
    const archivedAt = action === 'archive' ? null : 10;
    storage.setState(storage.getInitialState(), true);
    storage.getState().applyServerScopedSessionListRows(owner.id, [
      createSessionListRenderableSessionFixture({ id: sessionId, archivedAt }),
    ], { source: action === 'archive' ? 'ordinary' : 'archived', mode: 'replace' });
    boundary.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${sessionId}/${action}`
      ? Response.json({ error: 'database_transaction_timeout' }, { status: 503 }) : null);
    const run = action === 'archive' ? sessionArchiveWithServerScope : sessionUnarchiveWithServerScope;
    const result = await archiveSessionWithPendingState({ serverId: owner.id, sessionId },
      () => run(sessionId, { serverId: owner.id }));
    expect(result).toMatchObject({ success: false, code: 'database_transaction_timeout' });
    expect(storage.getState().sessionListRowsByServerId[owner.id]?.[sessionId]?.archivedAt).toBe(archivedAt);
    expect(storage.getState().sessionArchiveOperations).toEqual({});
    expect(boundary.httpRequests.filter(({ url }) => new URL(url).pathname.endsWith(`/${action}`))).toHaveLength(1);
  });

  it.each(['removed', 'offline', 'loading', 'active'] as const)('archives after unavailable Stop only for settled Machine access loss: %s', async machineState => {
    const owner = await boundary.addHome(`https://archive-access-${machineState}.example`, `archive-access-${machineState}`);
    const { storage } = await import('@/sync/domains/state/storage');
    const { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { sessionStopWithServerScope, sessionArchiveWithServerScope } = await import('../sessions');
    const { stopSessionAndMaybeArchive } = await import('@/components/sessions/sessionStopArchiveFlow');
    const sessionId = `archive-access-${machineState}`;
    const metadata = { machineId: 'machine-1', path: '/repo', host: 'tester.local' };
    const session = createSessionFixture({ id: sessionId, serverId: owner.id, active: true, archivedAt: null, metadata });
    const machines = machineState === 'offline' ? [createMachineFixture({ active: false })] : [];
    storage.setState(storage.getInitialState(), true);
    storage.setState({ sessions: { [sessionId]: session }, machineListByServerId: { [owner.id]: machines },
      machineListStatusByServerId: { [owner.id]: machineState === 'loading' ? 'loading' : 'idle' } });
    storage.getState().applyServerScopedSessionListRows(owner.id, [session], { source: 'ordinary', mode: 'replace' });
    boundary.setHttpResponder(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/machines/read-batch') return createMachineReadBatchResponseFixture(init?.body,
        id => machineState === 'offline' ? createPlainMachineRowFixture({ id, accountId: owner.accountId }) : null);
      if (path === '/v1/machines/machine-1') return machineState === 'offline'
        ? Response.json({ machine: createPlainMachineRowFixture({ id: 'machine-1', accountId: owner.accountId }) })
        : Response.json({ error: 'not_found' }, { status: 404 });
      if (path === `/v2/sessions/${sessionId}`) return Response.json({ session:
        createPlainSessionCurrentProjectionRecordFixture({ id: sessionId, active: true, metadata }) });
      if (path === `/v2/sessions/${sessionId}/archive`) return machineState === 'active'
        ? Response.json({ error: 'session-active' }, { status: 409 })
        : Response.json({ success: true, archivedAt: 42 });
      return null;
    });
    // Default network ACK is METHOD_NOT_FOUND: the runner was retired, or is offline.
    const stop = await sessionStopWithServerScope(sessionId, { serverId: owner.id, stopIntent: 'lifecycle_control' });
    expect(stop, JSON.stringify(stop)).toMatchObject({ success: false, code: 'session_stop_control_unavailable' });
    const run = stopSessionAndMaybeArchive({ address: { serverId: owner.id, sessionId },
      hideInactiveSessions: false, isPinned: false, archiveAfterStop: 'always', stopSession: async () => stop,
      archiveSession: () => sessionArchiveWithServerScope(sessionId, { serverId: owner.id }),
      stopErrorMessage: 'Stop failed', archiveErrorMessage: 'Archive failed' });
    if (machineState === 'removed') await expect(run).resolves.toBeUndefined();
    else await expect(run).rejects.toMatchObject({ code: machineState === 'active' ? 'session_active' : 'session_stop_control_unavailable' });
    expect(boundary.httpRequests.filter(({ url }) => new URL(url).pathname.endsWith('/archive')))
      .toHaveLength(machineState === 'removed' || machineState === 'active' ? 1 : 0);
    expect(storage.getState().sessionListRowsByServerId[owner.id]?.[sessionId]?.archivedAt)
      .toBe(machineState === 'removed' ? 42 : null);
    expect(storage.getState().sessionArchiveOperations).toEqual({});
  });


  it('keeps active API response consumption inside caller cancellation and Home authority', async () => {
    const owner = await boundary.addHome('https://archive-api-body.example', 'archive-api-body');
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const controller = new AbortController();
    let transportSignal: AbortSignal | null | undefined;
    let failBody: (error: Error) => void = () => {};
    let issued!: () => void;
    const entered = new Promise<void>(resolve => { issued = resolve; });
    boundary.setHttpResponder(async (input, init) => {
      if (new URL(String(input)).pathname !== '/v2/sessions/api-body/archive') return null;
      transportSignal = init?.signal;
      const response = new Response(new ReadableStream<Uint8Array>({ start(body) {
        failBody = error => body.error(error);
        transportSignal?.addEventListener('abort', () => failBody(new DOMException('Cancelled', 'AbortError')), { once: true });
      } }));
      issued();
      return response;
    });
    apiSocket.initialize({ endpoint: owner.serverUrl, token: owner.token, serverId: owner.id,
      generation: getActiveServerSnapshot().generation }, null);
    let settled = false;
    const pending = apiSocket.request('/v2/sessions/api-body/archive', { method: 'POST', signal: controller.signal },
      { retry: 'none' }, response => response.json()).then(
        value => { settled = true; return { success: true, value }; },
        () => { settled = true; return { success: false }; },
      );
    try {
      await entered;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      controller.abort();
      expect(transportSignal?.aborted).toBe(true);
      expect(await pending).toEqual({ success: false });
    } finally {
      failBody(new Error('Release test response'));
      await pending;
      apiSocket.disconnect();
    }
  });

  it.each(['headers', 'body'] as const)('recovers shared archive admission when remote response %s stalls', async phase => {
    const owner = await boundary.addHome(`https://archive-deadline-${phase}.example`, `deadline-${phase}`);
    const { storage } = await import('@/sync/domains/state/storage');
    const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { sessionArchiveWithServerScope } = await import('../sessions');
    const { stopSessionAndMaybeArchive } = await import('@/components/sessions/sessionStopArchiveFlow');
    storage.setState(storage.getInitialState(), true);
    const sessionId = `deadline-${phase}`;
    const address = { serverId: owner.id, sessionId };
    storage.getState().applyServerScopedSessionListRows(owner.id, [
      createSessionListRenderableSessionFixture({ id: sessionId, archivedAt: null }),
    ], { source: 'ordinary', mode: 'replace' });
    let issued!: () => void;
    const entered = new Promise<void>(resolve => { issued = resolve; });
    let transportSignal: AbortSignal | null | undefined;
    let failTransport: (error: Error) => void = () => {};
    boundary.setHttpResponder(async (input, init) => {
      if (new URL(String(input)).pathname !== `/v2/sessions/${sessionId}/archive`) return null;
      transportSignal = init?.signal;
      const failOnAbort = () => failTransport(new DOMException('Archive cancelled', 'AbortError'));
      if (phase === 'headers') {
        return await new Promise<Response>((_resolve, reject) => {
          failTransport = reject;
          transportSignal?.addEventListener('abort', failOnAbort, { once: true });
          issued();
        });
      }
      const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
        failTransport = error => controller.error(error);
        transportSignal?.addEventListener('abort', failOnAbort, { once: true });
      } }), { headers: { 'content-type': 'application/json' } });
      issued();
      return response;
    });
    vi.useFakeTimers();
    const run = () => stopSessionAndMaybeArchive({ address, hideInactiveSessions: true, isPinned: false,
      archiveAfterStop: 'always', stopSession: async () => ({ success: true }),
      archiveSession: () => sessionArchiveWithServerScope(sessionId, { serverId: owner.id }),
      stopErrorMessage: 'Stop failed', archiveErrorMessage: 'Archive failed',
    });
    const pending = run().then(() => ({ failed: false }), () => ({ failed: true }));
    try {
      await entered;
      expect(storage.getState().sessionArchiveOperations[owner.id]?.[sessionId]).toBeDefined();
      await vi.advanceTimersByTimeAsync(75_000);
      expect(transportSignal?.aborted).toBe(true);
      expect(await pending).toEqual({ failed: true });
      expect(storage.getState().sessionArchiveOperations).toEqual({});
      expect(storage.getState().sessionListRowsByServerId[owner.id]?.[sessionId]?.archivedAt).toBeNull();
      boundary.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${sessionId}/archive`
        ? Response.json({ success: true, archivedAt: 42 }) : null);
      await expect(run()).resolves.toBeUndefined();
      expect(storage.getState().sessionListRowsByServerId[owner.id]?.[sessionId]?.archivedAt).toBe(42);
    } finally {
      failTransport(new Error('Release test transport'));
      await pending;
      vi.useRealTimers();
    }
  });

  it.each(['archive', 'unarchive'] as const)('projects a remote %s only into the captured Home, including list-only rows', async action => {
    const owner = await boundary.addHome('https://projection-owner.example', 'projection-owner');
    const other = await boundary.addHome('https://projection-other.example', 'projection-other');
    const { storage } = await import('@/sync/domains/state/storage');
    const { createSessionFixture, createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { sessionArchiveWithServerScope, sessionUnarchiveWithServerScope } = await import('../sessions');
    storage.setState(storage.getInitialState(), true);
    const before = action === 'archive' ? null : 10;
    const after = action === 'archive' ? 42 : null;
    const active = createSessionFixture({ id: 'same-session', serverId: other.id, archivedAt: before });
    storage.setState({ sessions: { [active.id]: active } });
    storage.getState().applyServerScopedSessionListRows(owner.id, [
      createSessionListRenderableSessionFixture({ id: active.id, archivedAt: before }),
    ], { source: action === 'archive' ? 'ordinary' : 'archived', mode: 'replace' });
    storage.getState().applyServerScopedSessionListRows(other.id, [
      createSessionListRenderableSessionFixture({ id: active.id, archivedAt: before }),
    ], { source: 'ordinary', mode: 'replace' });
    const unrelated = storage.getState().sessionListRowsByServerId[other.id];
    boundary.setHttpResponder(async input => new URL(String(input)).pathname === `/v2/sessions/${active.id}/${action}`
      ? Response.json({ success: true, archivedAt: after }) : null);
    const run = action === 'archive' ? sessionArchiveWithServerScope : sessionUnarchiveWithServerScope;
    await expect(run(active.id, { serverId: owner.id })).resolves.toMatchObject({ success: true });
    expect(storage.getState().sessions[active.id]).toBe(active);
    expect(storage.getState().sessionListRowsByServerId[other.id]).toBe(unrelated);
    expect(storage.getState().sessionListRowsByServerId[owner.id]?.[active.id]?.archivedAt).toBe(after);
    expect(action === 'archive' ? storage.getState().archivedSessionListMembershipByServerId[owner.id]
      : storage.getState().ordinarySessionListMembershipByServerId[owner.id]).toContain(active.id);
  });

  it.each(['archive', 'unarchive'] as const)('projects a remote %s through Home identity discovery while HTTP is pending', async action => {
    const owner = await boundary.addHome(`https://discovered-${action}.example`, `discovered-${action}`);
    const { storage } = await import('@/sync/domains/state/storage');
    const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const { setServerProfileIdentityForUrl, areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
    const { readSessionListRowForServerId } = await import('@/sync/domains/session/listing/sessionListRowStateLookup');
    const { sessionArchiveWithServerScope, sessionUnarchiveWithServerScope } = await import('../sessions');
    storage.setState(storage.getInitialState(), true);
    const before = action === 'archive' ? null : 10;
    const after = action === 'archive' ? 42 : null;
    const sessionId = `discovered-${action}`;
    storage.getState().applyServerScopedSessionListRows(owner.id, [
      createSessionListRenderableSessionFixture({ id: sessionId, archivedAt: before }),
    ], { source: action === 'archive' ? 'ordinary' : 'archived', mode: 'replace' });
    let releaseResponse!: () => void;
    let enterRequest!: () => void;
    const responseReady = new Promise<void>(resolve => { releaseResponse = resolve; });
    const requestEntered = new Promise<void>(resolve => { enterRequest = resolve; });
    boundary.setHttpResponder(async input => {
      if (new URL(String(input)).pathname !== `/v2/sessions/${sessionId}/${action}`) return null;
      enterRequest();
      await responseReady;
      return Response.json({ success: true, archivedAt: after });
    });
    const run = action === 'archive' ? sessionArchiveWithServerScope : sessionUnarchiveWithServerScope;
    const pending = run(sessionId, { serverId: owner.id });
    const canonicalId = `srv_discovered_${action}`;
    try {
      await requestEntered;
      await setServerProfileIdentityForUrl(owner.serverUrl, canonicalId);
      expect(readSessionListRowForServerId(storage.getState().sessionListRowsByServerId, canonicalId, sessionId)?.archivedAt).toBe(before);
    } finally {
      releaseResponse();
    }
    await expect(pending).resolves.toMatchObject({ success: true });
    expect(readSessionListRowForServerId(storage.getState().sessionListRowsByServerId, canonicalId, sessionId)?.archivedAt).toBe(after);
    const memberships = action === 'archive' ? storage.getState().archivedSessionListMembershipByServerId
      : storage.getState().ordinarySessionListMembershipByServerId;
    expect(Object.entries(memberships).filter(([serverId]) => areServerProfileIdentifiersEquivalent(serverId, canonicalId))
      .flatMap(([, ids]) => ids ?? [])).toContain(sessionId);
  });

  it('defaults a null serverId to the preferred owner Home from its canonical local list', async () => {
    const owner = await boundary.addHome('https://archive-owner.example', 'archive-account');
    const { storage } = await import('@/sync/domains/state/storage');
    const { createSessionListRenderableSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    storage.setState(storage.getInitialState(), true);
    storage.getState().applyServerScopedSessionListRows(owner.id, [
      createSessionListRenderableSessionFixture({ id: 'sid-owned' }),
    ], { source: 'ordinary', mode: 'replace' });
    boundary.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v2/sessions/sid-owned/archive'
      ? Response.json({ success: true, archivedAt: 12 }) : null);
    const { sessionArchiveWithServerScope: archive } = await import('../sessions');

    await expect(archive('sid-owned', { serverId: null })).resolves.toEqual({ success: true, archivedAt: 12 });
    expect(boundary.httpRequests.filter(({ url }) => new URL(url).pathname.endsWith('/archive'))).toEqual([
      { url: `${owner.serverUrl}/v2/sessions/sid-owned/archive`, token: `Bearer ${owner.token}`, method: 'POST' },
    ]);
  });
});

describe('sessionUnarchiveWithServerScope', () => {

  it('reads the unarchive response from its prepared API Home without retargeting to focus', async () => {
    realArchiveBoundary.resetRequests();
    const owner = await realArchiveBoundary.addHome('https://prepared-unarchive.example', 'prepared-unarchive');
    const { apiSocket } = await import('@/sync/api/session/apiSocket');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    realArchiveBoundary.setHttpResponder(async input => new URL(String(input)).pathname === '/v2/sessions/prepared/unarchive'
      ? Response.json({ success: true, archivedAt: null }) : null);
    apiSocket.initialize({ endpoint: owner.serverUrl, token: owner.token, serverId: owner.id,
      generation: getActiveServerSnapshot().generation }, null);
    try {
      const response = await apiSocket.request('/v2/sessions/prepared/unarchive', { method: 'POST' }, { retry: 'none' });
      expect(await response.json()).toEqual({ success: true, archivedAt: null });
      expect(realArchiveBoundary.httpRequests.filter(({ url }) => new URL(url).pathname.endsWith('/unarchive'))).toEqual([
        { url: `${owner.serverUrl}/v2/sessions/prepared/unarchive`, token: `Bearer ${owner.token}`, method: 'POST' },
      ]);
    } finally { apiSocket.disconnect(); }
  });
});
