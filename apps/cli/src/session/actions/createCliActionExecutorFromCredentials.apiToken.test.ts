import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import axios from 'axios';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';
import fastify from 'fastify';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_TOKEN_FULL_GRANT_V1, ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, FeaturesResponseSchema, accountSettingsParse, normalizeActionsSettingsV1, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { projectSessionSummaryV1, SessionStatusActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';

import { configuration, reloadConfiguration } from '@/configuration';
import { registerDaemonExternalActionRoute } from '@/daemon/externalActions/registerDaemonExternalActionRoute';
import { installDaemonMachineAdmissionTransport } from '@/daemon/machineAdmissionTransport';
import { SIGNED_ROOT_ACTION_EXECUTE_PATH } from '@/daemon/externalActions/signedRootActionControl';
import { createAccountEncryptionCurrentnessFixture, createCurrentSessionProjectionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { encodeBase64, encryptLegacy } from '@/api/encryption';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { DiscussionSecondOpinionPreviewV1Schema } from '@happier-dev/protocol/discussions/secondOpinion';
import { DiscussionInviteInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';

const {
  createCliActionExecutor,
  ensureCliActionPolicySettings,
  fetchSessionById,
  fetchSessionsPage,
  importHistoricalSessionTranscript,
  lookupSessionsByTags,
  readSettings,
  daemonPost,
  resolveCurrentAccountMachineTarget,
  resolveLiveDaemonControlTargetForServer,
} = vi.hoisted(() => ({
  createCliActionExecutor: vi.fn(),
  ensureCliActionPolicySettings: vi.fn(),
  fetchSessionById: vi.fn(),
  fetchSessionsPage: vi.fn(),
  importHistoricalSessionTranscript: vi.fn(),
  lookupSessionsByTags: vi.fn(),
  readSettings: vi.fn(),
  daemonPost: vi.fn(),
  resolveCurrentAccountMachineTarget: vi.fn(),
  resolveLiveDaemonControlTargetForServer: vi.fn(),
}));

vi.mock('./createCliActionExecutor', () => ({
  createCliActionExecutor,
}));

vi.mock('./ensureCliActionPolicySettings', () => ({
  ensureCliActionPolicySettings,
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById,
  fetchSessionsPage,
  importHistoricalSessionTranscript,
  lookupSessionsByTags,
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readSettings,
}));

vi.mock('@/api/machine/resolveCurrentAccountMachineTarget', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/machine/resolveCurrentAccountMachineTarget')>(),
  resolveCurrentAccountMachineTarget,
}));

// Keep daemon control parsing and publication inspection real beneath the HTTP boundary.
vi.mock('@/daemon/controlHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/controlHttp')>(),
  daemonPost,
}));

vi.mock('@/daemon/multiDaemon', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/multiDaemon')>(),
  resolveLiveDaemonControlTargetForServer,
}));

const SYNTHETIC_API_TOKEN = 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43);
const exactSessionId = 'c123456789012345678901234';

function syntheticAccountToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: accountId,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`;
}

async function withPublishedAccountDaemon(run: (fixture: Readonly<{
  credentials: Readonly<{ token: string; encryption: null; credentialProvenance: 'stored_session' }>;
  serverId: string;
  serverApiUrl: string;
  daemonTarget: Readonly<{ pid: number; httpPort: number; controlToken: string; machineId: string; accountId: string }>;
  withdrawPublication(): Promise<void>;
}>) => Promise<void>): Promise<void> {
  if (!patActionEndpoint) throw new Error('Expected the existing Home HTTP fixture');
  const taskDir = await mkdtemp(join(tmpdir(), 'happier-captured-account-daemon-'));
  const originalHomeDir = process.env.HAPPIER_HOME_DIR;
  const serverId = 'cloud';
  const daemonTarget = { pid: process.pid, httpPort: Number(new URL(patActionEndpoint).port),
    controlToken: 'captured-account-control', machineId: 'machine-local', accountId: 'account-1' };
  const statePath = join(taskDir, 'servers', serverId, 'daemon.state.json');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const credentials = { token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: daemonTarget.accountId,
    session: 'captured-account-session', tokenEpoch: 7,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })}.signature`,
    encryption: null, credentialProvenance: 'stored_session' } as const;
  try {
    await mkdir(join(taskDir, 'servers', serverId), { recursive: true });
    // OS publication is the mocked boundary; the actual reader consumes the
    // captured Account/Machine pair rather than a synthesized reader result.
    await writeFile(statePath, JSON.stringify({ ...daemonTarget, startedAt: Date.now(), startedWithCliVersion: 'test' }), 'utf8');
    process.env.HAPPIER_HOME_DIR = taskDir;
    reloadConfiguration();
    const actual = await vi.importActual<typeof import('@/daemon/multiDaemon')>('@/daemon/multiDaemon');
    resolveLiveDaemonControlTargetForServer.mockImplementation(actual.resolveLiveDaemonControlTargetForServer);
    expect(await actual.resolveLiveDaemonControlTargetForServer(serverId)).toEqual(daemonTarget);
    await run({ credentials, serverId, serverApiUrl: patActionEndpoint, daemonTarget,
      withdrawPublication: async () => { await rm(statePath); } });
  } finally {
    if (originalHomeDir === undefined) delete process.env.HAPPIER_HOME_DIR;
    else process.env.HAPPIER_HOME_DIR = originalHomeDir;
    reloadConfiguration();
    await rm(taskDir, { recursive: true, force: true });
  }
}
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
    const requestBody = await readRequestBody(request);
    const result = fetch(new URL(request.url ?? '/', endpoint), {
      method: request.method,
      headers: requestHeaders(request),
      body: requestBody,
    });
    response.writeHead(result.statusCode, { 'content-type': 'application/json' });
    // The real external Action route echoes the request identity, including
    // SDK-generated identities on mutating Actions.
    const envelope: unknown = requestBody ? JSON.parse(requestBody) : null;
    const requestId = envelope && typeof envelope === 'object' && 'requestId' in envelope
      ? envelope.requestId : undefined;
    response.end(JSON.stringify({ ...result.body,
      ...(result.body.v === 1 && typeof requestId === 'string' ? { requestId } : {}),
    }));
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

