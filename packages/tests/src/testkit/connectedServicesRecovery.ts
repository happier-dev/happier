// Shared fake-provider/fixture helpers for connected-service provider-outcome
// recovery e2e coverage (plan section P8 of
// `.project/plans/connected-services-provider-outcome-recovery-supervisor-plan.md`).
//
// These helpers drive the REAL daemon recovery-coordination code (the durable
// RuntimeAuthRecoveryScheduler, the shared provider-outcome proof gate, the
// daemon-lifecycle / endpoint-availability gating, and the account-exhaustion
// suppression store) through the daemon control endpoint
// `/connected-service-runtime-auth/failure`. The only thing faked is the
// provider/transport BOUNDARY: a fake OAuth token server (reused from
// `connectedServicesCodexDaemon`) and a configurable reverse proxy that injects
// transport-level failures (HTTP 5xx vs socket-hangup vs connection-refused) in
// front of the server's connected-service auth-group endpoints.
//
// No real provider is contacted. This is the deterministic substitute for the
// real-provider QA that remains [blocked: needs real provider failure
// conditions] (plan P9). See the individual test file headers for which live QA
// each class substitutes for.

import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { join, resolve } from 'node:path';

import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  buildConnectedServiceCredentialRecord,
  encodeQualifiedConnectedAccountV4StructuredQueryValue,
  QualifiedConnectedAccountGroupRefSchema,
  QualifiedConnectedAccountGroupResponseV4Schema,
  type QualifiedConnectedAccountGroupRef,
  type QualifiedConnectedAccountGroupV4,
  type QualifiedConnectedAccountServiceRef,
  sealAccountScopedBlobCiphertext,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { upsertEncryptedAccountSettingsV2 } from './accountSettings';
import { createTestAuth, type TestAuth } from './auth';
import { seedCliAuthForTestAccount } from './cliAuth';
import { daemonControlPostJson } from './daemon/controlServerClient';
import { fetchJson } from './http';
import { writeTestManifestForServer } from './manifestForServer';
import { ensureCliSharedDepsBuilt } from './process/cliDist';
import { startServerLight, type StartedServer } from './process/serverLight';
import { startTestDaemon, type StartedDaemon } from './daemon/daemon';
import type { StartedConnectedServicesCodexDaemonFixture } from './connectedServicesCodexDaemon';

export type RecoveryProxyGroupFailureMode = 'http_503' | 'socket_hangup' | 'connection_refused';
export type RecoveryTokenServerRequest = Readonly<{
  path: string;
  method: string;
  body: string;
  receivedAtMs: number;
}>;

export type ConnectedServiceRecoveryProxy = Readonly<{
  baseUrl: string;
  groupLoadCount: () => number;
  activeAccountWriteCount: () => number;
  // Arm `count` consecutive failures on the auth-group GET endpoint using the
  // given transport failure mode. `socket_hangup`/`connection_refused` surface
  // as `network`-classified errors (the degraded-track edge from the live
  // daemon-lifecycle/endpoint-unavailable incident); `http_503` surfaces as a
  // `server_error` (normal retry track).
  armGroupLoadFailures: (count: number, mode: RecoveryProxyGroupFailureMode) => void;
  stop: () => Promise<void>;
}>;

export type ConnectedServiceRecoveryTokenServer = Readonly<{
  tokenUrl: string;
  requests: () => readonly RecoveryTokenServerRequest[];
  stop: () => Promise<void>;
}>;

type UnknownRecord = Record<string, unknown>;
type ConnectedServiceCredentialFixture =
  Pick<StartedConnectedServicesCodexDaemonFixture, 'serverBaseUrl' | 'auth' | 'accountSecret'>
  & Readonly<{ machineKey?: Uint8Array | null }>;

export function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

export function resolveQualifiedConnectedAccountServiceForLegacyServiceId(
  legacyServiceId: ConnectedServiceId,
): QualifiedConnectedAccountServiceRef {
  const match = Object.entries(
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  ).find(([candidateServiceId]) => candidateServiceId === legacyServiceId);
  if (!match) {
    throw new Error(`No qualified connected-account service is registered for legacy service ${legacyServiceId}`);
  }
  return match[1].service;
}

