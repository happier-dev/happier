import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { promisify } from 'node:util';

import {
  SessionUsageLimitRecoveryOperationResultV1Schema,
  buildConnectedServiceCredentialRecord,
  normalizeSessionUsageLimitRecoveryOperationResultV1,
  sealAccountScopedBlobCiphertext,
  type ConnectedServiceId,
  type SessionRuntimeIssueV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  startConnectedServicesCodexDaemon,
  startFakeTokenServer,
  type FakeTokenServerRequest,
  type StartedConnectedServicesCodexDaemonFixture,
} from '../../src/testkit/connectedServicesCodexDaemon';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';

const execFileAsync = promisify(execFile);
const run = createRunDirs({ runLabel: 'core', logsDir: process.env.HAPPIER_E2E_LOGS_DIR });

const CONNECTED_SERVICES_USAGE_LIMIT_FEATURE_ENV = {
  HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
  HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
  HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
  HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
  HAPPIER_FEATURE_SESSIONS_USAGE_LIMIT_RECOVERY__ENABLED: '1',
} satisfies Record<string, string>;

type UnknownRecord = Record<string, unknown>;
type SessionTurnMutationResponse = Readonly<{ success?: unknown; reason?: unknown }>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

async function resolvePreferredHostName(): Promise<string> {
  const fallback = hostname();
  if (process.platform !== 'darwin') return fallback;
  for (const key of ['HostName', 'LocalHostName', 'ComputerName'] as const) {
    try {
      const { stdout } = await execFileAsync('scutil', ['--get', key], { timeout: 400 });
      const value = typeof stdout === 'string' ? stdout.trim() : '';
      if (value.length > 0) return value;
    } catch {
      // Keep parity with the daemon helper: try the next macOS host-name source.
    }
  }
  return fallback;
}

async function createConnectedServiceProfile(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  serviceId: ConnectedServiceId;
  profileId: string;
  providerEmail: string;
}>): Promise<void> {
  const now = Date.now();
  const record = buildConnectedServiceCredentialRecord({
    now,
    serviceId: params.serviceId,
    profileId: params.profileId,
    kind: 'oauth',
    expiresAt: now + 60 * 60_000,
    oauth: {
      accessToken: `access-${params.profileId}`,
      refreshToken: `refresh-${params.profileId}`,
      idToken: `id-${params.profileId}`,
      scope: null,
      tokenType: null,
      providerAccountId: `acct-${params.profileId}`,
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
          providerAccountId: `acct-${params.profileId}`,
          expiresAt: record.expiresAt,
        },
      }),
      timeoutMs: 20_000,
    },
  );
  expect(response.status).toBe(200);
  expect(response.data?.success).toBe(true);
}

async function createConnectedServiceAuthGroup(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  serviceId: ConnectedServiceId;
  groupId: string;
  activeProfileId: string;
  memberProfileIds: readonly string[];
}>): Promise<UnknownRecord> {
  const response = await fetchJson<{ group?: unknown }>(`${params.fixture.serverBaseUrl}/v3/connect/${params.serviceId}/groups`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.fixture.auth.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      groupId: params.groupId,
      members: params.memberProfileIds.map((profileId, index) => ({ profileId, priority: (index + 1) * 10 })),
      activeProfileId: params.activeProfileId,
      policy: {
        autoSwitch: true,
        recoveryMode: 'switch_or_wait',
        memberRuntimeStatePersistence: 'server_state_json',
      },
    }),
    timeoutMs: 20_000,
  });
  expect(response.status).toBe(200);
  const group = asRecord(response.data?.group);
  if (!group) throw new Error('Expected connected service auth group response');
  return group;
}

async function postSessionTurnMutation(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  sessionId: string;
  mutation: Readonly<Record<string, unknown>>;
}>): Promise<void> {
  const response = await fetchJson<SessionTurnMutationResponse>(
    `${params.fixture.serverBaseUrl}/v1/sessions/${params.sessionId}/turns/mutations`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.fixture.auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params.mutation),
      timeoutMs: 20_000,
    },
  );
  if (response.status !== 200 || response.data?.success !== true) {
    throw new Error(`Failed to post session turn mutation (status=${response.status}, reason=${String(response.data?.reason)})`);
  }
}

function buildUsageLimitIssue(params: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId: string;
}>): SessionRuntimeIssueV1 {
  const occurredAt = Date.now();
  return {
    v: 1,
    scope: 'primary_session',
    status: 'failed',
    code: 'provider_usage_limit',
    source: 'usage_limit',
    provider: 'codex',
    occurredAt,
    sanitizedPreview: 'Provider usage limit reached.',
    usageLimit: {
      v: 1,
      resetAtMs: occurredAt + 60_000,
      retryAfterMs: 60_000,
      quotaScope: 'account',
      recoverability: 'switch_account',
      providerLimitId: 'primary',
      planType: 'pro',
      utilization: 100,
      action: { kind: 'settings' },
      connectedService: {
        serviceId: params.serviceId,
        profileId: params.profileId,
        groupId: params.groupId,
        groupExhausted: true,
      },
    },
  };
}

