import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import {
  attachAccountEncryptionMigrateProofSignatureV1,
  buildAccountStoredContentCompatibilityHttpHeadersV1,
  createAccountEncryptionMigrateProofSigningInputV1,
  CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  formatSharedSavedSecretRefV1,
  openEncryptedDataKeyEnvelopeV1,
  openSavedSecretResourceStoredContentV1,
  sealEncryptedDataKeyEnvelopeV1,
  sealQualifiedConnectedAccountContentEnvelope,
  sealSavedSecretResourceStoredContentV1,
  signAccountContentKeyBindingV1,
  verifyAccountContentKeyBindingV1,
  type AccountEncryptionMigrateUnsignedRequest,
} from '@happier-dev/protocol';

import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import type { Fastify } from '@/app/api/types';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { deriveAccountEncryptionMigrationKeyFingerprints } from '@/app/encryption/accountEncryptionTransition';
import { updateAccountEncryptionMode } from '@/app/api/routes/account/updateAccountEncryptionMode';
import { mutateQualifiedConnectedServiceCredential, readQualifiedConnectedServiceCredential } from '@/app/api/routes/connect/qualifiedConnectedAccounts/credentialRepository';
import {
  createSavedSecretResourceInTx,
  listSavedSecretResourceMaterialsForAccountInTx,
  promoteSavedSecretResourceInTx,
  updateSavedSecretResourceInTx,
} from './savedSecretResourceService';

const EMPTY_DOMAINS = {
  automations: { action: 'assert_empty' },
  machines: { action: 'assert_empty' },
  todos: { action: 'assert_empty' },
  artifacts: { action: 'assert_empty' },
  sessions: { action: 'assert_empty' },
  reviewComments: { action: 'assert_empty' },
  sessionOrganization: { action: 'assert_empty' },
  pets: { action: 'assert_empty' },
} as const;
const service = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
const accountRef = { service, accountId: 'work' };

function createKeys() {
  const signing = tweetnacl.sign.keyPair();
  const content = tweetnacl.box.keyPair();
  const contentPublicKeySig = signAccountContentKeyBindingV1({
    accountSigningSecretKey: signing.secretKey,
    contentPublicKey: content.publicKey,
  });
  const verified = verifyAccountContentKeyBindingV1({
    accountSigningPublicKey: signing.publicKey,
    contentPublicKey: content.publicKey,
    signature: contentPublicKeySig,
  });
  if (!verified) throw new Error('test binding must verify');
  return {
    signing,
    content,
    contentPublicKeySig,
    fingerprint: verified.contentPublicKeyFingerprint,
    row: {
      publicKey: privacyKit.encodeHex(signing.publicKey),
      contentPublicKey: new Uint8Array(content.publicKey),
      contentPublicKeySig: new Uint8Array(contentPublicKeySig),
    },
  };
}

function plainContent(name: string, kind: 'apiKey' | 'token', value: string) {
  return { t: 'plain' as const, v: { v: 1 as const, name, kind, value } };
}

/** Owner-side reseal of one resource to E2EE, exactly what the client sends. */
function resealToOwner(
  resourceId: string,
  content: ReturnType<typeof plainContent>['v'],
  accountId: string,
  keys: ReturnType<typeof createKeys>,
  fingerprint = keys.fingerprint,
) {
  const dataKey = tweetnacl.randomBytes(32);
  return {
    resourceId,
    storedContent: sealSavedSecretResourceStoredContentV1({
      resourceId,
      mode: 'e2ee',
      resourceDataKey: dataKey,
      content,
      randomBytes: tweetnacl.randomBytes,
    }),
    ownerKeyEnvelope: {
      recipientAccountId: accountId,
      recipientContentPublicKeyFingerprint: fingerprint,
      encryptedDataKey: privacyKit.encodeBase64(
        sealEncryptedDataKeyEnvelopeV1({
          dataKey,
          recipientPublicKey: keys.content.publicKey,
          randomBytes: tweetnacl.randomBytes,
        }),
      ),
    },
  };
}

