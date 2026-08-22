import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  ConnectedServiceQuotaSnapshotV1Schema,
  ExecutionRunStartResponseSchema,
  ProviderAccountUsageSnapshotV1Schema,
  buildConnectedServiceCredentialRecord,
  buildProviderAccountUsageRecordId,
  type ConnectedServiceId,
  type ConnectedServiceQuotaMeterV1,
  type ConnectedServiceQuotaSnapshotV1,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageConfidenceV1,
  type ProviderAccountUsageRecordKeyV1,
  type ProviderAccountUsageSnapshotV1,
  type ProviderAccountUsageSourceV1,
  type ProviderAccountUsageSubjectKindV1,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, describe, expect, it } from 'vitest';

import { fetchJson } from '../../src/testkit/http';
import { createTestAuth, type TestAuth } from '../../src/testkit/auth';
import { type StartedServer, startServerLight } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import {
  readFakeCodexAppServerRequestLog,
  writeFakeCodexAppServerScript,
} from '../../src/testkit/codexAppServerRemoteHarness';
import { createUserScopedSocketCollector, type SocketCollector } from '../../src/testkit/socketClient';

const run = createRunDirs({ runLabel: 'core' });

const codexProviderId = 'codex';
const codexServiceId: ConnectedServiceId = 'openai-codex';
const claudeProviderId = 'claude';
const claudeServiceId: ConnectedServiceId = 'anthropic';

const plainProviderUsageServerEnv: NodeJS.ProcessEnv = {
  HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
  HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
  HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: 'true',
  HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
  HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
  HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST: 'none',
};

type PlainEnvelopeResponse<T> = Readonly<{
  content?: Readonly<{ t?: string; v?: T }>;
  metadata?: Readonly<{ fetchedAt?: number; staleAfterMs?: number; status?: string }>;
  error?: unknown;
}>;
type FetchJsonResult<T> = Awaited<ReturnType<typeof fetchJson<T>>>;
type SafeParseResult<T> = { success: true; data: T } | { success: false };
type ParseSchema<T> = { safeParse: (input: unknown) => SafeParseResult<T> };

async function callPlainSessionRpc<TReq, TRes>(params: Readonly<{
  ui: SocketCollector;
  sessionId: string;
  method: string;
  req: TReq;
  schema: ParseSchema<TRes>;
  timeoutMs?: number;
}>): Promise<TRes> {
  const method = params.method.startsWith(`${params.sessionId}:`)
    ? params.method
    : `${params.sessionId}:${params.method}`;
  const ack = await params.ui.rpcCall<{ ok?: unknown; result?: unknown; error?: unknown; errorCode?: unknown }>(
    method,
    params.req as never,
    params.timeoutMs ?? 30_000,
  );
  if (!ack || ack.ok !== true) {
    throw new Error(`Plain RPC failed: ${params.method}; ack=${JSON.stringify(ack)}`);
  }
  const result = ack.result;
  if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
    throw new Error(`Plain RPC returned application error: ${params.method}; result=${JSON.stringify(result)}`);
  }
  const parsed = params.schema.safeParse(result);
  if (!parsed.success) {
    throw new Error(`Plain RPC returned invalid response: ${params.method}; result=${JSON.stringify(result)}`);
  }
  return parsed.data;
}

function createQuotaMeter(params: Readonly<{
  meterId: string;
  label: string;
  used: number;
  limit: number;
  utilizationPct: number;
  resetAtMs: number;
}>): ConnectedServiceQuotaMeterV1 {
  return {
    meterId: params.meterId,
    label: params.label,
    used: params.used,
    limit: params.limit,
    remaining: params.limit - params.used,
    remainingPct: 100 - params.utilizationPct,
    usedPct: params.utilizationPct,
    resetAtMs: params.resetAtMs,
    resetSource: 'in_band_snapshot',
    unit: 'tokens',
    utilizationPct: params.utilizationPct,
    resetsAt: params.resetAtMs,
    status: 'ok',
    source: 'in_band_provider_snapshot',
    scope: 'primary',
    limitScope: 'account',
    confidence: 'exact',
    details: {},
  };
}

function createRecordKey(params: Readonly<{
  providerId: string;
  accountSubjectId: string;
  subjectKind: ProviderAccountUsageSubjectKindV1;
}>): ProviderAccountUsageRecordKeyV1 {
  return {
    providerId: params.providerId,
    accountSubjectId: params.accountSubjectId,
    subjectKind: params.subjectKind,
    quotaScope: 'account',
  };
}

