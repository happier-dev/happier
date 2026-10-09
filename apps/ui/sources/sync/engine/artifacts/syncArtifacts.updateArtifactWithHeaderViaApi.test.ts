import { describe, expect, it, vi } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import type { ArtifactDataKeyCache } from './syncArtifacts';
import type { ArtifactUpdateRequest, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, type ArtifactBlobReferenceV1 } from '@happier-dev/protocol';
import { encodeBase64 } from '@/encryption/base64';
import { hashArtifactBinaryContent } from '@/sync/domains/artifacts/artifactBinaryContent';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { signAccountContentKeyBindingV1, verifyAccountContentKeyBindingV1, openEncryptedDataKeyEnvelopeV1,
  type ArtifactRecipientKeyEnvelopeCommitInputV1 } from '@happier-dev/protocol';
import { decodeBase64 } from '@/encryption/base64';
import { encodeHex } from '@/encryption/hex';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { openArtifactPrivateRevisionMetadata } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { createWorkBoardV1, buildWorkBoardArtifactHeaderV1 } from '@happier-dev/protocol';


const fileReference: ArtifactBlobReferenceV1 = { blobId: 'b6a4bb92-8b93-4b18-b8b4-230041388a62',
  mime: 'application/zip', sizeBytes: 3, sha256: 'a'.repeat(64) };

