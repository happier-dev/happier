import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol';

import { applySocketArtifactUpdate, decryptArtifactListItem, decryptArtifactWithBody, decryptSocketNewArtifactUpdate,
  fetchArtifactBodyRevisionsFromApi, restoreArtifactBodyRevisionViaApi } from './syncArtifacts';
import type { ArtifactUpdateRequest } from '@/sync/domains/artifacts/artifactTypes';
import { sealArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';

describe('decryptArtifactListItem (artifact headers)', () => {
  it.each(['plain', 'e2ee'] as const)('keeps %s retained actor metadata separate when restoring content', async mode => {
    const artifactId = '11111111-1111-4111-8111-111111111111';
    const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(11)) : null;
    const contentKey = new Uint8Array(32).fill(12);
    const privateKey = new Uint8Array(32).fill(13);
    const codec = new ArtifactEncryption(contentKey);
    const source = { sessionId: 'source-session', runId: 'source-run', machineId: 'source-machine', path: 'private/earlier.txt', sha: 'a'.repeat(64) };
    const firstActor = { savedBy: { kind: 'person' as const, accountId: 'owner' }, source };
    const secondActor = { savedBy: { kind: 'agent' as const, accountId: 'owner', sessionId: 'author-session' }, source: { ...source, path: 'private/current.txt' } };
    const sealBody = (body: string) => mode === 'plain' ? Promise.resolve(encodePlainArtifactStoredContent({ body })) : codec.encryptBody({ body });
    const firstBody = await sealBody('Earlier');
    let row: Artifact = { id: artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
      header: mode === 'plain' ? encodePlainArtifactStoredContent({ title: 'History' }) : await codec.encryptHeader({ title: 'History' }),
      body: await sealBody('Current'), dataEncryptionKey: encryption ? encodeBase64(await encryption.encryptEncryptionKey(contentKey)) : ARTIFACT_PLAIN_DATA_KEY_MARKER,
      provenance: await sealArtifactPrivateRevisionMetadata({ mode, artifactId, bodyVersion: 2, provenance: secondActor, dataKey: privateKey }),
      provenanceDataEncryptionKey: encryption ? encodeBase64(await encryption.encryptEncryptionKey(privateKey)) : null,
      headerVersion: 2, bodyVersion: 2, seq: 2, createdAt: 1, updatedAt: 2 };
    const firstMetadata = await sealArtifactPrivateRevisionMetadata({ mode, artifactId, bodyVersion: 1, provenance: firstActor, dataKey: privateKey });
    const request = async (path: string, init?: RequestInit) => {
      if (path.endsWith('/revisions')) return Response.json({ retentionCount: 10, revisions: [
        { bodyVersion: 1, body: firstBody, provenance: firstMetadata, createdAt: 1, sizeBytes: 7 },
        { bodyVersion: 2, body: row.body, provenance: row.provenance, createdAt: 2, sizeBytes: 7 } ] });
      if (path.endsWith('/restore')) {
        const write = JSON.parse(String(init?.body)) as ArtifactUpdateRequest;
        expect(write.expectedBodyVersion).toBe(2);
        expect(write.provenanceDataEncryptionKey).toBe(mode === 'plain' ? null : undefined);
        const openedBody = mode === 'plain' ? decodePlainArtifactStoredContent(write.body!) : await codec.decryptBody(write.body!);
        expect(openedBody).toEqual({ body: 'Earlier' });
        const openedHeader = mode === 'plain' ? decodePlainArtifactStoredContent(write.header!) : await codec.decryptHeaderRaw(write.header!);
        expect(openedHeader).not.toHaveProperty('source');
        row = { ...row, header: write.header!, body: write.body!, provenance: write.provenance, headerVersion: 3, bodyVersion: 3 };
        return Response.json({ success: true, headerVersion: 3, bodyVersion: 3 });
      }
      if (path.endsWith('/recipients')) return Response.json({ artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey,
        provenanceDataEncryptionKey: row.provenanceDataEncryptionKey, callerProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey, recipients: [] });
      return Response.json(row);
    };
    const params = { credentials: { token: 't' }, request, artifactId, encryption, artifactDataKeys: new Map() };
    const inventory = await fetchArtifactBodyRevisionsFromApi(params);
    expect(inventory.revisions.map(revision => revision.provenance)).toEqual([firstActor, secondActor]);
    const updated: unknown[] = [];
    await restoreArtifactBodyRevisionViaApi({ ...params, bodyVersion: 1, expectedRevision: { headerVersion: 2, bodyVersion: 2 },
      savedBy: { kind: 'person', accountId: 'restoring-user' }, updateArtifact: artifact => updated.push(artifact) });
    expect(updated).toMatchObject([{ body: 'Earlier', bodyVersion: 3, provenance: {
      savedBy: { kind: 'person', accountId: 'restoring-user' }, source, restoredFromBodyVersion: 1 } }]);
  });
  it.each(['plain', 'e2ee'] as const)('opens unknown stored %s envelope fields on current and socket reads and rejects substitution', async mode => {
    const artifactId = '11111111-1111-4111-8111-111111111111';
    const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(11)) : null;
    const contentKey = new Uint8Array(32).fill(12);
    const privateKey = new Uint8Array(32).fill(13);
    const codec = new ArtifactEncryption(contentKey);
    const provenance = { savedBy: { kind: 'agent' as const, accountId: 'owner', sessionId: 'session' } };
    // Model extra persisted fields at the storage boundary, bypassing the canonical writer.
    const storedMetadata = { v: 1, artifactId, bodyVersion: 1, unknown: true,
      provenance: { ...provenance, unknown: true, savedBy: { ...provenance.savedBy, unknown: true } } };
    const sealed = mode === 'plain' ? encodePlainArtifactStoredContent(storedMetadata)
      : await new ArtifactEncryption(privateKey).encryptHeader(storedMetadata);
    const row: Artifact = { id: artifactId, ownerAccountId: 'owner', access: 'view', encryptionMode: mode,
      header: mode === 'plain' ? encodePlainArtifactStoredContent({ title: 'Shared' }) : await codec.encryptHeader({ title: 'Shared' }),
      body: mode === 'plain' ? encodePlainArtifactStoredContent({ body: 'Text', unknown: true }) : await codec.encryptHeader({ body: 'Text', unknown: true }),
      dataEncryptionKey: encryption ? encodeBase64(await encryption.encryptEncryptionKey(contentKey)) : ARTIFACT_PLAIN_DATA_KEY_MARKER,
      provenance: sealed, provenanceDataEncryptionKey: encryption ? encodeBase64(await encryption.encryptEncryptionKey(privateKey)) : null,
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const artifactDataKeys = new Map();
    const full = await decryptArtifactWithBody({ artifact: row, encryption, artifactDataKeys });
    const socket = await decryptSocketNewArtifactUpdate({ ...row, artifactId, encryption, artifactDataKeys });
    for (const opened of [full, socket]) expect(opened).toMatchObject({ isDecrypted: true, body: 'Text', provenance });
    if (!full) throw new Error('Expected opened record');
    const restored = { ...provenance, restoredFromBodyVersion: 1 };
    const next = await sealArtifactPrivateRevisionMetadata({ mode, artifactId, bodyVersion: 2, provenance: restored, dataKey: privateKey });
    const updated = await applySocketArtifactUpdate({ existingArtifact: full, createdAt: 2, dataEncryptionKey: contentKey,
      provenanceDataKey: privateKey, provenance: next, body: { version: 2, value: row.body! } });
    expect(updated).toMatchObject({ isDecrypted: true, bodyVersion: 2, provenance: restored });
    const substituted = await decryptArtifactWithBody({ artifact: { ...row, bodyVersion: 2 }, encryption, artifactDataKeys });
    expect(substituted).toMatchObject({ isDecrypted: false, availability: { kind: 'locked' } });
  });
  it.each(['plain', 'e2ee'] as const)('refuses malformed and specialized binary %s bodies across full and socket reads', async (mode) => {
    const encryption = mode === 'plain' ? null : await Encryption.create(new Uint8Array(32).fill(11));
    const key = new Uint8Array(32).fill(12);
    const codec = new ArtifactEncryption(key);
    const envelope = encryption ? encodeBase64(await encryption.encryptEncryptionKey(key)) : ARTIFACT_PLAIN_DATA_KEY_MARKER;
    const reference = { blobId: 'e791014a-ec77-4a6b-a5d6-e210fe841561', mime: 'image/png', sizeBytes: 0, sha256: '0'.repeat(64) };
    for (const input of [{ kind: 'artifact.legacy', body: { ...reference, sizeBytes: -1 } },
      { kind: 'approval_request.v1', body: reference }]) {
      const header = { kind: input.kind, title: 'Invalid content' };
      // Malformed remote storage is deliberately encoded without the body schema.
      const stored = mode === 'plain' ? encodePlainArtifactStoredContent({ body: input.body }) : await codec.encryptHeader({ body: input.body });
      const artifact: Artifact = { id: 'invalid', ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        header: mode === 'plain' ? encodePlainArtifactStoredContent(header) : await codec.encryptHeader(header),
        body: stored, dataEncryptionKey: envelope, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
      const artifactDataKeys = new Map();
      const full = await decryptArtifactWithBody({ artifact, encryption, artifactDataKeys });
      const socket = await decryptSocketNewArtifactUpdate({ artifactId: artifact.id, ...artifact, encryption, artifactDataKeys });
      for (const row of [full, socket]) expect(row).toMatchObject({ isDecrypted: false, availability: { kind: 'locked' } });
      const validStored = mode === 'plain' ? encodePlainArtifactStoredContent({ body: 'prior content' }) : await codec.encryptBody({ body: 'prior content' });
      const existing = await decryptArtifactWithBody({ artifact: { ...artifact, body: validStored }, encryption, artifactDataKeys });
      if (!existing?.isDecrypted) throw new Error('Valid fixture must open');
      const updated = await applySocketArtifactUpdate({ existingArtifact: existing, createdAt: 2, dataEncryptionKey: mode === 'plain' ? null : key,
        body: { value: stored, version: 2 } });
      expect(updated).toMatchObject({ isDecrypted: false, availability: { kind: 'locked' } });
    }
  });

  it('preserves decrypted header metadata on the returned artifact', async () => {
    const masterSecret = new Uint8Array(32).fill(1);
    const encryption = await Encryption.create(masterSecret);

    const artifactKey = new Uint8Array(32).fill(2);
    const encryptedKeyEnvelope = await encryption.encryptEncryptionKey(artifactKey);

    const artifactEncryption = new ArtifactEncryption(artifactKey);
    const headerPayload = {
      v: 1,
      kind: 'approval_request.v1',
      title: 'Approval: do thing',
      approvalStatus: 'open',
      draft: false,
    };
    const encryptedHeader = await artifactEncryption.encryptHeader(headerPayload);

    const artifact: Artifact = {
      ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
      id: 'a1',
      header: encryptedHeader,
      headerVersion: 1,
      body: undefined,
      bodyVersion: undefined,
      dataEncryptionKey: encodeBase64(encryptedKeyEnvelope, 'base64'),
      seq: 1,
      createdAt: 10,
      updatedAt: 20,
    };

    const decrypted = await decryptArtifactListItem({
      artifact,
      encryption,
      artifactDataKeys: new Map(),
    });

    expect(decrypted?.title).toBe('Approval: do thing');
    expect(decrypted?.header).toMatchObject({
      kind: 'approval_request.v1',
      approvalStatus: 'open',
    });
  });

  it.each(['plain', 'e2ee'] as const)('keeps raw %s metadata separate from presentation on full, list and socket reads', async (mode) => {
    const encryption = mode === 'plain' ? null : await Encryption.create(new Uint8Array(32).fill(11));
    const key = new Uint8Array(32).fill(12);
    const codec = new ArtifactEncryption(key);
    const metadata = { kind: 'workflow-definition.v1', definitionId: 'workflow',
      revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: '  Workflow  ' } };
    const storedHeader = mode === 'plain' ? encodePlainArtifactStoredContent(metadata) : await codec.encryptHeader(metadata);
    const storedBody = mode === 'plain' ? encodePlainArtifactStoredContent({ body: 'body' }) : await codec.encryptBody({ body: 'body' });
    const envelope = encryption ? encodeBase64(await encryption.encryptEncryptionKey(key)) : ARTIFACT_PLAIN_DATA_KEY_MARKER;
    const artifact: Artifact = { id: 'workflow', ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
      header: storedHeader, body: storedBody, dataEncryptionKey: envelope, headerVersion: 1, bodyVersion: 1,
      seq: 1, createdAt: 1, updatedAt: 1 };
    const artifactDataKeys = new Map();
    const list = await decryptArtifactListItem({ artifact, encryption, artifactDataKeys });
    const full = await decryptArtifactWithBody({ artifact, encryption, artifactDataKeys });
    const socket = await decryptSocketNewArtifactUpdate({ artifactId: artifact.id, ...artifact, encryption, artifactDataKeys });
    for (const row of [list, full, socket]) {
      expect(row?.rawHeader).toEqual(metadata);
      expect(row?.header).toMatchObject({ title: 'Workflow', v: 1 });
      expect(row?.title).toBe('Workflow');
    }
    if (!full) throw new Error('Fixture must open');
    const nextMetadata = { ...metadata, revision: { headerVersion: 2, bodyVersion: 1 } };
    const nextHeader = mode === 'plain' ? encodePlainArtifactStoredContent(nextMetadata) : await codec.encryptHeader(nextMetadata);
    const updated = await applySocketArtifactUpdate({ existingArtifact: full, createdAt: 2,
      dataEncryptionKey: mode === 'plain' ? null : key, header: { version: 2, value: nextHeader } });
    expect(updated.rawHeader).toEqual(nextMetadata);
    expect(updated.title).toBe('Workflow');
    expect(updated.body).toBe('body');
  });
});
