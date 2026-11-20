import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import { createPluginCollectionSharingClientV1 } from './collectionSharingClientV1.js';
import { createActionExecutor } from '../../actions/actionExecutor.js';
import { createPluginCollectionSharingActionExecuteV1 } from './collectionSharingActionsV1.js';
import { PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1 } from './collectionSharingActionIdsV1.js';
import { normalizePluginAccountCollectionContractV1, type PluginCollectionMutationErrorV1 } from './collectionsV1.js';
import { encodePluginCollectionLogicalValueV1 } from './collectionLogicalCodecV1.js';
import { PluginCollectionSharingListRequestV1Schema, PluginCollectionSharingPutRequestV1Schema, PluginCollectionSharingSetGrantRequestV1Schema, type PluginCollectionSharingResourceV1 } from './collectionSharingV1.js';
import { signAccountContentKeyBindingV1 } from '../../crypto/accountContentKeyBindingV1.js';
import { openEncryptedDataKeyEnvelopeV1 } from '../../crypto/encryptedDataKeyEnvelopeV1.js';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { computeContentPublicKeyFingerprint } from '../../machines/identity/contentPublicKeyFingerprint.js';

const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'example.documents', contribution: {
  id: 'documents', schemaVersion: 1, rowIdField: 'id', identityFields: [],
  schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, note: { type: 'string' } },
    required: ['id', 'title', 'note'], additionalProperties: false },
  serverReadable: ['title'], indexes: [{ id: 'title', fields: [{ field: 'title', direction: 'asc' }] }],
  uiQueries: [], relations: [], migrations: [],
} });
type Document = Readonly<{ id: string; title: string; note: string }>;
const valid = (value: unknown): value is Document => value !== null && typeof value === 'object'
  && 'id' in value && typeof value.id === 'string' && 'title' in value && typeof value.title === 'string'
  && 'note' in value && typeof value.note === 'string';
function recipient(accountId: string) {
  const signingSecret = randomBytes(32), signingPublic = ed25519.getPublicKey(signingSecret);
  const secret = randomBytes(32), publicKey = x25519.getPublicKey(secret);
  return { secret, row: { recipientAccountId: accountId, contentKey: { status: 'available' as const,
    accountSigningPublicKey: bytesToHex(signingPublic), contentPublicKey: encodeBase64(publicKey),
    contentPublicKeySignature: encodeBase64(signAccountContentKeyBindingV1({
      accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: publicKey })) },
    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey), encryptedDataKey: null,
    recipientContentPublicKeyFingerprint: null } };
}

