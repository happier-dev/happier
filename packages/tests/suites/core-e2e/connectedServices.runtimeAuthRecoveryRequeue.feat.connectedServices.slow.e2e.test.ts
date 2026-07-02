import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { type ConnectedServiceId } from '@happier-dev/protocol';

import {
  startConnectedServicesCodexDaemon,
  startFakeTokenServer,
  type FakeTokenServerRequest,
  type StartedConnectedServicesCodexDaemonFixture,
} from '../../src/testkit/connectedServicesCodexDaemon';
import {
  createConnectedServiceAuthGroup,
  createConnectedServiceProfile,
  fetchConnectedServiceAuthGroup,
  startConnectedServiceRecoveryProxy,
  type ConnectedServiceRecoveryProxy,
} from '../../src/testkit/connectedServicesRecovery';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { createRunDirs } from '../../src/testkit/runDir';
import { sleep, waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function readString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Expected string ${key}`);
  return value;
}

function readNumber(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Expected number ${key}`);
  return value;
}

function withTemporaryEnv<T>(values: Readonly<Record<string, string>>, runWithEnv: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return runWithEnv().finally(() => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

async function spawnConnectedCodexGroupSession(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  sessionId: string;
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
}>): Promise<string> {
  const response = await daemonControlPostJson<{ success?: boolean; sessionId?: unknown; error?: string }>({
    port: params.fixture.daemonPort,
    path: '/spawn-session',
    controlToken: params.fixture.controlToken,
    body: {
      directory: params.fixture.workspaceDir,
      agent: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      sessionId: params.sessionId,
      terminal: { mode: 'plain' },
      experimentalCodexAcp: true,
      environmentVariables: {
        HAPPIER_HOME_DIR: params.fixture.daemonHomeDir,
        HAPPIER_SERVER_URL: params.fixture.daemonServerBaseUrl,
        HAPPIER_WEBAPP_URL: params.fixture.daemonServerBaseUrl,
        HAPPIER_VARIANT: 'dev',
        HAPPIER_EXPERIMENTAL_CODEX_ACP: '1',
        HAPPIER_CODEX_ACP_BIN: params.fixture.acpStubProvider,
      },
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
    },
    timeoutMs: 150_000,
  });
  expect(response.status).toBe(200);
  expect(response.data?.success).toBe(true);
  if (typeof response.data?.sessionId !== 'string' || response.data.sessionId.length === 0) {
    throw new Error(`Expected daemon spawn-session response sessionId; error=${String(response.data?.error)}`);
  }
  return response.data.sessionId;
}

function recoveryIntentPath(fixture: StartedConnectedServicesCodexDaemonFixture): string {
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

async function readRecoveryIntent(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  sessionId: string;
  serviceId: ConnectedServiceId;
  profileId: string | null;
  groupId: string | null;
}>): Promise<UnknownRecord | null> {
  const raw = await readFile(recoveryIntentPath(params.fixture), 'utf8');
  const snapshot = asRecord(JSON.parse(raw) as unknown);
  const intents = asRecord(snapshot?.intentsBySessionId);
  const legacyIntent = asRecord(intents?.[params.sessionId]);
  if (legacyIntent) return legacyIntent;
  if (intents) {
    for (const candidate of Object.values(intents)) {
      const intent = asRecord(candidate);
      if (!intent) continue;
      if (intent.sessionId !== params.sessionId) continue;
      if (intent.serviceId !== params.serviceId) continue;
      if ((intent.profileId ?? null) !== params.profileId) continue;
      if ((intent.groupId ?? null) !== params.groupId) continue;
      return intent;
    }
  }

  const keyedIntents = asRecord(snapshot?.intentsByKey);
  if (!keyedIntents) return null;
  for (const candidate of Object.values(keyedIntents)) {
    const intent = asRecord(candidate);
    if (!intent) continue;
    if (intent.sessionId !== params.sessionId) continue;
    if (intent.serviceId !== params.serviceId) continue;
    if ((intent.profileId ?? null) !== params.profileId) continue;
    if ((intent.groupId ?? null) !== params.groupId) continue;
    return intent;
  }
  return null;
}

function expectRuntimeAuthRecoveryScheduledProjection(params: Readonly<{
  result: UnknownRecord | null;
  serviceId: ConnectedServiceId;
  profileId: string;
  groupId: string;
}>): void {
  expect(params.result).toMatchObject({ status: 'recovery_retry_scheduled' });
  const diagnostic = asRecord(params.result?.uxDiagnostic);
  expect(diagnostic).toMatchObject({
    code: 'recovery_retry_scheduled',
    failurePhase: 'runtime_auth_recovery',
    source: 'runtime_auth_recovery',
    serviceId: params.serviceId,
    profileId: params.profileId,
    groupId: params.groupId,
    retryable: true,
  });
  expect(asRecord(diagnostic?.diagnostics)).toEqual(expect.objectContaining({
    runtimeFailureKind: 'usage_limit',
    classificationSource: 'structured_provider_error',
  }));

  const runtimeIssue = asRecord(params.result?.runtimeIssue);
  const transcriptEvent = asRecord(params.result?.transcriptEvent);
  expect(runtimeIssue ?? transcriptEvent).not.toBeNull();
}

describe('core e2e: connected-service runtime-auth recovery requeue', () => {
  let fixture: StartedConnectedServicesCodexDaemonFixture | null = null;
  let tokenServer: Awaited<ReturnType<typeof startFakeTokenServer>> | null = null;
  let proxy: ConnectedServiceRecoveryProxy | null = null;

  afterEach(async () => {
    await fixture?.daemon.stop().catch(() => {});
    await fixture?.server.stop().catch(() => {});
    await tokenServer?.stop().catch(() => {});
    await proxy?.stop().catch(() => {});
    fixture = null;
    tokenServer = null;
    proxy = null;
  }, 60_000);

  it('durably requeues a transient runtime-auth handler failure and retries through the group switch coordinator without hammering', async () => {
    const serviceId = 'openai-codex';
    const groupId = `runtime-requeue-${randomUUID()}`;
    tokenServer = await startFakeTokenServer({
      respond: (_request: FakeTokenServerRequest) => ({
        status: 200,
        body: {
          access_token: 'runtime-requeue-access',
          refresh_token: 'runtime-requeue-refresh',
          id_token: 'runtime-requeue-id',
          expires_in: 3600,
          token_type: 'Bearer',
        },
      }),
    });

    fixture = await withTemporaryEnv({
      HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_BASE_BACKOFF_MS: '1000',
      HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_BACKOFF_MS: '2000',
      HAPPIER_CONNECTED_SERVICES_RUNTIME_AUTH_RECOVERY_MAX_ATTEMPTS: '3',
      HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS: '0',
    }, async () => await startConnectedServicesCodexDaemon({
      testDir: run.testDir('connected-services-runtime-auth-recovery-requeue'),
      testName: 'connected-services-runtime-auth-recovery-requeue',
      tokenUrl: tokenServer!.tokenUrl,
      accessToken: 'runtime-requeue-initial',
      refreshToken: 'runtime-requeue-refresh-initial',
      idToken: 'runtime-requeue-id-initial',
      expiresAt: Date.now() + 60 * 60_000,
      resolveDaemonServerBaseUrl: async (serverBaseUrl) => {
        proxy = await startConnectedServiceRecoveryProxy({
          targetBaseUrl: serverBaseUrl,
          serviceId,
          groupId,
        });
        return proxy.baseUrl;
      },
    }));

    await createConnectedServiceProfile({
      fixture,
      serviceId,
      profileId: 'backup',
      providerEmail: 'backup@example.test',
    });
    const createdGroup = await createConnectedServiceAuthGroup({
      fixture,
      serviceId,
      groupId,
      activeProfileId: 'work',
      memberProfileIds: ['work', 'backup'],
    });
    expect(createdGroup).toMatchObject({ activeProfileId: 'work', generation: 0 });

    const sessionId = await spawnConnectedCodexGroupSession({
      fixture,
      sessionId: `runtime-requeue-session-${randomUUID()}`,
      serviceId,
      groupId,
      profileId: 'work',
    });

    const baselineGroupLoadCount = proxy?.groupLoadCount() ?? 0;
    proxy?.armGroupLoadFailures(3, 'http_503');
    const recovery = await daemonControlPostJson<{
      ok?: boolean;
      result?: unknown;
    }>({
      port: fixture.daemonPort,
      path: '/connected-service-runtime-auth/failure',
      controlToken: fixture.controlToken,
      body: {
        sessionId,
        switchesThisTurn: 0,
        classification: {
          kind: 'usage_limit',
          limitCategory: 'quota',
          serviceId,
          profileId: 'work',
          groupId,
          resetsAtMs: null,
          retryAfterMs: 30_000,
          quotaScope: 'account',
          providerLimitId: 'weekly',
          action: null,
          planType: null,
          rateLimits: null,
          source: 'structured_provider_error',
        },
      },
      timeoutMs: 90_000,
    });
    expect(recovery.status).toBe(200);
    expect(recovery.data.ok).toBe(true);
    const scheduled = asRecord(recovery.data.result);
    expectRuntimeAuthRecoveryScheduledProjection({
      result: scheduled,
      serviceId,
      profileId: 'work',
      groupId,
    });
    const recoveryResult = asRecord(scheduled?.recovery);
    expect(recoveryResult).toMatchObject({ status: 'scheduled', retryable: true });

    const initialGroupLoadCount = proxy?.groupLoadCount() ?? 0;
    expect(initialGroupLoadCount - baselineGroupLoadCount).toBeGreaterThanOrEqual(3);
    expect(initialGroupLoadCount - baselineGroupLoadCount).toBeLessThanOrEqual(4);
    expect(proxy?.activeProfileWriteCount()).toBe(0);

    const intent = await readRecoveryIntent({
      fixture,
      sessionId,
      serviceId,
      profileId: 'work',
      groupId,
    });
    if (!intent) throw new Error('Expected runtime-auth recovery intent to be durably recorded');
    expect(['waiting', 'checking']).toContain(intent.status);
    expect(intent).toMatchObject({
      failurePhase: 'handler',
      failureReason: 'handler_transient_failure',
      serviceId,
      profileId: 'work',
      groupId,
    });
    expect(asRecord(intent?.lastErrorClassification)).toMatchObject({
      kind: 'server_error',
      retryable: true,
      statusCode: 503,
    });
    expect(readNumber(intent, 'attemptCount')).toBeLessThanOrEqual(1);
    expect(readNumber(intent, 'nextRetryAtMs')).toBeGreaterThan(0);

    await sleep(300);
    expect((proxy?.groupLoadCount() ?? 0) - initialGroupLoadCount).toBeLessThanOrEqual(1);
    expect(proxy?.activeProfileWriteCount()).toBe(0);

    await waitFor(async () => {
      const group = await fetchConnectedServiceAuthGroup({ fixture: fixture!, serviceId, groupId });
      return readString(group, 'activeProfileId') === 'backup';
    }, {
      timeoutMs: 30_000,
      intervalMs: 250,
      context: 'runtime-auth recovery retry re-enters the auth-group coordinator and switches once',
    });

    const switchedGroup = await fetchConnectedServiceAuthGroup({ fixture, serviceId, groupId });
    expect(switchedGroup).toMatchObject({ activeProfileId: 'backup', generation: 1 });
    expect(proxy?.activeProfileWriteCount()).toBe(1);
    expect(proxy?.groupLoadCount()).toBeLessThanOrEqual(initialGroupLoadCount + 5);

    await waitFor(async () => {
      const finalIntent = await readRecoveryIntent({
        fixture: fixture!,
        sessionId,
        serviceId,
        profileId: 'work',
        groupId,
      });
      return finalIntent?.status === 'cancelled';
    }, {
      timeoutMs: 60_000,
      intervalMs: 250,
      context: 'runtime-auth recovery intent is cleared after successful retry',
    });
  }, 360_000);
});
