import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import {
  startConnectedServicesCodexDaemon,
  startFakeTokenServer,
  type FakeTokenServerRequest,
  type StartedConnectedServicesCodexDaemonFixture,
} from '../../src/testkit/connectedServicesCodexDaemon';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fetchJson } from '../../src/testkit/http';
import { type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';
import { waitFor } from '../../src/testkit/timing';

const run = createRunDirs({ runLabel: 'core' });
const serviceId: ConnectedServiceId = 'openai-codex';

type UnknownRecord = Record<string, unknown>;
type AuthGroupResponse = Readonly<{
  group?: unknown;
  error?: unknown;
  generation?: unknown;
}>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function readNumber(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected numeric ${key}`);
  }
  return value;
}

function readString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected non-empty string ${key}`);
  }
  return value;
}

async function createConnectedServiceProfile(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  profileId: string;
  providerEmail: string;
}>): Promise<void> {
  const now = Date.now();
  const record = buildConnectedServiceCredentialRecord({
    now,
    serviceId,
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
  const ciphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: { type: 'legacy', secret: params.fixture.accountSecret },
    payload: record,
    randomBytes: (length) => randomBytes(length),
  });

  const response = await fetchJson<{ success?: boolean }>(
    `${params.fixture.serverBaseUrl}/v2/connect/${serviceId}/profiles/${params.profileId}/credential`,
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
  groupId: string;
  activeProfileId: string;
  memberProfileIds: readonly string[];
}>): Promise<UnknownRecord> {
  const response = await fetchJson<AuthGroupResponse>(
    `${params.fixture.serverBaseUrl}/v3/connect/${serviceId}/groups`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.fixture.auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        groupId: params.groupId,
        members: params.memberProfileIds.map((profileId, index) => ({
          profileId,
          priority: (index + 1) * 10,
        })),
        activeProfileId: params.activeProfileId,
        policy: {
          autoSwitch: true,
          recoveryMode: 'switch_or_wait',
          memberRuntimeStatePersistence: 'server_state_json',
        },
      }),
      timeoutMs: 20_000,
    },
  );

  expect(response.status).toBe(200);
  const group = asRecord(response.data?.group);
  if (!group) throw new Error('Expected connected service auth group response');
  return group;
}

async function switchActiveProfile(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  groupId: string;
  profileId: string;
  expectedGeneration: number;
}>): Promise<UnknownRecord> {
  const response = await fetchJson<AuthGroupResponse>(
    `${params.fixture.serverBaseUrl}/v3/connect/${serviceId}/groups/${params.groupId}/active-profile`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.fixture.auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profileId: params.profileId,
        expectedGeneration: params.expectedGeneration,
      }),
      timeoutMs: 20_000,
    },
  );

  expect(response.status).toBe(200);
  const group = asRecord(response.data?.group);
  if (!group) throw new Error('Expected connected service auth group response');
  return group;
}

async function patchMemberQuotaState(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  groupId: string;
  expectedGeneration: number;
  profileId: string;
  quotaExhaustedUntilMs: number;
}>): Promise<UnknownRecord> {
  const now = Date.now();
  const response = await fetchJson<AuthGroupResponse>(
    `${params.fixture.serverBaseUrl}/v3/connect/${serviceId}/groups/${params.groupId}/runtime-state`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${params.fixture.auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        expectedGeneration: params.expectedGeneration,
        state: {
          status: 'exhausted',
          lastSwitchReason: 'usage_limit',
        },
        memberStates: [
          {
            profileId: params.profileId,
            state: {
              quotaExhaustedUntilMs: params.quotaExhaustedUntilMs,
              lastFailureKind: 'usage_limit',
              lastFailureCode: 'usage_limit_reached',
              lastObservedAtMs: now,
            },
          },
        ],
      }),
      timeoutMs: 20_000,
    },
  );

  expect(response.status).toBe(200);
  const group = asRecord(response.data?.group);
  if (!group) throw new Error('Expected connected service auth group runtime-state response');
  return group;
}

async function fetchConnectedServiceAuthGroup(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  groupId: string;
}>): Promise<UnknownRecord> {
  const response = await fetchJson<AuthGroupResponse>(
    `${params.fixture.serverBaseUrl}/v3/connect/${serviceId}/groups/${params.groupId}`,
    {
      headers: { Authorization: `Bearer ${params.fixture.auth.token}` },
      timeoutMs: 20_000,
    },
  );

  expect(response.status).toBe(200);
  const group = asRecord(response.data?.group);
  if (!group) throw new Error('Expected connected service auth group response');
  return group;
}

async function spawnConnectedCodexGroupSession(params: Readonly<{
  fixture: StartedConnectedServicesCodexDaemonFixture;
  groupId: string;
  sessionId: string;
}>): Promise<string> {
  const response = await daemonControlPostJson<{
    success?: boolean;
    sessionId?: string;
    error?: string;
    errorCode?: string;
  }>({
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
          [serviceId]: { source: 'connected', selection: 'group', groupId: params.groupId },
        },
      },
    },
    timeoutMs: 150_000,
  });

  expect(response.status).toBe(200);
  expect(response.data).toMatchObject({ success: true });
  const spawnedSessionId = response.data?.sessionId;
  if (typeof spawnedSessionId !== 'string' || spawnedSessionId.length === 0) {
    throw new Error('Expected spawned connected-service session id');
  }
  return spawnedSessionId;
}

