import { beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactIdScopeMatchesAccountV1 } from '@happier-dev/protocol/artifacts/idScope';
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

  it('sends the explicit non-content Review start beside sealed Artifact content', async () => {
    const store = createAccountArtifactStore({ accountContent: { accountId: 'owner', encryption: null },
      getAccountEncryptionMode: async () => 'plain' });
    mockPost.mockImplementation(async (_url: string, wire: unknown) => ({ status: 200, data: {
      ...readCarrierMutation(wire), id: '11111111-1111-4111-8111-111111111111', ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain',
      publicAudience: 'none', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    } }));
    const reviewMetadata = { projectSourceId: null, workflowId: null, subjectKind: 'comparison' as const,
      sourceKind: 'direct' as const, state: 'running' as const, currentRoundOrdinal: 1, startedAt: 1, finishedAt: null };
    await store.create({ artifactId: '11111111-1111-4111-8111-111111111111',
      header: { kind: 'review.v1', v: 1, reviewId: '11111111-1111-4111-8111-111111111111', title: 'Private title' },
      body: JSON.stringify({ v: 1, rounds: [] }), reviewMetadata,
      authorizationHeaders: async () => ({ Authorization: 'Bearer test' }) });
    expect(readCarrierMutation(mockPost.mock.calls[0]![1])).toMatchObject({ reviewMetadata });
  });

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

  it.each(['plain', 'e2ee'] as const)('rejoins an Account-scoped %s creation from its acknowledgement', async mode => {
    const encryption = mode === 'plain' ? null : { type: 'legacy' as const, secret: new Uint8Array(32).fill(5) };
    const storeFor = (accountId: string) => createAccountArtifactStore({ accountContent: { accountId, encryption },
      getAccountEncryptionMode: async () => mode });
    const store = storeFor('owner');
    let actorAccountId = 'owner';
    const committed = new Map<string, unknown>();
    mockPost.mockImplementation(async (_url: string, wire: unknown) => {
      const write = readCarrierMutation(wire);
      const artifactId = String(write.id);
      expect(artifactIdScopeMatchesAccountV1({ artifactId, accountId: actorAccountId, idScope: write.idScope })).toBe(true);
      expect(artifactIdScopeMatchesAccountV1({ artifactId, accountId: 'foreign', idScope: write.idScope })).toBe(false);
      if (!committed.has(artifactId)) committed.set(artifactId, {
        ...write, ownerAccountId: actorAccountId, access: 'owner', encryptionMode: mode, publicAudience: 'none',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      });
      return { status: 200, data: committed.get(artifactId) };
    });
    const input = { creationSource: 'request-identity', includeAcknowledgedContent: true,
      header: { title: 'Notes' }, body: 'committed bytes', authorizationHeaders: async () => ({ Authorization: 'Bearer test' }) };
    const first = await store.create(input);
    const retry = await store.create({ ...input, body: 'attempted bytes' });
    expect(retry).toMatchObject({ artifactId: first.artifactId, acknowledged: { body: 'committed bytes' } });
    expect(committed.size).toBe(1);
    expect(mockGet).not.toHaveBeenCalled();

    actorAccountId = 'another-owner';
    const other = await storeFor(actorAccountId).create(input);
    expect(other.artifactId).not.toBe(first.artifactId);
    expect(committed.size).toBe(2);
  });

  it('honors explicit absent attribution instead of falling back to the account actor', async () => {
    const store = createAccountArtifactStore({ credentials: { token: 'token', encryption: null },
      getAccountEncryptionMode: async () => 'plain', savedBy: { kind: 'person', accountId: 'owner' } });
    mockPost.mockResolvedValue({ status: 200, data: { id: 'released', headerVersion: 1, bodyVersion: 1 } });
    await store.create({ artifactId: 'released', header: { title: 'Released' }, body: 'portable bytes', savedBy: null });
    expect(readCarrierMutation(mockPost.mock.calls[0]![1])).not.toHaveProperty('provenance');
  });
});
