import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountArtifactStore, createAcknowledgedAccountArtifactTransport } from './accountArtifactStore';
import { readCarrierMutation } from './accountArtifactStore.testkit';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: Object.assign(actual.default.create(), actual.default, { get: mockGet, post: mockPost }) };
});

describe('acknowledged Account Artifact creation', () => {
  beforeEach(() => { mockGet.mockReset(); mockPost.mockReset(); });

  it('returns acknowledged created content without reading its own write', async () => {
    const store = createAccountArtifactStore({ accountContent: { accountId: 'owner', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    mockPost.mockImplementation(async (_url: string, wire: unknown) => ({ status: 200, data: {
      ...readCarrierMutation(wire), id: 'created', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
      publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    } }));
    const authorizationHeaders = async () => ({ Authorization: 'Bearer test' });
    const transport = createAcknowledgedAccountArtifactTransport({ ...store,
      create: input => store.create({ ...input, authorizationHeaders }) });
    expect(await transport.create({ artifactId: 'created', header: { title: 'Created' }, body: 'reviewed bytes' }))
      .toMatchObject({ artifactId: 'created', ownerAccountId: 'owner', access: 'owner',
        body: 'reviewed bytes', header: { title: 'Created' }, revision: { headerVersion: 1, bodyVersion: 1 } });
    expect(mockGet).not.toHaveBeenCalled();
    mockPost.mockResolvedValue({ status: 200, data: {
      id: 'created', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
      header: encodePlainArtifactStoredContent({ title: 'Incumbent' }),
      body: encodePlainArtifactStoredContent({ body: 'incumbent bytes' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 3, bodyVersion: 4, seq: 4, createdAt: 1, updatedAt: 4,
    } });
    expect(await transport.create({ artifactId: 'created', header: { title: 'Replacement' }, body: 'replacement bytes' }))
      .toMatchObject({ header: { title: 'Incumbent' }, body: 'incumbent bytes', revision: { headerVersion: 3, bodyVersion: 4 } });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('honors explicit absent attribution instead of falling back to the account actor', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain', savedBy: { kind: 'person', accountId: 'owner' } });
    mockPost.mockResolvedValue({ status: 200, data: { id: 'released', headerVersion: 1, bodyVersion: 1 } });
    await store.create({ artifactId: 'released', header: { title: 'Released' }, body: 'portable bytes', savedBy: null });
    expect(readCarrierMutation(mockPost.mock.calls[0]![1])).not.toHaveProperty('provenance');
  });
});