async function createInactiveCodexUsageLimitSession(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  sessionMachineId: string;
  host: string;
  homeDir: string;
}>): Promise<string> {
  const metadata = {
    v: 1,
    name: 'Inactive Codex usage-limit recovery e2e',
    path: params.fixture.workspaceDir,
    host: params.host,
    homeDir: params.homeDir,
    machineId: params.sessionMachineId,
    flavor: 'codex',
    connectedServices: {
      v: 1,
      bindingsByServiceId: {
        [params.serviceId]: {
          source: 'connected',
          selection: 'group',
          profileId: params.profileId,
          groupId: params.groupId,
        },
      },
    },
  };

  const response = await fetchJson<{ session?: { id?: unknown } }>(
    `${params.fixture.serverBaseUrl}/v1/sessions`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.fixture.auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tag: `usage-limit-operation-result-${run.runId}`,
        metadata: JSON.stringify(metadata),
        agentState: null,
        dataEncryptionKey: null,
        encryptionMode: 'plain',
      }),
      timeoutMs: 20_000,
    },
  );
  const sessionId = response.data?.session?.id;
  if (response.status !== 200 || typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`Failed to create inactive Codex usage-limit session (status=${response.status})`);
  }

  const turnId = `turn-${randomUUID()}`;
  const occurredAt = Date.now();
  await postSessionTurnMutation({
    fixture: params.fixture,
    sessionId,
    mutation: {
      v: 1,
      action: 'begin',
      sessionId,
      turnId,
      mutationId: `mutation-${randomUUID()}`,
      observedAt: occurredAt,
      provider: 'codex',
    },
  });
  await postSessionTurnMutation({
    fixture: params.fixture,
    sessionId,
    mutation: {
      v: 1,
      action: 'fail',
      sessionId,
      turnId,
      mutationId: `mutation-${randomUUID()}`,
      observedAt: occurredAt + 1,
      provider: 'codex',
      issue: buildUsageLimitIssue({
        serviceId: params.serviceId,
        profileId: params.profileId,
        groupId: params.groupId,
      }),
    },
  });

  await waitFor(async () => {
    const updated = await fetchSessionV2(params.fixture.serverBaseUrl, params.fixture.auth.token, sessionId);
    return updated.latestTurnStatus === 'failed'
      && updated.lastRuntimeIssue?.source === 'usage_limit'
      && updated.lastRuntimeIssue.usageLimit?.connectedService?.groupId === params.groupId;
  }, {
    timeoutMs: 20_000,
    context: 'inactive Codex usage-limit issue persisted before recovery control',
  });

  return sessionId;
}