export function createQualifiedConnectedAccountGroupRefForLegacyService(params: Readonly<{
  legacyServiceId: ConnectedServiceId;
  groupId: string;
}>): QualifiedConnectedAccountGroupRef {
  return {
    service: resolveQualifiedConnectedAccountServiceForLegacyServiceId(params.legacyServiceId),
    groupId: params.groupId,
  };
}

function groupResponseOrThrow(params: Readonly<{
  operation: string;
  response: Readonly<{ status: number; data: unknown }>;
}>): QualifiedConnectedAccountGroupV4 {
  const parsed = QualifiedConnectedAccountGroupResponseV4Schema.safeParse(params.response.data);
  if (params.response.status !== 200 || !parsed.success) {
    throw new Error(
      `Failed to ${params.operation} (status=${params.response.status}, body=${JSON.stringify(params.response.data)})`,
    );
  }
  return parsed.data.group;
}

function encodedQualifiedConnectedAccountGroupQuery(
  group: QualifiedConnectedAccountGroupRef,
): string {
  return new URLSearchParams({
    group: encodeQualifiedConnectedAccountV4StructuredQueryValue(
      QualifiedConnectedAccountGroupRefSchema,
      group,
    ),
  }).toString();
}

function requestTargetsQualifiedConnectedAccountGroup(params: Readonly<{
  body: Buffer;
  group: QualifiedConnectedAccountGroupRef;
}>): boolean {
  try {
    const payload = asRecord(JSON.parse(params.body.toString('utf8')));
    const requestGroup = asRecord(payload?.group);
    const requestService = asRecord(requestGroup?.service);
    return requestGroup?.groupId === params.group.groupId
      && requestService?.pluginId === params.group.service.pluginId
      && requestService?.localId === params.group.service.localId;
  } catch {
    return false;
  }
}

export const CLAUDE_SUBSCRIPTION_SERVICE_ID = 'claude-subscription' satisfies ConnectedServiceId;
export const CLAUDE_CODE_E2E_OAUTH_SCOPE =
  'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload';

export async function startConnectedServiceRecoveryTokenServer(params: Readonly<{
  respond: (request: RecoveryTokenServerRequest) => Readonly<{ status: number; body: unknown }>;
}>): Promise<ConnectedServiceRecoveryTokenServer> {
  const requests: RecoveryTokenServerRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const request = {
        path: url.pathname,
        method: req.method ?? 'GET',
        body,
        receivedAtMs: Date.now(),
      };
      requests.push(request);
      const response = params.respond(request);
      res.statusCode = response.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(response.body));
    });
    req.on('error', () => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'request_error' }));
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('connected-service recovery token server missing address');

  return {
    tokenUrl: `http://127.0.0.1:${address.port}/oauth/token`,
    requests: () => [...requests],
    stop: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

function copyBufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const out = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(out).set(buffer);
  return out;
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function writeProxyResponse(res: ServerResponse, response: Response, body: Buffer): void {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') return;
    res.setHeader(key, value);
  });
  res.end(body);
}

