import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';

import { createAcpSessionListingOwner } from './createAcpSessionListingContribution';

type AcpRequest = Readonly<{
  id?: string | number;
  method?: string;
  params?: Readonly<Record<string, unknown>>;
}>;

type Fixture = Readonly<{
  port: number;
  requests: readonly AcpRequest[];
  /** Resolves once every socket the contribution owned has closed. */
  allSocketsClosed(): Promise<boolean>;
  close(): Promise<void>;
}>;

/**
 * A real TCP ACP peer. Session listing owns this socket, so teardown has to be
 * observed on the wire rather than through a stubbed backend.
 */
async function startAcpPeer(params: Readonly<{
  /**
   * May return a promise so a test can park one connection's `session/list`
   * and let another connection run past it.
   */
  answerList: (request: AcpRequest, connectionIndex: number) => unknown | undefined;
  negotiateList?: boolean;
  /** A predicate answers per connection, so one peer can serve both handshakes. */
  negotiateDelete?: boolean | ((connectionIndex: number) => boolean);
}>): Promise<Fixture> {
  const requests: AcpRequest[] = [];
  const sockets = new Set<Socket>();
  let closedCount = 0;
  let openedCount = 0;
  const closeWaiters = new Set<() => void>();
  const server: Server = createServer((socket) => {
    const connectionIndex = openedCount;
    openedCount += 1;
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('error', () => undefined);
    socket.on('close', () => {
      sockets.delete(socket);
      closedCount += 1;
      for (const waiter of closeWaiters) waiter();
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const request = JSON.parse(line) as AcpRequest;
        requests.push(request);
        const negotiatesDelete = typeof params.negotiateDelete === 'function'
          ? params.negotiateDelete(connectionIndex)
          : params.negotiateDelete === true;
        const result = request.method === 'initialize'
          ? {
              protocolVersion: 1,
              agentCapabilities: {
                sessionCapabilities: {
                  ...(params.negotiateList === false ? {} : { list: {} }),
                  ...(negotiatesDelete ? { delete: {} } : {}),
                },
              },
              authMethods: [],
            }
          : request.method === 'session/list'
            ? params.answerList(request, connectionIndex)
            : {};
        if (result === undefined) continue;
        const id = request.id;
        void Promise.resolve(result).then((answered) => {
          if (answered === undefined || socket.destroyed) return;
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: answered })}\n`);
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
  return Object.freeze({
    port: address.port,
    requests,
    async allSocketsClosed() {
      const settled = new Promise<boolean>((resolve) => {
        const check = () => {
          if (openedCount > 0 && closedCount >= openedCount) {
            closeWaiters.delete(check);
            resolve(true);
          }
        };
        closeWaiters.add(check);
        check();
      });
      return await Promise.race([
        settled,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
      ]);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

function listRequest(overrides: Readonly<{
  cursor?: string;
  maxItems?: number;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  searchTerm?: string;
}> = {}) {
  const services = createUnavailablePluginServices();
  return {
    source: { kind: 'fixtureAcpSessions' },
    ...(overrides.cursor === undefined ? {} : { cursor: overrides.cursor }),
    ...(overrides.searchTerm === undefined ? {} : { searchTerm: overrides.searchTerm }),
    maxItems: overrides.maxItems ?? 10,
    maxSerializedBytes: 1_048_576,
    deadlineAtMs: overrides.deadlineAtMs ?? Date.now() + 10_000,
    signal: overrides.signal ?? new AbortController().signal,
    exec: services.exec,
    ripgrep: { run: async () => { throw new Error('ACP sources have no file corpus'); } },
    managedEndpointRead: async () => {
      throw new Error('This ACP listing source reaches its Agent directly');
    },
  };
}

function ownerFor(port: number) {
  return createAcpSessionListingOwner({
    pluginId: 'happier.agent.fixture',
    agentId: 'fixture',
    runtime: { transport: { kind: 'tcp', host: '127.0.0.1', port } },
    sourceKinds: new Set(['fixtureAcpSessions']),
  });
}

function contributionFor(port: number) {
  return ownerFor(port).contribution;
}

function deleteRequest(overrides: Readonly<{
  remoteSessionId?: string;
  sourceKind?: string;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}> = {}) {
  const services = createUnavailablePluginServices();
  return {
    source: { kind: overrides.sourceKind ?? 'fixtureAcpSessions' },
    remoteSessionId: overrides.remoteSessionId ?? ' provider\nsession-1 ',
    maxSerializedBytes: 1_048_576,
    deadlineAtMs: overrides.deadlineAtMs ?? Date.now() + 10_000,
    signal: overrides.signal ?? new AbortController().signal,
    exec: services.exec,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function providerSession(index: number) {
  return {
    sessionId: ` provider\nsession-${index} `,
    cwd: '/workspace/project',
    title: `Project ${index}`,
    updatedAt: '2026-09-13T08:30:00.000Z',
  };
}

let fixture: Fixture | null = null;

afterEach(async () => {
  await fixture?.close();
  fixture = null;
});

describe('createAcpSessionListingContribution', () => {
  it('pages exact ACP identities into resume-only candidates and disposes the connection', async () => {
    fixture = await startAcpPeer({
      answerList: () => ({ sessions: [providerSession(1)], nextCursor: ' page\n2 ' }),
    });

    await expect(contributionFor(fixture.port).listCandidates(listRequest({ cursor: ' page\n1 ' })))
      .resolves.toEqual({
        ok: true,
        value: {
          candidates: [{
            remoteSessionId: ' provider\nsession-1 ',
            title: 'Project 1',
            updatedAtMs: Date.parse('2026-09-13T08:30:00.000Z'),
          }],
          nextCursor: ' page\n2 ',
        },
      });
    const listed = fixture.requests.find((request) => request.method === 'session/list');
    expect(listed?.params).toEqual({ cursor: ' page\n1 ' });
    await expect(fixture.allSocketsClosed()).resolves.toBe(true);
  }, 20_000);

  it('never filters the provider listing by a fabricated daemon working directory', async () => {
    fixture = await startAcpPeer({ answerList: () => ({ sessions: [], nextCursor: null }) });

    await expect(contributionFor(fixture.port).listCandidates(listRequest()))
      .resolves.toMatchObject({ ok: true });
    const listed = fixture.requests.find((request) => request.method === 'session/list');
    expect(listed?.params).not.toHaveProperty('cwd');
  }, 20_000);

  it.each([
    ['with a continuation cursor', ' page\n2 '],
    ['without a continuation cursor', null],
  ])('rejects an oversized provider page %s instead of dropping sessions', async (_label, nextCursor) => {
    fixture = await startAcpPeer({
      answerList: () => ({
        sessions: [1, 2, 3].map(providerSession),
        nextCursor,
      }),
    });

    const result = await contributionFor(fixture.port).listCandidates(listRequest({ maxItems: 2 }));

    expect(result).toMatchObject({ ok: false, code: 'agent_error', retryable: false });
    await expect(fixture.allSocketsClosed()).resolves.toBe(true);
  }, 20_000);

  it('closes its owned connection and settles when a pending session/list is aborted', async () => {
    fixture = await startAcpPeer({ answerList: () => undefined });
    const controller = new AbortController();
    const pending = contributionFor(fixture.port)
      .listCandidates(listRequest({ signal: controller.signal }));

    // The provider answered `initialize` and then went silent; only the abort
    // can end this call.
    await expect.poll(
      () => fixture!.requests.some((request) => request.method === 'session/list'),
      { timeout: 10_000 },
    ).toBe(true);
    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, code: 'cancelled' });
    await expect(fixture.allSocketsClosed()).resolves.toBe(true);
  }, 20_000);

  it('closes its owned connection and settles when a pending session/list passes its deadline', async () => {
    fixture = await startAcpPeer({ answerList: () => undefined });

    const result = await contributionFor(fixture.port)
      .listCandidates(listRequest({ deadlineAtMs: Date.now() + 750 }));

    expect(result).toMatchObject({ ok: false, code: 'timeout', retryable: true });
    await expect(fixture.allSocketsClosed()).resolves.toBe(true);
  }, 20_000);

  it('advertises candidate deletion only from the handshake that served the listing', async () => {
    fixture = await startAcpPeer({
      negotiateDelete: true,
      answerList: () => ({ sessions: [providerSession(1)], nextCursor: null }),
    });
    const owner = ownerFor(fixture.port);

    // A request that never listed observed no handshake, so nothing may be
    // advertised for it.
    await expect(owner.runListingRequest(async () => 'no-listing')).resolves.toEqual({
      value: 'no-listing',
      negotiatedDeleteSupport: false,
    });
    await expect(owner.runListingRequest(async () => (
      await owner.contribution.listCandidates(listRequest())
    ))).resolves.toMatchObject({
      value: { ok: true },
      negotiatedDeleteSupport: true,
    });
  }, 20_000);

  /**
   * The capability belongs to the request that proved it. A later request whose
   * page came from somewhere other than a live ACP listing — an indexed
   * continuation — must not inherit a predecessor's negotiated handshake.
   */
  it('never lets one request inherit the delete capability another request proved', async () => {
    fixture = await startAcpPeer({
      negotiateDelete: true,
      answerList: () => ({ sessions: [providerSession(1)], nextCursor: null }),
    });
    const owner = ownerFor(fixture.port);

    await expect(owner.runListingRequest(async () => (
      await owner.contribution.listCandidates(listRequest())
    ))).resolves.toMatchObject({ negotiatedDeleteSupport: true });

    await expect(owner.runListingRequest(async () => 'served-from-index')).resolves.toEqual({
      value: 'served-from-index',
      negotiatedDeleteSupport: false,
    });
  }, 20_000);

  /**
   * Two listing requests overlap on one owner while their Agents negotiate
   * differently, and the one that proved `session/delete` finishes last. Each
   * response must carry only the capability its own handshake advertised: a
   * single shared capability store would let the later request's handshake
   * decide what the earlier caller is told it may delete.
   */
  it('answers interleaved listing requests from their own handshakes regardless of completion order', async () => {
    const listReached = [createDeferred<void>(), createDeferred<void>()];
    const releaseList = [createDeferred<void>(), createDeferred<void>()];
    fixture = await startAcpPeer({
      // The first connection negotiates deletion; the second never does.
      negotiateDelete: (connectionIndex) => connectionIndex === 0,
      answerList: async (_request, connectionIndex) => {
        listReached[connectionIndex]?.resolve();
        await releaseList[connectionIndex]?.promise;
        return { sessions: [providerSession(connectionIndex + 1)], nextCursor: null };
      },
    });
    const owner = ownerFor(fixture.port);

    const negotiated = owner.runListingRequest(async () => (
      await owner.contribution.listCandidates(listRequest())
    ));
    await listReached[0]!.promise;
    const unnegotiated = owner.runListingRequest(async () => (
      await owner.contribution.listCandidates(listRequest())
    ));
    await listReached[1]!.promise;

    // Both requests are now parked inside their own listing. Settle them in the
    // reverse order they started so completion order cannot explain the answers.
    releaseList[1]!.resolve();
    await expect(unnegotiated).resolves.toMatchObject({
      value: { ok: true },
      negotiatedDeleteSupport: false,
    });
    releaseList[0]!.resolve();
    await expect(negotiated).resolves.toMatchObject({
      value: { ok: true },
      negotiatedDeleteSupport: true,
    });
  }, 20_000);

  it('keeps candidate deletion unadvertised when the Agent never negotiated session/delete', async () => {
    fixture = await startAcpPeer({ answerList: () => ({ sessions: [], nextCursor: null }) });
    const owner = ownerFor(fixture.port);

    await expect(owner.runListingRequest(async () => (
      await owner.contribution.listCandidates(listRequest())
    ))).resolves.toMatchObject({
      value: { ok: true },
      negotiatedDeleteSupport: false,
    });
  }, 20_000);

  it('deletes with the exact opaque provider id and disposes its own connection', async () => {
    fixture = await startAcpPeer({
      negotiateDelete: true,
      answerList: () => ({ sessions: [providerSession(1)], nextCursor: null }),
    });

    await expect(ownerFor(fixture.port).deleteCandidate(deleteRequest()))
      .resolves.toEqual({ ok: true, value: undefined });
    const deleted = fixture.requests.find((request) => request.method === 'session/delete');
    expect(deleted?.params).toEqual({ sessionId: ' provider\nsession-1 ' });
    expect(fixture.requests.some((request) => request.method === 'session/list')).toBe(false);
    await expect(fixture.allSocketsClosed()).resolves.toBe(true);
  }, 20_000);

  it('refuses deletion against an Agent that did not negotiate session/delete', async () => {
    fixture = await startAcpPeer({ answerList: () => ({ sessions: [], nextCursor: null }) });

    const result = await ownerFor(fixture.port).deleteCandidate(deleteRequest());

    expect(result).toMatchObject({ ok: false, code: 'agent_error' });
    expect(fixture.requests.some((request) => request.method === 'session/delete')).toBe(false);
    await expect(fixture.allSocketsClosed()).resolves.toBe(true);
  }, 20_000);

  it('refuses deletion for a source kind this Agent never declared', async () => {
    fixture = await startAcpPeer({
      negotiateDelete: true,
      answerList: () => ({ sessions: [], nextCursor: null }),
    });

    await expect(ownerFor(fixture.port).deleteCandidate(deleteRequest({ sourceKind: 'otherAgentSessions' })))
      .resolves.toMatchObject({ ok: false, code: 'source_invalid' });
    expect(fixture.requests).toEqual([]);
  }, 20_000);

  it('reports an unnegotiated session/list as a provider error and disposes', async () => {
    fixture = await startAcpPeer({
      negotiateList: false,
      answerList: () => ({ sessions: [], nextCursor: null }),
    });

    const result = await contributionFor(fixture.port).listCandidates(listRequest());

    expect(result).toMatchObject({ ok: false, code: 'agent_error' });
    expect(fixture.requests.some((request) => request.method === 'session/list')).toBe(false);
    await expect(fixture.allSocketsClosed()).resolves.toBe(true);
  }, 20_000);
});
