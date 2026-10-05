import { describe, expect, it, vi } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import type { ArtifactDataKeyCache } from './syncArtifacts';
import type { ArtifactCreateRequest, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { ArtifactBodyV1Schema, decodePlainArtifactStoredContent, encodeBase64, type ArtifactBlobStoredContentV1 } from '@happier-dev/protocol';
import { ARTIFACT_UPLOAD_PATH_V1, decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';

describe('createArtifactWithHeaderViaApi', () => {
  it('refuses a reference-only create before any request can persist missing file bytes', async () => {
    // Captured HTTP represents a server that accepts opaque legacy text bodies.
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/v1/account/encryption') return new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }));
      const input = JSON.parse(String(init?.body)) as ArtifactCreateRequest;
      return new Response(JSON.stringify({ ...input, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 0, updatedAt: 0 }));
    });
    const { createArtifactWithHeaderViaApi } = await import('./syncArtifacts');
    await expect(createArtifactWithHeaderViaApi({ credentials: { token: 't' }, header: { title: 'File' },
      body: { blobId: 'b6a4bb92-8b93-4b18-b8b4-230041388a62', mime: 'application/zip', sizeBytes: 3, sha256: 'a'.repeat(64) },
      encryption: null, artifactDataKeys: new Map(), request, addArtifact: () => {} })).rejects.toMatchObject({ code: 'artifact_invalid_body' });
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['plain', 'e2ee'] as const)('uploads and reads binary bytes in %s without disclosing a mismatched or substituted payload', async (mode) => {
    const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(9)) : null;
    const artifactDataKeys: ArtifactDataKeyCache = new Map();
    const added: DecryptedArtifact[] = [];
    let saved: ArtifactCreateRequest | null = null;
    let blob: ArtifactBlobStoredContentV1 | null = null;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/v1/account/encryption') return new Response(JSON.stringify({ mode, updatedAt: 0 }));
      if (path === ARTIFACT_UPLOAD_PATH_V1) {
        if (!(init?.body instanceof ArrayBuffer)) throw new Error('Expected canonical Artifact upload frame');
        const frame = new Uint8Array(init.body);
        const separator = frame.indexOf(10);
        const metadata = decodeArtifactUploadMetadataV1(frame.subarray(0, separator));
        if (metadata.kind !== 'create') throw new Error('Expected create destination');
        const content = encodeBase64(frame.subarray(separator + 1));
        blob = metadata.t === 'plain' ? { t: 'plain', v: content } : { t: 'encrypted', c: content };
        saved = { id: metadata.artifactId, header: metadata.header, body: metadata.body, dataEncryptionKey: metadata.dataEncryptionKey,
          blob: { blobId: metadata.blobId, content: blob } };
      }
      if (!saved) throw new Error('Missing created Artifact');
      if (path.endsWith('/recipients')) return new Response(JSON.stringify({ artifactId: saved.id, ownerAccountId: 'owner', access: 'owner',
        encryptionMode: mode, dataEncryptionKey: saved.dataEncryptionKey, callerDataEncryptionKey: saved.dataEncryptionKey, recipients: [] }));
      if (path.includes('/blobs/')) return new Response(JSON.stringify({ blobId: saved.blob?.blobId, content: blob }));
      return new Response(JSON.stringify({ ...saved, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 0, updatedAt: 0 }));
    });
    const { createArtifactWithHeaderViaApi, fetchArtifactBinaryFromApi } = await import('./syncArtifacts');
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    const artifactId = await createArtifactWithHeaderViaApi({ credentials: { token: 't' }, header: { kind: 'artifact.legacy', title: 'Image' },
      body: { bytes, mime: 'image/png' }, encryption, artifactDataKeys, request, addArtifact: artifact => added.push(artifact) });
    if (!saved || !blob) throw new Error('Missing uploaded bytes');
    const wire: ArtifactCreateRequest = saved;
    const storedBody = mode === 'plain' ? decodePlainArtifactStoredContent(wire.body)
      : await new ArtifactEncryption(artifactDataKeys.get(artifactId)!.dataKey).decryptBody(wire.body);
    const body = ArtifactBodyV1Schema.parse(Reflect.get(storedBody as object, 'body'));
    if (typeof body === 'string') throw new Error('Binary must remain a reference');
    expect(body).toMatchObject({ mime: 'image/png', sizeBytes: bytes.length, blobId: wire.blob?.blobId });
    expect(added[0]?.body).toEqual(body);
    await expect(fetchArtifactBinaryFromApi({ credentials: { token: 't' }, artifactId, reference: body, encryption, artifactDataKeys, request })).resolves.toEqual(bytes);
    blob = mode === 'plain' ? { t: 'encrypted', c: 'AA==' } : { t: 'plain', v: 'AA==' };
    await expect(fetchArtifactBinaryFromApi({ credentials: { token: 't' }, artifactId, reference: body, encryption, artifactDataKeys, request })).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
  });
  it('preserves passthrough header metadata in local decrypted artifacts', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(9));
    const artifactDataKeys: ArtifactDataKeyCache = new Map();
    const added: DecryptedArtifact[] = [];
    // Captured HTTP is the external boundary; mode checks, API and crypto stay real.
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/v1/account/encryption') return new Response(JSON.stringify({ mode: 'e2ee', updatedAt: 0 }));
      expect(path).toBe('/v1/artifacts');
      const input = JSON.parse(String(init?.body)) as ArtifactCreateRequest;
      return new Response(JSON.stringify({ ...input, ownerAccountId: 'owner', access: 'owner', encryptionMode: 'e2ee',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 0, updatedAt: 0 }));
    });

    const { createArtifactWithHeaderViaApi } = await import('./syncArtifacts');

    const artifactId = await createArtifactWithHeaderViaApi({
      credentials: { token: 't', secret: 's' },
      header: { v: 1, kind: 'approval_request.v1', title: 'Approve export', approvalStatus: 'open' },
      body: '{"v":1}',
      encryption,
      artifactDataKeys,
      request,
      addArtifact: (artifact) => added.push(artifact),
    });

    expect(typeof artifactId).toBe('string');
    expect(added).toHaveLength(1);
    expect(added[0]?.header?.kind).toBe('approval_request.v1');
    expect(added[0]?.header?.approvalStatus).toBe('open');
    expect(added[0]?.title).toBe('Approve export');
    expect(added[0]).toMatchObject({ ownerAccountId: 'owner', access: 'owner' });
  });
});