// A reverse proxy in front of the server. It forwards everything verbatim except
// the connected-service auth-group GET, where it can inject transport failures so
// the daemon's recovery handler observes the SAME error shapes as a real local
// endpoint outage.
export async function startConnectedServiceRecoveryProxy(params: Readonly<{
  targetBaseUrl: string;
  serviceId: ConnectedServiceId;
  groupId: string;
}>): Promise<ConnectedServiceRecoveryProxy> {
  let groupLoadFailuresRemaining = 0;
  let groupLoadFailureMode: RecoveryProxyGroupFailureMode = 'http_503';
  let groupLoadCount = 0;
  let activeAccountWriteCount = 0;
  const target = new URL(params.targetBaseUrl);
  const group = createQualifiedConnectedAccountGroupRefForLegacyService({
    legacyServiceId: params.serviceId,
    groupId: params.groupId,
  });
  const encodedGroup = encodeQualifiedConnectedAccountV4StructuredQueryValue(
    QualifiedConnectedAccountGroupRefSchema,
    group,
  );
  const groupPath = '/v4/connect/qualified/group';
  const activeAccountPath = '/v4/connect/qualified/group/active-account';
  const sockets = new Set<Socket>();
  const trackSocket = (socket: Socket): Socket => {
    sockets.add(socket);
    socket.once('close', () => {
      sockets.delete(socket);
    });
    return socket;
  };
  const server = createServer(async (req, res) => {
    try {
      const targetUrl = new URL(req.url ?? '/', params.targetBaseUrl);
      const body = await readRequestBody(req);

      const readsGroup = req.method === 'GET'
        && targetUrl.pathname === groupPath
        && targetUrl.searchParams.get('group') === encodedGroup;
      if (readsGroup && groupLoadFailuresRemaining > 0) {
        groupLoadCount += 1;
        groupLoadFailuresRemaining -= 1;
        if (groupLoadFailureMode === 'socket_hangup') {
          // Destroy the socket without a response → the daemon's fetch rejects
          // with "socket hang up" / ECONNRESET → classified `network`/retryable
          // → degraded track (must NOT terminalize, must NOT burn dead-letter
          // budget).
          req.socket.destroy();
          return;
        }
        if (groupLoadFailureMode === 'connection_refused') {
          // Same network class, different shape: drop the connection abruptly.
          res.destroy();
          return;
        }
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'transient_recovery_proxy_failure' }));
        return;
      }
      if (readsGroup) {
        groupLoadCount += 1;
      }
      if (req.method === 'POST'
        && targetUrl.pathname === activeAccountPath
        && requestTargetsQualifiedConnectedAccountGroup({ body, group })) {
        activeAccountWriteCount += 1;
      }

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (key.toLowerCase() === 'host') continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else if (typeof value === 'string') {
          headers.set(key, value);
        }
      }
      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : copyBufferToArrayBuffer(body),
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      writeProxyResponse(res, response, responseBody);
    } catch (error) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  server.on('connection', (socket) => {
    trackSocket(socket);
  });

  server.on('upgrade', (req, socket, head) => {
    const targetSocket = trackSocket(connect({ host: target.hostname, port: Number(target.port) }));
    targetSocket.once('connect', () => {
      targetSocket.write(`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}\r\n`);
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const key = req.rawHeaders[index];
        const value = req.rawHeaders[index + 1];
        if (!key || value === undefined) continue;
        targetSocket.write(`${key}: ${value}\r\n`);
      }
      targetSocket.write('\r\n');
      if (head.length > 0) targetSocket.write(head);
      socket.pipe(targetSocket);
      targetSocket.pipe(socket);
    });
    targetSocket.once('error', () => socket.destroy());
    targetSocket.once('close', () => {
      socket.destroy();
    });
    socket.once('close', () => {
      targetSocket.destroy();
    });
    socket.once('error', () => targetSocket.destroy());
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('connected-service recovery proxy missing address');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    groupLoadCount: () => groupLoadCount,
    activeAccountWriteCount: () => activeAccountWriteCount,
    armGroupLoadFailures: (count, mode) => {
      groupLoadFailuresRemaining = Math.max(0, Math.trunc(count));
      groupLoadFailureMode = mode;
    },
    stop: async () => {
      const closed = once(server, 'close').catch(() => {});
      server.close();
      for (const socket of sockets) {
        socket.destroy();
      }
      await closed;
    },
  };
}

export async function createConnectedServiceProfile(params: Readonly<{
  fixture: ConnectedServiceCredentialFixture;
  serviceId: ConnectedServiceId;
  profileId: string;
  providerEmail: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string | null;
  scope?: string | null;
  tokenType?: string | null;
  providerAccountId?: string;
  expiresAt?: number;
}>): Promise<void> {
  const now = Date.now();
  const providerAccountId = params.providerAccountId ?? `acct-${params.profileId}`;
  const expiresAt = params.expiresAt ?? now + 60 * 60_000;
  const record = buildConnectedServiceCredentialRecord({
    now,
    serviceId: params.serviceId,
    profileId: params.profileId,
    kind: 'oauth',
    expiresAt,
    oauth: {
      accessToken: params.accessToken ?? `access-${params.profileId}`,
      refreshToken: params.refreshToken ?? `refresh-${params.profileId}`,
      idToken: params.idToken === undefined ? `id-${params.profileId}` : params.idToken,
      scope: params.scope ?? null,
      tokenType: params.tokenType ?? null,
      providerAccountId,
      providerEmail: params.providerEmail,
    },
  });
  const machineKey = params.fixture.machineKey;
  const ciphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: machineKey
      ? { type: 'dataKey', machineKey }
      : { type: 'legacy', secret: params.fixture.accountSecret },
    payload: record,
    randomBytes: (length) => randomBytes(length),
  });

  const response = await fetchJson<{ success?: boolean }>(
    `${params.fixture.serverBaseUrl}/v2/connect/${params.serviceId}/profiles/${params.profileId}/credential`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.fixture.auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sealed: { format: 'account_scoped_v1', ciphertext },
        metadata: {
          kind: 'oauth',
          providerEmail: params.providerEmail,
          providerAccountId,
          expiresAt: record.expiresAt,
        },
      }),
      timeoutMs: 20_000,
    },
  );
  if (response.status !== 200 || response.data?.success !== true) {
    throw new Error(`Failed to seed connected service profile ${params.profileId} (status=${response.status})`);
  }
}

