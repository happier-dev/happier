import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountArtifactStore } from './accountArtifactStore';
import { readCarrierMutation } from './accountArtifactStore.testkit';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: Object.assign(actual.default.create(), actual.default, { get: mockGet, post: mockPost }) };
});

describe('acknowledged Account Artifact creation', () => {
  beforeEach(() => { mockGet.mockReset(); mockPost.mockReset(); });

  it('honors explicit absent attribution instead of falling back to the account actor', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain', savedBy: { kind: 'person', accountId: 'owner' } });
    mockPost.mockResolvedValue({ status: 200, data: { id: 'released', headerVersion: 1, bodyVersion: 1 } });
    await store.create({ artifactId: 'released', header: { title: 'Released' }, body: 'portable bytes', savedBy: null });
    expect(readCarrierMutation(mockPost.mock.calls[0]![1])).not.toHaveProperty('provenance');
  });
});
