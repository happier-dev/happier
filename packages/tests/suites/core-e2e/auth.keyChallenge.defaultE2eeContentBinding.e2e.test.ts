import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { afterAll, describe, expect, it } from 'vitest';

import {
  AccountEncryptionCurrentnessResponseSchema,
  AccountSettingsV2GetResponseSchema,
  computeAccountEncryptionMigrateKeyFingerprintV1,
  deriveAccountMachineKeyFromRecoverySecret,
} from '@happier-dev/protocol';

import { createTestAuth } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });

describe('core e2e: key-challenge test auth content-key binding', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop().catch(() => {});
    server = null;
  }, 60_000);

  it('provisions a fresh default-E2EE Account with the binding for its exact legacy client material', async () => {
    const testDir = run.testDir(`auth-key-challenge-content-binding-${randomUUID()}`);
    server = await startServerLight({
      testDir,
      extraEnv: {
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'required_e2ee',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'e2ee',
      },
    });

    const auth = await createTestAuth(server.baseUrl);
    expect(auth.accountMachineKey).toEqual(
      deriveAccountMachineKeyFromRecoverySecret(auth.accountSigningSeed),
    );
    const contentPublicKey = Uint8Array.from(
      tweetnacl.box.keyPair.fromSecretKey(auth.accountMachineKey).publicKey,
    );
    const expectedContentKeyFingerprint =
      computeAccountEncryptionMigrateKeyFingerprintV1(contentPublicKey);
    const unrelatedDaemonContentKeyFingerprint =
      computeAccountEncryptionMigrateKeyFingerprintV1(
        tweetnacl.box.keyPair.fromSecretKey(
          deriveAccountMachineKeyFromRecoverySecret(new Uint8Array(32).fill(0x5a)),
        ).publicKey,
      );

    const currentnessResponse = await fetchJson<unknown>(
      `${server.baseUrl}/v1/account/encryption/currentness`,
      {
        headers: { Authorization: `Bearer ${auth.token}` },
        timeoutMs: 20_000,
      },
    );
    expect(currentnessResponse.status).toBe(200);
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse(currentnessResponse.data);
    expect(currentness).toMatchObject({
      mode: 'e2ee',
      version: 0,
      contentKeyFingerprint: expectedContentKeyFingerprint,
    });
    expect(currentness.contentKeyFingerprint).not.toBe(unrelatedDaemonContentKeyFingerprint);

    const settingsResponse = await fetchJson<unknown>(`${server.baseUrl}/v2/account/settings`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      timeoutMs: 20_000,
    });
    expect(settingsResponse.status).toBe(200);
    expect(AccountSettingsV2GetResponseSchema.parse(settingsResponse.data)).toEqual({
      content: null,
      version: 0,
    });
  }, 240_000);
});