export async function createQualifiedConnectedAccountGroup(params: Readonly<{
  serverBaseUrl: string;
  authToken: string;
  legacyServiceId: ConnectedServiceId;
  groupId: string;
  activeConnectedAccountId: string;
  memberConnectedAccountIds: readonly string[];
  preTurnProbeMode?: 'never';
}>): Promise<QualifiedConnectedAccountGroupV4> {
  const service = resolveQualifiedConnectedAccountServiceForLegacyServiceId(params.legacyServiceId);
  const groupRef = { service, groupId: params.groupId };
  const created = await fetchJson<unknown>(`${params.serverBaseUrl}/v4/connect/qualified/groups`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      service,
      group: {
        groupId: params.groupId,
        policy: {
          autoSwitch: true,
          ...(params.preTurnProbeMode ? { preTurnProbeMode: params.preTurnProbeMode } : {}),
          recoveryMode: 'switch_or_wait',
        },
      },
    }),
    timeoutMs: 20_000,
  });
  let group = groupResponseOrThrow({
    operation: `create qualified connected-account group ${params.groupId}`,
    response: created,
  });

  for (const [index, connectedAccountId] of params.memberConnectedAccountIds.entries()) {
    const added = await fetchJson<unknown>(
      `${params.serverBaseUrl}/v4/connect/qualified/group/members`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          group: groupRef,
          connectedAccountId,
          priority: (index + 1) * 10,
          expectedIncarnation: group.incarnation,
          expectedRuntimeStateRevision: group.runtimeStateRevision,
        }),
        timeoutMs: 20_000,
      },
    );
    group = groupResponseOrThrow({
      operation: `add qualified connected-account member ${connectedAccountId}`,
      response: added,
    });
  }

  const selected = await fetchJson<unknown>(
    `${params.serverBaseUrl}/v4/connect/qualified/group/active-account`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        group: groupRef,
        connectedAccountId: params.activeConnectedAccountId,
        expectedGeneration: group.generation,
        expectedIncarnation: group.incarnation,
        expectedRuntimeStateRevision: group.runtimeStateRevision,
      }),
      timeoutMs: 20_000,
    },
  );
  return groupResponseOrThrow({
    operation: `select qualified connected-account member ${params.activeConnectedAccountId}`,
    response: selected,
  });
}

export async function fetchQualifiedConnectedAccountGroup(params: Readonly<{
  serverBaseUrl: string;
  authToken: string;
  legacyServiceId: ConnectedServiceId;
  groupId: string;
}>): Promise<QualifiedConnectedAccountGroupV4> {
  const group = createQualifiedConnectedAccountGroupRefForLegacyService({
    legacyServiceId: params.legacyServiceId,
    groupId: params.groupId,
  });
  const response = await fetchJson<unknown>(
    `${params.serverBaseUrl}/v4/connect/qualified/group?${encodedQualifiedConnectedAccountGroupQuery(group)}`,
    {
      headers: { Authorization: `Bearer ${params.authToken}` },
      timeoutMs: 20_000,
    },
  );
  return groupResponseOrThrow({
    operation: `fetch qualified connected-account group ${params.groupId}`,
    response,
  });
}