describe('Collection sharing client through authenticated transport', () => {
  it.each([
    { error: 'collection_quota_exceeded' },
    { error: 'collection_quota_incompatible', dimension: 'maxRowEncodedBytes', effectiveMaximum: 4096 },
  ] satisfies PluginCollectionMutationErrorV1[])('preserves the canonical Collection quota refusal and recovery details on a shared edit: $error', async refusal => {
    const value = { id: 'document', title: 'Visible title', note: 'Private note' };
    const encoded = encodePluginCollectionLogicalValueV1({ contract, isValidLogicalValue: valid, value,
      encryptionMode: 'plain', material: null, randomBytes });
    if (encoded.status !== 'encoded') throw new Error(encoded.reason);
    const client = createPluginCollectionSharingClientV1<Document>({ accountId: 'peer', contract,
      isValidLogicalValue: valid, parseStoredLogicalValue: input => valid(input) ? input : null,
      requireCurrent: () => {}, crypto: { accountMaterial: null, randomBytes, openKey: async () => null },
      request: async path => path.endsWith('/put')
        ? { status: 409, body: refusal }
        : { status: 200, body: { ownerAccountId: 'owner', pluginId: contract.pluginId,
          collectionId: contract.collectionId, rowId: 'document', access: 'edit', encryptionMode: 'plain',
          encryptedDataKey: null, row: { rowId: 'document', revision: 1, content: encoded.content, projection: encoded.projection } } },
    });
    await expect(client.put({ ownerAccountId: 'owner', value, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: refusal.error, outcome: 'refused', details: refusal });
  });

  it('refuses a response addressed to a different owner before exposing its value', async () => {
    const value = { id: 'document', title: 'Visible title', note: 'Private note' };
    const encoded = encodePluginCollectionLogicalValueV1({ contract, isValidLogicalValue: valid, value,
      encryptionMode: 'plain', material: null, randomBytes });
    if (encoded.status !== 'encoded') throw new Error(encoded.reason);
    const client = createPluginCollectionSharingClientV1<Document>({ accountId: 'peer', contract,
      isValidLogicalValue: valid, parseStoredLogicalValue: input => valid(input) ? input : null,
      requireCurrent: () => {}, crypto: { accountMaterial: null, randomBytes, openKey: async () => null },
      request: async () => ({ status: 200, body: { ownerAccountId: 'other-owner', pluginId: contract.pluginId,
        collectionId: contract.collectionId, rowId: 'document', access: 'view', encryptionMode: 'plain',
        encryptedDataKey: null, row: { rowId: 'document', revision: 1, content: encoded.content, projection: encoded.projection } } }),
    });
    await expect(client.get({ ownerAccountId: 'owner', rowId: 'document' }))
      .rejects.toMatchObject({ code: 'collection_content_unavailable' });
  });

  it.each(['plain', 'e2ee'] as const)('preserves Team scope while sharing, listing, editing, and revoking %s content', async mode => {
    const owner = recipient('owner'), peer = recipient('peer');
    const material = { type: 'legacy' as const, secret: randomBytes(32) };
    const value = { id: 'document', title: 'Visible title', note: 'Private note' };
    const encoded = encodePluginCollectionLogicalValueV1({ contract, isValidLogicalValue: valid, value,
      encryptionMode: mode, material: mode === 'e2ee' ? material : null, randomBytes });
    if (encoded.status !== 'encoded') throw new Error(encoded.reason);
    let resource: PluginCollectionSharingResourceV1 = { ownerAccountId: 'owner', pluginId: contract.pluginId,
      collectionId: contract.collectionId, rowId: 'document', access: 'owner', encryptionMode: mode,
      encryptedDataKey: null, row: { rowId: 'document', revision: 1, content: encoded.content, projection: encoded.projection } };
    let revoked = false;
    const wraps = new Map<string, string>();
    const bodies: unknown[] = [];
    const options = (accountId: 'owner' | 'peer') => ({ accountId, contract, isValidLogicalValue: valid,
      parseStoredLogicalValue: (input: unknown) => valid(input) ? input : null,
      requireCurrent: () => {},
      crypto: { accountMaterial: accountId === 'owner' && mode === 'e2ee' ? material : null, randomBytes,
        openKey: async (envelope: string) => openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(envelope),
          recipientSecretKeyOrSeed: accountId === 'owner' ? owner.secret : peer.secret }) },
      request: async (path: string, body: unknown) => {
        if (accountId === 'peer' && revoked) return { status: 404, body: { error: 'collection_unavailable' } };
        if (path.endsWith('/census')) return { status: 200, body: {
          ownerAccountId: 'owner', pluginId: contract.pluginId, collectionId: contract.collectionId,
          rowId: 'document', access: 'owner', encryptionMode: mode,
          dataEncryptionKey: wraps.get('owner') ?? null, callerDataEncryptionKey: wraps.get(accountId) ?? null,
          recipients: [owner.row, peer.row].map(row => ({ ...row, encryptedDataKey: wraps.get(row.recipientAccountId) ?? null,
            recipientContentPublicKeyFingerprint: wraps.has(row.recipientAccountId) ? row.contentPublicKeyFingerprint : null })),
        } };
        if (path.endsWith('/set-grant')) {
          const parsed = PluginCollectionSharingSetGrantRequestV1Schema.parse(body);
          bodies.push(parsed);
          if (parsed.expectedRevision !== resource.row.revision) return { status: 409, body: { error: 'collection_revision_conflict' } };
          if (parsed.promotion) {
            resource = { ...resource, row: { ...resource.row, revision: resource.row.revision + 1, content: parsed.promotion.content } };
            for (const wrap of [parsed.promotion.ownerKeyEnvelope, ...parsed.promotion.recipientKeyEnvelopes]) wraps.set(wrap.recipientAccountId, wrap.encryptedDataKey);
          }
          return { status: 200, body: { changed: true } };
        }
        if (path.endsWith('/revoke-grant')) { revoked = true; return { status: 200, body: { changed: true } }; }
        if (path.endsWith('/put')) {
          const parsed = PluginCollectionSharingPutRequestV1Schema.parse(body);
          if (parsed.expectedRevision !== resource.row.revision)
            return { status: 409, body: { error: 'collection_revision_conflict' } };
          resource = { ...resource, row: { ...resource.row, revision: resource.row.revision + 1,
            content: parsed.content, projection: parsed.projection } };
        }
        const projected = { ...resource, access: accountId === 'owner' ? 'owner' : 'edit', encryptedDataKey: wraps.get(accountId) ?? null };
        if (path.endsWith('/shared-with-me')) {
          const selected = PluginCollectionSharingListRequestV1Schema.parse(body);
          return { status: 200, body: {
            resources: selected.sharedWithTeamId === 'selected-team' ? [{ ...projected, sharedWithTeamScope: 'group' }] : [],
            nextCursor: null,
          } };
        }
        return { status: 200, body: projected };
      },
    });
    const ownerClient = createPluginCollectionSharingClientV1<Document>(options('owner'));
    const peerClient = createPluginCollectionSharingClientV1<Document>(options('peer'));
    await expect(ownerClient.setGrant('document', { principal: { kind: 'account', accountId: 'peer' }, accessLevel: 'edit', expectedRevision: 1 })).resolves.toEqual({ changed: true });
    const shared = await peerClient.get({ ownerAccountId: 'owner', rowId: 'document' });
    expect(shared).toMatchObject({ ownerAccountId: 'owner', access: 'edit', value });
    const executor = createActionExecutor({ pluginCollectionSharingAction: createPluginCollectionSharingActionExecuteV1({
      resolveClient: async () => peerClient,
    }) });
    const { pluginId, collectionId, schemaVersion, contractDigest } = contract;
    const collectionRef = { pluginId, collectionId, schemaVersion, contractDigest };
    const listId = PLUGIN_COLLECTION_SHARING_ACTION_IDS_BY_OPERATION_V1.list;
    await expect(executor.execute(listId, { collectionRef, sharedWithTeamId: 'selected-team' },
      { surface: 'ui', authority: 'present_user' })).resolves.toEqual({
      ok: true, result: { rows: [{ ...shared, sharedWithTeamScope: 'group' }] },
    });
    await expect(executor.execute(listId, { collectionRef, sharedWithTeamId: 'another-team' },
      { surface: 'ui', authority: 'present_user' })).resolves.toEqual({ ok: true, result: { rows: [] } });
    const edited = await peerClient.put({ ownerAccountId: 'owner', value: { ...value, note: 'Edited privately' }, expectedRevision: shared.revision });
    expect(edited.value.note).toBe('Edited privately');
    await expect(peerClient.put({ ownerAccountId: 'owner', value, expectedRevision: shared.revision })).rejects.toMatchObject({ code: 'collection_revision_conflict' });
    await ownerClient.revokeGrant('document', { principal: { kind: 'account', accountId: 'peer' } });
    await expect(peerClient.get({ ownerAccountId: 'owner', rowId: 'document' })).rejects.toMatchObject({ code: 'collection_unavailable' });
    if (mode === 'plain') expect(wraps.size).toBe(0);
    else {
      expect(wraps.size).toBe(2);
      expect(JSON.stringify(bodies)).not.toContain('Private note');
      expect(resource.row.content).toMatchObject({ t: 'encrypted', k: 'collection' });
    }
  });
});
