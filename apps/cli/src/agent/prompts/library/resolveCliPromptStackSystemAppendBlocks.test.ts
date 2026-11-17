import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol/storage/artifactStoredContent';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { ArtifactReadHeadersBatchInputV1Schema, ArtifactReadHeadersBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { SessionCreationTargetPreparationRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1, ConnectedAccountCatalogRowReadResponseV1Schema, emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { io } from 'socket.io-client';
import { bindApiSessionSocketMock, createApiSessionSocketStub, createSessionCreationTargetPreparationRpcResult } from '@/testkit/backends/apiSessionSocketHarness';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

// Load/transform the substantial real Action owner before timed hooks, under
// an isolated OS Home. Each test still resets modules and admits its own Home.
const actionOwnerLoadHome = await createTempDir('happier-prompt-owner-load-');
vi.stubEnv('HAPPIER_HOME_DIR', actionOwnerLoadHome);
for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_SERVER_ID', 'HAPPIER_WEBAPP_URL']) vi.stubEnv(key, '');
try {
  await import('@/session/actions/createCliActionDeps');
} finally {
  vi.resetModules();
  vi.unstubAllEnvs();
  await removeTempDir(actionOwnerLoadHome);
}

// Real Axios, credentials, Home selection and codecs run above HTTP/FS peers.
let taskHome: string;
const peers: Server[] = [];
beforeEach(async () => {
  vi.resetModules();
  taskHome = await createTempDir('happier-qualified-prompts-');
  vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
  for (const key of [
    'HAPPIER_SERVER_URL',
    'HAPPIER_LOCAL_SERVER_URL',
    'HAPPIER_SERVER_ID',
    'HAPPIER_WEBAPP_URL',
  ])
    vi.stubEnv(key, '');
});
afterEach(async () => {
  for (const peer of peers.splice(0)) {
    peer.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      peer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  vi.unstubAllEnvs();
  await removeTempDir(taskHome);
});
function entry(id: string, serverId?: string): PromptStackEntryV1 {
  return {
    id,
    ref: { kind: 'doc', artifactId: id, ...(serverId ? { serverId } : {}) },
    enabled: true,
    required: true,
    placement: 'system_append',
  };
}
async function home(id: string, token: string, accountMarkdownByToken?: Readonly<Record<string, string>>) {
  function row(artifactId: string, markdown: string, kind = 'prompt_doc.v2') {
    return {
      id: artifactId,
      ownerAccountId: id,
      access: 'owner',
      encryptionMode: 'plain',
      publicAudience: 'none',
      header: encodePlainArtifactStoredContent({
        v: 1,
        kind,
        title: artifactId,
      }),
      body: encodePlainArtifactStoredContent({
        body: JSON.stringify({
          v: 1,
          markdown,
          createdAtMs: 1,
          updatedAtMs: 1,
        }),
      }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 1,
      bodyVersion: 1,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
    };
  }
  const rows = new Map<string, ReturnType<typeof row>>();
  const requests: string[] = [];
  const authenticatedRequests: string[] = [];
  let responseBytes = 0;
  let status = 200;
  let headerEndpointStatus: number | null = null;
  const peer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(url.pathname);
    if (request.headers.authorization) authenticatedRequests.push(url.pathname);
    let data: unknown;
    let code = 200;
    const requestToken = request.headers.authorization?.slice('Bearer '.length);
    const accountMarkdown = requestToken ? accountMarkdownByToken?.[requestToken] : undefined;
    if (request.headers.authorization !== `Bearer ${token}` && accountMarkdown === undefined) {
      code = 401;
      data = { error: 'wrong_account' };
    } else if (url.pathname === '/v1/account/profile') data = { id };
    else if (url.pathname === '/v1/account/encryption/currentness') data = {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    };
    else if (url.pathname === '/v2/account/settings') data = { content: { t: 'plain', v: {} }, version: 1 };
    else if (url.pathname === '/v2/sessions/lookup-by-tags') data = { sessions: [] };
    else if (url.pathname === '/v1/home/governance/get') data = HomeSessionDefaultsProjectionV1Schema.parse({ homeDefaults: null });
    else if (url.pathname === `${CONNECTED_ACCOUNT_CATALOG_ROWS_ROUTE_V1}/purposes`) data = ConnectedAccountCatalogRowReadResponseV1Schema.parse({
      status: 'present', revision: 1, content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1('purposes') },
    });
    else if (url.pathname === '/v1/machines/machine-1') data = { machine: {
      id: 'machine-1', active: true, installationId: 'installation-1', kind: 'persistent',
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, revokedAt: null, replacedByMachineId: null,
    } };
    else if (url.pathname === '/v1/account/encryption')
      data = { mode: 'plain', updatedAt: 0 };
    else if (url.pathname === '/v1/artifacts/read' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const input = ArtifactReadHeadersBatchInputV1Schema.parse(JSON.parse(body));
      code = headerEndpointStatus ?? (status === 404 ? 200 : status);
      data = code === 200 ? ArtifactReadHeadersBatchResponseV1Schema.parse({ projection: 'headers', items: input.artifactIds.map(artifactId => {
        const found = status === 404 ? undefined : rows.get(artifactId);
        if (!found) return { artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false };
        const { body: _body, ...artifact } = accountMarkdown === undefined ? found : row(found.id, accountMarkdown);
        return { artifactId, ok: true, artifact };
      }) }) : { error: 'unavailable' };
    }
    else if (url.pathname === '/v1/artifacts') {
      code = status === 404 ? 200 : status;
      const sorted = [...rows.values()].sort(
        (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
      );
      const cursor = url.searchParams.get('cursor');
      const last: unknown = cursor
        ? JSON.parse(Buffer.from(cursor, 'base64url').toString())
        : null;
      const after =
        last && typeof last === 'object'
          ? sorted.findIndex((item) => item.id === Reflect.get(last, 'id')) + 1
          : 0;
      data = sorted
        .slice(after, after + Number(url.searchParams.get('limit') ?? 500))
        .map(({ body: _body, bodyVersion: _version, ...header }) => header);
      if (status === 404) data = [];
      else if (code !== 200) data = { error: 'unavailable' };
    } else {
      code = status;
      const found = rows.get(
        decodeURIComponent(url.pathname.slice('/v1/artifacts/'.length)),
      );
      if (code === 200 && !found) code = 404;
      data = code === 200 ? found && accountMarkdown !== undefined ? row(found.id, accountMarkdown) : found : { error: 'unavailable' };
    }
    response.writeHead(code, { 'Content-Type': 'application/json' });
    const encoded = JSON.stringify(data);
    responseBytes += Buffer.byteLength(encoded);
    response.end(encoded);
  });
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve));
  peers.push(peer);
  const address = peer.address();
  if (!address || typeof address === 'string')
    throw new Error('missing_http_address');
  const url = `http://127.0.0.1:${address.port}`;
  await mkdir(join(taskHome, 'servers', id), { recursive: true });
  await writeFile(
    join(taskHome, 'servers', id, 'access.key'),
    JSON.stringify({ token }),
  );
  return {
    id,
    url,
    requests,
    authenticatedRequests,
    get responseBytes() { return responseBytes; },
    rows,
    set: (artifactId: string, markdown: string, kind?: string) => {
      const previous = rows.get(artifactId);
      return rows.set(artifactId, { ...row(artifactId, markdown, kind),
        bodyVersion: (previous?.bodyVersion ?? 0) + 1, seq: (previous?.seq ?? 0) + 1,
        updatedAt: (previous?.updatedAt ?? 0) + 1 });
    },
    fail: (code: number) => {
      status = code;
    },
    rejectHeaderEndpoint: (code: number | null) => {
      headerEndpointStatus = code;
    },
  };
}
async function profiles(homes: readonly Awaited<ReturnType<typeof home>>[]) {
  await writeFile(
    join(taskHome, 'settings.json'),
    JSON.stringify({
      schemaVersion: 6,
      activeServerId: homes[0]!.id,
      servers: Object.fromEntries(
        homes.map((item) => [
          item.id,
          {
            id: item.id,
            name: item.id,
            serverUrl: item.url,
            webappUrl: item.url,
            createdAt: 1,
            updatedAt: 1,
            lastUsedAt: 1,
          },
        ]),
      ),
    }),
  );
}