function createProviderAccountUsageSnapshot(params: Readonly<{
  providerId: string;
  accountSubjectId: string;
  subjectKind: ProviderAccountUsageSubjectKindV1;
  accountSubjectKind: 'providerSubject' | 'provisionalLocalSubject';
  fetchedAtMs: number;
  source: ProviderAccountUsageSourceV1;
  confidence: ProviderAccountUsageConfidenceV1;
  planLabel?: string | null;
  accountLabel?: string | null;
  meters?: readonly ConnectedServiceQuotaMeterV1[];
}>): ProviderAccountUsageSnapshotV1 {
  const recordKey = createRecordKey(params);
  const staleAfterMs = 300_000;
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
    recordKey,
    providerId: params.providerId,
    accountSubject: {
      kind: params.accountSubjectKind,
      id: params.accountSubjectId,
    },
    observedAtMs: params.fetchedAtMs,
    fetchedAtMs: params.fetchedAtMs,
    staleAfterMs,
    source: params.source,
    confidence: params.confidence,
    state: 'loaded_data',
    planLabel: params.planLabel ?? null,
    accountLabel: params.accountLabel ?? null,
    meters: params.meters ? [...params.meters] : [
      createQuotaMeter({
        meterId: 'primary',
        label: 'Primary quota',
        used: 40,
        limit: 100,
        utilizationPct: 40,
        resetAtMs: params.fetchedAtMs + staleAfterMs,
      }),
    ],
  });
}

function createConnectedQuotaSnapshot(params: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  providerId: string;
  accountSubjectId: string;
  fetchedAtMs: number;
  planLabel?: string | null;
  accountLabel?: string | null;
  meters?: readonly ConnectedServiceQuotaMeterV1[];
}>): ConnectedServiceQuotaSnapshotV1 {
  const staleAfterMs = 300_000;
  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    v: 1,
    serviceId: params.serviceId,
    profileId: params.profileId,
    providerId: params.providerId,
    activeAccountId: params.accountSubjectId,
    fetchedAt: params.fetchedAtMs,
    fetchedAtMs: params.fetchedAtMs,
    staleAfterMs,
    source: 'user_probe',
    confidence: 'exact',
    planLabel: params.planLabel ?? null,
    accountLabel: params.accountLabel ?? null,
    meters: params.meters ? [...params.meters] : [
      createQuotaMeter({
        meterId: 'primary',
        label: 'Primary quota',
        used: 40,
        limit: 100,
        utilizationPct: 40,
        resetAtMs: params.fetchedAtMs + staleAfterMs,
      }),
    ],
  });
}

