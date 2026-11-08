import { afterEach, expect, it, vi } from 'vitest';
import { readSessionByIdHttp, resetSessionByIdHttpReadsForTests } from './sessionByIdHttp';
import { createCapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';

const runtimeFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/system/runtimeFetch', () => ({ runtimeFetch: (...args: unknown[]) => runtimeFetch(...args) ,
    get runtimeFetchManualResponse() { return this.runtimeFetch; },
}));
afterEach(() => { runtimeFetch.mockReset(); resetSessionByIdHttpReadsForTests(); });
const unusedRequest = async (): Promise<Response> => { throw new Error('Captured transport must own the physical read'); };

it('cancels an unshared request at its network boundary when its deadline expires', async () => {
  const request = (_path: string, init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  await expect(readSessionByIdHttp({ sessionId: 'session', token: 'opaque', request, timeoutMs: 10 }))
    .rejects.toMatchObject({ name: 'AbortError' });
});

it('does not dispatch an unshared request that is already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = vi.fn(async () => Response.json({}));
  await expect(readSessionByIdHttp({ sessionId: 'session', token: 'opaque', request, signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(request).not.toHaveBeenCalled();
});

it('does not turn cancellation during response-body consumption into a successful null body', async () => {
  const controller = new AbortController();
  const request = async (): Promise<Response> => {
    const body = new ReadableStream<Uint8Array>({ start(stream) {
      controller.signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } });
    const response = new Response(body);
    queueMicrotask(() => controller.abort());
    return response;
  };
  await expect(readSessionByIdHttp({ sessionId: 'session', token: 'opaque', request, signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
});

function transport(token = 'bearer', serverUrl = 'https://home.example.test') {
  return createCapturedServerReadTransport({ serverId: 'home', profile: { serverUrl }, credentials: { token } });
}
function partsCalls() { return runtimeFetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v2/sessions/read-batch'); }
function partsResponse(init?: RequestInit) {
  const input = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init?.body)));
  return Response.json({ results: input.sessionIds.map(sessionId => ({ sessionId,
    detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: sessionId }) } },
    ...(input.includeTurns !== false ? { turns: { status: 200, body: { v: 1, sessionId, updatedAt: 1, turns: [] } } } : {}),
  })) });
}

it('detaches one deadline without aborting an equivalent surviving Session read', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let physicalSignal: AbortSignal | null | undefined;
  runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (new URL(String(url)).pathname !== '/v2/sessions/read-batch') return Response.json({});
    physicalSignal = init?.signal;
    await Promise.race([held, new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })]);
    return partsResponse(init);
  });
  const input = { sessionId: 'session', serverId: 'home', token: 'bearer', request: unusedRequest, readTransport: transport(), retry: 'none' as const };
  const departed = readSessionByIdHttp({ ...input, timeoutMs: 10 }).catch(() => 'departed');
  const survivor = readSessionByIdHttp({ ...input, timeoutMs: 1000 }).catch(() => 'cancelled');
  await expect(departed).resolves.toBe('departed');
  const abortedSurvivor = physicalSignal?.aborted;
  release();
  const observation = await survivor;
  expect(abortedSurvivor).toBe(false);
  expect(observation).toMatchObject({ ok: true, status: 200, body: { session: { id: 'session' } } });
  expect(partsCalls()).toHaveLength(1);
});

it('shares only identical authority and access projections and never retains a settled response', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (new URL(String(url)).pathname !== '/v2/sessions/read-batch') return Response.json({});
    await held;
    return partsResponse(init);
  });
  const input = { sessionId: 'session', serverId: 'home', token: 'bearer', request: unusedRequest, readTransport: transport(), retry: 'none' as const };
  const reads = [readSessionByIdHttp(input), readSessionByIdHttp(input),
    readSessionByIdHttp({ ...input, accessProjectionVersion: 1 }),
    readSessionByIdHttp({ ...input, readTransport: transport('bearer', 'https://other.example.test') }),
    readSessionByIdHttp({ ...input, token: 'other-bearer', readTransport: transport('other-bearer') })];
  release();
  await Promise.all(reads);
  expect(partsCalls()).toHaveLength(4);
  await readSessionByIdHttp(input);
  expect(partsCalls()).toHaveLength(5);
});

it('does not treat an unbranded callback identity as cancellation-neutral authority', async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const request = vi.fn(async () => { await held; return Response.json({}); });
  const input = { sessionId: 'session', serverId: 'home', token: 'bearer', request };
  const reads = [readSessionByIdHttp(input), readSessionByIdHttp(input)];
  release();
  await Promise.all(reads);
  expect(request).toHaveBeenCalledTimes(2);
});

it('retains the unshared invocation request for a restricted PAT even when given a neutral descriptor', async () => {
  const token = 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43);
  runtimeFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/auth/ping') return Response.json({});
    if (path === '/v2/sessions/read-batch') return Response.json({ error: 'present_user_required' }, { status: 403 });
    expect(new Headers(init?.headers).get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)).toBe('captured-action-authorization');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    return Response.json({ session: { id: 'session' } });
  });
  const request = vi.fn(async (path: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    headers.set(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, 'captured-action-authorization');
    return await runtimeFetch(`https://home.example.test${path}`, { ...init, headers });
  });
  const input = { sessionId: 'session', token, request, readTransport: transport(token), retry: 'none' as const };
  const results = await Promise.all([readSessionByIdHttp(input), readSessionByIdHttp(input)]);
  for (const result of results) expect(result).toMatchObject({ ok: true, body: { session: { id: 'session' } } });
  expect(request).toHaveBeenCalledTimes(2);
  expect(partsCalls()).toHaveLength(0);
});

it.each(['batch', 'record'] as const)('preserves exact status and refusal bodies from a %s failure', async failure => {
  const body = { error: 'credential_scope_denied' };
  runtimeFetch.mockImplementation(async (url: unknown) => {
    if (new URL(String(url)).pathname !== '/v2/sessions/read-batch') return Response.json({});
    return failure === 'batch' ? Response.json(body, { status: 403 })
      : Response.json({ results: [{ sessionId: 'session', detail: { status: 403, body } }] });
  });
  await expect(readSessionByIdHttp({ sessionId: 'session', token: 'bearer', request: unusedRequest,
    readTransport: transport(), retry: 'none' })).resolves.toEqual({ ok: false, status: 403, body });
});