async function startPromptPreparationDispatch(prepare: () => Promise<string>, options?: { metadataAvailable?: boolean }) {
  const { runPermissionModePromptLoop } = await import('@/agent/runtime/runPermissionModePromptLoop');
  const { MessageQueue2 } = await import('@/agent/runtime/modeMessageQueue');
  const { combinePermissionModeQueuedPrompts } = await import('@/agent/runtime/permissions/queuedPrompt');
  const { createMutableApiSessionClientFixture } = await import('@/testkit/backends/sessionFixtures');
  const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
  const { MessageBuffer } = await import('@/ui/ink/messageBuffer');
  type Options = Parameters<typeof runPermissionModePromptLoop>[0];
  type QueuedPrompt = import('@/agent/runtime/permissions/queuedPrompt').PermissionModeQueuedPrompt;
  type QueuedMode = import('@/agent/runtime/permissions/queuedPrompt').PermissionModeQueuedPromptMode;
  const observeProviderInputSettlement = vi.fn(async () => false);
  const publications: unknown[] = [];
  const failures: unknown[] = [];
  const metadataWaiters = new Set<(changed: boolean) => void>();
  const controller = new AbortController();
  const session = createMutableApiSessionClientFixture({ overrides: {
    sessionId: 'prompt-preparation-session', observeProviderInputSettlement,
    async enqueueAgentMessageCommitted(_agent, body) {
      publications.push(body);
      return { persisted: true, delivered: false };
    },
    waitForMetadataUpdate: signal => options?.metadataAvailable === false ? Promise.resolve(false) : new Promise<boolean>(resolve => {
      const finish = (changed: boolean) => {
        metadataWaiters.delete(finish);
        signal?.removeEventListener('abort', abort);
        resolve(changed);
      };
      const abort = () => finish(false);
      metadataWaiters.add(finish);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    }),
  } });
  session.__setMetadata(createTestMetadata({ permissionMode: 'default', permissionModeUpdatedAt: 0 }));
  const queue = new MessageQueue2<QueuedMode, QueuedPrompt>(mode => JSON.stringify(mode), {
    batcher: messages => combinePermissionModeQueuedPrompts(messages),
  });
  queue.push({ text: 'Retained input', localId: 'retained-input', userMessageSeq: 42 }, { permissionMode: 'default' });
  // Only the native Agent boundary is substituted. The real prompt-library HTTP
  // reader, Protocol preparation and host dispatch/settlement path run together.
  const runtime = {
    beginTurnLifecycle: vi.fn(), sendTurnPrompt: vi.fn(async () => {}),
    steerInFlightTurn: vi.fn(async () => {}), waitForTurnCompletion: vi.fn(async () => {}),
    subscribeRuntimeEvents: () => () => {}, respondToPermission: vi.fn(async () => {}),
    cancelTurn: vi.fn(async () => {}), readSessionIdentity: () => ({ sessionId: 'native-session' }),
    updateSessionRuntimeConfig: vi.fn(async () => {}), resetOrDisposeRuntime: vi.fn(async () => {}),
    shouldResumeAfterPermissionModeChange: () => true,
  } as unknown as Options['runtime'];
  let done = false;
  const messageBuffer = new MessageBuffer();
  const run = runPermissionModePromptLoop({
    providerName: 'Fixture Agent', agentMessageType: 'fixture', explicitPermissionMode: undefined,
    session, messageQueue: queue, permissionHandler: { setPermissionMode() {}, reset() {} }, runtime,
    createOverrideSynchronizer: () => ({ syncFromMetadata() {}, flushPendingAfterStart: async () => {} }),
    messageBuffer, shouldExit: () => done,
    getAbortSignal: () => controller.signal, keepAlive() {}, setThinking() {},
    sendReady() { done = true; }, currentPermissionModeUpdatedAt: 0,
    setCurrentPermissionMode() {}, setCurrentPermissionModeUpdatedAt() {},
    resolveFreshSessionSystemPrompt: prepare,
    onPromptFailure: error => { failures.push(error); },
    formatPromptErrorMessage: () => 'Preparation unavailable', registerProviderAcceptedEffect() {},
  });
  return { runtime, observeProviderInputSettlement, publications, failures, messageBuffer, run,
    wake: () => { for (const finish of [...metadataWaiters]) finish(true); },
    enqueue: (localId: string) => queue.push({ text: 'Later input', localId }, { permissionMode: 'default' }),
    stop: () => { done = true; controller.abort(); },
  };
}