async function postProviderUsageToServer(params: Readonly<{
  serverBaseUrl: string;
  auth: TestAuth;
  snapshot: ProviderAccountUsageSnapshotV1;
  fingerprint: string;
  source?: ConnectedServiceUsageSourceV1;
}>): Promise<void> {
  const response = await fetchJson<{ success?: boolean; error?: unknown }>(
    `${params.serverBaseUrl}/v3/connect/provider-account-usage/${params.snapshot.recordId}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: { t: 'plain', v: params.snapshot },
        metadata: {
          fetchedAt: params.snapshot.fetchedAtMs,
          staleAfterMs: params.snapshot.staleAfterMs,
          status: 'ok',
          materialFingerprint: params.fingerprint,
        },
        ...(params.source ? { source: params.source } : {}),
      }),
      timeoutMs: 20_000,
    },
  );

  if (response.status !== 200) {
    throw new Error(
      `Expected provider-account usage write to succeed; status=${response.status}; body=${JSON.stringify(response.data)}`,
    );
  }
  expect(response.data?.success).toBe(true);
}

async function postPlainConnectedCredential(params: Readonly<{
  serverBaseUrl: string;
  auth: TestAuth;
  serviceId: ConnectedServiceId;
  profileId: string;
  providerAccountId: string;
  providerEmail: string;
}>): Promise<void> {
  const now = Date.now();
  const credential = buildConnectedServiceCredentialRecord({
    now,
    serviceId: params.serviceId,
    profileId: params.profileId,
    kind: 'oauth',
    expiresAt: now + 60 * 60_000,
    oauth: {
      accessToken: `${params.profileId}-access`,
      refreshToken: `${params.profileId}-refresh`,
      idToken: null,
      scope: null,
      tokenType: null,
      providerAccountId: params.providerAccountId,
      providerEmail: params.providerEmail,
    },
  });
  const response = await fetchJson<{ success?: boolean; error?: unknown }>(
    `${params.serverBaseUrl}/v3/connect/${params.serviceId}/profiles/${params.profileId}/credential`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: { t: 'plain', v: credential } }),
      timeoutMs: 20_000,
    },
  );
  if (response.status !== 200) {
    throw new Error(
      `Expected connected-service credential seed to succeed; status=${response.status}; body=${JSON.stringify(response.data)}`,
    );
  }
  expect(response.data?.success).toBe(true);
}

async function readProviderUsage(params: Readonly<{
  serverBaseUrl: string;
  auth: TestAuth;
  recordId: string;
}>): Promise<FetchJsonResult<PlainEnvelopeResponse<ProviderAccountUsageSnapshotV1>>> {
  return await fetchJson<PlainEnvelopeResponse<ProviderAccountUsageSnapshotV1>>(
    `${params.serverBaseUrl}/v3/connect/provider-account-usage/${params.recordId}`,
    {
      headers: { Authorization: `Bearer ${params.auth.token}` },
      timeoutMs: 10_000,
    },
  );
}

async function waitForProviderUsage(params: Readonly<{
  serverBaseUrl: string;
  auth: TestAuth;
  recordId: string;
  context: string;
}>): Promise<ProviderAccountUsageSnapshotV1> {
  let latestSnapshot: ProviderAccountUsageSnapshotV1 | null = null;
  await waitFor(async () => {
    const latest = await readProviderUsage(params);
    if (latest.status !== 200 || latest.data?.content?.t !== 'plain') return false;
    const snapshot = latest.data.content.v;
    if (!snapshot || snapshot.recordId !== params.recordId) return false;
    latestSnapshot = snapshot;
    return true;
  }, {
    timeoutMs: 60_000,
    intervalMs: 250,
    context: params.context,
  });

  if (!latestSnapshot) throw new Error(`Expected provider account usage snapshot for ${params.recordId}`);
  return latestSnapshot;
}

async function readQuotaProjection(params: Readonly<{
  serverBaseUrl: string;
  auth: TestAuth;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): Promise<FetchJsonResult<PlainEnvelopeResponse<ConnectedServiceQuotaSnapshotV1>>> {
  return await fetchJson<PlainEnvelopeResponse<ConnectedServiceQuotaSnapshotV1>>(
    `${params.serverBaseUrl}/v3/connect/${params.serviceId}/profiles/${params.profileId}/quotas`,
    {
      headers: { Authorization: `Bearer ${params.auth.token}` },
      timeoutMs: 10_000,
    },
  );
}

async function deleteQuotaSource(params: Readonly<{
  serverBaseUrl: string;
  auth: TestAuth;
  serviceId: ConnectedServiceId;
  profileId: string;
}>): Promise<void> {
  const response = await fetchJson<{ success?: boolean; error?: unknown }>(
    `${params.serverBaseUrl}/v3/connect/${params.serviceId}/profiles/${params.profileId}/quotas`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${params.auth.token}` },
      timeoutMs: 10_000,
    },
  );
  expect(response.status).toBe(200);
  expect(response.data?.success).toBe(true);
}

