import { describe, expect, it } from 'vitest';
import { projectPrivateLabelForRecipientV1, sealPrivateLabelV1 } from '../../crypto/privateLabelV1.js';

import {
  projectSavedSecretCatalogCollisionStateV1,
  formatSavedSecretCatalogReferenceV1,
  isSharedSavedSecretReferenceV1,
  parseSavedSecretCatalogReferenceV1,
  SavedSecretCatalogEntryV1Schema,
  SavedSecretCatalogResultV1Schema,
  SavedSecretResourceEnvelopeCensusResponseV1Schema,
  SavedSecretResourceMaterialV1Schema,
  SavedSecretResourceMaterialsResponseV1Schema,
} from './savedSecretCatalogV1.js';

describe('Saved Secret catalog collision projection', () => {
  it('projects only genuine shared-reference collisions and stays idempotent', () => {
    const colliding = {
      id: 'happier:shared-secret:v1:legacy-personal',
      updatedAt: 7,
    };
    const secrets = [
      { id: 'personal', updatedAt: 1 },
      { id: 'happier:shared-secret:v1:', updatedAt: 2 },
      colliding,
    ];

    expect(projectSavedSecretCatalogCollisionStateV1(secrets)).toEqual({
      status: 'migration_required',
      collisions: [{ ref: colliding.id, expectedUpdatedAt: 7 }],
    });
    expect(projectSavedSecretCatalogCollisionStateV1(secrets)).toEqual(
      projectSavedSecretCatalogCollisionStateV1(secrets),
    );
    expect(projectSavedSecretCatalogCollisionStateV1([
      { id: 'personal', updatedAt: 1 },
      { id: 'happier:shared-secret:v1:', updatedAt: 2 },
    ])).toEqual({ status: 'none', collisions: [] });
  });
});
import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES } from '../../crypto/encryptedDataKeyEnvelopeFormatV1.js';

describe('saved secret catalog reference contract', () => {
  it('preserves personal ids and formats shared refs through the one codec', () => {
    expect(parseSavedSecretCatalogReferenceV1('legacy-id')).toEqual({ kind: 'personal', id: 'legacy-id' });
    const shared = formatSavedSecretCatalogReferenceV1({ kind: 'shared_resource', id: 'resource_1' });
    expect(shared).toBe('happier:shared-secret:v1:resource_1');
    expect(parseSavedSecretCatalogReferenceV1(shared)).toEqual({ kind: 'shared_resource', id: 'resource_1' });
    expect(isSharedSavedSecretReferenceV1(shared)).toBe(true);
  });

  it('fails closed for malformed shared refs and rejects extra catalog fields', () => {
    expect(parseSavedSecretCatalogReferenceV1('happier:shared-secret:v1:')).toBeNull();
    expect(isSharedSavedSecretReferenceV1('happier:shared-secret:v1:')).toBe(false);
    expect(SavedSecretCatalogEntryV1Schema.safeParse({
      ref: 'secret', source: 'personal', relationship: 'owner', name: null, kind: null,
      ownerAccountId: null, revision: null, materialStatus: 'ready',
      capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
      extra: true,
    }).success).toBe(false);
  });

  it('accepts only caller-scoped mode-correct hydrated material', () => {
    const entry = {
      ref: 'happier:shared-secret:v1:resource_1', source: 'shared_resource' as const,
      relationship: 'recipient' as const, name: 'Token', kind: 'token' as const,
      ownerAccountId: 'owner', revision: 2, materialStatus: 'ready' as const,
      capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
    };
    const encrypted = {
      resourceId: 'resource_1',
      encryptionMode: 'e2ee' as const,
      entry,
      storedContent: { t: 'encrypted' as const, c: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' },
      recipientEnvelope: {
        encryptedDataKey: Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES).toString('base64'),
        recipientContentPublicKeyFingerprint: 'fingerprint',
      },
    };
    expect(SavedSecretResourceMaterialsResponseV1Schema.safeParse({ resources: [encrypted] }).success).toBe(true);
    expect(SavedSecretResourceMaterialV1Schema.safeParse({
      ...encrypted,
      recipientEnvelope: null,
    }).success).toBe(false);
    expect(SavedSecretResourceMaterialV1Schema.safeParse({
      ...encrypted,
      storedContent: { t: 'plain', v: { v: 1, name: 'Token', kind: 'token', value: 'secret' } },
    }).success).toBe(false);
    expect(SavedSecretResourceMaterialV1Schema.safeParse({
      ...encrypted,
      entry: { ...entry, materialStatus: 'update_required', capabilities: { ...entry.capabilities, use: false } },
      storedContent: null,
      recipientEnvelope: null,
    }).success).toBe(true);
  });

  it('keeps recipient provenance least-privilege while giving owners an exact audience', () => {
    const account = {
      kind: 'account' as const,
      accountId: 'owner',
      firstName: 'Maya',
      lastName: null,
      username: 'maya',
      avatarUrl: null,
    };
    const groupName = { kind: 'available' as const, label: projectPrivateLabelForRecipientV1({
      stored: sealPrivateLabelV1({ mode: 'plain', binding: { entity: 'team_group', field: 'name', id: 'group-1' }, value: 'Developers' }),
      recipientAccountId: 'owner',
    }) };
    const recipient = SavedSecretCatalogEntryV1Schema.parse({
      ref: 'happier:shared-secret:v1:resource_1', source: 'shared_resource',
      relationship: 'recipient', name: 'Token', kind: 'token',
      encryptionMode: 'e2ee', owner: account,
      accessSources: [{ kind: 'group', teamId: 'team-1', teamName: 'Acme', groupId: 'group-1', name: groupName }],
      audience: null, revision: 2, materialStatus: 'ready',
      capabilities: { use: true, rename: false, rotate: false, manageAccess: false, delete: false },
    });
    expect(recipient.owner.accountId).toBe('owner');
    expect(recipient.accessSources).toEqual([
      { kind: 'group', teamId: 'team-1', teamName: 'Acme', groupId: 'group-1', name: groupName },
    ]);
    expect(recipient.audience).toBeNull();

    expect(SavedSecretResourceEnvelopeCensusResponseV1Schema.safeParse({
      resourceId: 'resource_1', revision: 2, nextCursor: null,
      recipients: [{
        account,
        readiness: {
          status: 'available',
          contentPublicKey: Buffer.alloc(32).toString('base64'),
          contentPublicKeyFingerprint: 'content-public-key-sha256:' + 'a'.repeat(64),
        },
        envelopeStatus: 'missing',
      }],
    }).success).toBe(true);
  });

  it('admits a row-local corrupt resource state without inventing a canonical reference', () => {
    const owner = {
      materialStatus: 'resource_corrupt',
      relationship: 'owner',
      repair: {
        kind: 'delete_resource',
        resourceId: '',
        expectedRevision: -3,
      },
    };
    const recipient = {
      materialStatus: 'resource_corrupt',
      relationship: 'recipient',
      repair: null,
    };

    expect(SavedSecretCatalogResultV1Schema.safeParse(owner).success).toBe(true);
    expect(SavedSecretCatalogResultV1Schema.safeParse(recipient).success).toBe(true);
    expect(SavedSecretResourceMaterialV1Schema.safeParse({ entry: owner }).success).toBe(true);
    expect(SavedSecretResourceMaterialV1Schema.safeParse({ entry: recipient }).success).toBe(true);
    expect(SavedSecretCatalogResultV1Schema.safeParse({
      ...recipient,
      repair: owner.repair,
    }).success).toBe(false);
  });
});
