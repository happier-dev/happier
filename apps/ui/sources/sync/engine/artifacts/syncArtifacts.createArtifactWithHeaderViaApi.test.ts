import { describe, expect, it, vi } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import type { ArtifactDataKeyCache } from './syncArtifacts';
import type { ArtifactCreateRequest, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { ArtifactBodyV1Schema, decodePlainArtifactStoredContent, type ArtifactBlobStoredContentV1 } from '@happier-dev/protocol';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import { encodeBase64 } from '@/encryption/base64';

describe('createArtifactWithHeaderViaApi', () => {
  it.each(['plain', 'e2ee'] as const)('refuses a reference-only create in %s before any request can persist missing file bytes', async (mode) => {
    const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(9)) : null;
    const artifactDataKeys: ArtifactDataKeyCache = new Map();
    const added: DecryptedArtifact[] = [];
    // Captured HTTP represents a server that accepts opaque legacy text bodies.
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/v1/account/encryption') return new Response(JSON.stringify({ mode, updatedAt: 0 }));
      const input = JSON.parse(String(init?.body)) as ArtifactCreateRequest;
      return new Response(JSON.stringify({ ...input, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 0, updatedAt: 0 }));
    });
    const { createArtifactWithHeaderViaApi } = await import('./syncArtifacts');
    await expect(createArtifactWithHeaderViaApi({ credentials: { token: 't' }, header: { title: 'File' },
      body: { blobId: 'b6a4bb92-8b93-4b18-b8b4-230041388a62', mime: 'application/zip', sizeBytes: 3, sha256: 'a'.repeat(64) },
      encryption, artifactDataKeys, request, addArtifact: artifact => added.push(artifact) })).rejects.toMatchObject({ code: 'artifact_invalid_body' });
    expect(request).not.toHaveBeenCalled();
    expect(artifactDataKeys.size).toBe(0);
    expect(added).toEqual([]);
  });
  it.each(['plain', 'e2ee'] as const)('uploads and reads binary bytes in %s without disclosing a mismatched or substituted payload', async (mode) => {
    const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(9)) : null;
    const artifactDataKeys: ArtifactDataKeyCache = new Map();
    const added: DecryptedArtifact[] = [];
    let saved: ArtifactCreateRequest | null = null;
    let blob: ArtifactBlobStoredContentV1 | null = null;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/v1/account/encryption') return new Response(JSON.stringify({ mode, updatedAt: 0 }));
      if (path === '/v1/artifacts/content/binary') {
        saved = JSON.parse(String(init?.body)) as ArtifactCreateRequest;
        blob = saved.blob?.content ?? null;
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
    const substituted = new Uint8Array(bytes.length).fill(42);
    blob = mode === 'plain' ? { t: 'plain', v: encodeBase64(substituted, 'base64') }
      : { t: 'encrypted', c: await new ArtifactEncryption(artifactDataKeys.get(artifactId)!.dataKey).encryptBytes(substituted) };
    await expect(fetchArtifactBinaryFromApi({ credentials: { token: 't' }, artifactId, reference: body, encryption, artifactDataKeys, request })).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
    blob = mode === 'plain' ? { t: 'encrypted', c: 'AA==' } : { t: 'plain', v: 'AA==' };
    await expect(fetchArtifactBinaryFromApi({ credentials: { token: 't' }, artifactId, reference: body, encryption, artifactDataKeys, request })).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
  });
  it.each(['plain', 'e2ee'] as const)('keeps legacy null-body creation usable in %s', async (mode) => {
    const encryption = mode === 'e2ee' ? await Encryption.create(new Uint8Array(32).fill(9)) : null;
    const added: DecryptedArtifact[] = [];
    const request = async (path: string, init?: RequestInit) => {
      if (path === '/v1/account/encryption') return Response.json({ mode, updatedAt: 0 });
      expect(path).toBe('/v1/artifacts');
      const input = JSON.parse(String(init?.body)) as ArtifactCreateRequest;
      expect(input.blob).toBeUndefined();
      return Response.json({ ...input, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 0, updatedAt: 0 });
    };
    const { createArtifactWithHeaderViaApi } = await import('./syncArtifacts');
    await createArtifactWithHeaderViaApi({ credentials: { token: 't' }, header: { title: 'Empty' }, body: null,
      encryption, artifactDataKeys: new Map(), request, addArtifact: artifact => added.push(artifact) });
    expect(added).toHaveLength(1);
    expect(added[0]?.body).toBeNull();
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
