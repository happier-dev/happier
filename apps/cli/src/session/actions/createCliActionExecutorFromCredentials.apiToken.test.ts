import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import fastify from 'fastify';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1 } from '@happier-dev/protocol';

import { configuration, reloadConfiguration } from '@/configuration';
import { registerDaemonExternalActionRoute } from '@/daemon/externalActions/registerDaemonExternalActionRoute';

const {
  createCliActionExecutor,
  ensureCliActionPolicySettings,
  fetchSessionById,
  fetchSessionsPage,
  importHistoricalSessionTranscript,
  lookupSessionsByTags,
  readSettings,
  requestDaemonSignedRootActionExecution,
  resolveCurrentAccountMachineTarget,
} = vi.hoisted(() => ({
  createCliActionExecutor: vi.fn(),
  ensureCliActionPolicySettings: vi.fn(),
  fetchSessionById: vi.fn(),
  fetchSessionsPage: vi.fn(),
  importHistoricalSessionTranscript: vi.fn(),
  lookupSessionsByTags: vi.fn(),
  readSettings: vi.fn(),
  requestDaemonSignedRootActionExecution: vi.fn(),
  resolveCurrentAccountMachineTarget: vi.fn(),
}));

vi.mock('./createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

vi.mock('./ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
  fetchSessionsPage,
  importHistoricalSessionTranscript,
  lookupSessionsByTags,
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readSettings,
}));

vi.mock('@/api/machine/resolveCurrentAccountMachineTarget', () => ({
  resolveCurrentAccountMachineTarget,
}));

vi.mock('@/daemon/controlClient', () => ({
  requestDaemonSignedRootActionExecution,
}));

const exactSessionId = 'c123456789012345678901234';
type MockActionResponse = Readonly<{
  statusCode: number;
  body: Readonly<Record<string, unknown>>;
}>;
type FetchLike = (input: URL, init?: RequestInit) => MockActionResponse;

let patActionServer: Server | null = null;
let patActionEndpoint: string | null = null;
let patActionFetch: FetchLike | null = null;
let originalServerUrl: string | undefined;
let originalWebappUrl: string | undefined;

function installPatActionTransportMock(fetch: FetchLike): void {
  patActionFetch = fetch;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return body;
}

function requestHeaders(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(Object.entries(request.headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    return [[name, Array.isArray(value) ? value.join(', ') : value]];
  }));
}