async function dispatchWithPromptPreparation(prepare: () => Promise<string>) {
  const dispatch = await startPromptPreparationDispatch(prepare);
  await dispatch.run;
  return dispatch;
}

describe('CLI qualified current Artifact prompt preparation', () => {
  it.each([400, 404])('refuses an unsupported header endpoint without omitting optional context or reading bodies (HTTP %s)', async status => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('doc', 'Optional instructions');
    a.rejectHeaderEndpoint(status);
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    const args = { surface: 'coding' as const, memoryEnabled: false,
      accountEntries: [{ ...entry('doc'), required: false }] };
    await expect(resolve(args)).rejects.toMatchObject({ status: 'attachment_unavailable', reason: 'malformed',
      cause: { classification: { statusCode: status, retryable: false } } });
    expect(a.requests.filter(path => path.startsWith('/v1/artifacts'))).toEqual(['/v1/artifacts/read']);
    a.rejectHeaderEndpoint(null);
    expect(await resolve(args)).toMatchObject({ blocks: ['Optional instructions'], admittedEntries: [{ outcome: 'ready' }] });
    expect(a.requests.filter(path => path.startsWith('/v1/artifacts'))).toEqual([
      '/v1/artifacts/read', '/v1/artifacts/read', '/v1/artifacts/doc',
    ]);
  });

  it.each([503, 403])('retains Home read classification through header and body preparation (HTTP %s)', async status => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('doc', 'Forbidden instructions');
    a.fail(status);
    const { resolveCliPromptStackSystemAppendBlocks: resolve, withCliPromptLibraryArtifactReader } = await import('./resolveCliPromptStackSystemAppendBlocks');
    const { HomeReadPreparationError } = await import('./homeReadPreparationError');
    const { classifyPrimarySessionRuntimeIssue } = await import('@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue');
    const failures = [await resolve({ surface: 'coding', accountEntries: [entry('doc')], memoryEnabled: false }).catch((error: unknown) => error),
      await withCliPromptLibraryArtifactReader(reader => reader.readArtifact({ kind: 'doc', artifactId: 'doc' })).catch((error: unknown) => error)];
    for (const error of failures) {
      const code = status === 503 ? 'preparation_pending' : 'attachment_unavailable';
      expect(error).toMatchObject({ code, reason: status === 503 ? 'unavailable' : 'locked',
        cause: { classification: { kind: status === 503 ? 'server_error' : 'auth_failed', statusCode: status, retryable: status === 503 } } });
      expect(error instanceof Error ? error.cause : null).toBeInstanceOf(HomeReadPreparationError);
      expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error })).toMatchObject({ code, source: 'dependency_failure' });
    }
  });

  it.each([{ status: 500, wake: 'metadata' }, { status: 503, wake: 'queue' }])('retains unavailable required context and wakes early on $wake (HTTP $status)', async ({ status, wake }) => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('doc', 'Required instruction');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    let failed!: () => void;
    let unavailableReads = 0;
    const preparationFailed = new Promise<void>(resolve => { failed = resolve; });
    const prepare = async () => {
      try { return (await resolve({ surface: 'coding', accountEntries: [entry('doc')] })).blocks.join('\n'); }
      catch (error) { unavailableReads += 1; failed(); throw error; }
    };
    a.fail(status);
    const dispatch = await startPromptPreparationDispatch(prepare);
    try {
      await preparationFailed;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(dispatch.runtime.beginTurnLifecycle).not.toHaveBeenCalled();
      expect(dispatch.runtime.sendTurnPrompt).not.toHaveBeenCalled();
      expect(dispatch.observeProviderInputSettlement).not.toHaveBeenCalled();
      expect(dispatch.failures).toEqual([]);
      expect(dispatch.publications).toEqual([]);
      const requestCount = a.requests.length;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(a.requests).toHaveLength(requestCount);
      if (wake === 'queue') dispatch.enqueue('later-input-1');
      else dispatch.wake();
      await vi.waitFor(() => expect(unavailableReads).toBe(2));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(dispatch.runtime.sendTurnPrompt).not.toHaveBeenCalled();
      expect(dispatch.failures).toEqual([]);
      expect(dispatch.publications).toEqual([]);
      a.fail(200);
      if (wake === 'queue') dispatch.enqueue('later-input-2');
      else dispatch.wake();
      await dispatch.run;
      expect(dispatch.runtime.sendTurnPrompt).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('Required instruction'), expect.objectContaining({ localId: 'retained-input', userMessageSeq: 42 }),
      );
      expect(dispatch.observeProviderInputSettlement).not.toHaveBeenCalled();
      expect(dispatch.failures).toEqual([]);
      expect(dispatch.messageBuffer.getMessages().filter(message => message.type === 'user'))
        .toMatchObject([{ content: 'Retained input' }]);
    } finally {
      dispatch.stop();
      await dispatch.run;
    }
    a.fail(404);
    const absent = await dispatchWithPromptPreparation(prepare);
    expect(absent.runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(absent.observeProviderInputSettlement).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      reason: 'runtime_config_blocked', retryable: false,
      diagnostic: expect.objectContaining({ code: 'attachment_unavailable' }),
    }));
    expect(absent.failures).toHaveLength(1);
    // The Session lifecycle (onPromptFailure) owns the failure message; the prompt loop publishes nothing itself.
    expect(absent.publications).toEqual([]);
  });

  it('retains unavailable Account prompt inventory until cancellation without publishing a failed turn', async () => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    const { prepareSessionPromptStackInputs } = await import('@/agent/prompting/coding/sessionPromptStack');
    let failed!: () => void;
    const preparationFailed = new Promise<void>(resolve => { failed = resolve; });
    const result = await startPromptPreparationDispatch(async () => {
      try { await prepareSessionPromptStackInputs({ machineId: 'machine-1', metadata: null,
        credentials: { token: 'active-token', encryption: null },
        accountContext: { scopeKey: 'unavailable-account', lifetimeToken: -1, settings: null },
      }); } catch (error) { failed(); throw error; }
      return '';
    });
    await preparationFailed;
    await new Promise<void>(resolve => setImmediate(resolve));
    result.stop();
    await result.run;
    expect(result.runtime.sendTurnPrompt).not.toHaveBeenCalled();
    expect(result.observeProviderInputSettlement).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
    expect(result.publications).toEqual([]);
  });

  it.each([true, false])('paces repeated Home outages and dispatches once after silent recovery (metadata subscription available: %s)', async metadataAvailable => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('doc', 'Required instruction');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    let failed!: () => void;
    const preparationAttempts: number[] = [];
    let preparationError: unknown;
    const preparationFailed = new Promise<void>(resolve => { failed = resolve; });
    a.fail(503);
    const dispatch = await startPromptPreparationDispatch(async () => {
      preparationAttempts.push(Date.now());
      try { return (await resolve({ surface: 'coding', accountEntries: [entry('doc')] })).blocks.join('\n'); }
      catch (error) { preparationError = error; failed(); throw error; }
    }, { metadataAvailable });
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    try {
      // Install the clock before the real HTTP failure can arm any recovery
      // delay; leave socket I/O and setImmediate running on the real event loop.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      await preparationFailed;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(preparationError).toMatchObject({ status: 'preparation_pending', reason: 'unavailable' });
      // Pass the default createBackoff attempt cap and reach the incumbent
      // offline policy's delay saturation; failures must never retire custody.
      for (let attempt = 1; attempt <= 11; attempt += 1) {
        const nextFailure = new Promise<void>(resolve => { failed = resolve; });
        await vi.advanceTimersToNextTimerAsync();
        expect(preparationAttempts).toHaveLength(attempt + 1);
        await nextFailure;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(dispatch.runtime.sendTurnPrompt).not.toHaveBeenCalled();
        expect(dispatch.observeProviderInputSettlement).not.toHaveBeenCalled();
        expect(dispatch.failures).toEqual([]);
        expect(dispatch.publications).toEqual([]);
      }
      const spacing = preparationAttempts.slice(1).map((time, index) => time - preparationAttempts[index]!);
      // The real offline policy owns 5s minimum / 60s maximum / saturation at
      // ten failures. Fix randomness so spacing, rather than wall time, decides.
      expect(spacing[0]).toBeGreaterThanOrEqual(5_000);
      expect(spacing[1]).toBeGreaterThan(spacing[0]!);
      expect(spacing[2]).toBeGreaterThan(spacing[1]!);
      expect(Math.max(...spacing)).toBeLessThanOrEqual(60_000);
      expect(spacing[10]).toBe(spacing[9]);
      a.fail(200);
      // Prove the same real Home reader is healthy independently of the parked
      // loop. This does not emit a Session metadata/reconnect or queue wake.
      expect((await resolve({ surface: 'coding', accountEntries: [entry('doc')] })).blocks.join('\n'))
        .toContain('Required instruction');
      await vi.advanceTimersToNextTimerAsync();
      await dispatch.run;
      expect(dispatch.runtime.beginTurnLifecycle).toHaveBeenCalledTimes(1);
      expect(dispatch.runtime.sendTurnPrompt).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('Required instruction'), expect.objectContaining({ localId: 'retained-input', userMessageSeq: 42 }),
      );
      expect(dispatch.observeProviderInputSettlement).not.toHaveBeenCalled();
      expect(dispatch.failures).toEqual([]);
      expect(dispatch.publications).toEqual([]);
      expect(dispatch.messageBuffer.getMessages().filter(message => message.type === 'user'))
        .toMatchObject([{ content: 'Retained input' }]);
    } finally {
      dispatch.stop();
      await dispatch.run;
      vi.useRealTimers();
      random.mockRestore();
    }
  });

  it('cancels paced Home re-preparation without dispatching after silent recovery', async () => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('doc', 'Required instruction');
    a.fail(503);
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    let failed!: () => void;
    let attempts = 0;
    const preparationFailed = new Promise<void>(resolve => { failed = resolve; });
    const dispatch = await startPromptPreparationDispatch(async () => {
      attempts += 1;
      try { return (await resolve({ surface: 'coding', accountEntries: [entry('doc')] })).blocks.join('\n'); }
      catch (error) { failed(); throw error; }
    });
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await preparationFailed;
      await new Promise<void>(resolve => setImmediate(resolve));
      a.fail(200);
      dispatch.stop();
      await dispatch.run;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toBe(1);
      expect(dispatch.runtime.beginTurnLifecycle).not.toHaveBeenCalled();
      expect(dispatch.runtime.sendTurnPrompt).not.toHaveBeenCalled();
      expect(dispatch.observeProviderInputSettlement).not.toHaveBeenCalled();
      expect(dispatch.failures).toEqual([]);
      expect(dispatch.publications).toEqual([]);
    } finally {
      dispatch.stop();
      await dispatch.run;
      vi.useRealTimers();
    }
  });

  it.each(['local', 'published'] as const)('uses the admitted %s route when descriptor HTTPS is unreachable', async carrier => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    const path = join(taskHome, 'settings.json');
    const saved = JSON.parse(await readFile(path, 'utf8'));
    saved.servers.alpha.localServerUrl = a.url;
    saved.servers.alpha.serverUrl = 'https://127.0.0.1:1';
    saved.servers.alpha.homeConnectionDescriptor = { v: 1, homeServerIdentityId: 'srv_alpha',
      canonicalServerUrl: 'https://127.0.0.1:1', revision: 1,
      endpoints: [{ kind: 'https', url: 'https://127.0.0.1:1' }] };
    await writeFile(path, JSON.stringify(saved));
    a.set('doc', 'Admitted route instructions');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    const { resolveCurrentCliHomeTarget } = await import('@/server/homeTarget');
    expect(await resolveCurrentCliHomeTarget()).toMatchObject({ homeServerIdentityId: 'srv_alpha',
      applicationUrl: 'https://127.0.0.1:1' });
    const { publishServerHttpRuntimeOrigin } = await import('@/api/client/serverHttpBaseUrl');
    const release = carrier === 'published' ? publishServerHttpRuntimeOrigin(a.url, 'iroh') : () => {};
    try {
      expect(await resolve({ surface: 'coding', memoryEnabled: false, accountEntries: [entry('doc', a.id)] }))
        .toMatchObject({ blocks: ['Admitted route instructions'], admittedEntries: [{ outcome: 'ready' }] });
      expect(a.requests.filter(path => path === '/v1/artifacts')).toEqual([]);
      expect(a.requests.filter(path => path === '/v1/artifacts/doc')).toHaveLength(1);
      expect(a.requests.filter(path => path === '/v1/artifacts/read')).toHaveLength(1);
    } finally { release(); }
  });
  it('ignores the retired settings-root stack while composing explicit canonical entries', async () => {
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    const readArtifact = async (ref: { artifactId: string }) => ({ id: ref.artifactId,
      header: { v: 1, kind: 'prompt_doc.v2', title: ref.artifactId },
      body: JSON.stringify({ v: 1, markdown: ref.artifactId, createdAtMs: 1, updatedAtMs: 1 }),
      revision: { headerVersion: 1, bodyVersion: 1 } });
    const result = await resolve({ surface: 'coding', readArtifact,
      settings: { promptStacksV1: { v: 1, surfaces: { coding: [entry('retired-root')] } } },
    });
    expect(result.blocks).toEqual([]);
    expect((await resolve({ surface: 'coding', readArtifact, accountEntries: [entry('canonical-row')] })).blocks)
      .toEqual(['canonical-row']);
  });
  it('prepares an empty effective stack without resolving an unavailable Home', async () => {
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    const args = { surface: 'coding' as const, serverId: 'missing-home' };
    expect(await resolve(args)).toEqual({ blocks: [], admittedEntries: [] });
    expect(await resolve({ ...args, accountEntries: [entry('disabled')],
      disabledInheritedEntryIds: ['disabled'] })).toEqual({ blocks: [], admittedEntries: [] });
    expect(await resolve({ ...args, sessionEntries: [{ ...entry('disabled-session'), enabled: false }] }))
      .toEqual({ blocks: [], admittedEntries: [] });
  });

  it('keeps a configured prompt unavailable when its Home cannot be resolved', async () => {
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    const { classifyPrimarySessionRuntimeIssue } = await import('@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue');
    const failure = await resolve({ surface: 'coding', serverId: 'missing-home', accountEntries: [entry('required')] })
      .catch((error: unknown) => error);
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure }))
      .toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
    expect(failure).toMatchObject({ status: 'preparation_pending', reason: 'unavailable' });
    expect(JSON.stringify(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure })))
      .not.toContain('missing-home');
  });

  describe('ordinary Instructions birth admission', () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alpha' })).toString('base64url')}.signature`;
    let a: Awaited<ReturnType<typeof home>>;
    let protocol: typeof import('@happier-dev/protocol');
    let createCliActionDeps: typeof import('@/session/actions/createCliActionDeps')['createCliActionDeps'];
    let createActionSettingsProvider: typeof import('@/settings/actionsSettingsProvider')['createActionSettingsProvider'];
    beforeEach(async () => {
      a = await home('alpha', token);
      await profiles([a]);
      // Configuration consumes the saved Home. Compile/load the real owner as
      // fixture setup, outside the timed network-admission assertion.
      protocol = await import('@happier-dev/protocol');
      ({ createCliActionDeps } = await import('@/session/actions/createCliActionDeps'));
      ({ createActionSettingsProvider } = await import('@/settings/actionsSettingsProvider'));
    });
    it.each(['missing', 'unavailable'] as const)('refuses ordinary selected Instructions %s before a provider spawn', async state => {
    if (state === 'unavailable') { a.set('instructions', 'Required remit'); a.fail(503); }
    // Home's Socket.IO response is the Machine transport boundary. Keep the
    // real target-preparation request and codec before Instructions admission.
    bindApiSessionSocketMock(vi.mocked(io), createApiSessionSocketStub({ emitWithAck: async (event, raw) => {
      if (event !== SOCKET_RPC_EVENTS.CALL || !raw || typeof raw !== 'object'
        || !('method' in raw) || typeof raw.method !== 'string' || !('params' in raw)) throw new Error('Unexpected RPC');
      const content = { mode: 'plain' as const };
      const decoded = await socketRpcCodec.decodeRequestParams(content, raw.params, raw.method);
      let result: unknown;
      if (raw.method === `machine-1:${RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT}`) {
        result = createSessionCreationTargetPreparationRpcResult(SessionCreationTargetPreparationRequestV1Schema.parse(decoded.params));
      } else if (raw.method === `machine-1:${RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE}`) {
        result = { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
          codex: { id: 'codex', title: 'Codex', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
        } } };
      } else if (raw.method === `machine-1:${RPC_METHODS.CAPABILITIES_DETECT}`) {
        result = { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: {
          installed: true, version: '1.2.3', latestVersion: null, update: { supported: false, command: null },
          signIn: { status: 'signedIn', loginSupport: 'unsupported' }, platform: { supported: true },
          install: { available: false, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
        } } } };
      } else throw new Error(`Unexpected Machine RPC ${raw.method}`);
      return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, decoded.callId) };
    } }));
    const { createActionExecutor, SessionSpawnNewInputV2Schema, accountSettingsParse } = protocol;
    const spawn = vi.fn(async () => ({ success: false, error: 'Unexpected spawn' }));
    const executor = createActionExecutor(createCliActionDeps({
      token, credentials: { token, encryption: null }, sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {},
      serverId: a.id, serverHttpBaseUrl: a.url,
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
      sessionSpawnDirectTargetTransport: { machineId: 'machine-1',
        readMachineMetadataSnapshot: () => ({ status: 'ready', metadata: {} }),
        prepare: async () => ({ ok: true, directory: '/repo', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: { spawn, resolveSpawnSessionByNonce: vi.fn(async () => ({ status: 'not_found' as const })) },
      },
    }));
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: `instructions-${state}`,
      executionTarget: { serverId: a.id, machineId: 'machine-1' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      connectedServices: { v: 2, bindingsByServiceId: {} }, promptStack: [entry('instructions', a.id)],
    });
    const result = await executor.execute('session.spawn_new', input, { surface: 'cli', authority: 'present_user', serverId: a.id,
      presentUserConfirmation: { actionId: 'session.spawn_new' }, actionRequestId: `instructions-${state}` });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false,
      errorCode: state === 'unavailable' ? 'preparation_pending' : 'attachment_unavailable' });
    expect(spawn).not.toHaveBeenCalled();
    // Birth resolves the selected qualified document, not the optional catalog listing.
    expect(a.requests, JSON.stringify(a.requests)).toContain('/v1/artifacts/instructions');
    });
  });

  it.each(['owner', 'requester', 'invocation'] as const)('inherits stored UI memory through the daemon Home alias with %s custody', async custody => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alpha' })).toString('base64url')}.signature`;
    const a = await home('stack_agent-qa-orc__id_default', token);
    const foreign = await home('foreign-home', 'foreign-token');
    await profiles([a, foreign]);
    const portableId = 'srv_memory_home';
    const { adoptServerProfileHomeConnectionDescriptor } = await import('@/server/serverProfiles');
    await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: a.id, observation: 'exact', descriptor: {
      v: 1, homeServerIdentityId: portableId, canonicalServerUrl: a.url, revision: 1,
      endpoints: [{ kind: 'https', url: a.url }],
    } });
    a.set('memory', 'unused', 'memory_doc.v1');
    const row = a.rows.get('memory')!;
    a.rows.set('memory', { ...row, body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1,
      index: [{ id: 'e5b7472e-ff36-441e-96a1-8dcff5a0c022', text: 'INHERITED_HOME_MEMORY', createdAtMs: 1, sourceSessionRef: null }], topics: [],
    }) }) });
    foreign.set('memory', 'Foreign private memory', 'memory_doc.v1');
    const credentials = { token, encryption: null, ...(custody === 'requester' ? {
      requesterSessionCredentialScope: { serverId: a.id, serverHttpBaseUrl: a.url },
    } : {}) };
    const { createInvocationSavedSecretOperationContextV1 } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
    const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
    const { accountSettingsParse } = await import('@happier-dev/protocol/account/settings/accountSettings');
    const operationContext = custody === 'invocation' ? createInvocationSavedSecretOperationContextV1({ credentials,
      serverHttpBaseUrl: a.url, snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
      isCurrent: async () => true }) : undefined;
    const { prepareSessionMemoryInheritance } = await import('@/agent/prompting/coding/sessionPromptStack');
    const { resolveCliPromptStackSystemAppendBlocks: resolve, withCliPromptLibraryArtifactReader } = await import('./resolveCliPromptStackSystemAppendBlocks');
    const { SessionPromptStackV1Schema } = await import('@happier-dev/protocol/sessions/context/sessionContextV1');
    const selected = entry('memory', portableId);
    const inherited = await prepareSessionMemoryInheritance({ credentials, serverId: a.id,
      metadata: { work: { memoryEnabled: true, promptStack: SessionPromptStackV1Schema.parse([selected]) } } });
    expect(inherited).toEqual({ memoryEnabled: true, promptStack: [selected] });
    const composed = await resolve({ credentials, serverId: a.id, operationContext, surface: 'coding',
      memoryEnabled: inherited.memoryEnabled, sessionEntries: SessionPromptStackV1Schema.parse(inherited.promptStack) });
    expect(composed.blocks.join('\n')).toContain('INHERITED_HOME_MEMORY');
    // Both directions of the spelling mismatch must keep the captured Account.
    await withCliPromptLibraryArtifactReader(async reader => {
      expect(await reader.readArtifact({ kind: 'doc', artifactId: 'memory', serverId: a.id })).not.toBeNull();
      await expect(reader.readArtifact({ kind: 'doc', artifactId: 'memory', serverId: foreign.id }))
        .rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
    }, { credentials: { ...credentials, requesterSessionCredentialScope: { serverId: portableId, serverHttpBaseUrl: a.url } }, serverId: portableId });
    await expect(prepareSessionMemoryInheritance({ credentials, serverId: a.id,
      metadata: { work: { memoryEnabled: true, promptStack: [entry('memory', foreign.id)] } } }))
      .rejects.toMatchObject({ reason: 'unavailable' });
    expect(foreign.authenticatedRequests).toEqual([]);
  });

  describe('private requester Home admission', () => {
    let bob: Awaited<ReturnType<typeof home>>;
    let alice: Awaited<ReturnType<typeof home>>;
    let withReader: typeof import('./resolveCliPromptStackSystemAppendBlocks').withCliPromptLibraryArtifactReader;
    beforeEach(async () => {
      bob = await home('bob-home', 'bob-token');
      alice = await home('alice-home', 'alice-token');
      await profiles([bob, alice]);
      bob.set('bob-doc', 'Bob current prompt');
      alice.set('alice-doc', 'Alice private prompt');
      // Load Configuration after the saved Homes exist, before the HTTP-only test phase.
      ({ withCliPromptLibraryArtifactReader: withReader } = await import('./resolveCliPromptStackSystemAppendBlocks'));
    });
    it('never borrows a custodian saved Home for a private requester prompt reference', async () => {
      const credentials = { token: 'bob-token', encryption: null,
        requesterSessionCredentialScope: { serverId: bob.id, serverHttpBaseUrl: bob.url } } as const;
      await withReader(async reader => {
        expect(await reader.readArtifact({ kind: 'doc', artifactId: 'bob-doc', serverId: bob.id }))
          .toMatchObject({ body: expect.stringContaining('Bob current prompt') });
        await expect(reader.readArtifact({ kind: 'doc', artifactId: 'alice-doc', serverId: alice.id }))
          .rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
      }, { credentials, serverId: bob.id });
      expect(alice.authenticatedRequests).toEqual([]);
      expect(alice.requests.filter(path => /^\/v[12]\/(?:account|artifacts)(?:\/|$)/.test(path))).toEqual([]);
    });
    it('keeps ordinary private invocation reads in their captured Home and retires cached readers', async () => {
      const { createInvocationSavedSecretOperationContextV1 } = await import('@/settings/secrets/hydrateSavedSecretCatalog');
      const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
      const { accountSettingsParse } = await import('@happier-dev/protocol/account/settings/accountSettings');
      const credentials = { token: 'bob-token', encryption: null };
      let current = true;
      const operationContext = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: bob.url,
        snapshot: { source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
          loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) },
        isCurrent: async () => current });
      await withReader(async reader => {
        expect(await reader.readArtifact({ kind: 'doc', artifactId: 'bob-doc' }))
          .toMatchObject({ body: expect.stringContaining('Bob current prompt') });
        expect(await reader.readArtifact({ kind: 'doc', artifactId: 'bob-doc', serverId: bob.id }))
          .toMatchObject({ body: expect.stringContaining('Bob current prompt') });
        await expect(reader.readArtifact({ kind: 'doc', artifactId: 'alice-doc', serverId: alice.id }))
          .rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
        current = false;
        const previousRequests = [...bob.requests];
        await expect(reader.readArtifact({ kind: 'doc', artifactId: 'bob-doc' }))
          .rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
        expect(bob.requests).toEqual(previousRequests);
      }, { credentials, serverId: bob.id, operationContext });
      expect(alice.authenticatedRequests).toEqual([]);
      // Anonymous canonical Home discovery is allowed; no foreign Account or Artifact read is.
      expect(alice.requests.filter(path => /^\/v[12]\/(?:account|artifacts)(?:\/|$)/.test(path))).toEqual([]);
    });
  });
  describe('admitted inventory', () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'alpha' })).toString('base64url')}.signature`;
    let a: Awaited<ReturnType<typeof home>>;
    let resolve: typeof import('./resolveCliPromptStackSystemAppendBlocks').resolveCliPromptStackSystemAppendBlocks;
    beforeEach(async () => {
      a = await home('alpha', token);
      await profiles([a]);
      a.set('doc', 'first');
      a.set('empty', '');
      // Load Configuration after the real saved Home exists, outside the
      // measured test phase, which contains only actual preparation.
      ({ resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks'));
    });
    it('publishes qualified admission facts with current revisions and valid-empty documents on each preparation', async () => {
      const args = { surface: 'coding' as const, credentials: { token, encryption: null }, memoryEnabled: false,
        accountEntries: [entry('doc'), entry('empty')] };
      const admitted = (id: string, bodyVersion: number, outcome: 'ready' | 'valid-empty') => ({
        entryId: id, layer: 'account', scope: { serverId: a.id, accountId: a.id },
        ref: { kind: 'doc', artifactId: id, serverId: a.id }, revision: { headerVersion: 1, bodyVersion }, outcome,
      });
      expect(await resolve(args)).toEqual({ blocks: ['first'], admittedEntries: [admitted('doc', 1, 'ready'), admitted('empty', 1, 'valid-empty')] });
      a.set('doc', 'second');
      expect(await resolve(args)).toEqual({ blocks: ['second'], admittedEntries: [admitted('doc', 2, 'ready'), admitted('empty', 1, 'valid-empty')] });
      expect(await resolve(args)).toEqual({ blocks: ['second'], admittedEntries: [admitted('doc', 2, 'ready'), admitted('empty', 1, 'valid-empty')] });
      expect(a.requests.filter(path => path === '/v1/artifacts/doc')).toHaveLength(3);
      expect(a.requests.filter(path => path === '/v1/artifacts/read')).toHaveLength(6);
      expect(a.requests.filter(path => path === '/v1/artifacts')).toEqual([]);
    });
  });
  it('reads current edited content on every preparation and shares repeated references only within that preparation', async () => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('doc', 'first');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } =
      await import('./resolveCliPromptStackSystemAppendBlocks');
    const args = { surface: 'coding' as const, accountEntries: [entry('doc'), { ...entry('doc'), id: 'duplicate-ref' }] };
    const started = performance.now();
    expect((await resolve(args)).blocks).toEqual(['first', 'first']);
    const firstPrepared = performance.now();
    a.set('doc', 'second');
    expect((await resolve(args)).blocks).toEqual(['second', 'second']);
    const editedPrepared = performance.now();
    expect((await resolve(args)).blocks).toEqual(['second', 'second']);
    const unchangedPrepared = performance.now();
    expect(a.requests.filter(path => path === '/v1/artifacts/doc')).toHaveLength(3);
    console.info('D11 loopback plaintext preparation', {
      firstMs: firstPrepared - started,
      editedMs: editedPrepared - firstPrepared,
      unchangedMs: unchangedPrepared - editedPrepared,
      detailReads: a.requests.filter(path => path.startsWith('/v1/artifacts/')).length,
      responseBytes: a.responseBytes,
    });
  });
  it('prepares the current unsaved environment Home without admitting an unknown foreign Home', async () => {
    const current = await home('unsaved', 'bound-token');
    // No settings.json is written: a current environment Home need not be a
    // saved profile, and its explicit Account credentials own this preparation.
    vi.stubEnv('HAPPIER_SERVER_URL', current.url);
    current.set('doc', 'unsaved current Home');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } =
      await import('./resolveCliPromptStackSystemAppendBlocks');
    const credentials = { token: 'bound-token', encryption: null };
    expect(await resolve({ surface: 'coding', credentials,
      accountEntries: [entry('doc')],
    })).toMatchObject({ blocks: ['unsaved current Home'] });
    const previousRequests = [...current.requests];
    const { logger } = await import('@/ui/logger');
    const diagnostic = vi.spyOn(logger, 'infoFile');
    const failure = await resolve({ surface: 'coding', credentials, memoryEnabled: false,
      accountEntries: [entry('doc', 'unknown-foreign-home')],
    }).catch((error: unknown) => error);
    const { classifyPrimarySessionRuntimeIssue } = await import('@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue');
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure })).toMatchObject({
      code: 'profile_missing', source: 'dependency_failure',
    });
    expect(diagnostic).toHaveBeenCalledWith('Prompt library read failed', {
      operation: 'header', errorCode: 'profile_missing', httpStatus: null,
      qualifiedHome: true, privateRequester: false,
    });
    diagnostic.mockRestore();
    expect(current.requests).toEqual(previousRequests);
  });
  it.each([true, false])('continues with required local context when an optional saved Home is missing (memory=%s)', async memoryEnabled => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('required', 'Required local instructions');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    const optional = { ...entry('foreign', 'missing-home'), required: false };
    const args = { surface: 'coding' as const, credentials: { token: 'active-token', encryption: null }, memoryEnabled };
    expect(await resolve({ ...args, accountEntries: [optional, entry('required')] })).toMatchObject({
      blocks: ['Required local instructions'],
      admittedEntries: [
        { entryId: 'foreign', outcome: 'unavailable', reason: 'not_found', revision: null },
        { entryId: 'required', outcome: 'ready' },
      ],
    });
    expect(a.requests.some(path => path.includes('foreign'))).toBe(false);
    await expect(resolve({ ...args, accountEntries: [optional, { ...optional, id: 'required-foreign', required: true }] }))
      .rejects.toMatchObject({ reason: 'not_found', cause: { code: 'profile_missing' } });
  });
  it('keeps optional and required context pending during a transient outage and recovers', async () => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('optional', 'Optional local context');
    a.fail(503);
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    await expect(resolve({ surface: 'coding', accountEntries: [{ ...entry('optional'), required: false }] }))
      .rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable',
        admittedEntries: [{ outcome: 'unavailable', reason: 'unavailable' }] });
    await expect(resolve({ surface: 'coding', accountEntries: [entry('optional')] }))
      .rejects.toMatchObject({ status: 'preparation_pending', reason: 'unavailable' });
    a.fail(200);
    expect(await resolve({ surface: 'coding', accountEntries: [{ ...entry('optional'), required: false }] }))
      .toMatchObject({ blocks: ['Optional local context'], admittedEntries: [{ outcome: 'ready' }] });
  });
  it('qualifies identical ids to distinct Homes without forwarding active credentials', async () => {
    const a = await home('alpha', 'active-token');
    const b = await home('bravo', 'other-token');
    await profiles([a, b]);
    a.set('same', 'alpha');
    b.set('same', 'bravo');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } =
      await import('./resolveCliPromptStackSystemAppendBlocks');
    expect(
      await resolve({
        surface: 'coding',
        credentials: { token: 'active-token', encryption: null },
        accountEntries: [entry('same', 'alpha'), entry('same', 'bravo')],
      }),
    ).toMatchObject({ blocks: ['alpha', 'bravo'] });
  });
  it('keeps explicit credentials for a bound non-active Home and saved credentials for another Home', async () => {
    const a = await home('alpha', 'active-token');
    const b = await home('bravo', 'saved-token', { 'bound-token': 'bound Account X', 'saved-token': 'saved Account Y' });
    await profiles([a, b]);
    a.set('same', 'alpha saved Account');
    b.set('same', 'saved Account Y');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    expect(await resolve({ surface: 'coding', serverId: 'bravo',
      credentials: { token: 'bound-token', encryption: null }, accountEntries: [entry('same', 'bravo')],
    })).toMatchObject({ blocks: ['bound Account X'] });
    expect(await resolve({ surface: 'coding', serverId: 'bravo',
      credentials: { token: 'bound-token', encryption: null },
      accountEntries: [entry('same', 'bravo'), entry('same', 'alpha')],
    })).toMatchObject({ blocks: ['bound Account X', 'alpha saved Account'] });
  });
  it('distinguishes retryable unavailability from confirmed absence and recovers', async () => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('doc', 'first');
    const { resolveCliPromptStackSystemAppendBlocks: resolve } =
      await import('./resolveCliPromptStackSystemAppendBlocks');
    const args = { surface: 'coding' as const, accountEntries: [entry('doc')] };
    const { logger } = await import('@/ui/logger');
    const diagnostic = vi.spyOn(logger, 'infoFile');
    a.fail(503);
    await expect(resolve(args)).rejects.toMatchObject({
      status: 'preparation_pending',
      reason: 'unavailable',
    });
    expect(diagnostic).toHaveBeenCalledWith('Prompt library read failed', {
      operation: 'artifact', errorCode: 'artifact_read_unavailable', httpStatus: 503,
      qualifiedHome: false, privateRequester: false,
    });
    logger.flushSync();
    const evidence = (await readFile(logger.getLogPath(), 'utf8')).split('\n')
      .find(line => line.includes('Prompt library read failed'));
    expect(evidence).toMatch(/"httpStatus"\s*:\s*503/u);
    expect(evidence).not.toContain('active-token');
    expect(evidence).not.toContain(a.url);
    diagnostic.mockRestore();
    a.fail(404);
    await expect(resolve(args)).rejects.toMatchObject({
      status: 'attachment_unavailable',
      reason: 'not_found',
    });
    a.fail(200);
    expect((await resolve(args)).blocks).toEqual(['first']);
  });
  it('reads only the selected header and suppresses memory without opening its body', async () => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    a.set('memory', 'must not load', 'memory_doc.v1');
    for (let index = 0; index < 500; index++)
      a.set(`z-other-${index}`, 'never load');
    // A header-only decision must not open the selected body or unrelated headers.
    const memory = a.rows.get('memory')!;
    a.rows.set('memory', { ...memory, body: 'unreadable-body-envelope' });
    const unrelated = a.rows.get('z-other-0')!;
    a.rows.set('z-other-0', { ...unrelated, header: 'unreadable-header-envelope', encryptionMode: 'e2ee' });
    const { resolveCliPromptStackSystemAppendBlocks: resolve } =
      await import('./resolveCliPromptStackSystemAppendBlocks');
    expect(
      await resolve({
        surface: 'coding',
        accountEntries: [entry('memory')],
        memoryEnabled: false,
      }),
    ).toEqual({ blocks: [], admittedEntries: [] });
    expect(a.requests.filter(path => path === '/v1/artifacts')).toEqual([]);
    expect(a.requests.filter(path => path.startsWith('/v1/artifacts/'))).toEqual(['/v1/artifacts/read']);
    const priorRequests = a.requests.length;
    a.set('memory', 'Current instructions');
    expect((await resolve({ surface: 'coding', accountEntries: [entry('memory')], memoryEnabled: false })).blocks)
      .toEqual(['Current instructions']);
    expect(a.requests.slice(priorRequests).filter(path => path === '/v1/artifacts')).toEqual([]);
    expect(a.requests.slice(priorRequests).filter(path => path.startsWith('/v1/artifacts/')))
      .toEqual(['/v1/artifacts/read', '/v1/artifacts/memory']);
  });
  it('skips disabled inherited selections before Account HTTP', async () => {
    const a = await home('alpha', 'active-token');
    await profiles([a]);
    const { resolveCliPromptStackSystemAppendBlocks: resolve } =
      await import('./resolveCliPromptStackSystemAppendBlocks');
    expect(
      await resolve({
        surface: 'coding',
        accountEntries: [entry('missing')],
        disabledInheritedEntryIds: ['missing'],
      }),
    ).toEqual({ blocks: [], admittedEntries: [] });
    expect(a.authenticatedRequests).toEqual([]);
    expect(a.requests.filter(path => /^\/v[12]\/(?:account|artifacts)(?:\/|$)/.test(path))).toEqual([]);
  });
  it('does not load a body when the current header is unreadable', async () => {
    const a = await home('alpha', 'active-token'); await profiles([a]); a.set('doc', 'must not load');
    const row = a.rows.get('doc')!; a.rows.set('doc', { ...row, header: encodePlainArtifactStoredContent({}) });
    const { resolveCliPromptStackSystemAppendBlocks: resolve } = await import('./resolveCliPromptStackSystemAppendBlocks');
    await expect(resolve({ surface: 'coding', accountEntries: [entry('doc')], memoryEnabled: false }))
      .rejects.toMatchObject({ status: 'attachment_unavailable', reason: 'locked' });
    expect(a.requests.filter(path => path === '/v1/artifacts')).toEqual([]);
    expect(a.requests.filter(path => path.startsWith('/v1/artifacts/'))).toEqual(['/v1/artifacts/read']);
  });
});