// Mark a member of a group as quota-exhausted (or clear it) through the
// canonical qualified runtime-state owner, so the daemon's switch coordinator
// sees no eligible fresh candidate.
export async function patchQualifiedConnectedAccountGroupMemberExhaustion(params: Readonly<{
  serverBaseUrl: string;
  authToken: string;
  group: QualifiedConnectedAccountGroupV4;
  expectedRuntimeStateRevision: number;
  connectedAccountId: string;
  quotaExhaustedUntilMs: number | null;
}>): Promise<QualifiedConnectedAccountGroupV4> {
  const response = await fetchJson<unknown>(
    `${params.serverBaseUrl}/v4/connect/qualified/group/runtime-state`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${params.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        service: params.group.ref.service,
        groupId: params.group.ref.groupId,
        expectedIncarnation: params.group.incarnation,
        expectedRuntimeStateRevision: params.expectedRuntimeStateRevision,
        runtimeState: {
          state: {
            status: params.quotaExhaustedUntilMs === null ? 'ready' : 'exhausted',
            ...(params.quotaExhaustedUntilMs === null ? {} : { lastSwitchReason: 'usage_limit' }),
          },
          memberStates: [
            {
              connectedAccountId: params.connectedAccountId,
              state: params.quotaExhaustedUntilMs === null
                ? { quotaExhaustedUntilMs: null, lastObservedAtMs: Date.now() }
                : {
                    quotaExhaustedUntilMs: params.quotaExhaustedUntilMs,
                    lastFailureKind: 'usage_limit',
                    lastFailureCode: 'usage_limit_reached',
                    lastObservedAtMs: Date.now(),
                  },
            },
          ],
        },
      }),
      timeoutMs: 20_000,
    },
  );
  return groupResponseOrThrow({
    operation: 'patch qualified connected-account group runtime state',
    response,
  });
}

function recoveryIntentPath(fixture: Pick<StartedConnectedServicesCodexDaemonFixture, 'daemonHomeDir' | 'serverId'>): string {
  return resolve(
    join(
      fixture.daemonHomeDir,
      'servers',
      fixture.serverId,
      'connected-services',
      'runtime-auth-recovery.json',
    ),
  );
}

// Read the durable runtime-auth recovery intent the real scheduler persists to
// disk, matching on the recovery key fields. Tolerates the legacy
// session-keyed map and the current key-keyed map shapes.
export async function readRuntimeAuthRecoveryIntent(params: Readonly<{
  fixture: Pick<StartedConnectedServicesCodexDaemonFixture, 'daemonHomeDir' | 'serverId'>;
  sessionId: string;
  serviceId: ConnectedServiceId;
  profileId: string | null;
  groupId: string | null;
}>): Promise<UnknownRecord | null> {
  let raw: string;
  try {
    raw = await readFile(recoveryIntentPath(params.fixture), 'utf8');
  } catch {
    return null;
  }
  const snapshot = asRecord(JSON.parse(raw) as unknown);
  const matches = (intent: UnknownRecord | null): boolean => {
    if (!intent) return false;
    if (intent.sessionId !== params.sessionId) return false;
    if (intent.serviceId !== params.serviceId) return false;
    if ((intent.profileId ?? null) !== params.profileId) return false;
    if ((intent.groupId ?? null) !== params.groupId) return false;
    return true;
  };

  const intents = asRecord(snapshot?.intentsBySessionId);
  const legacyIntent = asRecord(intents?.[params.sessionId]);
  if (legacyIntent && matches(legacyIntent)) return legacyIntent;
  for (const candidate of Object.values(intents ?? {})) {
    const intent = asRecord(candidate);
    if (matches(intent)) return intent;
  }

  const keyedIntents = asRecord(snapshot?.intentsByKey);
  for (const candidate of Object.values(keyedIntents ?? {})) {
    const intent = asRecord(candidate);
    if (matches(intent)) return intent;
  }
  return null;
}

export type StartedConnectedServicesClaudeDaemonFixture = Readonly<{
  server: StartedServer;
  serverBaseUrl: string;
  auth: TestAuth;
  accountSecret: Uint8Array;
  daemon: StartedDaemon;
  daemonHomeDir: string;
  workspaceDir: string;
  serverId: string;
  daemonPort: number;
  controlToken: string | undefined;
  fakeClaudeLogPath: string;
  fakeClaudeScenario: string | null;
}>;