describe('core e2e: usage-limit recovery operation result roundtrip', () => {
  let fixture: StartedConnectedServicesCodexDaemonFixture | null = null;
  let tokenServer: Awaited<ReturnType<typeof startFakeTokenServer>> | null = null;

  afterEach(async () => {
    await fixture?.daemon.stop().catch(() => {});
    await fixture?.server.stop().catch(() => {});
    await tokenServer?.stop().catch(() => {});
    fixture = null;
    tokenServer = null;
  }, 60_000);

  it('returns a typed operation-result schema when switch-account-now is invoked through the machine RPC path', async () => {
    const serviceId = 'openai-codex' satisfies ConnectedServiceId;
    const groupId = `usage-limit-roundtrip-${randomUUID()}`;
    tokenServer = await startFakeTokenServer({
      respond: (_request: FakeTokenServerRequest) => ({
        status: 200,
        body: {
          access_token: 'usage-limit-roundtrip-access',
          refresh_token: 'usage-limit-roundtrip-refresh',
          id_token: 'usage-limit-roundtrip-id',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      }),
    });

    fixture = await startConnectedServicesCodexDaemon({
      testDir: run.testDir('session-usage-limit-operation-result-roundtrip'),
      testName: 'session-usage-limit-operation-result-roundtrip',
      tokenUrl: tokenServer.tokenUrl,
      accessToken: 'usage-limit-roundtrip-initial',
      refreshToken: 'usage-limit-roundtrip-refresh-initial',
      idToken: 'usage-limit-roundtrip-id-initial',
      expiresAt: Date.now() + 60 * 60_000,
      authMode: 'dataKey',
      daemonExtraEnv: CONNECTED_SERVICES_USAGE_LIMIT_FEATURE_ENV,
    });
    if (!fixture.machineKey) throw new Error('Expected data-key daemon fixture');

    await createConnectedServiceProfile({
      fixture,
      serviceId,
      profileId: 'backup',
      providerEmail: 'usage-limit-backup@example.test',
    });
    const createdGroup = await createConnectedServiceAuthGroup({
      fixture,
      serviceId,
      groupId,
      activeProfileId: 'work',
      memberProfileIds: ['work', 'backup'],
    });
    expect(createdGroup).toMatchObject({ activeProfileId: 'work', generation: 0 });

    const sessionId = await createInactiveCodexUsageLimitSession({
      fixture,
      serviceId,
      groupId,
      profileId: 'work',
      sessionMachineId: fixture.machineId,
      host: await resolvePreferredHostName(),
      homeDir: homedir(),
    });

    const ui = createUserScopedSocketCollector(fixture.serverBaseUrl, fixture.auth.token);
    ui.connect();
    try {
      await waitFor(() => ui.isConnected(), {
        timeoutMs: 20_000,
        context: 'socket connected for usage-limit operation-result roundtrip',
      });
      const machineRpc = createDataKeyRpcClient(ui, fixture.machineKey);
      const rawResult = unwrapDataKeyRpcResult(
        await machineRpc.call(`${fixture.machineId}:${RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW}`, {
          sessionId,
          provider: 'codex',
          operation: 'switch_account_now',
        }, 90_000),
        'usage-limit switch-account-now machine rpc',
      );

      const parsed = SessionUsageLimitRecoveryOperationResultV1Schema.safeParse(rawResult);
      if (!parsed.success) {
        throw new Error(`Expected raw RPC result to satisfy SessionUsageLimitRecoveryOperationResultV1: ${JSON.stringify({
          rawResult,
          error: parsed.error.format(),
        })}`);
      }
      expect(normalizeSessionUsageLimitRecoveryOperationResultV1(rawResult, { sessionId })).toEqual(parsed.data);
    } finally {
      ui.close();
    }
  }, 360_000);

  it('routes inactive usage-limit controls for a replaced same-host machine instead of returning remote unavailable', async () => {
    const serviceId = 'openai-codex' satisfies ConnectedServiceId;
    const groupId = `usage-limit-stale-machine-${randomUUID()}`;
    tokenServer = await startFakeTokenServer({
      respond: (_request: FakeTokenServerRequest) => ({
        status: 200,
        body: {
          access_token: 'usage-limit-stale-access',
          refresh_token: 'usage-limit-stale-refresh',
          id_token: 'usage-limit-stale-id',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      }),
    });

    fixture = await startConnectedServicesCodexDaemon({
      testDir: run.testDir('session-usage-limit-stale-machine-routing'),
      testName: 'session-usage-limit-stale-machine-routing',
      tokenUrl: tokenServer.tokenUrl,
      accessToken: 'usage-limit-stale-initial',
      refreshToken: 'usage-limit-stale-refresh-initial',
      idToken: 'usage-limit-stale-id-initial',
      expiresAt: Date.now() + 60 * 60_000,
      authMode: 'dataKey',
      daemonExtraEnv: CONNECTED_SERVICES_USAGE_LIMIT_FEATURE_ENV,
    });
    if (!fixture.machineKey) throw new Error('Expected data-key daemon fixture');

    await createConnectedServiceProfile({
      fixture,
      serviceId,
      profileId: 'backup',
      providerEmail: 'usage-limit-stale-backup@example.test',
    });
    await createConnectedServiceAuthGroup({
      fixture,
      serviceId,
      groupId,
      activeProfileId: 'work',
      memberProfileIds: ['work', 'backup'],
    });
    const staleMachineId = `${fixture.machineId}-stale`;
    const sessionId = await createInactiveCodexUsageLimitSession({
      fixture,
      serviceId,
      groupId,
      profileId: 'work',
      sessionMachineId: staleMachineId,
      host: await resolvePreferredHostName(),
      homeDir: homedir(),
    });

    const ui = createUserScopedSocketCollector(fixture.serverBaseUrl, fixture.auth.token);
    ui.connect();
    try {
      await waitFor(() => ui.isConnected(), {
        timeoutMs: 20_000,
        context: 'socket connected for stale-machine usage-limit control routing',
      });
      const machineRpc = createDataKeyRpcClient(ui, fixture.machineKey);
      const rawResult = unwrapDataKeyRpcResult(
        await machineRpc.call(`${fixture.machineId}:${RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE}`, {
          sessionId,
        }, 90_000),
        'usage-limit wait-resume enable stale-machine machine rpc',
      );
      const result = asRecord(rawResult);
      expect(JSON.stringify(result)).not.toContain('session_usage_limit_recovery_control_remote_unavailable');
      const parsed = SessionUsageLimitRecoveryOperationResultV1Schema.safeParse(rawResult);
      if (!parsed.success) {
        throw new Error(`Expected stale-machine wait-resume result to satisfy SessionUsageLimitRecoveryOperationResultV1: ${JSON.stringify({
          rawResult,
          error: parsed.error.format(),
        })}`);
      }
      expect(parsed.data).toMatchObject({
        ok: true,
        status: 'waiting',
        sessionId,
      });
    } finally {
      ui.close();
    }
  }, 360_000);
});
