import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';

import {
  buildConnectedServiceCredentialRecord,
  sealAccountScopedBlobCiphertext,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { createTestAuth } from '../../src/testkit/auth';
import {
  createQualifiedConnectedAccountGroup,
  fetchQualifiedConnectedAccountGroup,
  patchQualifiedConnectedAccountGroupMemberExhaustion,
} from '../../src/testkit/connectedServicesRecovery';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

type UnknownRecord = Record<string, unknown>;

const CONNECTED_SERVICE_RECOVERY_ENV = {
  HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
  HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
  HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
  HAPPIER_FEATURE_SESSIONS_USAGE_LIMIT_RECOVERY__ENABLED: '1',
} as const;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function createReusableKeyChallengeAuth() {
  const kp = tweetnacl.sign.keyPair();
  const publicKey = Uint8Array.from(kp.publicKey);
  const secretKey = Uint8Array.from(kp.secretKey);

  return async (baseUrl: string): Promise<{ token: string; publicKeyBase64: string }> => {
    const challenge = Uint8Array.from(randomBytes(32));
    const signature = Uint8Array.from(tweetnacl.sign.detached(challenge, secretKey));
    const body = {
      publicKey: privacyKit.encodeBase64(publicKey),
      challenge: privacyKit.encodeBase64(challenge),
      signature: privacyKit.encodeBase64(signature),
    };

    const response = await fetchJson<{ token?: string }>(`${baseUrl}/v1/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 15_000,
    });
    if (response.status !== 200 || typeof response.data?.token !== 'string' || response.data.token.length === 0) {
      throw new Error(`Failed to mint reusable key-challenge auth token (status=${response.status})`);
    }
    return { token: response.data.token, publicKeyBase64: body.publicKey };
  };
}

async function createConnectedServiceProfile(params: Readonly<{
  baseUrl: string;
  token: string;
  serviceId: ConnectedServiceId;
  profileId: string;
  providerEmail: string;
}>): Promise<void> {
  const now = Date.now();
  const secret = Uint8Array.from(randomBytes(32));
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
  const ciphertext = sealAccountScopedBlobCiphertext({
    kind: 'connected_service_credential',
    material: { type: 'legacy', secret },
    payload: record,
    randomBytes: (length) => randomBytes(length),
  });

  const response = await fetchJson<{ success?: boolean }>(
    `${params.baseUrl}/v2/connect/${params.serviceId}/profiles/${params.profileId}/credential`,
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

describe('core e2e: connected-service quota switch and recovery contracts', () => {
  let server: StartedServer | null = null;

  afterEach(async () => {
    await server?.stop().catch(() => {});
    server = null;
  });

  it('persists auth-group runtime exhaustion across restart and blocks selection until reset', async () => {
    const testDir = run.testDir(`connected-service-auth-group-runtime-state-${randomUUID()}`);
    const reauth = createReusableKeyChallengeAuth();
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: CONNECTED_SERVICE_RECOVERY_ENV,
    });
    const auth = await reauth(server.baseUrl);
    const serviceId = 'openai-codex';
    const groupId = 'codex-main';

    await createConnectedServiceProfile({
      baseUrl: server.baseUrl,
      token: auth.token,
      serviceId,
      profileId: 'primary',
      providerEmail: 'primary@example.test',
    });
    await createConnectedServiceProfile({
      baseUrl: server.baseUrl,
      token: auth.token,
      serviceId,
      profileId: 'backup',
      providerEmail: 'backup@example.test',
    });
    const created = await createQualifiedConnectedAccountGroup({
      serverBaseUrl: server.baseUrl,
      authToken: auth.token,
      legacyServiceId: serviceId,
      groupId,
      activeConnectedAccountId: 'backup',
      memberConnectedAccountIds: ['primary', 'backup'],
    });
    expect(created).toMatchObject({ activeConnectedAccountId: 'backup' });

    const resetAtMs = Date.now() + 60_000;
    await patchQualifiedConnectedAccountGroupMemberExhaustion({
      serverBaseUrl: server.baseUrl,
      authToken: auth.token,
      group: created,
      expectedRuntimeStateRevision: created.runtimeStateRevision,
      connectedAccountId: 'primary',
      quotaExhaustedUntilMs: resetAtMs,
    });

    await server.stop();
    server = await startServerLight({
      testDir,
      dbProvider: 'sqlite',
      extraEnv: CONNECTED_SERVICE_RECOVERY_ENV,
      preserveExistingDataDir: true,
    });
    const restartedAuth = await reauth(server.baseUrl);

    const restarted = await fetchQualifiedConnectedAccountGroup({
      serverBaseUrl: server.baseUrl,
      authToken: restartedAuth.token,
      legacyServiceId: serviceId,
      groupId,
    });
    expect(restarted).toMatchObject({
      activeConnectedAccountId: 'backup',
      members: expect.arrayContaining([
        expect.objectContaining({
          connectedAccountId: 'primary',
          state: expect.objectContaining({ quotaExhaustedUntilMs: resetAtMs }),
        }),
      ]),
    });

    const blocked = await fetchJson<unknown>(`${server.baseUrl}/v4/connect/qualified/group/active-account`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${restartedAuth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        group: restarted.ref,
        connectedAccountId: 'primary',
        expectedGeneration: restarted.generation,
        expectedIncarnation: restarted.incarnation,
        expectedRuntimeStateRevision: restarted.runtimeStateRevision,
      }),
      timeoutMs: 20_000,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.data).toEqual({ error: 'connect_group_profile_runtime_cooldown', resetAtMs });

    const cleared = await patchQualifiedConnectedAccountGroupMemberExhaustion({
      serverBaseUrl: server.baseUrl,
      authToken: restartedAuth.token,
      group: restarted,
      expectedRuntimeStateRevision: restarted.runtimeStateRevision,
      connectedAccountId: 'primary',
      quotaExhaustedUntilMs: null,
    });
    const switched = await fetchJson<unknown>(
      `${server.baseUrl}/v4/connect/qualified/group/active-account`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${restartedAuth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          group: cleared.ref,
          connectedAccountId: 'primary',
          expectedGeneration: cleared.generation,
          expectedIncarnation: cleared.incarnation,
          expectedRuntimeStateRevision: cleared.runtimeStateRevision,
        }),
        timeoutMs: 20_000,
      },
    );
    expect(switched.status).toBe(200);
    expect(asRecord(switched.data)?.group).toMatchObject({
      activeConnectedAccountId: 'primary',
      generation: cleared.generation + 1,
    });
  }, 240_000);
});