function sessionStatusResult(active = true) {
  return SessionStatusActionResultV1Schema.parse({
    session: projectSessionSummaryV1({
      row: { ...sessionListItem(exactSessionId), active },
      metadata: null,
      encryption: null,
    }),
  });
}

// The PAT route executes through the SDK, which settles every success through
// the Action's own declared output schema. A stub standing in for a successful
// execution has to be a real result of that Action; `PARSED_*` is what the
// schema returns to the caller, defaults included.
const HANDOFF_RESULT = {
  handoffId: 'handoff-1',
  status: { handoffId: 'handoff-1', status: 'completed', phase: 'finalizing' },
  workspace: { kind: 'none' },
} as const;
const PARSED_HANDOFF_RESULT = {
  ...HANDOFF_RESULT,
  status: { ...HANDOFF_RESULT.status, recoveryActions: [] },
} as const;

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
  it('keeps caller-bound update routing outside its strict semantic publication input', async () => {
    const requests: unknown[] = [];
    installPatActionTransportMock((_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return apiSuccess('session.update.post', { sessionId: exactSessionId, persisted: true, localId: 'update-1' });
    });
    const executor = createCliActionExecutorFromCredentials({ credentials: {
      token: SYNTHETIC_API_TOKEN, encryption: null, credentialProvenance: 'api_token',
    } });
    expect(await executor.execute('session.update.post', { summary: 'Progress' }, {
      surface: 'cli', authority: 'account_automation', defaultSessionId: exactSessionId,
    })).toEqual({ ok: true, result: { sessionId: exactSessionId, persisted: true, localId: 'update-1' } });
    expect(requests).toEqual([{
      v: 1,
      requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      target: { kind: 'session', sessionId: exactSessionId },
      input: { summary: 'Progress' },
    }]);
  });
  it('refuses a qualified copy with unavailable exact Home credentials before remote effects', async () => {
    installPatActionTransportMock(() => { throw new Error('Missing Home copy reached the Action transport'); });
    const executor = createCliActionExecutorFromCredentials({ credentials: { token: SYNTHETIC_API_TOKEN, encryption: null } });
    await expect(executor.execute('daemon.filesystem.copy', { kind: 'target_copy',
      source: { serverId: 'missing-source-home', machineId: 'source', rootPath: '/source', path: 'file.dat' },
      destination: { serverId: 'missing-destination-home', machineId: 'destination', rootPath: '/destination', path: 'copy.dat' },
      overwrite: false, recursive: false }, { surface: 'mcp' })).resolves.toMatchObject({ ok: false, errorCode: 'target_unavailable' });
  });
  it('refuses generic MCP byte transfers before the PAT transport can prepare one', async () => {
    installPatActionTransportMock(() => { throw new Error('A generic MCP caller opened a prepared transfer'); });
    const executor = createCliActionExecutorFromCredentials({ credentials: { token: SYNTHETIC_API_TOKEN, encryption: null } });
    const input = { rootPath: '/repo', path: 'file.dat', source: { sourceId: 'unowned-source', sizeBytes: 4 }, overwrite: false };
    const result = await executor.execute('daemon.filesystem.upload', input, { surface: 'mcp' });
    expect(result).toMatchObject({ ok: false, errorCode: 'filesystem_transfer_custody_required' });
    const prepared = await executor.prepare('daemon.filesystem.upload', input, { surface: 'mcp' });
    expect(prepared).toMatchObject({ kind: 'settled', result });
  });
  it('uses the daemon-owned Machine admission transport for credential-backed Actions without per-caller wiring', async () => {
    const actual = await vi.importActual<typeof import('./createCliActionExecutor')>('./createCliActionExecutor');
    createCliActionExecutor.mockImplementation(actual.createCliActionExecutor);
    const sessionsHttp = await vi.importActual<typeof import('@/session/transport/http/sessionsHttp')>('@/session/transport/http/sessionsHttp');
    fetchSessionById.mockImplementation(sessionsHttp.fetchSessionById);
    const secret = new Uint8Array(32).fill(3);
    const session = createCurrentSessionProjectionRecordFixture({ id: exactSessionId, encryptionMode: 'e2ee', active: true,
      metadata: encodeBase64(encryptLegacy({ v: 1, machineId: 'machine-1' }, secret)),
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }) };
      if (String(url).includes(`/v2/sessions/${exactSessionId}`)) return { status: 200, data: { session } };
      if (String(url).endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: {
        id: 'machine-1', active: true, kind: 'persistent', revokedAt: null, replacedByMachineId: null, managedMachineRef: null,
      } } };
      throw new Error(`Unexpected fixture HTTP path: ${new URL(String(url)).pathname}`);
    });
    onTestFinished(() => get.mockRestore());
    const machineAdmissionTransport = vi.fn(async () => ({ status: 'accepted' as const, localId: 'input-1' }));
    const release = installDaemonMachineAdmissionTransport({
      serverId: configuration.activeServerId,
      transport: machineAdmissionTransport,
    });
    try {
      const executor = createCliActionExecutorFromCredentials({
        credentials: { token: syntheticAccountToken('account-1'), encryption: { type: 'legacy', secret }, credentialProvenance: 'stored_session' },
        machineId: 'machine-1', serverIdentityId: 'srv_test',
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {} }) },
        resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) }),
      });
      await expect(executor.execute('session.message.send', { sessionId: exactSessionId, message: 'Admit this input', localId: 'input-1', wait: false },
        { surface: 'cli', authority: 'present_user' })).resolves.toMatchObject({ ok: true, result: { status: 'accepted', localId: 'input-1' } });
      expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({ sessionId: exactSessionId, targetMachineId: 'machine-1', localId: 'input-1' }), expect.anything());
    } finally {
      release();
    }
  }, 120_000);
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
    daemonPost.mockReset();
    resolveLiveDaemonControlTargetForServer.mockReset();
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
    if (patActionEndpoint) {
      process.env.HAPPIER_SERVER_URL = patActionEndpoint;
      reloadConfiguration();
    }
  });

  it('composes Account-server-owned Actions into the executor used by the daemon ingress', async () => {
    const actual = await vi.importActual<typeof import('./createCliActionExecutor')>('./createCliActionExecutor');
    createCliActionExecutor.mockImplementation(actual.createCliActionExecutor);
    const selectedServerApiUrl = 'https://selected-home.example.test';
    const token = syntheticAccountToken('account-1');
    // The canonical Account-server adapter issues `axios.request`, so the
    // interception must sit there. Only the selected Home with the executor's
    // own bearer answers; every other endpoint or credential is unreachable,
    // which is what makes the resolved value evidence that the fixed Home
    // survived the post-construction `HAPPIER_SERVER_URL` change.
    const request = vi.spyOn(axios, 'request').mockImplementation(async (config) => {
      const url = String((config as { url?: unknown } | undefined)?.url ?? '');
      const headers = (config as { headers?: Record<string, unknown> } | undefined)?.headers ?? {};
      if (
        url !== `${selectedServerApiUrl}${ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1}`
        || headers.Authorization !== `Bearer ${token}`
      ) {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      }
      return { status: 200, data: { tokens: [] } };
    });
    onTestFinished(() => request.mockRestore());

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token,
        encryption: null,
        credentialProvenance: 'stored_session',
      },
      serverId: 'selected-home',
      serverApiUrl: selectedServerApiUrl,
      serverIdentityId: 'srv_selected',
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1, actions: {} }) },
    });

    process.env.HAPPIER_SERVER_URL = 'https://post-construction-attacker.example.test';
    reloadConfiguration();

    await expect(executor.execute('account.apiTokens.list', {}, { surface: 'cli', authority: 'present_user' }))
      .resolves.toEqual({ ok: true, result: { tokens: [] } });
  });

  it.each([
    { name: 'completed local confirmation', external: false, explicitAsk: false, confirmed: true, authority: 'present_user', nativeRequests: 1 },
    { name: 'explicit Ask policy', external: false, explicitAsk: true, confirmed: true, authority: 'present_user', nativeRequests: 0 },
    { name: 'a different Action confirmation', external: false, explicitAsk: false, confirmed: false, authority: 'present_user', nativeRequests: 0 },
    { name: 'automation authority', external: false, explicitAsk: false, confirmed: true, authority: 'account_automation', nativeRequests: 0 },
    { name: 'explicit external requester custody', external: true, explicitAsk: false, confirmed: true, authority: 'present_user', nativeRequests: 0 },
  ] as const)('uses current approval policy for show-once requester placement: $name', async ({ external, explicitAsk, confirmed, authority, nativeRequests }) => {
    const actual = await vi.importActual<typeof import('./createCliActionExecutor')>('./createCliActionExecutor');
    createCliActionExecutor.mockImplementation(actual.createCliActionExecutor);
    const daemon = await vi.importActual<typeof import('@/daemon/multiDaemon')>('@/daemon/multiDaemon');
    resolveLiveDaemonControlTargetForServer.mockImplementation(daemon.resolveLiveDaemonControlTargetForServer);
    // Native Home HTTP is the boundary. Reaching its refusal proves that the
    // confirmed local caller retained execution; no fixture ever mints a secret.
    const request = vi.spyOn(axios, 'request').mockResolvedValue({ status: 403, data: { error: 'present_user_required' } });
    const admission = vi.spyOn(axios, 'post').mockResolvedValue({ status: 503, data: { error: 'admission_unavailable' } });
    onTestFinished(() => { request.mockRestore(); admission.mockRestore(); });
    const executor = createCliActionExecutorFromCredentials({
      credentials: { token: syntheticAccountToken('account-1'), encryption: null, credentialProvenance: 'stored_session' },
      machineId: 'machine-local', serverId: 'selected-home', serverApiUrl: 'https://selected-home.example.test', serverIdentityId: 'srv_selected',
      ...(external ? { externalActionClient: true } : {}),
      actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
        actions: explicitAsk ? { 'account.apiTokens.create': { approvalRequiredSurfaces: ['cli'] } } : {} }) },
    });
    await expect(executor.execute('account.apiTokens.create', { tokenId: '11111111-1111-4111-8111-111111111111', label: 'Local custody' },
      { surface: 'cli', authority, presentUserConfirmation: { actionId: confirmed ? 'account.apiTokens.create' : 'account.apiTokens.revoke' } }))
      .resolves.toMatchObject({ ok: false, ...(nativeRequests ? { errorCode: 'present_user_required' } : {}) });
    expect(request.mock.calls).toHaveLength(nativeRequests);
  });

  it('routes only ordinary attested stored-session CLI root clients through their captured Account daemon', async () => {
    daemonPost.mockResolvedValue({
      ok: true,
      result: { machines: [] },
    });
    await withPublishedAccountDaemon(async ({ credentials, serverId, serverApiUrl, daemonTarget }) => {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId, serverApiUrl,
        machineId: daemonTarget.machineId, externalActionClient: true });
      await expect(executor.execute('machines.list', { limit: 10 },
        { surface: 'cli', authority: 'present_user', actionRequestId: 'request-signed' }))
        .resolves.toEqual({ ok: true, result: { machines: [] } });
      expect(daemonPost).toHaveBeenCalledWith(SIGNED_ROOT_ACTION_EXECUTE_PATH, {
        actionId: 'machines.list', input: { limit: 10 }, target: { kind: 'machine', machineId: 'machine-local' },
        actionRequestId: 'request-signed',
      }, expect.objectContaining({ target: daemonTarget, mutation: false }));
      daemonPost.mockClear();
      await expect(executor.execute('machines.list', { limit: 10 },
        { surface: 'api', authority: 'account_automation', actionRequestId: 'request-api' }))
        .resolves.toMatchObject({ ok: false, errorCode: 'local_executor_used' });
      expect(daemonPost).not.toHaveBeenCalled();
    });
  });

  it.each(['daemon_control', 'current_process'] as const)('routes an Account composite Machine child through signed daemon ingress (%s plugin owner)', async pluginActionExecutionOwner => {
    const actual = await vi.importActual<typeof import('./createCliActionExecutor')>('./createCliActionExecutor');
    createCliActionExecutor.mockImplementation(actual.createCliActionExecutor);
    daemonPost.mockResolvedValue({ ok: true, result: { kind: 'not_found' } });
    await withPublishedAccountDaemon(async ({ credentials, serverId, serverApiUrl, daemonTarget }) => {
      const executor = createCliActionExecutorFromCredentials({ credentials, serverId, serverApiUrl, pluginActionExecutionOwner,
        actionsSettingsProvider: { getActionsSettings: () => normalizeActionsSettingsV1({}), getAccountSettings: () => accountSettingsParse({}) } });
      const result = await executor.execute('wait', {
        target: { kind: 'action_operation', serverId, machineId: daemonTarget.machineId, operationId: 'operation-1' },
        condition: { kind: 'terminal' },
      }, { surface: 'cli', authority: 'present_user' });
      expect(result).toMatchObject({ ok: true, result: { disposition: 'target_unavailable' } });
      expect(daemonPost).toHaveBeenCalledWith(SIGNED_ROOT_ACTION_EXECUTE_PATH, {
        actionId: 'action.operations.get', input: { serverId, machineId: daemonTarget.machineId,
          operationId: 'operation-1', waitForTerminal: true }, target: { kind: 'machine', machineId: daemonTarget.machineId },
      }, expect.objectContaining({ target: daemonTarget, mutation: false }));
    });
  });

  it('routes sibling Machine starts through Protocol and CLI transport without conflicting on rejoin', async () => {
    const actual = await vi.importActual<typeof import('./createCliActionExecutor')>('./createCliActionExecutor');
    createCliActionExecutor.mockImplementation(actual.createCliActionExecutor);
    await withPublishedAccountDaemon(async ({ credentials, serverId, serverApiUrl, daemonTarget }) => {
      const transport = createCliActionExecutorFromCredentials({ credentials, serverId, serverApiUrl,
        machineId: daemonTarget.machineId, externalActionClient: true });
      const nativeStarts: string[] = [], requestIds: Array<string | undefined> = [];
      const runner = createActionOperationRunner({ store: createActionOperationStore(), resolveAction: actionId => ({
        actionId, title: getActionSpec('session.spawn_new').title, operation: getActionSpec('session.spawn_new').operation,
      }) });
      // Daemon HTTP and native process creation are system boundaries. The
      // Protocol composite, credentialed CLI transport and operation dedupe stay real.
      daemonPost.mockImplementation(async (_path, request: { actionId: string; input: unknown; actionRequestId?: string }) => {
        expect(request.actionId).toBe('session.spawn_new');
        requestIds.push(request.actionRequestId);
        const input = SessionSpawnNewInputV2Schema.parse(request.input);
        return runner.observe({ actionId: request.actionId, input, requestId: request.actionRequestId,
          scope: { accountId: daemonTarget.accountId, machineId: daemonTarget.machineId }, execute: async () => {
            nativeStarts.push(input.creationKey!);
            return { ok: true, result: { type: 'success', disposition: 'created', sessionId: `session-${input.creationKey}`,
              executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } } };
          } });
      });
      const reviewers = ['reviewer-a', 'reviewer-b'].map(participantSlotId => ({ participantSlotId,
        selection: { kind: 'model' as const, launch: { executionTarget: { serverId, machineId: daemonTarget.machineId },
          directory: { kind: 'path' as const, path: '/repo' },
          agentTarget: { kind: 'agent' as const, identity: { pluginId: 'example.agents', localId: 'reviewer' } }, permissionMode: 'read-only' as const } } }));
      const source = { kind: 'session' as const, message: { kind: 'session' as const, session: { serverId, sessionId: 'source' }, messageId: 'answer' } };
      const preview = DiscussionSecondOpinionPreviewV1Schema.parse({ source, sourceContentReady: true,
        sourceAudienceAccountIds: [daemonTarget.accountId], discussionAudienceAccountIds: [daemonTarget.accountId],
        missingDiscussionSourceAccountIds: [], discussionDisclosure: { ok: true }, canGrantSource: true,
        reviewers: reviewers.map(reviewer => ({ ...reviewer, sourceAccess: 'read', runtimeAccountId: daemonTarget.accountId,
          audienceAccountIds: [daemonTarget.accountId], missingSourceAccountIds: [], canGrantSource: true, disclosure: { ok: true } })) });
      const deps: Partial<ActionExecutorDeps> = {
        routeHostChildAction: ({ actionId, input, context }) => actionId === 'session.spawn_new'
          ? transport.execute(actionId, input, context) : Promise.resolve(null),
        sessionTranscriptGet: async () => ({ ok: true, sessionId: 'source', items: [{ id: 'answer', semanticRole: 'assistant',
          role: 'assistant', kind: 'message', createdAt: 1, text: 'Source answer' }], nextCursor: null, hasMore: false,
          diagnostics: { rawRowsScanned: 1, pagesFetched: 1, scanLimitReached: false, payloadTruncations: 0 } }),
        discussionAction: async ({ actionId, input }) => {
          if (actionId === 'discussion.second_opinion.start') return { ok: true, value: preview };
          if (actionId === 'discussion.invite') {
            const invite = DiscussionInviteInputV1Schema.parse(input);
            if (invite.participant.kind !== 'model') throw new Error('Expected model invitation');
            return { discussionId: 'opinion', ownerAccountId: daemonTarget.accountId, access: 'owner', grants: [], changed: true,
              modelParticipant: { participant: { kind: 'model', participantSlotId: invite.participant.participantSlotId },
                launch: invite.participant.launch, sessionId: null, answerPolicy: 'when_addressed', createdAt: 1 } };
          }
          if (actionId === 'discussion.post') return { ok: false, errorCode: 'fixture_after_invites', error: 'fixture_after_invites' };
          if (actionId !== 'discussion.create') throw new Error(`Unexpected Discussion HTTP operation: ${actionId}`);
          return { v: 1, serverId, firstMessage: { id: 'quote', discussionId: 'opinion', localId: 'quote-opinion', seq: 1,
            authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1, mentionedAccountIds: [],
            content: { v: 1, parts: [{ t: 'text', text: 'Source answer' }] },
            messageRef: { kind: 'discussion', discussion: { serverId, discussionId: 'opinion' }, messageId: 'quote' } },
            discussion: { id: 'opinion', ownerAccountId: daemonTarget.accountId, access: 'owner', encryptionMode: 'plain',
              keyReadiness: true, dataEncryptionKey: null, anchor: null, creationLocalId: 'create-opinion', title: 'Two reviewers',
              latestMessage: { id: 'quote', localId: 'quote-opinion', seq: 1, authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1 },
              messageSeq: 1, lastReadSeq: 0, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
              capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true,
                sendToSession: true, manageAccess: true, leave: false } } };
        },
      };
      const executor = createActionExecutor(deps as ActionExecutorDeps);
      const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId, actionRequestId: 'two-reviewer-root',
        actionsSettings: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: Object.fromEntries([
          'discussion.second_opinion.start', 'discussion.create', 'discussion.invite', 'discussion.post', 'session.spawn_new',
        ].map(id => [id, ['cli']])) }) };
      const input = { intent: 'ask', title: 'Two reviewers', question: 'Review this', source, reviewers, confirmedPreview: preview,
        retry: { creationLocalId: 'create-opinion', quoteLocalId: 'quote-opinion', questionLocalId: 'ask-opinion' },
        project: { machineId: daemonTarget.machineId, directory: '/repo' } };
      for (let retry = 0; retry < 2; retry++) {
        const result = await executor.execute('discussion.second_opinion.start', input, context);
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'pending', stage: 'ask', errorCode: 'fixture_after_invites' } });
      }
      expect(nativeStarts).toEqual(['reviewer-a', 'reviewer-b']);
      expect(requestIds).toHaveLength(4);
      expect(requestIds[0]).toEqual(expect.any(String));
      expect(requestIds[1]).not.toBe(requestIds[0]);
      expect(requestIds.slice(2)).toEqual(requestIds.slice(0, 2));
    });
  });

  it('keeps stored-session plugin installation on signed daemon control and refuses its excluded PAT Action transport', async () => {
    daemonPost.mockResolvedValue({
      ok: true,
      result: { installed: true },
    });

    const patRequests: URL[] = [];
    installPatActionTransportMock(url => {
      if (url.pathname === '/v1/features/authenticated') return { statusCode: 200,
        body: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) };
      patRequests.push(url);
      return apiFailure('plugins.install', 'present_user_required');
    });
    await withPublishedAccountDaemon(async ({ credentials, serverId, serverApiUrl, daemonTarget }) => {
      const signedRoot = createCliActionExecutorFromCredentials({ credentials, serverId, serverApiUrl, externalActionClient: true });
      await expect(signedRoot.execute('plugins.install', { source: '/workspace/plugin' },
        { surface: 'cli', authority: 'present_user' })).resolves.toEqual({ ok: true, result: { installed: true } });
      expect(daemonPost).toHaveBeenCalledWith(SIGNED_ROOT_ACTION_EXECUTE_PATH, {
        actionId: 'plugins.install', input: { source: '/workspace/plugin' },
      }, expect.objectContaining({ target: daemonTarget, mutation: true }));
    });

    const pat = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
        encryption: null,
        credentialProvenance: 'api_token',
      },
      externalActionClient: true,
    });
    await expect(pat.execute(
      'plugins.install',
      { source: '/workspace/plugin' },
      { surface: 'cli', authority: 'present_user' },
    )).resolves.toEqual({ ok: false, errorCode: 'unsupported', error: 'unsupported' });
    expect(patRequests).toEqual([]);
  });

  it('pins a fixed-Home stored-session root client to that Home daemon and fails closed when it is unavailable', async () => {
    daemonPost.mockResolvedValueOnce({
      ok: true,
      result: { machines: [] },
    });
    await withPublishedAccountDaemon(async ({ credentials, serverId, serverApiUrl, daemonTarget, withdrawPublication }) => {
      const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true, serverId, serverApiUrl });
      await expect(executor.execute(
        'machines.list',
        { limit: 10 },
        { surface: 'cli' },
      )).resolves.toEqual({ ok: true, result: { machines: [] } });
      expect(resolveLiveDaemonControlTargetForServer).toHaveBeenCalledWith(serverId);
      expect(daemonPost).toHaveBeenCalledWith(SIGNED_ROOT_ACTION_EXECUTE_PATH, {
        actionId: 'machines.list',
        input: { limit: 10 },
      }, expect.objectContaining({ target: daemonTarget, mutation: false }));

      await withdrawPublication();
      await expect(executor.execute(
        'machines.list',
        { limit: 10 },
        { surface: 'cli' },
      )).resolves.toEqual({
        ok: false,
        errorCode: 'daemon_unavailable',
        error: 'daemon_unavailable',
      });
      expect(daemonPost).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps an API Token on public HTTP even when a caller supplies a non-CLI surface', async () => {
    const fetch = vi.fn<FetchLike>(() => apiSuccess('action.spec.search', {
      actionSpecs: [],
    }));
    installPatActionTransportMock(fetch);
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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

    expect(daemonPost).not.toHaveBeenCalled();
    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('passes an exact full Session id directly to the PAT Action route without a lookup request', async () => {
    const fetch = vi.fn<FetchLike>(() => apiSuccess('session.status.get', sessionStatusResult()));
    installPatActionTransportMock(fetch);

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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
      result: sessionStatusResult(),
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
      headers: expect.objectContaining({ authorization: `Bearer ${SYNTHETIC_API_TOKEN}` }),
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

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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
      token: SYNTHETIC_API_TOKEN,
      requestedMachineId: 'machine-remote',
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      target: { kind: 'machine', machineId: 'machine-remote' },
      input: { sessionId: exactSessionId, limit: 10 },
    });
  });

  it('keeps explicit detached review engine discovery on its Machine despite a contextual Session', async () => {
    const actual = await vi.importActual<typeof import('@/api/machine/resolveCurrentAccountMachineTarget')>(
      '@/api/machine/resolveCurrentAccountMachineTarget',
    );
    resolveCurrentAccountMachineTarget.mockImplementation(actual.resolveCurrentAccountMachineTarget);
    const fetch = vi.fn<FetchLike>(() => apiSuccess('review.engines.list', { sessionId: null, items: [] }));
    installPatActionTransportMock(fetch);
    const executor = createCliActionExecutorFromCredentials({
      credentials: { token: SYNTHETIC_API_TOKEN, encryption: null, credentialProvenance: 'api_token' },
      machineId: 'machine-review',
    });

    await expect(executor.execute('review.engines.list', {
      sessionId: null, machineId: 'machine-review', scope: 'paths',
    }, { surface: 'cli', defaultSessionId: exactSessionId })).resolves.toEqual({
      ok: true, result: { sessionId: null, items: [] },
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1, target: { kind: 'machine', machineId: 'machine-review' },
      input: { sessionId: null, machineId: 'machine-review', scope: 'paths' },
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

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute('session.list', { limit: 1 }, { surface: 'cli' })).resolves.toEqual({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
    expect(resolveCurrentAccountMachineTarget).toHaveBeenCalledWith({ token: SYNTHETIC_API_TOKEN });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      target: { kind: 'machine', machineId: 'machine-remote' },
      input: { limit: 1 },
    });
  });

  it('never selects the ambient configured machine for a fixed-Home PAT executor', async () => {
    if (!patActionEndpoint) throw new Error('Expected PAT Action test endpoint.');
    resolveCurrentAccountMachineTarget.mockResolvedValue({
      kind: 'selected',
      target: { machineId: 'machine-fixed-home', machineLabel: 'machine-fixed-home' },
    });
    const fetch = vi.fn<FetchLike>(() => apiSuccess('session.list', {
      sessions: [],
      nextCursor: null,
      hasNext: false,
    }));
    installPatActionTransportMock(fetch);

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
        encryption: null,
        credentialProvenance: 'api_token',
      },
      serverId: 'fixed-home',
      serverApiUrl: patActionEndpoint,
    });

    await expect(executor.execute('session.list', { limit: 1 }, { surface: 'cli' })).resolves.toEqual({
      ok: true,
      result: { sessions: [], nextCursor: null, hasNext: false },
    });
    expect(readSettings).not.toHaveBeenCalled();
    expect(resolveCurrentAccountMachineTarget).toHaveBeenCalledWith({
      token: SYNTHETIC_API_TOKEN,
      serverHttpBaseUrl: patActionEndpoint,
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      target: { kind: 'machine', machineId: 'machine-fixed-home' },
      input: { limit: 1 },
    });
  });

  it('omits the target for a direct daemon Action endpoint without Account machine discovery', async () => {
    readSettings.mockResolvedValue({});
    resolveCurrentAccountMachineTarget.mockRejectedValue(new Error('account_machine_inventory_unavailable'));
    const receivedTargets: unknown[] = [];
    const receivedBodies: unknown[] = [];
    const app = fastify();
    app.addHook('preHandler', async (request) => {
      receivedBodies.push(request.body);
    });
    registerDaemonExternalActionRoute(app, {
      currentMachineId: 'machine-daemon-local',
      currentServerId: 'server-daemon-local',
      verifyPat: async () => ({
        ok: true as const,
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        expiresAt: null,
        authority: 'account_automation' as const,
      }),
      executor: {
        execute: async () => ({
          ok: true as const,
          result: { sessions: [], nextCursor: null, hasNext: false },
        }),
      },
      resolvePatExecutor: () => ({
        execute: async () => ({
          ok: true as const,
          result: { sessions: [], nextCursor: null, hasNext: false },
        }),
      }),
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

      const executor = createCliActionExecutorFromCredentials({
        credentials: {
          token: SYNTHETIC_API_TOKEN,
          encryption: null,
          credentialProvenance: 'api_token',
        },
      });

      await expect(executor.execute('session.list', {}, { surface: 'cli' })).resolves.toEqual({
        ok: true,
        result: { sessions: [], nextCursor: null, hasNext: false },
      });
      expect(receivedBodies).toEqual([{ v: 1, input: {} }]);
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

      const executor = createCliActionExecutorFromCredentials({
        credentials: {
          token: SYNTHETIC_API_TOKEN,
          encryption: null,
          credentialProvenance: 'api_token',
        },
      });

      await expect(executor.execute('session.list', { limit: 1 }, { surface: 'cli' })).resolves.toEqual({
        ok: true,
        result: { sessions: [], nextCursor: null, hasNext: false },
      });
      expect(resolveCurrentAccountMachineTarget).toHaveBeenCalledWith({ token: SYNTHETIC_API_TOKEN });
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
    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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
      return apiSuccess('session.status.get', sessionStatusResult());
    });
    installPatActionTransportMock(fetch);

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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
      result: sessionStatusResult(),
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

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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
    // `session.list` declares a union output: the released smaller UI-host page
    // is a result the Action really can return, so it survives the SDK's own
    // output parse and reaches this selector, which needs the canonical CLI
    // summary. The narrowing is the CLI's own contract, not a second copy of
    // the Action schema.
    const fetch = vi.fn<FetchLike>(() => apiSuccess('session.list', {
      ok: true,
      sessions: [{ id: exactSessionId, active: true, presence: null, updatedAt: 2 }],
      nextCursor: null,
      hasNext: false,
    }));
    installPatActionTransportMock(fetch);

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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
          result: sessionStatusResult(),
        });
    const verifyPat = vi.fn(async () => ({
      ok: true as const,
      accountId: 'account-1',
      principalId: 'principal-1',
      credentialId: 'credential-1',
      grant: API_TOKEN_FULL_GRANT_V1,
      expiresAt: null,
      authority: 'account_automation' as const,
    }));
    const app = fastify();
    registerDaemonExternalActionRoute(app, {
      currentMachineId: 'machine-selected',
      currentServerId: 'server-selected',
      verifyPat,
      executor: { execute },
      resolvePatExecutor: () => ({ execute }),
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
      const executor = createCliActionExecutorFromCredentials({
        credentials: {
          token: SYNTHETIC_API_TOKEN,
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
        result: sessionStatusResult(),
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

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.status.get',
      { sessionId: errorCode === 'session_id_ambiguous' ? 'shared' : 'missing' },
      { surface: 'cli' },
    )).resolves.toEqual({
      ok: false,
      errorCode,
      error: errorCode,
      ...(errorCode === 'session_id_ambiguous'
        ? { details: { candidates: sessions.map((session) => session.id) } }
        : {}),
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => String(url).endsWith('/v1/actions/session.list'))).toBe(true);
  });

  it('defers PAT Action execution until its prepared invocation runs', async () => {
    const fetch = vi.fn<FetchLike>(() => apiSuccess('session.status.get', sessionStatusResult()));
    installPatActionTransportMock(fetch);

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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
      result: sessionStatusResult(),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(createCliActionExecutor).not.toHaveBeenCalled();
  });

  it('projects an API Action failure without falling back to the local executor', async () => {
    const fetch = vi.fn<FetchLike>(() => apiFailure('session.status.get', 'target_unavailable', {
      retryAfterMs: 50,
    }));
    installPatActionTransportMock(fetch);

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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

  it('forwards session.handoff targetPath through the PAT adapter input', async () => {
    const requests: Array<Readonly<{ actionId: string; body: unknown }>> = [];
    const fetch = vi.fn<FetchLike>((input, init) => {
      const actionId = decodeURIComponent(String(input).split('/').at(-1) ?? '');
      const body = JSON.parse(String(init?.body));
      requests.push({ actionId, body });
      return actionId === 'session.list'
        ? apiSuccess('session.list', {
            sessions: [sessionListItem(exactSessionId, 'active-work')],
            nextCursor: null,
            hasNext: false,
          })
        : apiSuccess('session.handoff', HANDOFF_RESULT);
    });
    installPatActionTransportMock(fetch);

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.handoff',
      { sessionId: 'active-work', targetMachineId: 'machine-2', targetPath: '/target/repo' },
      { surface: 'api', actionRequestId: 'request-handoff' },
    )).resolves.toEqual({ ok: true, result: PARSED_HANDOFF_RESULT });

    expect(requests.at(-1)).toEqual({
      actionId: 'session.handoff',
      body: {
        v: 1,
        requestId: 'request-handoff',
        target: { kind: 'session', sessionId: exactSessionId },
        input: { sessionId: exactSessionId, targetMachineId: 'machine-2', targetPath: '/target/repo' },
      },
    });
  });

  it('rejects a non-public PAT Action before any local or HTTP execution', async () => {
    const fetch = vi.fn<FetchLike>();
    installPatActionTransportMock(fetch);

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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
      : apiSuccess('session.status.get', sessionStatusResult(false)));
    installPatActionTransportMock(fetch);

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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
      result: sessionStatusResult(false),
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
    const spawnResult = {
      type: 'success',
      disposition: 'created',
      sessionId: exactSessionId,
      executionTarget: { serverId: 'daemon-profile-only', machineId: 'machine-selected' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'accepted', localId: 'initial-input-1' },
    } as const;
    const fetch = vi.fn<FetchLike>(() => apiSuccess('session.spawn_new', spawnResult));
    installPatActionTransportMock(fetch);

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
        encryption: null,
        credentialProvenance: 'api_token',
      },
    });

    await expect(executor.execute(
      'session.spawn_new',
      {
        creationKey: 'manual:pat-spawn-1',
        executionTarget: { serverId: 'daemon-profile-only', machineId: 'machine-selected' },
        directory: { kind: 'path', path: '/workspace/pat-project' },
        organizationPlacement: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
      { surface: 'cli' },
    )).resolves.toEqual({ ok: true, result: spawnResult });

    expect(createCliActionExecutor).not.toHaveBeenCalled();
    expect(ensureCliActionPolicySettings).not.toHaveBeenCalled();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      v: 1,
      requestId: expect.any(String),
      target: { kind: 'machine', machineId: 'machine-selected' },
      input: {
        creationKey: 'manual:pat-spawn-1',
        directory: { kind: 'path', path: '/workspace/pat-project' },
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

    const executor = createCliActionExecutorFromCredentials({
      credentials: {
        token: SYNTHETIC_API_TOKEN,
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
