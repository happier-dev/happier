import { describe, expect, it, vi } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';

vi.mock('@/sync/api/artifacts/apiArtifacts', () => ({
  createArtifact: vi.fn(async (_credentials: any, request: any) => ({
    id: request.id,
    headerVersion: 1,
    bodyVersion: 1,
    seq: 1,
    createdAt: 0,
    updatedAt: 0,
  })),
  fetchArtifact: vi.fn(),
  fetchArtifacts: vi.fn(),
  updateArtifact: vi.fn(),
}));

describe('createArtifactWithHeaderViaApi', () => {
  it('preserves passthrough header metadata in local decrypted artifacts', async () => {
    const encryption = await Encryption.create(new Uint8Array(32).fill(9));
    const artifactDataKeys = new Map<string, Uint8Array>();
    const added: any[] = [];

    const { createArtifactWithHeaderViaApi } = await import('./syncArtifacts');

    const artifactId = await createArtifactWithHeaderViaApi({
      credentials: { token: 't', secret: 's' },
      header: { v: 1, kind: 'approval_request.v1', title: 'Approve export', approvalStatus: 'open' },
      body: '{"v":1}',
      encryption,
      artifactDataKeys,
      addArtifact: (artifact) => added.push(artifact),
    });

    expect(typeof artifactId).toBe('string');
    expect(added).toHaveLength(1);
    expect(added[0]?.header?.kind).toBe('approval_request.v1');
    expect(added[0]?.header?.approvalStatus).toBe('open');
    expect(added[0]?.title).toBe('Approve export');
  });
});

