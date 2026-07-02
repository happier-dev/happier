import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';

type UnknownRecord = Record<string, unknown>;
type AuthGroupResponse = Readonly<{
  group?: unknown;
  error?: unknown;
  generation?: unknown;
}>;

const run = createRunDirs({ runLabel: 'core' });
const serviceId: ConnectedServiceId = 'openai-codex';

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
  if (typeof value !== 'string') throw new Error(`Expected string ${key}`);
  return value;
}

async function createConnectedServiceProfile(params: Readonly<{
  baseUrl: string;
  token: string;
  profileId: string;
  providerEmail: string;
}>): Promise<void> {
  const now = Date.now();
  const secret = Uint8Array.from(randomBytes(32));
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
    material: { type: 'legacy', secret },
    payload: record,
    randomBytes: (length) => randomBytes(length),
  });

  const response = await fetchJson<{ success?: boolean }>(
    `${params.baseUrl}/v2/connect/${serviceId}/profiles/${params.profileId}/credential`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
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
  baseUrl: string;
  token: string;
  groupId: string;
  activeProfileId: string;
  memberProfileIds: readonly string[];
}>): Promise<UnknownRecord> {
  const response = await fetchJson<AuthGroupResponse>(`${params.baseUrl}/v3/connect/${serviceId}/groups`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
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
  });

  expect(response.status).toBe(200);
  const group = asRecord(response.data?.group);
  if (!group) throw new Error('Expected connected service auth group response');
  return group;
}

async function switchActiveProfile(params: Readonly<{
  baseUrl: string;
  token: string;
  groupId: string;
  profileId: string;
  expectedGeneration: number;
}>): Promise<Readonly<{ status: number; data: AuthGroupResponse }>> {
  const response = await fetchJson<AuthGroupResponse>(
    `${params.baseUrl}/v3/connect/${serviceId}/groups/${params.groupId}/active-profile`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profileId: params.profileId,
        expectedGeneration: params.expectedGeneration,
      }),
      timeoutMs: 20_000,
    },
  );

  return { status: response.status, data: response.data ?? {} };
}

async function patchRuntimeState(params: Readonly<{
  baseUrl: string;
  token: string;
  groupId: string;
  expectedGeneration: number;
  profileId: string;
}>): Promise<Readonly<{ status: number; data: AuthGroupResponse }>> {
  const response = await fetchJson<AuthGroupResponse>(
    `${params.baseUrl}/v3/connect/${serviceId}/groups/${params.groupId}/runtime-state`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${params.token}`,
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
              quotaExhaustedUntilMs: Date.now() + 60_000,
              lastFailureKind: 'usage_limit',
              lastFailureCode: 'usage_limit_reached',
              lastObservedAtMs: Date.now(),
            },
          },
        ],
      }),
      timeoutMs: 20_000,
    },
  );

  return { status: response.status, data: response.data ?? {} };
}

async function fetchConnectedServiceAuthGroup(params: Readonly<{
  baseUrl: string;
  token: string;
  groupId: string;
}>): Promise<UnknownRecord> {
  const response = await fetchJson<AuthGroupResponse>(
    `${params.baseUrl}/v3/connect/${serviceId}/groups/${params.groupId}`,
    {
      headers: { Authorization: `Bearer ${params.token}` },
      timeoutMs: 20_000,
    },
  );

  expect(response.status).toBe(200);
  const group = asRecord(response.data?.group);
  if (!group) throw new Error('Expected connected service auth group response');
  return group;
}

describe('core e2e: connected-service auth group CAS', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    server = null;
  });

  it('rejects stale concurrent auth-group writers and preserves the committed selection', async () => {
    const testDir = run.testDir(`connected-service-auth-group-cas-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
      },
    });
    const auth = await createTestAuth(server.baseUrl);
    const groupId = `codex-cas-${randomUUID()}`;

    await createConnectedServiceProfile({
      baseUrl: server.baseUrl,
      token: auth.token,
      profileId: 'primary',
      providerEmail: 'primary@example.test',
    });
    await createConnectedServiceProfile({
      baseUrl: server.baseUrl,
      token: auth.token,
      profileId: 'backup',
      providerEmail: 'backup@example.test',
    });
    await createConnectedServiceProfile({
      baseUrl: server.baseUrl,
      token: auth.token,
      profileId: 'standby',
      providerEmail: 'standby@example.test',
    });

    const created = await createConnectedServiceAuthGroup({
      baseUrl: server.baseUrl,
      token: auth.token,
      groupId,
      activeProfileId: 'primary',
      memberProfileIds: ['primary', 'backup', 'standby'],
    });
    const initialGeneration = readNumber(created, 'generation');
    expect(initialGeneration).toBe(0);

    const firstWriter = await switchActiveProfile({
      baseUrl: server.baseUrl,
      token: auth.token,
      groupId,
      profileId: 'backup',
      expectedGeneration: initialGeneration,
    });
    expect(firstWriter.status).toBe(200);
    const firstWriterGroup = asRecord(firstWriter.data.group);
    if (!firstWriterGroup) throw new Error('Expected first writer group response');
    expect(readString(firstWriterGroup, 'activeProfileId')).toBe('backup');
    expect(readNumber(firstWriterGroup, 'generation')).toBe(1);

    const staleSelection = await switchActiveProfile({
      baseUrl: server.baseUrl,
      token: auth.token,
      groupId,
      profileId: 'standby',
      expectedGeneration: initialGeneration,
    });
    expect(staleSelection.status).toBe(409);
    expect(staleSelection.data).toEqual({
      error: 'connect_group_generation_conflict',
      generation: 1,
    });

    const afterStaleSelection = await fetchConnectedServiceAuthGroup({
      baseUrl: server.baseUrl,
      token: auth.token,
      groupId,
    });
    expect(readString(afterStaleSelection, 'activeProfileId')).toBe('backup');
    expect(readNumber(afterStaleSelection, 'generation')).toBe(1);

    const retry = await switchActiveProfile({
      baseUrl: server.baseUrl,
      token: auth.token,
      groupId,
      profileId: 'standby',
      expectedGeneration: 1,
    });
    expect(retry.status).toBe(200);
    const retryGroup = asRecord(retry.data.group);
    if (!retryGroup) throw new Error('Expected retry group response');
    expect(readString(retryGroup, 'activeProfileId')).toBe('standby');
    expect(readNumber(retryGroup, 'generation')).toBe(2);

    const staleRuntimeState = await patchRuntimeState({
      baseUrl: server.baseUrl,
      token: auth.token,
      groupId,
      profileId: 'primary',
      expectedGeneration: 1,
    });
    expect(staleRuntimeState.status).toBe(409);
    expect(staleRuntimeState.data).toEqual({
      error: 'connect_group_generation_conflict',
      generation: 2,
    });

    const afterStaleRuntimeState = await fetchConnectedServiceAuthGroup({
      baseUrl: server.baseUrl,
      token: auth.token,
      groupId,
    });
    expect(readString(afterStaleRuntimeState, 'activeProfileId')).toBe('standby');
    expect(readNumber(afterStaleRuntimeState, 'generation')).toBe(2);
    expect(afterStaleRuntimeState.state).toEqual({});
  });
});