async function handlePatActionRequest(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
  const fetch = patActionFetch;
  const endpoint = patActionEndpoint;
  if (fetch === null || endpoint === null) {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'test_action_transport_unavailable' }));
    return;
  }
  try {
    const result = fetch(new URL(request.url ?? '/', endpoint), {
      method: request.method,
      headers: requestHeaders(request),
      body: await readRequestBody(request),
    });
    response.writeHead(result.statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result.body));
  } catch (error) {
    request.socket.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

function sessionListItem(id: string, tag?: string) {
  return {
    id,
    createdAt: 1,
    updatedAt: 2,
    active: true,
    activeAt: 2,
    share: null,
    encryption: null,
    ...(tag ? { tag } : {}),
  };
}

function apiSuccess(actionId: string, result: unknown): MockActionResponse {
  return {
    statusCode: 200,
    body: { v: 1, actionId, execution: { ok: true, result } },
  };
}

function apiFailure(actionId: string, errorCode: string, details?: unknown): MockActionResponse {
  return {
    statusCode: 200,
    body: {
      v: 1,
      actionId,
      execution: {
        ok: false,
        errorCode,
        error: errorCode,
        ...(details === undefined ? {} : { details }),
      },
    },
  };
}

describe('createCliActionExecutorFromCredentials API Token transport', () => {
  beforeAll(async () => {
    patActionServer = createServer((request, response) => {
      void handlePatActionRequest(request, response);
    });
    await new Promise<void>((resolve) => patActionServer?.listen(0, '127.0.0.1', () => resolve()));
    const address = patActionServer.address();
    if (address === null || typeof address === 'string') throw new Error('Expected PAT Action test endpoint.');
    patActionEndpoint = `http://127.0.0.1:${address.port}`;
    originalServerUrl = process.env.HAPPIER_SERVER_URL;
    originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    process.env.HAPPIER_SERVER_URL = patActionEndpoint;
    process.env.HAPPIER_WEBAPP_URL = patActionEndpoint;
    reloadConfiguration();
  });

  afterAll(async () => {
    patActionFetch = null;
    const server = patActionServer;
    patActionServer = null;
    patActionEndpoint = null;
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = originalServerUrl;
    if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
    else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
    reloadConfiguration();
  });

  beforeEach(() => {
    createCliActionExecutor.mockReset();
    createCliActionExecutor.mockReturnValue({
      prepare: vi.fn(),
      execute: vi.fn(async () => ({ ok: false, errorCode: 'local_executor_used', error: 'local_executor_used' })),
    });
    ensureCliActionPolicySettings.mockReset();
    fetchSessionById.mockReset();
    fetchSessionsPage.mockReset();
    importHistoricalSessionTranscript.mockReset();
    lookupSessionsByTags.mockReset();
    readSettings.mockReset();
    requestDaemonSignedRootActionExecution.mockReset();
    resolveCurrentAccountMachineTarget.mockReset();
    readSettings.mockResolvedValue({ machineId: 'machine-selected' });
    const legacySessionRouteUsed = () => Promise.reject(new Error('legacy_session_route_used'));
    fetchSessionById.mockImplementation(legacySessionRouteUsed);
    fetchSessionsPage.mockImplementation(legacySessionRouteUsed);
    lookupSessionsByTags.mockImplementation(legacySessionRouteUsed);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    patActionFetch = null;
  });

  it('composes Account-server-owned Actions into the executor used by the daemon ingress', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: { tokens: [] },
    });
    onTestFinished(() => post.mockRestore());
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');

    createCliActionExecutorFromCredentials({
      credentials: {
        token: 'signed-daemon-account-token',
        encryption: null,
        credentialProvenance: 'stored_session',
      },
    });

    const accountApiTokensListAction = createCliActionExecutor.mock.calls.at(-1)?.[0]
      ?.accountServerActionDeps?.accountApiTokensListAction;
    expect(accountApiTokensListAction).toEqual(expect.any(Function));
    await expect(accountApiTokensListAction?.({
      input: {},
      context: { surface: 'api', authority: 'account_automation' },
    })).resolves.toEqual({ tokens: [] });
    expect(post).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`${ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1}$`)),
      {},
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer signed-daemon-account-token',
        }),
      }),
    );
  });

  it('routes only attested stored-session root clients through signed daemon control', async () => {
    requestDaemonSignedRootActionExecution.mockResolvedValue({
      ok: true,
      result: { machines: [] },
    });
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'signed-daemon-account-token',
        encryption: null,
        credentialProvenance: 'stored_session',
      },
      machineId: 'machine-local',
      externalActionClient: true,
    });

    await expect(executor.execute(
      'machines.list',
      { limit: 10 },
      { surface: 'api', authority: 'account_automation', actionRequestId: 'request-signed' },
    )).resolves.toEqual({ ok: true, result: { machines: [] } });

    expect(requestDaemonSignedRootActionExecution).toHaveBeenCalledWith({
      actionId: 'machines.list',
      input: { limit: 10 },
      targetMachineId: 'machine-local',
      actionRequestId: 'request-signed',
    }, {});
  });

  it('keeps an API Token on public HTTP even when a caller supplies a non-CLI surface', async () => {
    const fetch = vi.fn<FetchLike>(() => apiSuccess('action.spec.search', {
      actionSpecs: [],
    }));
    installPatActionTransportMock(fetch);
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
      externalActionClient: true,
    });

    await expect(executor.execute(
      'action.spec.search',
      { limit: 10 },
      { surface: 'api', authority: 'present_user' },
    )).resolves.toEqual({
      ok: true,
      result: { actionSpecs: [] },
    });

    expect(requestDaemonSignedRootActionExecution).not.toHaveBeenCalled();
    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('passes an exact full Session id directly to the PAT Action route without a lookup request', async () => {
    const fetch = vi.fn<FetchLike>(() => apiSuccess('session.status.get', {
      session: { id: exactSessionId, active: true },
    }));
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: exactSessionId },
      { surface: 'cli', actionRequestId: 'request-1' },
    )).resolves.toEqual({
      ok: true,
      result: { session: { id: exactSessionId, active: true } },
    });

    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
    expect(lookupSessionsByTags).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe(new URL('v1/actions/session.status.get', configuration.apiServerUrl).toString());
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer hap_v1_token_secret' }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      v: 1,
      requestId: 'request-1',
      target: { kind: 'session', sessionId: exactSessionId },
      input: { sessionId: exactSessionId },
    });
  });

  it('routes persisted transcript reads for an exact inactive Session through the selected machine', async () => {
    resolveCurrentAccountMachineTarget.mockResolvedValue({
      kind: 'selected',
      target: { machineId: 'machine-remote', machineLabel: 'machine-remote' },
    });
    const fetch = vi.fn<FetchLike>(() => apiSuccess('session.transcript.get', {
      ok: true,
      sessionId: exactSessionId,
      items: [],
      nextCursor: null,
      hasMore: false,
      diagnostics: {
        rawRowsScanned: 0,
        pagesFetched: 1,
        scanLimitReached: false,
        payloadTruncations: 0,
      },
    }));
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
      machineId: 'machine-remote',
    });

    await expect(executor.execute(
      'session.transcript.get',
      { sessionId: exactSessionId, limit: 10 },
      { surface: 'cli', defaultSessionId: null },
    )).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(resolveCurrentAccountMachineTarget).toHaveBeenCalledWith({
      token: 'hap_v1_token_secret',
      requestedMachineId: 'machine-remote',
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      target: { kind: 'machine', machineId: 'machine-remote' },
      input: { sessionId: exactSessionId, limit: 10 },
    });
  });

  it('uses the sole current account machine when a PAT has no daemon-local target', async () => {
    readSettings.mockResolvedValue({});
    resolveCurrentAccountMachineTarget.mockResolvedValue({
      kind: 'selected',
      target: { machineId: 'machine-remote', machineLabel: 'machine-remote' },
    });
    const fetch = vi.fn<FetchLike>(() => apiSuccess('session.list', {
      sessions: [],
      nextCursor: null,
      hasNext: false,
    }));
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute('session.list', { limit: 1 }, { surface: 'cli' })).resolves.toEqual({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
    expect(resolveCurrentAccountMachineTarget).toHaveBeenCalledWith({ token: 'hap_v1_token_secret' });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      target: { kind: 'machine', machineId: 'machine-remote' },
      input: { limit: 1 },
    });
  });

  it('omits the target for a direct daemon Action endpoint without Account machine discovery', async () => {
    readSettings.mockResolvedValue({});
    resolveCurrentAccountMachineTarget.mockRejectedValue(new Error('account_machine_inventory_unavailable'));
    const receivedTargets: unknown[] = [];
    const app = fastify();
    registerDaemonExternalActionRoute(app, {
      currentMachineId: 'machine-daemon-local',
      currentServerId: 'server-daemon-local',
      verifyPat: async () => ({
        ok: true as const,
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        expiresAt: null,
        authority: 'account_automation' as const,
      }),
      executor: {
        execute: async () => ({
          ok: true as const,
          result: { sessions: [], nextCursor: null, hasNext: false },
        }),
      },
      resolveTarget: async ({ target, currentMachineId }) => {
        receivedTargets.push(target);
        return target ?? { kind: 'machine', machineId: currentMachineId };
      },
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-direct-action-endpoint-'));
    const originalHomeDir = process.env.HAPPIER_HOME_DIR;
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    try {
      const port = Number(new URL(address).port);
      await mkdir(join(homeDir, 'servers', 'cloud'), { recursive: true });
      await writeFile(join(homeDir, 'servers', 'cloud', 'daemon.state.json'), JSON.stringify({
        pid: process.pid,
        httpPort: port,
        startedAt: Date.now(),
        startedWithCliVersion: 'test',
        machineId: 'machine-daemon-local',
      }), 'utf8');
      process.env.HAPPIER_HOME_DIR = homeDir;
      process.env.HAPPIER_SERVER_URL = address;
      process.env.HAPPIER_WEBAPP_URL = address;
      reloadConfiguration();
      vi.unstubAllGlobals();

      const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
      const executor = createCliActionExecutorFromCredentials({
        credentials: {
          token: 'hap_v1_token_secret',
          encryption: null,
          credentialProvenance: 'api_token',
        },
      });

      await expect(executor.execute('session.list', { limit: 1 }, { surface: 'cli' })).resolves.toEqual({
        ok: true,
        result: { sessions: [], nextCursor: null, hasNext: false },
      });
      expect(resolveCurrentAccountMachineTarget).not.toHaveBeenCalled();
      expect(receivedTargets).toEqual([undefined]);
    } finally {
      await app.close();
      await rm(homeDir, { recursive: true, force: true });
      if (originalHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = originalHomeDir;
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('keeps Account machine targeting for an unclaimed loopback Action endpoint', async () => {
    readSettings.mockResolvedValue({});
    resolveCurrentAccountMachineTarget.mockResolvedValue({
      kind: 'selected',
      target: { machineId: 'machine-account-server', machineLabel: 'machine-account-server' },
    });
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-account-action-endpoint-'));
    const originalHomeDir = process.env.HAPPIER_HOME_DIR;
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    try {
      process.env.HAPPIER_HOME_DIR = homeDir;
      if (patActionEndpoint === null) throw new Error('Expected PAT Action test endpoint.');
      process.env.HAPPIER_SERVER_URL = patActionEndpoint;
      process.env.HAPPIER_WEBAPP_URL = patActionEndpoint;
      reloadConfiguration();
      const fetch = vi.fn<FetchLike>(() => apiSuccess('session.list', {
        sessions: [],
        nextCursor: null,
        hasNext: false,
      }));
      installPatActionTransportMock(fetch);

      const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
      const executor = createCliActionExecutorFromCredentials({
        credentials: {
          token: 'hap_v1_token_secret',
          encryption: null,
          credentialProvenance: 'api_token',
        },
      });

      await expect(executor.execute('session.list', { limit: 1 }, { surface: 'cli' })).resolves.toEqual({
        ok: true,
        result: { sessions: [], nextCursor: null, hasNext: false },
      });
      expect(resolveCurrentAccountMachineTarget).toHaveBeenCalledWith({ token: 'hap_v1_token_secret' });
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
        v: 1,
        target: { kind: 'machine', machineId: 'machine-account-server' },
        input: { limit: 1 },
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      if (originalHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
      else process.env.HAPPIER_HOME_DIR = originalHomeDir;
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it('returns selector candidates before transport when multiple PAT machines are current', async () => {
    readSettings.mockResolvedValue({});
    resolveCurrentAccountMachineTarget.mockResolvedValue({
      kind: 'selection_required',
      candidates: [
        { machineId: 'machine-a', machineLabel: 'machine-a' },
        { machineId: 'machine-b', machineLabel: 'machine-b' },
      ],
    });
    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute('session.list', { limit: 1 }, { surface: 'cli' })).resolves.toEqual({
      ok: false,
      errorCode: 'machine_selection_required',
      error: 'machine_selection_required',
      details: { candidates: ['machine-a', 'machine-b'] },
    });
  });

  it.each([
    ['tag', 'active-work'],
    ['prefix', exactSessionId.slice(0, 12)],
  ] as const)('resolves a unique Session %s through the PAT-authorized session.list Action before invoking the target Action', async (_kind, selector) => {
    const fetch = vi.fn<FetchLike>((input) => {
      const url = String(input);
      if (url.endsWith('/v1/actions/session.list')) {
        return apiSuccess('session.list', {
          sessions: [sessionListItem(exactSessionId, 'active-work')],
          nextCursor: null,
          hasNext: false,
        });
      }
      return apiSuccess('session.status.get', {
        session: { id: exactSessionId, active: true },
      });
    });
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: selector },
      { surface: 'cli' },
    )).resolves.toEqual({
      ok: true,
      result: { session: { id: exactSessionId, active: true } },
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      new URL('v1/actions/session.list', configuration.apiServerUrl).toString(),
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      target: { kind: 'machine', machineId: 'machine-selected' },
      input: { limit: 200, archivedOnly: false },
    });
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      new URL('v1/actions/session.list', configuration.apiServerUrl).toString(),
    );
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      v: 1,
      target: { kind: 'machine', machineId: 'machine-selected' },
      input: { limit: 200, archivedOnly: true },
    });
    expect(String(fetch.mock.calls[2]?.[0])).toBe(
      new URL('v1/actions/session.status.get', configuration.apiServerUrl).toString(),
    );
    expect(resolveCurrentAccountMachineTarget).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
    expect(lookupSessionsByTags).not.toHaveBeenCalled();
  });

  it('resolves a PAT Session selector and starts a delegate through public Actions without legacy bootstrap', async () => {
    resolveCurrentAccountMachineTarget.mockResolvedValue({
      kind: 'selected',
      target: { kind: 'machine', machineId: 'machine-selected' },
    });
    const fetch = vi.fn<FetchLike>((input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname.endsWith('/v1/actions/session.list')) {
        return apiSuccess('session.list', {
          sessions: [sessionListItem(exactSessionId, 'active-work')],
          nextCursor: null,
          hasNext: false,
        });
      }
      if (pathname.endsWith('/v1/actions/action.options.resolve')) {
        return apiSuccess('action.options.resolve', {
          actionId: 'subagents.delegate.start',
          fieldPath: 'backendTargetKeys',
          optionsSourceId: 'execution.backends.enabled',
          options: [{ value: 'agent:com.acme.agent/acme', label: 'Acme Agent' }],
        });
      }
      if (pathname.endsWith('/v1/actions/subagents.delegate.start')) {
        return apiSuccess('subagents.delegate.start', {
          results: [{ key: 'agent:com.acme.agent/acme' }],
        });
      }
      throw new Error(`Unexpected public Action path: ${pathname}`);
    });
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
      machineId: 'machine-selected',
    });

    const target = await executor.resolveSessionTarget('active-work');
    expect(target).toEqual({ ok: true, sessionId: exactSessionId });
    if (!target.ok) throw new Error('Expected an exact Session target');

    await expect(executor.execute(
      'action.options.resolve',
      {
        actionId: 'subagents.delegate.start',
        fieldPath: 'backendTargetKeys',
        optionsSourceId: 'execution.backends.enabled',
        sessionId: target.sessionId,
        includeDisabled: true,
      },
      { surface: 'cli', defaultSessionId: target.sessionId },
    )).resolves.toEqual({
      ok: true,
      result: {
        actionId: 'subagents.delegate.start',
        fieldPath: 'backendTargetKeys',
        optionsSourceId: 'execution.backends.enabled',
        options: [{ value: 'agent:com.acme.agent/acme', label: 'Acme Agent' }],
      },
    });
    await expect(executor.execute(
      'subagents.delegate.start',
      {
        backendTargetKeys: ['agent:com.acme.agent/acme'],
        instructions: 'Delegate.',
      },
      { surface: 'cli', defaultSessionId: target.sessionId },
    )).resolves.toEqual({
      ok: true,
      result: { results: [{ key: 'agent:com.acme.agent/acme' }] },
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/v1/actions/session.list',
      '/v1/actions/session.list',
      '/v1/actions/action.options.resolve',
      '/v1/actions/subagents.delegate.start',
    ]);
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      v: 1,
      target: { kind: 'machine', machineId: 'machine-selected' },
      input: {
        actionId: 'subagents.delegate.start',
        fieldPath: 'backendTargetKeys',
        optionsSourceId: 'execution.backends.enabled',
        sessionId: exactSessionId,
        includeDisabled: true,
      },
    });
    expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body))).toEqual({
      v: 1,
      requestId: expect.any(String),
      target: { kind: 'machine', machineId: 'machine-selected' },
      input: {
        sessionId: exactSessionId,
        backendTargetKeys: ['agent:com.acme.agent/acme'],
        instructions: 'Delegate.',
      },
    });
    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
    expect(fetchSessionById).not.toHaveBeenCalled();
    expect(fetchSessionsPage).not.toHaveBeenCalled();
    expect(lookupSessionsByTags).not.toHaveBeenCalled();
  });

  it.each([
    'subagents.plan.start',
    'voice_agent.start',
  ] as const)('binds the selected machine and exact parent Session for PAT-backed %s', async (actionId) => {
    const fetch = vi.fn<FetchLike>(() => apiSuccess(actionId, { results: [] }));
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
      machineId: 'machine-selected',
    });

    await expect(executor.execute(
      actionId,
      {
        backendTargetKeys: ['agent:com.acme.agent/acme'],
        instructions: 'Start.',
      },
      { surface: 'cli', defaultSessionId: exactSessionId },
    )).resolves.toEqual({ ok: true, result: { results: [] } });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      requestId: expect.any(String),
      target: { kind: 'machine', machineId: 'machine-selected' },
      input: {
        sessionId: exactSessionId,
        backendTargetKeys: ['agent:com.acme.agent/acme'],
        instructions: 'Start.',
      },
    });
    expect(resolveCurrentAccountMachineTarget).not.toHaveBeenCalled();
    expect(createCliActionExecutor).not.toHaveBeenCalled();
  });

  it('rejects a PAT session-list result that does not satisfy the canonical Session list schema', async () => {
    const fetch = vi.fn<FetchLike>(() => apiSuccess('session.list', {
      sessions: [{ id: exactSessionId, tag: 'active-work' }],
      nextCursor: null,
      hasNext: false,
    }));
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: 'active-work' },
      { surface: 'cli' },
    )).rejects.toThrow('invalid_session_list_result');
  });

  it.each([
    ['tag', 'active-work'],
    ['prefix', exactSessionId.slice(0, 12)],
  ] as const)('admits a PAT and resolves a unique Session %s through the real daemon Action route', async (_kind, selector) => {
    const execute = vi.fn(async (actionId: string) => actionId === 'session.list'
      ? {
          ok: true as const,
          result: {
            sessions: [sessionListItem(exactSessionId, 'active-work')],
            nextCursor: null,
            hasNext: false,
          },
        }
      : {
          ok: true as const,
          result: { session: { id: exactSessionId, active: true } },
        });
    const verifyPat = vi.fn(async () => ({
      ok: true as const,
      accountId: 'account-1',
      principalId: 'principal-1',
      credentialId: 'credential-1',
      expiresAt: null,
      authority: 'account_automation' as const,
    }));
    const app = fastify();
    registerDaemonExternalActionRoute(app, {
      currentMachineId: 'machine-selected',
      currentServerId: 'server-selected',
      verifyPat,
      executor: { execute },
      resolveTarget: async ({ target }) => target ?? null,
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const originalServerUrl = process.env.HAPPIER_SERVER_URL;
    const originalWebappUrl = process.env.HAPPIER_WEBAPP_URL;
    process.env.HAPPIER_SERVER_URL = address;
    process.env.HAPPIER_WEBAPP_URL = address;
    reloadConfiguration();
    try {
      vi.unstubAllGlobals();
      const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
      const executor = createCliActionExecutorFromCredentials({
        credentials: {
          token: 'hap_v1_token_secret',
          encryption: null,
          credentialProvenance: 'api_token',
        },
      });

      await expect(executor.execute(
        'session.status.get',
        { sessionId: selector },
        { surface: 'cli' },
      )).resolves.toEqual({
        ok: true,
        result: { session: { id: exactSessionId, active: true } },
      });

      expect(verifyPat).toHaveBeenCalledTimes(3);
      expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual([
        'session.list',
        'session.list',
        'session.status.get',
      ]);
      expect(fetchSessionById).not.toHaveBeenCalled();
      expect(fetchSessionsPage).not.toHaveBeenCalled();
      expect(lookupSessionsByTags).not.toHaveBeenCalled();
    } finally {
      await app.close();
      if (originalServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
      else process.env.HAPPIER_SERVER_URL = originalServerUrl;
      if (originalWebappUrl === undefined) delete process.env.HAPPIER_WEBAPP_URL;
      else process.env.HAPPIER_WEBAPP_URL = originalWebappUrl;
      reloadConfiguration();
    }
  });

  it.each([
    ['session_id_ambiguous', [
      { id: exactSessionId, tag: 'shared' },
      { id: 'c223456789012345678901234', tag: 'shared' },
    ]],
    ['session_not_found', []],
  ] as const)('preserves the typed %s selector result without invoking the target Action', async (errorCode, sessions) => {
    const fetch = vi.fn<FetchLike>(() => apiSuccess('session.list', {
      sessions: sessions.map((session) => sessionListItem(session.id, session.tag)),
      nextCursor: null,
      hasNext: false,
    }));
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: errorCode === 'session_id_ambiguous' ? 'shared' : 'missing' },
      { surface: 'cli' },
    )).resolves.toEqual({
      ok: true,
      result: {
        ok: false,
        errorCode,
        error: errorCode,
        ...(errorCode === 'session_id_ambiguous'
          ? { candidates: sessions.map((session) => session.id) }
          : {}),
      },
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/v1/actions/session.list'))).toBe(true);
  });

  it('defers PAT Action execution until its prepared invocation runs', async () => {
    const fetch = vi.fn<FetchLike>(() => apiSuccess('session.status.get', {
      session: { id: exactSessionId, active: true },
    }));
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    const prepared = await executor.prepare(
      'session.status.get',
      { sessionId: exactSessionId },
      { surface: 'cli' },
    );

    expect(prepared.kind).toBe('ready');
    expect(fetch).not.toHaveBeenCalled();
    if (prepared.kind !== 'ready') throw new Error('Expected a runnable public Action invocation');

    const firstRun = prepared.invocation.run();
    expect(prepared.invocation.run()).toBe(firstRun);
    await expect(firstRun).resolves.toEqual({
      ok: true,
      result: { session: { id: exactSessionId, active: true } },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(createCliActionExecutor).not.toHaveBeenCalled();
  });

  it('projects an API Action failure without falling back to the local executor', async () => {
    const fetch = vi.fn<FetchLike>(() => apiFailure('session.status.get', 'target_unavailable', {
      retryAfterMs: 50,
    }));
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: exactSessionId },
      { surface: 'cli' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'target_unavailable',
      error: 'target_unavailable',
      details: { retryAfterMs: 50 },
    });

    expect(createCliActionExecutor).not.toHaveBeenCalled();
  });

  it('rejects a non-public PAT Action before any local or HTTP execution', async () => {
    const fetch = vi.fn<FetchLike>();
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.handoff.commit',
      {},
      { surface: 'mcp' },
    )).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported',
      error: 'unsupported',
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
  });

  it('routes PAT-backed MCP Session Actions through the external adapter without local E2EE access', async () => {
    const fetch = vi.fn<FetchLike>((input) => String(input).endsWith('/v1/actions/session.list')
      ? apiSuccess('session.list', {
          sessions: [sessionListItem(exactSessionId, 'active-work')],
          nextCursor: null,
          hasNext: false,
        })
      : apiSuccess('session.status.get', {
          session: { id: exactSessionId, active: false },
        }));
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: 'active-work' },
      { surface: 'mcp', defaultSessionId: 'active-work' },
    )).resolves.toEqual({
      ok: true,
      result: { session: { id: exactSessionId, active: false } },
    });

    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({
      v: 1,
      target: { kind: 'session', sessionId: exactSessionId },
      input: { sessionId: exactSessionId },
    });
  });

  it('projects PAT Session creation through the canonical public spawn binding', async () => {
    const fetch = vi.fn<FetchLike>(() => apiSuccess('session.spawn_new', {
      type: 'success',
      sessionId: exactSessionId,
    }));
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.spawn_new',
      {
        creationKey: 'manual:pat-spawn-1',
        executionTarget: { serverId: 'daemon-profile-only', machineId: 'machine-selected' },
        directory: '/workspace/pat-project',
        organizationPlacement: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
      { surface: 'cli' },
    )).resolves.toEqual({
      ok: true,
      result: { type: 'success', sessionId: exactSessionId },
    });

    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      requestId: expect.any(String),
      target: { kind: 'machine', machineId: 'machine-selected' },
      input: {
        creationKey: 'manual:pat-spawn-1',
        directory: '/workspace/pat-project',
        organizationPlacement: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
    });
  });

  it('surfaces transport failure instead of retrying through a local executor', async () => {
    const fetch = vi.fn<FetchLike>(() => {
      throw new Error('network unreachable');
    });
    installPatActionTransportMock(fetch);

    const { createCliActionExecutorFromCredentials } = await import('./createCliActionExecutorFromCredentials');
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: 'hap_v1_token_secret',
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: 'active-work' },
      { surface: 'cli' },
    )).rejects.toThrow('Could not reach the Happier API.');

    expect(createCliActionExecutor).not.toHaveBeenCalled();
  });
});