describe('updateArtifactWithHeaderViaApi', () => {
  it('refuses private pins with only an active public link and preserves safe writes when its audience cannot be observed', async () => {
    const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'board' } } as const;
    const instance = { v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: 'private-definition' }, bindings: {} } as const;
    const board = { ...createWorkBoardV1({ id: 'board', name: 'Board' }), widgets: [{ kind: 'widget' as const,
      ref: { surface, instanceId: instance.id }, instance, size: 'medium' as const }] };
    const header = buildWorkBoardArtifactHeaderV1(board);
    let current: DecryptedArtifact = { id: board.id, title: board.name, header: { ...header, title: board.name }, rawHeader: header,
      body: JSON.stringify(board), ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', headerVersion: 2, bodyVersion: 2,
      seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'plain', isDecrypted: true };
    const before = structuredClone(current);
    // Cached private exposure must not authorize a pin after a publication is retained.
    let publicAudience: unknown = 'retained';
    const writes: ArtifactUpdateRequest[] = [];
    const request = async (path: string, init?: RequestInit) => {
      if (path.endsWith('/access/grants')) return Response.json({ artifactId: board.id, ownerAccountId: 'owner', access: 'owner', grants: [] });
      if (path.startsWith('/v1/public-shares?')) throw new Error('Audience admission must not read feature-gated public links');
      if (path === `/v1/artifacts/${board.id}` && init?.method !== 'POST') return Response.json({ ...current, publicAudience,
        encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent(current.rawHeader), body: encodePlainArtifactStoredContent({ body: current.body }) });
      if (path.endsWith('/revisions')) return Response.json({ revisions: [{ bodyVersion: 1, body: encodePlainArtifactStoredContent({ body: JSON.stringify(pinned) }),
        createdAt: 1, sizeBytes: 1 }], retentionCount: 1 });
      if (init?.method !== 'POST') throw new Error('Unexpected HTTP request');
      const wire = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
      expect(wire.expectedHeaderVersion).toBe(current.headerVersion);
      expect(wire.expectedBodyVersion).toBe(current.bodyVersion);
      writes.push(wire);
      return Response.json({ success: true, headerVersion: current.headerVersion + 1, bodyVersion: current.bodyVersion! + 1 });
    };
    const { updateArtifactWithHeaderViaApi, restoreArtifactBodyRevisionViaApi } = await import('./syncArtifacts');
    const save = (body: string) => updateArtifactWithHeaderViaApi({ credentials: { token: 'token' }, artifactId: board.id,
      expectedRevision: { headerVersion: current.headerVersion, bodyVersion: current.bodyVersion! }, header, body, encryption: null, artifactDataKeys: new Map(),
      request, getArtifact: () => current, updateArtifact: row => { current = row; } });
    const pinned = { ...board, widgets: [{ ...board.widgets[0], instance: { ...instance, bindings: { cloud: { kind: 'value', value: {
      nested: [{ service: { pluginId: 'com.acme.test', localId: 'cloud' }, accountId: 'private' }],
    } } } } }] };
    await expect(save(JSON.stringify(pinned))).rejects.toMatchObject({ code: 'artifact_shared_content_forbidden' });
    expect(current).toEqual(before);
    await expect(restoreArtifactBodyRevisionViaApi({ credentials: { token: 'token' }, artifactId: board.id, bodyVersion: 1,
      expectedRevision: { headerVersion: 2, bodyVersion: 2 }, encryption: null, artifactDataKeys: new Map(), request,
      updateArtifact: row => { current = row; } })).rejects.toMatchObject({ code: 'artifact_shared_content_forbidden' });
    expect(current).toEqual(before);
    publicAudience = undefined;
    await expect(save(JSON.stringify(pinned))).rejects.toMatchObject({ code: 'content_unavailable' });
    await expect(restoreArtifactBodyRevisionViaApi({ credentials: { token: 'token' }, artifactId: board.id, bodyVersion: 1,
      expectedRevision: { headerVersion: 2, bodyVersion: 2 }, encryption: null, artifactDataKeys: new Map(), request,
      updateArtifact: row => { current = row; } })).rejects.toMatchObject({ code: 'content_unavailable' });
    expect(writes).toHaveLength(0);
    await save(JSON.stringify({ ...board, name: 'Safe rename' }));
    expect(current.body).toBe(JSON.stringify({ ...board, name: 'Safe rename' }));
    expect(decodePlainArtifactStoredContent(writes[0]!.body!)).toEqual({ body: JSON.stringify({ ...board, name: 'Safe rename' }) });
    publicAudience = 'none';
    await save(JSON.stringify(pinned));
    expect(current.body).toBe(JSON.stringify(pinned));
    await restoreArtifactBodyRevisionViaApi({ credentials: { token: 'token' }, artifactId: board.id, bodyVersion: 1,
      expectedRevision: { headerVersion: current.headerVersion, bodyVersion: current.bodyVersion! }, encryption: null, artifactDataKeys: new Map(), request,
      updateArtifact: row => { current = row; } });
    expect(writes).toHaveLength(3);
  });
  it.each(['owner', 'edit'] as const)('admits actual %s audience before generic WorkBoard content writes', async access => {
    const surface = { serverId: 'home', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'board' } } as const;
    const instance = { v: 1, id: 'copy', definition: { kind: 'artifact', artifactId: 'private-definition' }, bindings: {} } as const;
    const board = { ...createWorkBoardV1({ id: 'board', name: 'Board' }), widgets: [{ kind: 'widget' as const,
      ref: { surface, instanceId: instance.id }, instance, size: 'medium' as const }] };
    const header = buildWorkBoardArtifactHeaderV1(board);
    let current: DecryptedArtifact = { id: board.id, title: board.name, header: { ...header, title: board.name }, rawHeader: header,
      body: JSON.stringify(board), ownerAccountId: 'owner', access, headerVersion: 1, bodyVersion: 1,
      seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'plain', isDecrypted: true };
    const before = structuredClone(current);
    const request = async (path: string, init?: RequestInit) => {
      if (path.endsWith('/access/grants')) return Response.json({ artifactId: board.id, ownerAccountId: 'owner', access,
        grants: [{ principal: { kind: 'account', accountId: 'viewer' }, accessLevel: 'view', createdByAccountId: 'owner', createdAt: 1, display: { name: 'Viewer' } }] });
      if (path === `/v1/artifacts/${board.id}` && init?.method !== 'POST') return Response.json({ ...current,
        publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: current.body }) });
      if (init?.method !== 'POST') throw new Error('Unexpected HTTP request');
      const wire = JSON.parse(String(init.body)) as ArtifactUpdateRequest;
      const opened = decodePlainArtifactStoredContent(wire.body!);
      expect(opened).toEqual({ body: JSON.stringify({ ...board, name: 'Safe rename' }) });
      return Response.json({ success: true, headerVersion: 2, bodyVersion: 2 });
    };
    const { updateArtifactWithHeaderViaApi } = await import('./syncArtifacts');
    const save = (candidateHeader: Readonly<Record<string, unknown>>, body: string) => updateArtifactWithHeaderViaApi({
      credentials: { token: 'token' }, artifactId: board.id, expectedRevision: { headerVersion: 1, bodyVersion: 1 }, header: candidateHeader,
      body, encryption: null, artifactDataKeys: new Map(), request, getArtifact: () => current, updateArtifact: row => { current = row; } });
    const pinned = { ...board, widgets: [{ ...board.widgets[0], instance: { ...instance, bindings: { cloud: { kind: 'value', value: {
      nested: [{ service: { pluginId: 'com.acme.test', localId: 'cloud' }, accountId: 'private' }],
    } } } } }] };
    for (const candidateHeader of [header, { kind: 'ordinary' }]) {
      await expect(save(candidateHeader, JSON.stringify(pinned))).rejects.toMatchObject({ code: 'artifact_shared_content_forbidden' });
      expect(current).toEqual(before);
    }
    const safe = { ...board, name: 'Safe rename' };
    await save(buildWorkBoardArtifactHeaderV1(safe), JSON.stringify(safe));
    expect(current.body).toBe(JSON.stringify(safe));
  });
  it.each([['editor', false], ['editor', true], ['owner', false]] as const)('initializes legacy provenance to the owner when %s saves (first CAS refused: %s)', async (callerId, refuseFirst) => {
    const artifactId = '11111111-1111-4111-8111-111111111111';
    const ownerSecret = new Uint8Array(32).fill(15);
    const editorSecret = new Uint8Array(32).fill(16);
    const editorEncryption = await Encryption.createFromContentKeyPair({ publicKey: x25519.getPublicKey(editorSecret), machineKey: editorSecret });
    const ownerEncryption = await Encryption.createFromContentKeyPair({ publicKey: x25519.getPublicKey(ownerSecret), machineKey: ownerSecret });
    const encryption = callerId === 'owner' ? ownerEncryption : editorEncryption;
    const dataKey = new Uint8Array(32).fill(17);
    const codec = new ArtifactEncryption(dataKey);
    const ownerContentEnvelope = encodeBase64(await ownerEncryption.encryptEncryptionKey(dataKey));
    const editorContentEnvelope = encodeBase64(await editorEncryption.encryptEncryptionKey(dataKey));
    const callerContentEnvelope = callerId === 'owner' ? ownerContentEnvelope : editorContentEnvelope;
    const recipients = [ ['owner', ownerSecret], ['editor', editorSecret] ] as const;
    const recipientRows = recipients.map(([recipientAccountId, contentSecret], index) => {
      const signingSecret = new Uint8Array(32).fill(30 + index);
      const signingPublic = ed25519.getPublicKey(signingSecret);
      const contentPublic = x25519.getPublicKey(contentSecret);
      const signature = signAccountContentKeyBindingV1({ accountSigningSecretKey: new Uint8Array([...signingSecret, ...signingPublic]), contentPublicKey: contentPublic });
      const fingerprint = verifyAccountContentKeyBindingV1({ accountSigningPublicKey: signingPublic, contentPublicKey: contentPublic, signature })!.contentPublicKeyFingerprint;
      return { recipientAccountId, contentKey: { status: 'available' as const, accountSigningPublicKey: encodeHex(signingPublic),
        contentPublicKey: encodeBase64(contentPublic), contentPublicKeySignature: encodeBase64(signature) }, contentPublicKeyFingerprint: fingerprint,
        encryptedDataKey: recipientAccountId === 'owner' ? ownerContentEnvelope : editorContentEnvelope,
        recipientContentPublicKeyFingerprint: fingerprint, encryptedProvenanceDataKey: null as string | null };
    });
    let stored = { id: artifactId, ownerAccountId: 'owner', access: callerId === 'owner' ? 'owner' as const : 'edit' as const, encryptionMode: 'e2ee' as const,
      header: await codec.encryptHeader({ title: 'Legacy' }), body: await codec.encryptBody({ body: 'Before' }),
      dataEncryptionKey: callerContentEnvelope, provenance: null as string | null, provenanceDataEncryptionKey: null as string | null,
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const cache: ArtifactDataKeyCache = new Map([[artifactId, { envelope: callerContentEnvelope, dataKey }]]);
    let current: DecryptedArtifact = { ...stored, title: 'Legacy', rawHeader: { title: 'Legacy' }, header: { title: 'Legacy' },
      body: 'Before', provenance: undefined, storageMode: 'e2ee', isDecrypted: true };
    let refused = false;
    let write: ArtifactUpdateRequest | undefined;
    const request = async (path: string, init?: RequestInit) => {
      if (path.endsWith('/recipients')) return Response.json({ artifactId, ownerAccountId: 'owner', access: stored.access, encryptionMode: 'e2ee',
        dataEncryptionKey: ownerContentEnvelope, callerDataEncryptionKey: callerContentEnvelope,
        provenanceDataEncryptionKey: stored.provenanceDataEncryptionKey,
        callerProvenanceDataEncryptionKey: callerId === 'owner' ? stored.provenanceDataEncryptionKey : recipientRows[1]!.encryptedProvenanceDataKey, recipients: recipientRows });
      if (path.endsWith('/key-envelopes')) {
        const commit = JSON.parse(String(init?.body)) as ArtifactRecipientKeyEnvelopeCommitInputV1;
        expect(commit.expectedProvenanceDataEncryptionKey).toBe(stored.provenanceDataEncryptionKey);
        for (const prepared of commit.recipientKeyEnvelopes) {
          const recipient = recipientRows.find(row => row.recipientAccountId === prepared.recipientAccountId);
          if (recipient) recipient.encryptedProvenanceDataKey = prepared.encryptedProvenanceDataKey ?? null;
        }
        return Response.json({ appliedRecipientAccountIds: ['editor'], skippedRecipientAccountIds: [] });
      }
      if (init?.method !== 'POST') return Response.json(stored);
      write = JSON.parse(String(init?.body)) as ArtifactUpdateRequest;
      if (refuseFirst && !refused) { refused = true; return Response.json({ success: false, error: 'version-mismatch' }); }
      stored = { ...stored, body: write.body!, provenance: write.provenance ?? null,
        provenanceDataEncryptionKey: write.provenanceDataEncryptionKey ?? stored.provenanceDataEncryptionKey, bodyVersion: 2 };
      return Response.json({ success: true, headerVersion: 1, bodyVersion: 2 });
    };
    const { updateArtifactWithHeaderViaApi } = await import('./syncArtifacts');
    const save = () => updateArtifactWithHeaderViaApi({ credentials: { token: createAccountTokenForTests(callerId) }, artifactId,
      header: { title: 'Legacy' }, body: 'After', savedBy: { kind: 'person', accountId: callerId }, encryption,
      artifactDataKeys: cache, request, getArtifact: () => current, updateArtifact: row => { current = row; } });
    if (refuseFirst) {
      await expect(save()).rejects.toMatchObject({ code: 'version_mismatch' });
      expect(cache.get(artifactId)?.provenanceDataKey).toBeUndefined();
    }
    await save();
    expect(stored.provenanceDataEncryptionKey).toBeTruthy();
    const privateKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(stored.provenanceDataEncryptionKey!), recipientSecretKeyOrSeed: ownerSecret });
    expect(privateKey).not.toBeNull();
    await expect(openArtifactPrivateRevisionMetadata({ mode: 'e2ee', artifactId, bodyVersion: 2, provenance: stored.provenance,
      dataKey: privateKey })).resolves.toEqual({ savedBy: { kind: 'person', accountId: callerId } });
    const editorPrivateKey = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(recipientRows[1]!.encryptedProvenanceDataKey!), recipientSecretKeyOrSeed: editorSecret });
    expect(editorPrivateKey).toEqual(privateKey);
  });
  it.each(['plain', 'e2ee'] as const)('deliberately clears a %s file through the binary-aware route and keeps later text edits on the ordinary route', async (mode) => {
    const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(9)) : null;
    const dataKey = ArtifactEncryption.generateDataEncryptionKey();
    const artifactDataKeys: ArtifactDataKeyCache = new Map(mode === 'e2ee'
      ? [['document', { envelope: 'cached-key', dataKey }]] : []);
    let current: DecryptedArtifact = { id: 'document', title: 'File', header: { title: 'File' }, rawHeader: { title: 'File' },
      body: fileReference, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, storageMode: mode, isDecrypted: true };
    const writes: Readonly<{ path: string; request: ArtifactUpdateRequest }>[] = [];
    let storedFile = true;
    // Captured HTTP models the required binary-head admission contract, not verified current server behavior.
    // All codecs and Sync logic stay real.
    const request = async (path: string, init?: RequestInit) => {
      const wire = JSON.parse(String(init?.body)) as ArtifactUpdateRequest;
      writes.push({ path, request: wire });
      if (storedFile) {
        if (path !== '/v1/artifacts/document/content/binary' || !Object.hasOwn(wire, 'blob') || wire.blob !== null) {
          return Response.json({ error: 'artifact_binary_write_required' }, { status: 409 });
        }
        expect(wire.expectedBodyVersion).toBe(1);
        expect(wire.body).toBeTypeOf('string');
        storedFile = false;
      }
      return Response.json({ success: true, headerVersion: current.headerVersion + (wire.header === undefined ? 0 : 1),
        bodyVersion: current.bodyVersion! + 1 });
    };
    const { updateArtifactWithHeaderViaApi } = await import('./syncArtifacts');
    const replacement = mode === 'plain' ? null : 'replacement text';
    const update = (body: string | null) => updateArtifactWithHeaderViaApi({ credentials: { token: 'token' }, artifactId: current.id,
      header: { title: 'File' }, body, encryption, artifactDataKeys, request, getArtifact: () => current,
      updateArtifact: row => { current = row; } });
    await update(replacement);
    expect(storedFile).toBe(false);
    expect(current.body).toBe(replacement);
    const opened = mode === 'plain' ? decodePlainArtifactStoredContent(writes[0]!.request.body!)
      : await new ArtifactEncryption(dataKey).decryptBody(writes[0]!.request.body!);
    expect(opened).toEqual({ body: replacement });
    await update('later text');
    expect(writes[1]?.path).toBe('/v1/artifacts/document');
    expect(Object.hasOwn(writes[1]!.request, 'blob')).toBe(false);
    expect(current.body).toBe('later text');
  });

  it('keeps an unchanged file out of a header-only write and preserves its body version', async () => {
    const current: DecryptedArtifact = { id: 'document', title: 'File', header: { title: 'File' }, rawHeader: { title: 'File' },
      body: fileReference, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1, storageMode: 'plain', isDecrypted: true };
    const updated: DecryptedArtifact[] = [];
    const { updateArtifactWithHeaderViaApi } = await import('./syncArtifacts');
    await updateArtifactWithHeaderViaApi({ credentials: { token: 'token' }, artifactId: current.id,
      header: { title: 'Renamed file' }, body: { ...fileReference }, encryption: null, artifactDataKeys: new Map(), getArtifact: () => current,
      request: async (path, init) => {
        const wire = JSON.parse(String(init?.body)) as ArtifactUpdateRequest;
        expect(path).toBe('/v1/artifacts/document');
        expect(wire.body).toBeUndefined();
        expect(Object.hasOwn(wire, 'blob')).toBe(false);
        return Response.json({ success: true, headerVersion: 2, bodyVersion: 1 });
      }, updateArtifact: row => updated.push(row) });
    expect(updated[0]?.body).toEqual(fileReference);
    expect(updated[0]?.bodyVersion).toBe(1);
  });

  it.each(['plain', 'e2ee'] as const)('preserves reference-only updates to a retained blob in %s', async (mode) => {
    const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(9)) : null;
    const dataKey = mode === 'e2ee' ? ArtifactEncryption.generateDataEncryptionKey() : null;
    const artifactDataKeys: ArtifactDataKeyCache = new Map();
    const artifactId = 'document';
    if (dataKey && encryption) artifactDataKeys.set(artifactId, { envelope: encodeBase64(await encryption.encryptEncryptionKey(dataKey)), dataKey });
    const reference: ArtifactBlobReferenceV1 = { blobId: 'b6a4bb92-8b93-4b18-b8b4-230041388a62',
      mime: 'application/zip', sizeBytes: 3, sha256: hashArtifactBinaryContent(new Uint8Array([1, 2, 3])) };
    const current: DecryptedArtifact = { id: artifactId, header: { title: 'File' }, rawHeader: { title: 'File' },
      title: 'File', body: reference, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      storageMode: mode, isDecrypted: true };
    const updated: DecryptedArtifact[] = [];
    const request = async (path: string, init?: RequestInit) => {
      expect(path).toBe(`/v1/artifacts/${artifactId}/content/binary`);
      const wire = JSON.parse(String(init?.body)) as ArtifactUpdateRequest;
      expect(wire.blob).toEqual({ blobId: reference.blobId });
      expect(wire.expectedBodyVersion).toBe(1);
      const opened = mode === 'plain' ? decodePlainArtifactStoredContent(wire.body!)
        : await new ArtifactEncryption(dataKey!).decryptBody(wire.body!);
      expect(opened).toEqual({ body: reference });
      return Response.json({ success: true, headerVersion: 2, bodyVersion: 2 });
    };
    const { updateArtifactWithHeaderViaApi } = await import('./syncArtifacts');
    await updateArtifactWithHeaderViaApi({ credentials: { token: 't' }, artifactId, header: { title: 'Renamed' }, body: reference,
      expectedRevision: { headerVersion: 1, bodyVersion: 1 }, encryption, artifactDataKeys,
      getArtifact: () => current, request, updateArtifact: artifact => updated.push(artifact) });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({ body: reference, bodyVersion: 2, title: 'Renamed' });
  });
  it('refuses to rewrite a retained encrypted artifact while its content is locked', async () => {
    const updateArtifact = vi.fn();
    const { updateArtifactWithHeaderViaApi } = await import('./syncArtifacts');

    await expect(updateArtifactWithHeaderViaApi({
      credentials: { token: 't', secret: 's' },
      artifactId: 'locked-artifact',
      header: { title: 'Replacement title' },
      body: 'replacement body',
      encryption: null,
      artifactDataKeys: new Map(),
      getArtifact: () => ({
        id: 'locked-artifact',
        title: null,
        header: null,
        body: undefined,
        headerVersion: 3,
        bodyVersion: 4,
        seq: 5,
        createdAt: 1,
        updatedAt: 2,
        isDecrypted: false,
        storageMode: 'e2ee',
        availability: {
          kind: 'locked',
          reason: 'encryption_material_unavailable',
        },
      }),
      updateArtifact,
    })).rejects.toThrow('Artifact locked-artifact is locked');

    expect(updateArtifact).not.toHaveBeenCalled();
  });

  it('updates passthrough header metadata in local decrypted artifacts', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(9));
    const artifactDataKeys: ArtifactDataKeyCache = new Map();
    const artifactId = 'a1';
    const dataEncryptionKey = ArtifactEncryption.generateDataEncryptionKey();
    artifactDataKeys.set(artifactId, { envelope: 'envelope-a1', dataKey: dataEncryptionKey });

    const current: DecryptedArtifact = {
      id: artifactId,
      header: { v: 1, kind: 'approval_request.v1', title: 'Approve export', approvalStatus: 'open' },
      title: 'Approve export',
      body: '{"v":1}',
      headerVersion: 1,
      bodyVersion: 1,
      seq: 1,
      createdAt: 0,
      updatedAt: 0,
      isDecrypted: true,
    };

    const updated: DecryptedArtifact[] = [];

    const { updateArtifactWithHeaderViaApi } = await import('./syncArtifacts');

    await updateArtifactWithHeaderViaApi({
      credentials: { token: 't', secret: 's' },
      artifactId,
      request: async () => Response.json({ success: true, headerVersion: 2, bodyVersion: 2 }),
      header: { v: 1, kind: 'approval_request.v1', title: 'Approve export', approvalStatus: 'approved' },
      body: '{"v":1,"status":"approved"}',
      encryption,
      artifactDataKeys,
      getArtifact: () => current,
      updateArtifact: (artifact) => updated.push(artifact),
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]?.header?.kind).toBe('approval_request.v1');
    expect(updated[0]?.header?.approvalStatus).toBe('approved');
    expect(updated[0]?.headerVersion).toBe(2);
    expect(updated[0]?.bodyVersion).toBe(2);
  });

  it('persists an explicit raw replacement even when a legacy display-only cache normalizes it to the same version', async () => {
    const displayHeader = { title: 'Future metadata', v: 2, excerpt: 'same body' };
    const rawReplacement = { ...displayHeader, v: 2.1 };
    const current: DecryptedArtifact = { id: 'document', header: displayHeader, title: displayHeader.title,
      body: 'same body', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      storageMode: 'plain', isDecrypted: true };
    const updated: DecryptedArtifact[] = [];
    const writes: ArtifactUpdateRequest[] = [];
    const { updateArtifactWithHeaderViaApi } = await import('./syncArtifacts');
    await updateArtifactWithHeaderViaApi({ credentials: { token: 'token' }, artifactId: current.id,
      header: rawReplacement, body: current.body!, encryption: null, artifactDataKeys: new Map(), getArtifact: () => current,
      request: async (_path, init) => { writes.push(JSON.parse(String(init?.body)) as ArtifactUpdateRequest);
        return Response.json({ success: true, headerVersion: 2, bodyVersion: 1 }); },
      updateArtifact: (row) => updated.push(row) });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.rawHeader).toEqual(rawReplacement);
    expect(decodePlainArtifactStoredContent(writes[0]!.header!)).toEqual(rawReplacement);
    expect(writes[0]?.body).toBeUndefined();
  });
});
