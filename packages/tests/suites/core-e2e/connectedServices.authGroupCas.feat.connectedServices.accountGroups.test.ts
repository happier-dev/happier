import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
  type ConnectedServiceId,
  type QualifiedConnectedAccountGroupV4,
} from '@happier-dev/protocol';

import { createTestAuth } from '../../src/testkit/auth';
import {
  createQualifiedConnectedAccountGroup,
  fetchQualifiedConnectedAccountGroup,
} from '../../src/testkit/connectedServicesRecovery';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';

type UnknownRecord = Record<string, unknown>;

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

async function switchActiveAccount(params: Readonly<{
  baseUrl: string;
  token: string;
  group: QualifiedConnectedAccountGroupV4;
  connectedAccountId: string;
  expectedGeneration: number;
}>): Promise<Readonly<{ status: number; data: unknown }>> {
  const response = await fetchJson<unknown>(
    `${params.baseUrl}/v4/connect/qualified/group/active-account`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        group: params.group.ref,
        connectedAccountId: params.connectedAccountId,
        expectedGeneration: params.expectedGeneration,
        expectedIncarnation: params.group.incarnation,
        expectedRuntimeStateRevision: params.group.runtimeStateRevision,
      }),
      timeoutMs: 20_000,
    },
  );

  return { status: response.status, data: response.data };
}

async function patchRuntimeState(params: Readonly<{
  baseUrl: string;
  token: string;
  group: QualifiedConnectedAccountGroupV4;
  expectedRuntimeStateRevision: number;
  connectedAccountId: string;
}>): Promise<Readonly<{ status: number; data: unknown }>> {
  const response = await fetchJson<unknown>(
    `${params.baseUrl}/v4/connect/qualified/group/runtime-state`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        service: params.group.ref.service,
        groupId: params.group.ref.groupId,
        expectedIncarnation: params.group.incarnation,
        expectedRuntimeStateRevision: params.expectedRuntimeStateRevision,
        runtimeState: {
          state: {
            status: 'exhausted',
            lastSwitchReason: 'usage_limit',
          },
          memberStates: [
            {
              connectedAccountId: params.connectedAccountId,
              state: {
                quotaExhaustedUntilMs: Date.now() + 60_000,
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

  return { status: response.status, data: response.data };
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

    const created = await createQualifiedConnectedAccountGroup({
      serverBaseUrl: server.baseUrl,
      authToken: auth.token,
      legacyServiceId: serviceId,
      groupId,
      activeConnectedAccountId: 'primary',
      memberConnectedAccountIds: ['primary', 'backup', 'standby'],
    });
    const initialGeneration = created.generation;

    const firstWriter = await switchActiveAccount({
      baseUrl: server.baseUrl,
      token: auth.token,
      group: created,
      connectedAccountId: 'backup',
      expectedGeneration: initialGeneration,
    });
    expect(firstWriter.status).toBe(200);
    const firstWriterGroup = asRecord(asRecord(firstWriter.data)?.group);
    if (!firstWriterGroup) throw new Error('Expected first writer group response');
    expect(readString(firstWriterGroup, 'activeConnectedAccountId')).toBe('backup');
    const firstWriterGeneration = readNumber(firstWriterGroup, 'generation');
    expect(firstWriterGeneration).toBe(initialGeneration + 1);

    const staleSelection = await switchActiveAccount({
      baseUrl: server.baseUrl,
      token: auth.token,
      group: created,
      connectedAccountId: 'standby',
      expectedGeneration: initialGeneration,
    });
    expect(staleSelection.status).toBe(409);
    expect(staleSelection.data).toEqual({
      error: 'connect_group_generation_conflict',
      generation: firstWriterGeneration,
    });

    const afterStaleSelection = await fetchQualifiedConnectedAccountGroup({
      serverBaseUrl: server.baseUrl,
      authToken: auth.token,
      legacyServiceId: serviceId,
      groupId,
    });
    expect(afterStaleSelection.activeConnectedAccountId).toBe('backup');
    expect(afterStaleSelection.generation).toBe(firstWriterGeneration);

    const retry = await switchActiveAccount({
      baseUrl: server.baseUrl,
      token: auth.token,
      group: afterStaleSelection,
      connectedAccountId: 'standby',
      expectedGeneration: afterStaleSelection.generation,
    });
    expect(retry.status).toBe(200);
    const retryGroup = asRecord(asRecord(retry.data)?.group);
    if (!retryGroup) throw new Error('Expected retry group response');
    expect(readString(retryGroup, 'activeConnectedAccountId')).toBe('standby');
    const retryGeneration = readNumber(retryGroup, 'generation');
    expect(retryGeneration).toBe(afterStaleSelection.generation + 1);

    const afterRetry = await fetchQualifiedConnectedAccountGroup({
      serverBaseUrl: server.baseUrl,
      authToken: auth.token,
      legacyServiceId: serviceId,
      groupId,
    });
    const runtimeWriter = await patchRuntimeState({
      baseUrl: server.baseUrl,
      token: auth.token,
      group: afterRetry,
      connectedAccountId: 'primary',
      expectedRuntimeStateRevision: afterRetry.runtimeStateRevision,
    });
    expect(runtimeWriter.status).toBe(200);
    const runtimeWriterGroup = asRecord(asRecord(runtimeWriter.data)?.group);
    if (!runtimeWriterGroup) throw new Error('Expected runtime writer group response');
    const runtimeWriterRevision = readNumber(runtimeWriterGroup, 'runtimeStateRevision');
    expect(runtimeWriterRevision).toBe(afterRetry.runtimeStateRevision + 1);

    const staleRuntimeState = await patchRuntimeState({
      baseUrl: server.baseUrl,
      token: auth.token,
      group: afterRetry,
      connectedAccountId: 'primary',
      expectedRuntimeStateRevision: afterRetry.runtimeStateRevision,
    });
    expect(staleRuntimeState.status).toBe(409);
    expect(staleRuntimeState.data).toEqual({
      error: 'connect_group_runtime_state_revision_conflict',
      runtimeStateRevision: runtimeWriterRevision,
    });

    const afterStaleRuntimeState = await fetchQualifiedConnectedAccountGroup({
      serverBaseUrl: server.baseUrl,
      authToken: auth.token,
      legacyServiceId: serviceId,
      groupId,
    });
    expect(afterStaleRuntimeState.activeConnectedAccountId).toBe('standby');
    expect(afterStaleRuntimeState.generation).toBe(retryGeneration);
    expect(afterStaleRuntimeState.runtimeStateRevision).toBe(runtimeWriterRevision);
    expect(afterStaleRuntimeState.state).toMatchObject({ status: 'exhausted' });
  });
});