export async function startConnectedServicesClaudeDaemon(params: Readonly<{
  testDir: string;
  testName: string;
  tokenUrl: string;
  fakeClaudePath: string;
  fakeClaudeLogPath: string;
  fakeClaudeScenario?: string;
  extraEnv?: Record<string, string>;
}>): Promise<StartedConnectedServicesClaudeDaemonFixture> {
  const startedAt = new Date().toISOString();
  const server = await startServerLight({
    testDir: params.testDir,
    dbProvider: 'sqlite',
    extraEnv: {
      HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
    },
  });
  const auth = await createTestAuth(server.baseUrl);
  const daemonHomeDir = resolve(join(params.testDir, 'daemon-home'));
  const workspaceDir = resolve(join(params.testDir, 'workspace'));
  await mkdir(daemonHomeDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const secret = auth.accountSigningSeed;
  const { serverId } = await seedCliAuthForTestAccount({
    cliHome: daemonHomeDir,
    serverUrl: server.baseUrl,
    auth,
    mode: 'legacy',
  });

  await upsertEncryptedAccountSettingsV2({
    baseUrl: server.baseUrl,
    token: auth.token,
    secret,
    settings: {
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      claudeRemoteAgentSdkEnabled: true,
      claudeRemoteSettingSourcesV2: ['user', 'project', 'local'],
    },
  });

  writeTestManifestForServer({
    testDir: params.testDir,
    server,
    startedAt,
    runId: params.testName,
    testName: params.testName,
    sessionIds: [],
    env: {
      CI: process.env.CI,
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: server.baseUrl,
    },
  });

  const daemonEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_HOME_DIR: daemonHomeDir,
    HAPPIER_SERVER_URL: server.baseUrl,
    HAPPIER_WEBAPP_URL: server.baseUrl,
    HAPPIER_CLAUDE_PATH: params.fakeClaudePath,
    HAPPIER_E2E_FAKE_CLAUDE_LOG: params.fakeClaudeLogPath,
    HAPPIER_E2E_FAKE_CLAUDE_REQUIRE_NATIVE_OAUTH: '1',
    ...(params.fakeClaudeScenario ? { HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: params.fakeClaudeScenario } : {}),
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '1',
    HAPPIER_CONNECTED_SERVICES_REFRESH_TICK_MS: '300000',
    HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS: '0',
    HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: params.tokenUrl,
    HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'happier-e2e-claude-client',
    ...(params.extraEnv ?? {}),
  };

  await ensureCliSharedDepsBuilt({ testDir: params.testDir, env: daemonEnv });
  const daemon = await startTestDaemon({
    testDir: params.testDir,
    happyHomeDir: daemonHomeDir,
    env: daemonEnv,
    startupTimeoutMs: 120_000,
  });
  await waitForDaemonControlList({
    daemonPort: daemon.state.httpPort,
    controlToken: daemon.state.controlToken,
  });

  return {
    server,
    serverBaseUrl: server.baseUrl,
    auth,
    accountSecret: secret,
    daemon,
    daemonHomeDir,
    workspaceDir,
    serverId,
    daemonPort: daemon.state.httpPort,
    controlToken: daemon.state.controlToken,
    fakeClaudeLogPath: params.fakeClaudeLogPath,
    fakeClaudeScenario: params.fakeClaudeScenario ?? null,
  };
}

async function waitForDaemonControlList(params: Readonly<{
  daemonPort: number;
  controlToken: string | undefined;
}>): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const res = await daemonControlPostJson({
      port: params.daemonPort,
      path: '/list',
      body: {},
      controlToken: params.controlToken,
      timeoutMs: 5_000,
    }).catch(() => null);
    if (res?.status === 200) return;
    if (Date.now() - startedAt > 20_000) throw new Error('Timed out waiting for daemon control /list');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