describe('core e2e: provider account usage canonical flow', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;

  afterEach(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
    daemon = null;
    server = null;
  });

  it('keeps direct provider usage separate from connected-service quota views until an explicit source link exists', async () => {
    const testDir = run.testDir(`provider-account-usage-codex-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: plainProviderUsageServerEnv,
    });
    const auth = await createTestAuth(server.baseUrl);

    const subjectId = 'acct-1';
    const fetchedAtMs = Date.now();
    const nativeSnapshot = createProviderAccountUsageSnapshot({
      providerId: codexProviderId,
      accountSubjectId: subjectId,
      subjectKind: 'account',
      accountSubjectKind: 'providerSubject',
      fetchedAtMs,
      source: 'runtimeSignal',
      confidence: 'confirmed',
      planLabel: 'ChatGPT Team',
      accountLabel: 'user@example.test',
    });

    await postProviderUsageToServer({
      serverBaseUrl: server.baseUrl,
      auth,
      snapshot: nativeSnapshot,
      fingerprint: `codex-native:${nativeSnapshot.recordId}`,
    });
    const nativePersisted = await waitForProviderUsage({
      serverBaseUrl: server.baseUrl,
      auth,
      recordId: nativeSnapshot.recordId,
      context: 'native Codex usage persists through canonical server route',
    });

    expect(nativePersisted.recordKey).toEqual(nativeSnapshot.recordKey);
    expect('aliases' in nativePersisted).toBe(false);

    const beforeConnectedProjection = await readQuotaProjection({
      serverBaseUrl: server.baseUrl,
      auth,
      serviceId: codexServiceId,
      profileId: 'work',
    });
    expect(beforeConnectedProjection.status).toBe(404);

    await postPlainConnectedCredential({
      serverBaseUrl: server.baseUrl,
      auth,
      serviceId: codexServiceId,
      profileId: 'work',
      providerAccountId: subjectId,
      providerEmail: 'user@example.test',
    });
    const connectedSnapshot = createConnectedQuotaSnapshot({
      serviceId: codexServiceId,
      profileId: 'work',
      providerId: codexProviderId,
      accountSubjectId: subjectId,
      fetchedAtMs: fetchedAtMs + 1,
      planLabel: 'ChatGPT Team',
      accountLabel: 'user@example.test',
    });
    const connectedRecordId = buildProviderAccountUsageRecordId(createRecordKey({
      providerId: codexProviderId,
      accountSubjectId: subjectId,
      subjectKind: 'account',
    }));
    expect(connectedRecordId).toBe(nativeSnapshot.recordId);
    const connectedUsageSnapshot = createProviderAccountUsageSnapshot({
      providerId: codexProviderId,
      accountSubjectId: subjectId,
      subjectKind: 'account',
      accountSubjectKind: 'providerSubject',
      fetchedAtMs: connectedSnapshot.fetchedAt,
      source: 'connectedServiceProbe',
      confidence: 'confirmed',
      planLabel: connectedSnapshot.planLabel,
      accountLabel: connectedSnapshot.accountLabel,
      meters: connectedSnapshot.meters,
    });
    expect(connectedUsageSnapshot.recordId).toBe(connectedRecordId);

    await postProviderUsageToServer({
      serverBaseUrl: server.baseUrl,
      auth,
      snapshot: connectedUsageSnapshot,
      fingerprint: `codex-connected:${connectedRecordId}`,
      source: {
        serviceId: codexServiceId,
        profileId: 'work',
        bindingKind: 'profile',
      },
    });
    const connectedPersisted = await waitForProviderUsage({
      serverBaseUrl: server.baseUrl,
      auth,
      recordId: connectedRecordId,
      context: 'connected-service source writes canonical Codex usage',
    });

    expect(connectedPersisted.recordKey.accountSubjectId).toBe(subjectId);
    expect('aliases' in connectedPersisted).toBe(false);
    expect(connectedPersisted.meters).toEqual(connectedUsageSnapshot.meters);

    const projected = await readQuotaProjection({
      serverBaseUrl: server.baseUrl,
      auth,
      serviceId: codexServiceId,
      profileId: 'work',
    });
    expect(projected.status).toBe(200);
    expect(projected.data?.content).toMatchObject({
      t: 'plain',
      v: {
        serviceId: codexServiceId,
        profileId: 'work',
        providerId: codexProviderId,
        activeAccountId: subjectId,
        planLabel: 'ChatGPT Team',
        accountLabel: 'user@example.test',
      },
    });
    expect(projected.data?.content?.v?.meters).toEqual(connectedPersisted.meters);

    await deleteQuotaSource({
      serverBaseUrl: server.baseUrl,
      auth,
      serviceId: codexServiceId,
      profileId: 'work',
    });
    const afterDeleteProjection = await readQuotaProjection({
      serverBaseUrl: server.baseUrl,
      auth,
      serviceId: codexServiceId,
      profileId: 'work',
    });
    expect(afterDeleteProjection.status).toBe(404);
    const preservedUsage = await readProviderUsage({ serverBaseUrl: server.baseUrl, auth, recordId: connectedRecordId });
    expect(preservedUsage.status).toBe(200);
  }, 60_000);

  it('keeps Claude native and connected provisional subjects separate until provider-owned evidence exists', async () => {
    const testDir = run.testDir(`provider-account-usage-claude-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: plainProviderUsageServerEnv,
    });
    const auth = await createTestAuth(server.baseUrl);
    const fetchedAtMs = Date.now();
    const nativeSubjectId = `provisional:native-claude:${randomUUID()}`;
    const connectedSubjectId = `provisional:connected-claude:${randomUUID()}`;

    const nativeSnapshot = createProviderAccountUsageSnapshot({
      providerId: claudeProviderId,
      accountSubjectId: nativeSubjectId,
      subjectKind: 'unknown',
      accountSubjectKind: 'provisionalLocalSubject',
      fetchedAtMs,
      source: 'runtimeSignal',
      confidence: 'unknown',
      planLabel: 'Claude Pro',
      accountLabel: 'same-user@example.test',
    });
    const connectedSnapshot = createConnectedQuotaSnapshot({
      serviceId: claudeServiceId,
      profileId: 'work',
      providerId: claudeProviderId,
      accountSubjectId: connectedSubjectId,
      fetchedAtMs: fetchedAtMs + 1,
      planLabel: 'Claude Pro',
      accountLabel: 'same-user@example.test',
    });
    const connectedRecordId = buildProviderAccountUsageRecordId(createRecordKey({
      providerId: claudeProviderId,
      accountSubjectId: connectedSubjectId,
      subjectKind: 'account',
    }));

    expect(nativeSnapshot.recordId).not.toBe(connectedRecordId);

    await postProviderUsageToServer({
      serverBaseUrl: server.baseUrl,
      auth,
      snapshot: nativeSnapshot,
      fingerprint: `claude-native:${nativeSnapshot.recordId}`,
    });
    await postPlainConnectedCredential({
      serverBaseUrl: server.baseUrl,
      auth,
      serviceId: claudeServiceId,
      profileId: 'work',
      providerAccountId: connectedSubjectId,
      providerEmail: 'same-user@example.test',
    });
    const connectedUsageSnapshot = createProviderAccountUsageSnapshot({
      providerId: claudeProviderId,
      accountSubjectId: connectedSubjectId,
      subjectKind: 'account',
      accountSubjectKind: 'providerSubject',
      fetchedAtMs: connectedSnapshot.fetchedAt,
      source: 'connectedServiceProbe',
      confidence: 'confirmed',
      planLabel: connectedSnapshot.planLabel,
      accountLabel: connectedSnapshot.accountLabel,
      meters: connectedSnapshot.meters,
    });
    expect(connectedUsageSnapshot.recordId).toBe(connectedRecordId);

    await postProviderUsageToServer({
      serverBaseUrl: server.baseUrl,
      auth,
      snapshot: connectedUsageSnapshot,
      fingerprint: `claude-connected:${connectedRecordId}`,
      source: {
        serviceId: claudeServiceId,
        profileId: 'work',
        bindingKind: 'profile',
      },
    });

    const nativeRead = await readProviderUsage({
      serverBaseUrl: server.baseUrl,
      auth,
      recordId: nativeSnapshot.recordId,
    });
    const connectedRead = await readProviderUsage({
      serverBaseUrl: server.baseUrl,
      auth,
      recordId: connectedRecordId,
    });

    expect(nativeRead.status).toBe(200);
    expect(connectedRead.status).toBe(200);
    expect(nativeRead.data?.content?.v?.accountSubject).toEqual({
      kind: 'provisionalLocalSubject',
      id: nativeSubjectId,
    });
    expect(connectedRead.data?.content?.v?.accountSubject).toEqual({
      kind: 'providerSubject',
      id: connectedSubjectId,
    });
    expect('aliases' in (connectedRead.data?.content?.v ?? {})).toBe(false);

    const projected = await readQuotaProjection({
      serverBaseUrl: server.baseUrl,
      auth,
      serviceId: claudeServiceId,
      profileId: 'work',
    });
    expect(projected.status).toBe(200);
    expect(projected.data?.content).toMatchObject({
      t: 'plain',
      v: {
        serviceId: claudeServiceId,
        profileId: 'work',
        providerId: claudeProviderId,
        activeAccountId: connectedSubjectId,
        planLabel: 'Claude Pro',
        accountLabel: 'same-user@example.test',
      },
    });
  }, 60_000);

  it('records daemon-spawn native Codex app-server usage without a connected-service binding', async () => {
    const testDir = run.testDir(`provider-account-usage-codex-daemon-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: plainProviderUsageServerEnv,
    });
    const serverBaseUrl = server.baseUrl;
    const auth = await createTestAuth(serverBaseUrl);
    const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
    const workspaceDir = resolve(join(testDir, 'workspace'));
    const codexHome = resolve(join(testDir, 'codex-home'));
    await mkdir(daemonHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHome, { recursive: true });

    const subjectId = `acct_daemon_${randomUUID()}`;
    await writeFile(join(codexHome, 'auth.json'), `${JSON.stringify({ account_id: subjectId })}\n`, 'utf8');
    await seedCliAuthForTestAccount({
      cliHome: daemonHomeDir,
      serverUrl: serverBaseUrl,
      auth,
      mode: 'legacy',
    });

    const requestLogPath = resolve(join(testDir, 'fake-codex-app-server.requests.jsonl'));
    const fakeAppServer = await writeFakeCodexAppServerScript({ dir: testDir, requestLogPath });
    const rateLimitSnapshot = {
      rateLimits: {
        planType: 'team',
        account: { email: 'daemon-codex@example.test' },
        primary: { usedPercent: 66, resetsAt: 1_768_010_000 },
      },
    };
    const codexEnv = {
      CI: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_HOME_DIR: daemonHomeDir,
      HAPPIER_SERVER_URL: serverBaseUrl,
      HAPPIER_WEBAPP_URL: serverBaseUrl,
      HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
      HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
      HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'appServer',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      CODEX_HOME: codexHome,
      HAPPIER_E2E_FAKE_CODEX_APP_SERVER_RATE_LIMITS_JSON: JSON.stringify(rateLimitSnapshot),
    };

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: daemonHomeDir,
      snapshotDir: resolve(join(testDir, 'cli-dist')),
      env: {
        ...process.env,
        ...codexEnv,
      },
    });

    const controlToken = (daemon.state as { controlToken?: string }).controlToken;
    const spawnRes = await daemonControlPostJson<{ success?: boolean; sessionId?: string }>({
      port: daemon.state.httpPort,
      path: '/spawn-session',
      controlToken,
      body: {
        directory: workspaceDir,
        agent: 'codex',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        codexBackendMode: 'appServer',
        terminal: { mode: 'plain' },
        environmentVariables: codexEnv,
      },
      timeoutMs: 60_000,
    });

    expect(spawnRes.status).toBe(200);
    expect(spawnRes.data?.success).toBe(true);
    const sessionId = spawnRes.data?.sessionId;
    expect(typeof sessionId).toBe('string');
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Missing sessionId from daemon spawn-session');
    }

    const ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
    ui.connect();
    try {
      await waitFor(() => ui.isConnected(), {
        timeoutMs: 20_000,
        context: 'Codex provider account usage daemon-spawn UI socket connects',
      });

      const started = await callPlainSessionRpc({
        ui,
        sessionId,
        method: SESSION_RPC_METHODS.EXECUTION_RUN_START,
        req: {
          intent: 'review',
          backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
          instructions: 'Trigger Codex app-server account usage recording.',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'bounded',
          ioMode: 'request_response',
          intentInput: {
            engineId: 'codex',
            engineIds: ['codex'],
            instructions: 'Trigger Codex app-server account usage recording.',
            changeType: 'committed',
            base: { kind: 'none' },
          },
        },
        schema: ExecutionRunStartResponseSchema,
        timeoutMs: 40_000,
      });
      expect(started.runId).toEqual(expect.any(String));

      await waitFor(async () => {
        const requests = await readFakeCodexAppServerRequestLog(requestLogPath);
        return requests.some((entry) => entry.method === 'account/rateLimits/read');
      }, {
        timeoutMs: 45_000,
        intervalMs: 250,
        context: 'Codex daemon-spawn app-server reads account usage',
      });

      const recordId = buildProviderAccountUsageRecordId({
        providerId: 'openai-codex',
        accountSubjectId: subjectId,
        subjectKind: 'account',
        quotaScope: 'account',
      });
      const persisted = await waitForProviderUsage({
        serverBaseUrl,
        auth,
        recordId,
        context: 'daemon-spawn native Codex app-server usage persists canonically',
      });

      expect(persisted).toMatchObject({
        recordId,
        providerId: 'openai-codex',
        accountSubject: { kind: 'providerSubject', id: subjectId },
        planLabel: 'team',
        accountLabel: 'daemon-codex@example.test',
        state: 'loaded_data',
      });
      expect('aliases' in persisted).toBe(false);
      expect(persisted.meters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          meterId: 'primary',
          utilizationPct: 66,
        }),
      ]));
    } finally {
      ui.close();
    }
  }, 180_000);
});
