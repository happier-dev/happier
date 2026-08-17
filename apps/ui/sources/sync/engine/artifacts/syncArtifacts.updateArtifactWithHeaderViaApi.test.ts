import { describe, expect, it, vi } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import type { ArtifactDataKeyCache } from './syncArtifacts';

vi.mock('@/sync/api/artifacts/apiArtifacts', () => ({
  createArtifact: vi.fn(),
  fetchArtifact: vi.fn(),
  fetchArtifacts: vi.fn(),
  updateArtifact: vi.fn(async (_credentials: any, _artifactId: string, _request: any) => ({
    success: true,
    headerVersion: 2,
    bodyVersion: 2,
  })),
}));

describe('updateArtifactWithHeaderViaApi', () => {
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

    const current = {
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
    } as any;

    const updated: any[] = [];

    const { updateArtifactWithHeaderViaApi } = await import('./syncArtifacts');

    await updateArtifactWithHeaderViaApi({
      credentials: { token: 't', secret: 's' },
      artifactId,
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
});