export async function spawnConnectedClaudeGroupSession(params: Readonly<{
  fixture: StartedConnectedServicesClaudeDaemonFixture;
  sessionId: string;
  groupId: string;
  profileId: string;
  initialPrompt?: string;
}>): Promise<string> {
  const response = await daemonControlPostJson<{ success?: boolean; sessionId?: unknown; error?: string }>({
    port: params.fixture.daemonPort,
    path: '/spawn-session',
    controlToken: params.fixture.controlToken,
    body: {
      directory: params.fixture.workspaceDir,
      agent: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      sessionId: params.sessionId,
      terminal: { mode: 'plain' },
      ...(params.initialPrompt ? { initialPrompt: params.initialPrompt } : {}),
      environmentVariables: {
        CI: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_HOME_DIR: params.fixture.daemonHomeDir,
        HAPPIER_SERVER_URL: params.fixture.serverBaseUrl,
        HAPPIER_WEBAPP_URL: params.fixture.serverBaseUrl,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: params.fixture.fakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_REQUIRE_NATIVE_OAUTH: '1',
        ...(params.fixture.fakeClaudeScenario
          ? { HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: params.fixture.fakeClaudeScenario }
          : {}),
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          [CLAUDE_SUBSCRIPTION_SERVICE_ID]: {
            source: 'connected',
            selection: 'group',
            groupId: params.groupId,
            profileId: params.profileId,
          },
        },
      },
    },
    timeoutMs: 90_000,
  });
  if (response.status !== 200 || response.data?.success !== true) {
    throw new Error(`Expected Claude group spawn success (status=${response.status}, data=${JSON.stringify(response.data)})`);
  }
  if (typeof response.data.sessionId !== 'string' || response.data.sessionId.length === 0) {
    throw new Error(`Expected Claude group spawn response sessionId; error=${String(response.data.error)}`);
  }
  return response.data.sessionId;
}

export async function reportConnectedServiceRuntimeAuthFailure(params: Readonly<{
  fixture: Pick<StartedConnectedServicesClaudeDaemonFixture, 'daemonPort' | 'controlToken'>;
  sessionId: string;
  switchesThisTurn?: number;
  classification: UnknownRecord;
}>): Promise<{ status: number; data: { ok?: boolean; result?: unknown } }> {
  return await daemonControlPostJson<{ ok?: boolean; result?: unknown }>({
    port: params.fixture.daemonPort,
    path: '/connected-service-runtime-auth/failure',
    controlToken: params.fixture.controlToken,
    body: {
      sessionId: params.sessionId,
      switchesThisTurn: params.switchesThisTurn ?? 0,
      classification: params.classification,
    },
    timeoutMs: 120_000,
  });
}

export async function recordConnectedServiceTurnLifecycle(params: Readonly<{
  fixture: Pick<StartedConnectedServicesClaudeDaemonFixture, 'daemonPort' | 'controlToken'>;
  sessionId: string;
  event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';
}>): Promise<void> {
  const response = await daemonControlPostJson({
    port: params.fixture.daemonPort,
    path: '/connected-service-turn-lifecycle',
    controlToken: params.fixture.controlToken,
    body: {
      sessionId: params.sessionId,
      event: params.event,
    },
    timeoutMs: 20_000,
  });
  if (response.status !== 200) {
    throw new Error(`Failed to record connected-service turn lifecycle (status=${response.status})`);
  }
}

export function isRuntimeAuthRecoveryAwaitingProviderOutcomeProof(intent: unknown): boolean {
  const record = asRecord(intent);
  return record?.status === 'resumed_awaiting_proof'
    && record.lastError === 'recovery_unproven_awaiting_provider_outcome';
}

export async function countFakeClaudeUserTextOccurrences(params: Readonly<{
  logPath: string;
  text: string;
  sinceMs?: number;
}>): Promise<number> {
  let raw = '';
  try {
    raw = await readFile(params.logPath, 'utf8');
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: UnknownRecord | null = null;
    try {
      event = asRecord(JSON.parse(trimmed) as unknown);
    } catch {
      continue;
    }
    if (!event) continue;
    if (typeof params.sinceMs === 'number') {
      if (typeof event.ts !== 'number' || event.ts < params.sinceMs) continue;
    }
    const userTextPreview = typeof event.userTextPreview === 'string' ? event.userTextPreview : null;
    if (!userTextPreview?.includes(params.text)) continue;
    if (event.type === 'sdk_stdin' && event.hasUserText === true) {
      count += 1;
      continue;
    }
    if (event.type === 'local_stdin_turn_completed') {
      count += 1;
    }
  }
  return count;
}
