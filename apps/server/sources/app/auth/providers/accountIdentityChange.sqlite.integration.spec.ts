import tweetnacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPasswordMutationChallengeSigningInputV1,
  encodePasswordCredentialFieldV1,
} from '@happier-dev/protocol';
import {
  isAccountCurrentnessChangeV1,
  readAccountIdentitiesChangeV1,
} from '@happier-dev/protocol/changes';
import * as privacyKit from 'privacy-kit';

import { registerAccountSecurityRoutes } from '@/app/api/routes/auth/registerAccountSecurityRoutes';
import { changesRoutes } from '@/app/api/routes/changes/changesRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { hashPasswordMaterial } from '@/app/auth/password/passwordMaterialVerifier';
import { issuePasswordMutationKeyChallengeV1 } from '@/app/auth/keyChallengeV2';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { HOME_GOVERNANCE_POLICY_ID } from '@/app/home/governance/governancePolicy';
import { initEncrypt } from '@/modules/encrypt';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';

type FeedChange = {
  kind: string;
  entityId: string;
  cursor: number;
  hint?: unknown;
};

// Runs on SQLite (integration) and on PostgreSQL/MySQL through the disposable DB-contract runner.
describe('linked-identity AccountChange durability', () => {
  let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
  beforeAll(async () => {
    harness = await createDatabaseIntegrationHarness({
      tempDirPrefix: 'account-identity-change-',
      env: {
        HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: 'true',
        AUTH_REQUIRED_LOGIN_PROVIDERS: '',
        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
        HAPPIER_SERVER_IDENTITY_ID: 'srv_identity_change_home',
        HANDY_MASTER_SECRET: 'disposable-identity-change-contract',
      },
    });
    await initEncrypt();
  }, 120_000);
  afterAll(async () => {
    await db.homeGovernancePolicy.deleteMany({
      where: { id: HOME_GOVERNANCE_POLICY_ID },
    });
    await harness?.close();
  });

  it('keeps a password-removal identity fact for a continuously connected reader across same-transaction and later self writes', async () => {
    const signing = tweetnacl.sign.keyPair();
    const account = await db.account.create({
      data: {
        encryptionMode: 'e2ee',
        publicKey: privacyKit.encodeHex(new Uint8Array(signing.publicKey)),
      },
    });
    const email = `identity-change-${account.id}@example.test`;
    await db.accountIdentity.create({
      data: {
        accountId: account.id,
        provider: 'email',
        providerUserId: email,
        profile: {},
      },
    });
    const field = (length: number) =>
      encodePasswordCredentialFieldV1(new Uint8Array(length));
    await db.accountPasswordCredential.create({
      data: {
        accountId: account.id,
        credential: {
          v: 1,
          kind: 'e2ee_password_envelope',
          authVerifier: {
            v: 1,
            hash: await hashPasswordMaterial(new Uint8Array(32)),
          },
          envelope: {
            v: 1,
            accountSigningPublicKey: encodePasswordCredentialFieldV1(
              new Uint8Array(signing.publicKey),
            ),
            kdf: {
              algorithm: 'argon2id13',
              salt: field(16),
              opsLimit: 3,
              memLimitBytes: 67108864,
              outputBytes: 32,
            },
            cipher: {
              algorithm: 'aes256gcm',
              nonce: field(12),
              ciphertext: field(48),
            },
          },
        },
      },
    });
    // The Account keeps a key-challenge login route after the password goes.
    await db.homeGovernancePolicy.upsert({
      where: { id: HOME_GOVERNANCE_POLICY_ID },
      create: {
        id: HOME_GOVERNANCE_POLICY_ID,
        authenticationPolicy: {
          v: 1,
          enabledMethodIds: ['email_password', 'key_challenge'],
        },
      },
      update: {
        authenticationPolicy: {
          v: 1,
          enabledMethodIds: ['email_password', 'key_challenge'],
        },
      },
    });
    const challenge = await issuePasswordMutationKeyChallengeV1({
      env: process.env,
      mutation: {
        v: 1,
        action: 'remove',
        accountId: account.id,
        expectedCredentialRevision: 1,
        normalizedNativeEmail: email,
        newCredentialDigest: null,
      },
    });
    if (!challenge) throw new Error('challenge unavailable');
    const proof = {
      challengeId: challenge.challengeId,
      publicKey: encodePasswordCredentialFieldV1(
        new Uint8Array(signing.publicKey),
      ),
      signature: encodePasswordCredentialFieldV1(
        new Uint8Array(
          tweetnacl.sign.detached(
            createPasswordMutationChallengeSigningInputV1(challenge),
            signing.secretKey,
          ),
        ),
      ),
    };
    const connectedCursor = (
      await db.account.findUniqueOrThrow({
        where: { id: account.id },
        select: { seq: true },
      })
    ).seq;

    await withAuthenticatedTestApp(
      (app) => {
        registerAccountSecurityRoutes(app);
        changesRoutes(app);
      },
      async (app) => {
        const headers = { 'x-test-user-id': account.id };
        const readFeed = async (after: number): Promise<FeedChange[]> => {
          const response = await app.inject({
            method: 'GET',
            url: `/v2/changes?after=${after}`,
            headers,
          });
          expect(response.statusCode, response.body).toBe(200);
          return response.json().changes;
        };
        const removed = await app.inject({
          method: 'POST',
          url: '/v1/account/password/remove',
          headers,
          payload: { v: 1, kind: 'e2ee', expectedCredentialRevision: 1, proof },
        });
        expect(removed.statusCode, removed.body).toBe(200);
        expect(
          await db.accountIdentity.count({
            where: { accountId: account.id, provider: 'email' },
          }),
        ).toBe(0);

        // The same password-removal transaction also writes its hint-free security `self` fact.
        const afterRemoval = await readFeed(connectedCursor);
        expect(afterRemoval.filter(readAccountIdentitiesChangeV1)).toHaveLength(
          1,
        );
        const removalCursor = Math.max(
          ...afterRemoval.map((change) => change.cursor),
        );

        // A later unrelated settings write still replaces `self` but not the identity fact.
        await inTx((tx) =>
          markAccountChanged(tx, {
            accountId: account.id,
            kind: 'account',
            entityId: 'self',
            hint: { settingsVersion: 3 },
          }),
        );
        const caughtUp = await readFeed(connectedCursor);
        expect(caughtUp.filter(readAccountIdentitiesChangeV1)).toHaveLength(1);
        expect(
          caughtUp.find((change) => change.entityId === 'self')?.hint,
        ).toEqual({ settingsVersion: 3 });
        expect(caughtUp.some(isAccountCurrentnessChangeV1)).toBe(true);

        // Cursor-relative: a reader that already consumed the removal sees only the settings fact.
        const later = await readFeed(removalCursor);
        expect(later).toEqual([
          expect.objectContaining({
            kind: 'account',
            entityId: 'self',
            hint: { settingsVersion: 3 },
          }),
        ]);
        expect(later.some(readAccountIdentitiesChangeV1)).toBe(false);
        expect(later.some(isAccountCurrentnessChangeV1)).toBe(false);
      },
    );
  });
});