function openAsOwner(
  row: { id: string; storedContent: unknown },
  envelope: Uint8Array,
  keys: ReturnType<typeof createKeys>,
) {
  const dataKey = openEncryptedDataKeyEnvelopeV1({
    envelope,
    recipientSecretKeyOrSeed: keys.content.secretKey,
  });
  if (!dataKey) return null;
  return openSavedSecretResourceStoredContentV1({
    resourceId: row.id,
    mode: 'e2ee',
    storedContent: row.storedContent as never,
    resourceDataKey: dataKey,
  });
}

describe('Saved Secret resources follow Account.encryptionMode (SQLite)', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'happier-saved-secret-account-mode-',
      initEncrypt: true,
    });
  }, 300_000);
  afterAll(async () => {
    await harness?.close();
  });

  async function migrate(accountId: string, payload: unknown) {
    const app = createAuthenticatedTestApp() as Fastify;
    const { accountRoutes } =
      await import('@/app/api/routes/account/accountRoutes');
    accountRoutes(app);
    try {
      const headers = {
        'x-test-user-id': accountId,
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(
          CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
        ),
      };
      return await app.inject({
        method: 'POST',
        url: '/v1/account/encryption/migrate',
        headers,
        payload: payload as object,
      });
    } finally {
      await app.close();
    }
  }

  async function seedPlainAccount() {
    // Resource ids are global; each seed starts from no resources.
    await db.savedSecretResourceKeyEnvelope.deleteMany();
    await db.savedSecretAccountGrant.deleteMany();
    await db.savedSecretResource.deleteMany();
    harness.resetEnv({
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
    });
    const keys = createKeys();
    const owner = await db.account.create({
      data: { encryptionMode: 'plain', settingsVersion: 2, ...keys.row },
      select: { id: true },
    });
    const friend = await db.account.create({
      data: { encryptionMode: 'plain' },
      select: { id: true },
    });
    const keyContent = plainContent(
      'Anthropic API key',
      'apiKey',
      'sk-ant-converted',
    );
    // A converted Connected Account key: its one record is promoted with the credential that references it.
    expect(
      await inTx((tx) =>
        promoteSavedSecretResourceInTx(tx, {
          accountId: owner.id,
          resourceId: 'anthropic-key',
          displayName: keyContent.v.name,
          kind: 'apiKey',
          encryptionMode: 'plain',
          storedContent: keyContent,
          nextSettings: null,
          profileMutations: [],
          referenceCensus: {
            scope: 'catalogs',
            accountMode: 'plain',
            catalogs: {},
          },
          connectedAccountCredentialMutation: {
            ref: accountRef,
            authenticationModeId: 'api-key',
            expectedCredentialRevision: null,
            metadata: { scopes: [] },
            savedSecretResourceIds: ['anthropic-key'],
            content: {
              t: 'plain',
              v: {
                v: 1,
                values: {},
                secretRefs: {
                  token: formatSharedSavedSecretRefV1('anthropic-key'),
                },
              },
            },
          },
        }),
      ),
    ).toMatchObject({ ok: true });
    const privateContent = plainContent(
      'Private token',
      'token',
      'private-value',
    );
    const sharedContent = plainContent('Shared token', 'token', 'shared-value');
    for (const [resourceId, content] of [
      ['private-token', privateContent],
      ['shared-token', sharedContent],
    ] as const) {
      expect(
        await inTx((tx) =>
          createSavedSecretResourceInTx(tx, {
            accountId: owner.id,
            resourceId,
            displayName: content.v.name,
            kind: 'token',
            encryptionMode: 'plain',
            storedContent: content,
          }),
        ),
      ).toMatchObject({ ok: true });
    }
    // The grant row is the sharing fact; eligibility rules for creating it are not under test.
    await db.savedSecretAccountGrant.create({
      data: {
        resourceId: 'shared-token',
        accountId: friend.id,
        createdByAccountId: owner.id,
      },
    });
    return { keys, owner, friend, keyContent, privateContent, sharedContent };
  }

  async function toE2eeRequest(
    seed: Awaited<ReturnType<typeof seedPlainAccount>>,
    savedSecretResources?: unknown,
  ) {
    const { keys, owner } = seed;
    const captured = await db.account.findUniqueOrThrow({
      where: { id: owner.id },
    });
    const fingerprints =
      deriveAccountEncryptionMigrationKeyFingerprints(captured);
    const credential = await readQualifiedConnectedServiceCredential({
      accountId: owner.id,
      ref: accountRef,
    });
    if (
      credential.status !== 'resolved' ||
      credential.credential.revisionSemantics !== 'revisioned'
    )
      throw new Error('credential must be revisioned');
    const material = {
      type: 'dataKey' as const,
      machineKey: keys.content.secretKey,
    };
    const unsigned = {
      toMode: 'e2ee',
      expectedAccountVersion: captured.seq,
      expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
      expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
      expectedSettingsVersion: captured.settingsVersion,
      settingsContent: null,
      keyProof: {
        v: 1,
        publicKey: privacyKit.encodeBase64(keys.signing.publicKey),
        contentPublicKey: privacyKit.encodeBase64(keys.content.publicKey),
        contentPublicKeySig: privacyKit.encodeBase64(keys.contentPublicKeySig),
      },
      connectedServices: {
        action: 'migrate',
        credentials: [],
        qualifiedCredentials: [
          {
            ref: accountRef,
            expectedCredentialRevision:
              credential.credential.credentialRevision,
            expectedConfigurationRevision: null,
            authenticationModeId: 'api-key',
            metadata: credential.credential.metadata,
            replacementCredentialContentEnvelope:
              sealQualifiedConnectedAccountContentEnvelope({
                kind: 'credential',
                accountMode: 'e2ee',
                material,
                payload: {
                  v: 1,
                  values: {},
                  secretRefs: {
                    token: formatSharedSavedSecretRefV1('anthropic-key'),
                  },
                },
                randomBytes: tweetnacl.randomBytes,
              }),
          },
        ],
      },
      ...EMPTY_DOMAINS,
      ...(savedSecretResources ? { savedSecretResources } : {}),
    } as AccountEncryptionMigrateUnsignedRequest;
    const signingInput = createAccountEncryptionMigrateProofSigningInputV1({
      request: unsigned,
      accountId: owner.id,
      sourceMode: 'plain',
    });
    return attachAccountEncryptionMigrateProofSignatureV1({
      request: unsigned,
      signature: privacyKit.encodeBase64(
        tweetnacl.sign.detached(signingInput, keys.signing.secretKey),
      ),
    });
  }

  const readResources = (ownerAccountId: string) =>
    db.savedSecretResource.findMany({
      where: { ownerAccountId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        encryptionMode: true,
        revision: true,
        storedContent: true,
        keyEnvelopes: true,
        accountGrants: { select: { accountId: true } },
      },
    });

  it('refuses a Plain-to-E2EE switch that would leave owned unshared Saved Secrets server-readable', async () => {
    const seed = await seedPlainAccount();
    const before = await readResources(seed.owner.id);
    const response = await migrate(seed.owner.id, await toE2eeRequest(seed));
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'invalid-params',
      reason: 'migration_inventory_changed',
    });
    expect(
      (await db.account.findUniqueOrThrow({ where: { id: seed.owner.id } }))
        .encryptionMode,
    ).toBe('plain');
    expect(await readResources(seed.owner.id)).toEqual(before);
  });

  it('reseals the converted key and the private secret to the owner atomically with the credential, and keeps a shared one readable', async () => {
    const seed = await seedPlainAccount();
    const { owner, keys } = seed;
    const items = [
      {
        ...resealToOwner('anthropic-key', seed.keyContent.v, owner.id, keys),
        expectedRevision: 1,
      },
      {
        ...resealToOwner(
          'private-token',
          seed.privateContent.v,
          owner.id,
          keys,
        ),
        expectedRevision: 1,
      },
    ];
    // A shared resource is not this migration's to reseal: naming it refuses the whole switch.
    const sharedNamed = await migrate(
      owner.id,
      await toE2eeRequest(seed, {
        items: [
          ...items,
          {
            ...resealToOwner(
              'shared-token',
              seed.sharedContent.v,
              owner.id,
              keys,
            ),
            expectedRevision: 1,
          },
        ],
      }),
    );
    expect(sharedNamed.statusCode, sharedNamed.body).toBe(400);
    // An owner envelope sealed to any key but the verified target one refuses the switch with nothing written.
    const wrongKey = await migrate(
      owner.id,
      await toE2eeRequest(seed, {
        items: [
          items[0],
          {
            ...items[1],
            ownerKeyEnvelope: {
              ...items[1]!.ownerKeyEnvelope,
              recipientContentPublicKeyFingerprint: createKeys().fingerprint,
            },
          },
        ],
      }),
    );
    expect(wrongKey.statusCode, wrongKey.body).toBe(400);
    expect(
      (await readResources(owner.id)).map((row) => [
        row.id,
        row.encryptionMode,
        row.revision,
      ]),
    ).toEqual([
      ['anthropic-key', 'plain', 1],
      ['private-token', 'plain', 1],
      ['shared-token', 'plain', 1],
    ]);
    expect(
      (await db.account.findUniqueOrThrow({ where: { id: owner.id } }))
        .encryptionMode,
    ).toBe('plain');

    const response = await migrate(
      owner.id,
      await toE2eeRequest(seed, { items }),
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await db.account.findUniqueOrThrow({ where: { id: owner.id } }))
        .encryptionMode,
    ).toBe('e2ee');
    const rows = await readResources(owner.id);
    for (const [id, value] of [
      ['anthropic-key', 'sk-ant-converted'],
      ['private-token', 'private-value'],
    ] as const) {
      const row = rows.find((candidate) => candidate.id === id)!;
      expect(row).toMatchObject({ encryptionMode: 'e2ee', revision: 2 });
      expect(row.storedContent).not.toContain(value);
      expect(
        row.keyEnvelopes.map((envelope) => [
          envelope.recipientAccountId,
          envelope.recipientContentPublicKeyFingerprint,
        ]),
      ).toEqual([[owner.id, keys.fingerprint]]);
      const material = (
        await inTx((tx) =>
          listSavedSecretResourceMaterialsForAccountInTx(tx, owner.id),
        )
      ).find(
        (candidate) => 'resourceId' in candidate && candidate.resourceId === id,
      )!;
      expect(material).toMatchObject({
        encryptionMode: 'e2ee',
        entry: { materialStatus: 'ready', capabilities: { use: true } },
      });
      const projected = material as Extract<
        typeof material,
        { resourceId: string }
      >;
      expect(
        openAsOwner(
          { id, storedContent: projected.storedContent },
          projected.encryptedDataKey!,
          keys,
        ),
      ).toMatchObject({ value });
    }
    // The shared resource keeps its mode and its recipient.
    expect(rows.find((row) => row.id === 'shared-token')).toMatchObject({
      encryptionMode: 'plain',
      revision: 1,
      accountGrants: [{ accountId: seed.friend.id }],
    });
    const friendView = await inTx((tx) =>
      listSavedSecretResourceMaterialsForAccountInTx(tx, seed.friend.id),
    );
    expect(friendView).toEqual([
      expect.objectContaining({
        resourceId: 'shared-token',
        encryptionMode: 'plain',
        entry: expect.objectContaining({ materialStatus: 'ready' }),
      }),
    ]);
    // The credential still names its one record.
    const credential = await readQualifiedConnectedServiceCredential({
      accountId: owner.id,
      ref: accountRef,
    });
    expect(credential).toMatchObject({
      status: 'resolved',
      credential: { content: { t: 'encrypted' } },
    });
  });

  it('on an E2EE Account, never writes Plain material: create and rotate are refused or re-sealed to E2EE', async () => {
    const keys = createKeys();
    const owner = await db.account.create({ data: { encryptionMode: 'plain', ...keys.row }, select: { id: true } });
    const friend = await db.account.create({ data: { encryptionMode: 'plain' }, select: { id: true } });
    const content = plainContent('Shared token', 'token', 'old-value');
    // A shared resource a Plain-to-E2EE switch left Plain: created Plain, shared, then the Account mode flips.
    expect(await inTx((tx) => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId: 'left-plain',
      displayName: content.v.name, kind: 'token', encryptionMode: 'plain', storedContent: content }))).toMatchObject({ ok: true });
    await db.savedSecretAccountGrant.create({ data: { resourceId: 'left-plain', accountId: friend.id, createdByAccountId: owner.id } });
    await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee' } });
    expect(await inTx((tx) => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId: 'new-plain',
      displayName: content.v.name, kind: 'token', encryptionMode: 'plain', storedContent: content }))).toEqual({ ok: false, error: 'account_mode_mismatch' });
    const stored = await db.savedSecretResource.findUniqueOrThrow({
      where: { id: 'left-plain' },
    });
    const rotated = plainContent('Shared token', 'token', 'new-value');
    expect(
      await inTx((tx) =>
        updateSavedSecretResourceInTx(tx, {
          accountId: owner.id,
          resourceId: 'left-plain',
          expectedRevision: stored.revision,
          displayName: rotated.v.name,
          kind: 'token',
          storedContent: rotated,
        }),
      ),
    ).toEqual({ ok: false, error: 'account_mode_mismatch' });
    expect(
      await db.savedSecretResource.findUniqueOrThrow({
        where: { id: 'left-plain' },
      }),
    ).toEqual(stored);
    const resealed = resealToOwner('left-plain', rotated.v, owner.id, keys);
    expect(
      await inTx((tx) =>
        updateSavedSecretResourceInTx(tx, {
          accountId: owner.id,
          resourceId: 'left-plain',
          expectedRevision: stored.revision,
          displayName: rotated.v.name,
          kind: 'token',
          toMode: 'e2ee',
          storedContent: resealed.storedContent,
          keyEnvelopes: [
            {
              ...resealed.ownerKeyEnvelope,
              encryptedDataKey: privacyKit.decodeBase64(
                resealed.ownerKeyEnvelope.encryptedDataKey,
              ),
            },
          ],
        }),
      ),
    ).toMatchObject({ ok: true });
    const after = await db.savedSecretResource.findUniqueOrThrow({
      where: { id: 'left-plain' },
      include: { accountGrants: true },
    });
    expect(after).toMatchObject({
      encryptionMode: 'e2ee',
      accountGrants: [expect.objectContaining({ accountId: friend.id })],
    });
    expect(after.storedContent).not.toContain('new-value');
    // The Plain recipient is not silently cut off: it sees the existing readiness state.
    const friendView = await inTx((tx) =>
      listSavedSecretResourceMaterialsForAccountInTx(tx, friend.id),
    );
    expect(friendView).toEqual([
      expect.objectContaining({
        resourceId: 'left-plain',
        entry: expect.objectContaining({
          materialStatus: 'recipient_mode_unsupported',
        }),
      }),
    ]);
  });

  it('E2EE-to-Plain reseals owned unshared resources to Plain and refuses a switch that would strand them', async () => {
    harness.resetEnv({
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
      HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1',
      HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST: 'none',
    });
    const keys = createKeys();
    const owner = await db.account.create({
      data: { encryptionMode: 'e2ee', ...keys.row, settings: null },
      select: { id: true },
    });
    const content = plainContent('Private token', 'token', 'private-value');
    const sealed = resealToOwner('e2ee-token', content.v, owner.id, keys);
    expect(
      await inTx((tx) =>
        createSavedSecretResourceInTx(tx, {
          accountId: owner.id,
          resourceId: 'e2ee-token',
          displayName: content.v.name,
          kind: 'token',
          encryptionMode: 'e2ee',
          storedContent: sealed.storedContent,
          keyEnvelopes: [
            {
              ...sealed.ownerKeyEnvelope,
              encryptedDataKey: privacyKit.decodeBase64(
                sealed.ownerKeyEnvelope.encryptedDataKey,
              ),
            },
          ],
        }),
      ),
    ).toMatchObject({ ok: true });
    const captured = await db.account.findUniqueOrThrow({
      where: { id: owner.id },
    });
    const fingerprints =
      deriveAccountEncryptionMigrationKeyFingerprints(captured);
    const request = (savedSecretResources?: unknown) => ({
      toMode: 'plain',
      expectedAccountVersion: captured.seq,
      expectedSigningKeyFingerprint: fingerprints.signingKeyFingerprint,
      expectedContentKeyFingerprint: fingerprints.contentKeyFingerprint,
      expectedSettingsVersion: 0,
      settingsContent: null,
      connectedServices: { action: 'assert_empty' },
      ...EMPTY_DOMAINS,
      ...(savedSecretResources ? { savedSecretResources } : {}),
    });
    const stranded = await migrate(owner.id, request());
    expect(stranded.statusCode, stranded.body).toBe(400);
    expect(
      (await db.account.findUniqueOrThrow({ where: { id: owner.id } }))
        .encryptionMode,
    ).toBe('e2ee');
    const converted = await migrate(
      owner.id,
      request({
        items: [
          {
            resourceId: 'e2ee-token',
            expectedRevision: 1,
            storedContent: content,
          },
        ],
      }),
    );
    expect(converted.statusCode, converted.body).toBe(200);
    expect(
      await db.savedSecretResource.findUniqueOrThrow({
        where: { id: 'e2ee-token' },
        include: { keyEnvelopes: true },
      }),
    ).toMatchObject({ encryptionMode: 'plain', revision: 2, keyEnvelopes: [] });
    expect(
      await inTx((tx) =>
        listSavedSecretResourceMaterialsForAccountInTx(tx, owner.id),
      ),
    ).toEqual([
      expect.objectContaining({
        resourceId: 'e2ee-token',
        encryptionMode: 'plain',
        storedContent: content,
      }),
    ]);
  });
  it('an edit of an already-converted key never mints a second record beside the first (one record per key)', async () => {
    const seed = await seedPlainAccount();
    const { owner } = seed;
    const basis = await readQualifiedConnectedServiceCredential({ accountId: owner.id, ref: accountRef });
    if (basis.status !== 'resolved' || basis.credential.revisionSemantics !== 'revisioned') throw new Error('credential must be revisioned');
    const edited = plainContent('Anthropic API key', 'apiKey', 'sk-ant-second');
    const outcome = await inTx((tx) => promoteSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId: 'anthropic-key-2',
      displayName: edited.v.name, kind: 'apiKey', encryptionMode: 'plain', storedContent: edited, nextSettings: null, profileMutations: [],
      referenceCensus: { scope: 'catalogs', accountMode: 'plain', catalogs: {} },
      connectedAccountCredentialMutation: { ref: accountRef, authenticationModeId: 'api-key',
        expectedCredentialRevision: basis.credential.credentialRevision, expectedConfigurationRevision: null,
        metadata: { scopes: [] }, savedSecretResourceIds: ['anthropic-key-2'],
        content: { t: 'plain', v: { v: 1, values: {}, secretRefs: { token: formatSharedSavedSecretRefV1('anthropic-key-2') } } } } }))
      .catch((error: { error?: string }) => ({ ok: false, error: error.error }));
    expect(outcome).toEqual({ ok: false, error: 'references_conflict' });
    expect((await readResources(owner.id)).map((row) => row.id)).toEqual(['anthropic-key', 'private-token', 'shared-token']);
    const after = await readQualifiedConnectedServiceCredential({ accountId: owner.id, ref: accountRef });
    expect(after).toMatchObject({ status: 'resolved', credential: { credentialRevision: basis.credential.credentialRevision } });
  });
  it('no reconnect path can leave a second copy beside a converted key; the record itself rotates and keeps its grants', async () => {
    const seed = await seedPlainAccount();
    const { owner } = seed;
    await db.savedSecretAccountGrant.create({ data: { resourceId: 'anthropic-key', accountId: seed.friend.id, createdByAccountId: owner.id } });
    const basis = await readQualifiedConnectedServiceCredential({ accountId: owner.id, ref: accountRef });
    if (basis.status !== 'resolved' || basis.credential.revisionSemantics !== 'revisioned') throw new Error('credential must be revisioned');
    // The daemon reconnect settlement shape: inline values, an empty Saved Secret id set.
    const reconnect = await mutateQualifiedConnectedServiceCredential({ accountId: owner.id, ref: accountRef, authenticationModeId: 'api-key',
      expectedCredentialRevision: basis.credential.credentialRevision, expectedConfigurationRevision: null, metadata: { scopes: [] },
      savedSecretResourceIds: [], content: { t: 'plain', v: { v: 1, values: { token: 'sk-ant-reconnected' } } } });
    expect(reconnect).toEqual({ status: 'saved_secret_held' });
    // Another person's resource id cannot be attached either, and nothing moved.
    const foreign = await mutateQualifiedConnectedServiceCredential({ accountId: owner.id, ref: accountRef, authenticationModeId: 'api-key',
      expectedCredentialRevision: basis.credential.credentialRevision, expectedConfigurationRevision: null, metadata: { scopes: [] },
      savedSecretResourceIds: ['someone-elses-key'], content: { t: 'plain', v: { v: 1, values: {}, secretRefs: { token: formatSharedSavedSecretRefV1('someone-elses-key') } } } });
    expect(foreign).toEqual({ status: 'saved_secret_held' });
    expect(await readQualifiedConnectedServiceCredential({ accountId: owner.id, ref: accountRef }))
      .toMatchObject({ status: 'resolved', credential: { credentialRevision: basis.credential.credentialRevision } });
    // The supported rotation writes the new key into the one record, which keeps its id and grant.
    const rotated = plainContent('Anthropic API key', 'apiKey', 'sk-ant-reconnected');
    expect(await inTx((tx) => updateSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId: 'anthropic-key', expectedRevision: 1,
      displayName: rotated.v.name, kind: 'apiKey', storedContent: rotated }))).toMatchObject({ ok: true });
    const rows = await readResources(owner.id);
    expect(rows.map((row) => row.id)).toEqual(['anthropic-key', 'private-token', 'shared-token']);
    expect(rows[0]).toMatchObject({ revision: 2, accountGrants: [{ accountId: seed.friend.id }] });
    const material = (await inTx((tx) => listSavedSecretResourceMaterialsForAccountInTx(tx, owner.id))).find((row) => 'resourceId' in row && row.resourceId === 'anthropic-key');
    expect(material).toMatchObject({ storedContent: { t: 'plain', v: { value: 'sk-ant-reconnected' } } });
  });
  it('the legacy empty-only PATCH cannot switch E2EE to Plain while owned E2EE Saved Secrets would be stranded', async () => {
    harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT: '1' });
    const keys = createKeys();
    const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...keys.row, settings: null }, select: { id: true } });
    const content = plainContent('Private token', 'token', 'private-value');
    const sealed = resealToOwner('patch-e2ee-token', content.v, owner.id, keys);
    expect(await inTx((tx) => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId: 'patch-e2ee-token', displayName: content.v.name,
      kind: 'token', encryptionMode: 'e2ee', storedContent: sealed.storedContent,
      keyEnvelopes: [{ ...sealed.ownerKeyEnvelope, encryptedDataKey: privacyKit.decodeBase64(sealed.ownerKeyEnvelope.encryptedDataKey) }] }))).toMatchObject({ ok: true });
    expect(await updateAccountEncryptionMode({ accountId: owner.id, mode: 'plain' })).toEqual({ status: 'migration_required' });
    expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).encryptionMode).toBe('e2ee');
  });

  it('on an E2EE Account, a Plain rotation of a resource that is still Plain needs the confirmed Home-managed directive', async () => {
    const keys = createKeys();
    const owner = await db.account.create({ data: { encryptionMode: 'plain', ...keys.row }, select: { id: true } });
    const content = plainContent('Shared token', 'token', 'old-value');
    expect(await inTx((tx) => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId: 'still-plain', displayName: content.v.name,
      kind: 'token', encryptionMode: 'plain', storedContent: content }))).toMatchObject({ ok: true });
    await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee' } });
    const rotated = plainContent('Shared token', 'token', 'new-value');
    expect(await inTx((tx) => updateSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId: 'still-plain', expectedRevision: 1,
      displayName: rotated.v.name, kind: 'token', storedContent: rotated }))).toEqual({ ok: false, error: 'account_mode_mismatch' });
    // "Keep Home-managed": the same confirmed directive the conversion uses keeps it Plain, in place.
    expect(await inTx((tx) => updateSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId: 'still-plain', expectedRevision: 1,
      displayName: rotated.v.name, kind: 'token', toMode: 'plain', storedContent: rotated }))).toEqual({ ok: true, value: { resourceId: 'still-plain', revision: 2 } });
    expect(await db.savedSecretResource.findUniqueOrThrow({ where: { id: 'still-plain' } })).toMatchObject({ encryptionMode: 'plain', revision: 2 });
  });
});