describe('core e2e: connected-service group divergence switching', () => {
  let fixture: StartedConnectedServicesCodexDaemonFixture | null = null;
  let server: StartedServer | null = null;
  let fakeTokenServer: Awaited<ReturnType<typeof startFakeTokenServer>> | null = null;

  afterEach(async () => {
    await fixture?.daemon.stop().catch(() => {});
    await server?.stop().catch(() => {});
    await fakeTokenServer?.stop().catch(() => {});
    fixture = null;
    server = null;
    fakeTokenServer = null;
  });

  it('selects an eligible member instead of blindly applying an exhausted active profile after divergence', async () => {
    fakeTokenServer = await startFakeTokenServer({
      respond: (_request: FakeTokenServerRequest) => ({
        status: 200,
        body: {
          access_token: 'unused-refresh-access',
          refresh_token: 'unused-refresh-token',
          id_token: 'unused-id-token',
          expires_in: 3600,
        },
      }),
    });
    fixture = await startConnectedServicesCodexDaemon({
      testDir: run.testDir('connected-services-group-divergence-switch'),
      testName: 'connected-services-group-divergence-switch',
      tokenUrl: fakeTokenServer.tokenUrl,
      accessToken: 'work-access',
      refreshToken: 'work-refresh',
      idToken: 'work-id',
      expiresAt: Date.now() + 60 * 60_000,
    });
    server = fixture.server;

    const groupId = 'codex-divergence';
    const originalProfileId = 'limited';
    const exhaustedActiveProfileId = 'already-exhausted';
    const eligibleProfileId = 'eligible';

    await createConnectedServiceProfile({
      fixture,
      profileId: originalProfileId,
      providerEmail: 'limited@example.test',
    });
    await createConnectedServiceProfile({
      fixture,
      profileId: exhaustedActiveProfileId,
      providerEmail: 'already-exhausted@example.test',
    });
    await createConnectedServiceProfile({
      fixture,
      profileId: eligibleProfileId,
      providerEmail: 'eligible@example.test',
    });

    const created = await createConnectedServiceAuthGroup({
      fixture,
      groupId,
      activeProfileId: originalProfileId,
      memberProfileIds: [originalProfileId, exhaustedActiveProfileId, eligibleProfileId],
    });
    expect(readString(created, 'activeProfileId')).toBe(originalProfileId);
    expect(readNumber(created, 'generation')).toBe(0);

    const sessionId = await spawnConnectedCodexGroupSession({
      fixture,
      groupId,
      sessionId: 'connected-services-group-divergence-1',
    });

    const diverged = await switchActiveProfile({
      fixture,
      groupId,
      profileId: exhaustedActiveProfileId,
      expectedGeneration: 0,
    });
    expect(readString(diverged, 'activeProfileId')).toBe(exhaustedActiveProfileId);
    expect(readNumber(diverged, 'generation')).toBe(1);

    await patchMemberQuotaState({
      fixture,
      groupId,
      expectedGeneration: 1,
      profileId: exhaustedActiveProfileId,
      quotaExhaustedUntilMs: Date.now() + 60_000,
    });

    const recovery = await daemonControlPostJson<{
      ok?: boolean;
      result?: {
        status?: string;
        result?: {
          status?: string;
          activeProfileId?: string;
          generation?: number;
        };
      };
    }>({
      port: fixture.daemonPort,
      path: '/connected-service-runtime-auth/failure',
      body: {
        sessionId,
        switchesThisTurn: 0,
        classification: {
          kind: 'usage_limit',
          limitCategory: 'quota',
          serviceId,
          profileId: originalProfileId,
          groupId,
          resetsAtMs: Date.now() + 60_000,
          retryAfterMs: 60_000,
          quotaScope: 'account',
          providerLimitId: 'primary',
          planType: 'pro',
          rateLimits: null,
          source: 'structured_provider_error',
        },
      },
      controlToken: fixture.controlToken,
      timeoutMs: 120_000,
    });

    expect(recovery.status).toBe(200);
    expect(recovery.data).toMatchObject({
      ok: true,
      result: {
        status: 'switch_attempted',
        result: {
          status: 'switched',
          activeProfileId: eligibleProfileId,
        },
      },
    });

    await waitFor(async () => {
      const group = await fetchConnectedServiceAuthGroup({ fixture: fixture!, groupId });
      return readString(group, 'activeProfileId') === eligibleProfileId;
    }, {
      timeoutMs: 30_000,
      context: 'diverged runtime-auth recovery commits the eligible connected-service group profile',
    });

    const group = await fetchConnectedServiceAuthGroup({ fixture, groupId });
    expect(readString(group, 'activeProfileId')).toBe(eligibleProfileId);
    expect(readNumber(group, 'generation')).toBe(2);
  }, 300_000);
});
