import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import {
  openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
} from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import {
  openSavedSecretResourceStoredContentV1,
  sealSavedSecretResourceStoredContentV1,
} from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import {
  SavedSecretResourceMaterialV1Schema,
  type SavedSecretResourceMaterialV1,
} from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { buildAccountEncryptionSavedSecretResourcesDirective } from './buildAccountEncryptionSavedSecretResourcesDirective';

const ownerId = 'owner-account';
const noAudience = { accounts: [], teams: [], groups: [] };

function material(
  input: Readonly<{
    resourceId: string;
    mode: 'plain' | 'e2ee';
    value: string;
    relationship?: 'owner' | 'recipient';
    audience?:
      | typeof noAudience
      | {
          accounts: [];
          teams: [{ kind: 'team'; teamId: string; name: string }];
          groups: [];
        };
    ownerKey?: Uint8Array;
  }>,
): SavedSecretResourceMaterialV1 {
  const content = {
    v: 1 as const,
    name: `Name ${input.resourceId}`,
    kind: 'token' as const,
    value: input.value,
  };
  const dataKey = new Uint8Array(32).fill(input.resourceId.length);
  const storedContent =
    input.mode === 'plain'
      ? sealSavedSecretResourceStoredContentV1({
          resourceId: input.resourceId,
          mode: 'plain',
          content,
        })
      : sealSavedSecretResourceStoredContentV1({
          resourceId: input.resourceId,
          mode: 'e2ee',
          resourceDataKey: dataKey,
          content,
          randomBytes: tweetnacl.randomBytes,
        });
  const relationship = input.relationship ?? 'owner';
  return SavedSecretResourceMaterialV1Schema.parse({
    resourceId: input.resourceId,
    encryptionMode: input.mode,
    storedContent,
    recipientEnvelope:
      input.mode === 'e2ee'
        ? {
            encryptedDataKey: encodeBase64(
              sealEncryptedDataKeyEnvelopeV1({
                dataKey,
                recipientPublicKey: input.ownerKey!,
                randomBytes: tweetnacl.randomBytes,
              }),
              'base64',
            ),
            recipientContentPublicKeyFingerprint:
              computeContentPublicKeyFingerprint(input.ownerKey!),
          }
        : null,
    entry: {
      ref: formatSharedSavedSecretRefV1(input.resourceId),
      source: 'shared_resource',
      relationship,
      name: content.name,
      kind: 'token',
      encryptionMode: input.mode,
      audience:
        relationship === 'owner' ? (input.audience ?? noAudience) : null,
      revision: 3,
      materialStatus: 'ready',
      capabilities: {
        use: true,
        rename: true,
        rotate: true,
        manageAccess: true,
        delete: true,
      },
    },
  });
}

describe('Account-mode migration Saved Secret reseal', () => {
  it('reseals every owned unshared resource to the owner in E2EE and leaves shared or received ones alone', async () => {
    const target = tweetnacl.box.keyPair();
    const directive = await buildAccountEncryptionSavedSecretResourcesDirective(
      {
        accountId: ownerId,
        fromMode: 'plain',
        toMode: 'e2ee',
        resources: [
          material({
            resourceId: 'converted-key',
            mode: 'plain',
            value: 'sk-converted',
          }),
          material({
            resourceId: 'private-token',
            mode: 'plain',
            value: 'private-value',
          }),
          material({
            resourceId: 'shared-token',
            mode: 'plain',
            value: 'shared',
            audience: {
              accounts: [],
              teams: [{ kind: 'team', teamId: 'team-a', name: 'Team A' }],
              groups: [],
            },
          }),
          material({
            resourceId: 'received-token',
            mode: 'plain',
            value: 'theirs',
            relationship: 'recipient',
          }),
        ],
        openSourceDataKey: async () => null,
        targetContentPublicKey: target.publicKey,
      },
    );
    expect(
      directive?.items.map((item) => [
        item.resourceId,
        item.expectedRevision,
        item.storedContent.t,
      ]),
    ).toEqual([
      ['converted-key', 3, 'encrypted'],
      ['private-token', 3, 'encrypted'],
    ]);
    for (const [item, value] of [
      [directive!.items[0]!, 'sk-converted'],
      [directive!.items[1]!, 'private-value'],
    ] as const) {
      expect(item.ownerKeyEnvelope).toMatchObject({
        recipientAccountId: ownerId,
        recipientContentPublicKeyFingerprint:
          computeContentPublicKeyFingerprint(target.publicKey),
      });
      const dataKey = openEncryptedDataKeyEnvelopeV1({
        envelope: decodeBase64(
          item.ownerKeyEnvelope!.encryptedDataKey,
          'base64',
        ),
        recipientSecretKeyOrSeed: target.secretKey,
      });
      expect(
        openSavedSecretResourceStoredContentV1({
          resourceId: item.resourceId,
          mode: 'e2ee',
          storedContent: item.storedContent,
          resourceDataKey: dataKey!,
        }),
      ).toMatchObject({ value });
      expect(JSON.stringify(item)).not.toContain(value);
    }
  });

  it('opens owned E2EE resources with the source key and reseals them Plain, without an envelope', async () => {
    const source = tweetnacl.box.keyPair();
    const directive = await buildAccountEncryptionSavedSecretResourcesDirective(
      {
        accountId: ownerId,
        fromMode: 'e2ee',
        toMode: 'plain',
        resources: [
          material({
            resourceId: 'e2ee-token',
            mode: 'e2ee',
            value: 'private-value',
            ownerKey: source.publicKey,
          }),
        ],
        openSourceDataKey: async (encryptedDataKey) =>
          openEncryptedDataKeyEnvelopeV1({
            envelope: decodeBase64(encryptedDataKey, 'base64'),
            recipientSecretKeyOrSeed: source.secretKey,
          }),
        targetContentPublicKey: null,
      },
    );
    expect(directive).toEqual({
      items: [
        {
          resourceId: 'e2ee-token',
          expectedRevision: 3,
          storedContent: {
            t: 'plain',
            v: {
              v: 1,
              name: 'Name e2ee-token',
              kind: 'token',
              value: 'private-value',
            },
          },
        },
      ],
    });
  });

  it('fails closed when an owned unshared resource cannot be opened, instead of omitting it', async () => {
    await expect(
      buildAccountEncryptionSavedSecretResourcesDirective({
        accountId: ownerId,
        fromMode: 'e2ee',
        toMode: 'plain',
        resources: [
          material({
            resourceId: 'e2ee-token',
            mode: 'e2ee',
            value: 'private-value',
            ownerKey: tweetnacl.box.keyPair().publicKey,
          }),
        ],
        openSourceDataKey: async () => null,
        targetContentPublicKey: null,
      }),
    ).rejects.toThrow('saved_secret_migration_unavailable');
    expect(
      await buildAccountEncryptionSavedSecretResourcesDirective({
        accountId: ownerId,
        fromMode: 'plain',
        toMode: 'e2ee',
        resources: [],
        openSourceDataKey: async () => null,
        targetContentPublicKey: tweetnacl.box.keyPair().publicKey,
      }),
    ).toBeUndefined();
  });
});
