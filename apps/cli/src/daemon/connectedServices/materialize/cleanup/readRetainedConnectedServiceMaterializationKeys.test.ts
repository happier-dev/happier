import { describe, expect, it, vi } from 'vitest';
import {
  type AccountEncryptionCurrentnessResponse,
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { readRetainedConnectedServiceMaterializationKeys } from './readRetainedConnectedServiceMaterializationKeys';

const legacySecret = new Uint8Array(32).fill(1);
const credentials: Credentials = {
  token: 'token',
  encryption: { type: 'legacy', secret: legacySecret },
};
const plainAccountEncryptionCurrentness = Object.freeze({
  mode: 'plain' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
  recipientEnvelopeReadiness: Object.freeze({ status: 'unavailable' as const, reason: 'plain_account' as const }),
}) satisfies AccountEncryptionCurrentnessResponse;

describe('readRetainedConnectedServiceMaterializationKeys', () => {
  it('refuses reclamation authority when owner metadata cannot be read or is omitted for upgrade', async () => {
    const params = { credentials, getAccountEncryptionCurrentness: async () => plainAccountEncryptionCurrentness };
    await expect(readRetainedConnectedServiceMaterializationKeys({
      ...params, fetchSessionsPage: async () => ({
        sessions: [{ encryptionMode: 'plain', metadataLayoutVersion: 1, ownerMetadata: 'unreadable' }],
        nextCursor: null, hasNext: false,
      }),
    })).rejects.toMatchObject({ code: 'connected_service_home_retention_unavailable' });
    await expect(readRetainedConnectedServiceMaterializationKeys({
      ...params, fetchSessionsPage: async () => ({
        sessions: [], nextCursor: null, hasNext: false, metadataUpgradeRequiredCount: 1,
      }),
    })).rejects.toMatchObject({ code: 'connected_service_home_retention_unavailable' });
  });

  it('refuses reclamation authority when the server repeats a continuation cursor', async () => {
    await expect(readRetainedConnectedServiceMaterializationKeys({
      credentials, getAccountEncryptionCurrentness: async () => plainAccountEncryptionCurrentness,
      fetchSessionsPage: async () => ({ sessions: [], nextCursor: 'same-cursor', hasNext: true }),
    })).rejects.toMatchObject({ code: 'connected_service_home_retention_unavailable' });
    await expect(readRetainedConnectedServiceMaterializationKeys({
      credentials, getAccountEncryptionCurrentness: async () => plainAccountEncryptionCurrentness,
      fetchSessionsPage: async () => ({ sessions: [], nextCursor: null, hasNext: true }),
    })).rejects.toMatchObject({ code: 'connected_service_home_retention_unavailable' });
  });

  it('retains an inactive layout-v1 materialization identity from its sealed owner envelope', async () => {
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      connectedServices: {
        connectedServiceMaterializationIdentityV1: {
          v: 1,
          id: 'layout-v1-retained',
          createdAt: 1_000,
        },
      },
    });
    const fetchSessionsPage = vi.fn().mockResolvedValue({
      sessions: [{
        id: 'inactive-layout-v1',
        active: false,
        archivedAt: null,
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({ v: 1 }),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
      }],
      nextCursor: null,
      hasNext: false,
    });

    await expect(readRetainedConnectedServiceMaterializationKeys({
      credentials,
      fetchSessionsPage,
      getAccountEncryptionCurrentness: async () => plainAccountEncryptionCurrentness,
    })).resolves.toEqual(['layout-v1-retained']);
  });

  it('retains csm identities referenced by active and archived server Sessions too', async () => {
    const sessions = [
      { active: true, archivedAt: null, key: 'csm_live' },
      { active: false, archivedAt: 1_000, key: 'csm_archived' },
    ].map(({ key, ...row }) => ({
      ...row, encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({
        v: 1, connectedServices: {
          connectedServiceMaterializationIdentityV1: { v: 1, id: key, createdAt: 1_000 },
        },
      })),
    }));
    await expect(readRetainedConnectedServiceMaterializationKeys({
      credentials, fetchSessionsPage: async ({ archivedOnly }) => ({
        sessions: sessions.filter(row => archivedOnly ? row.archivedAt !== null : row.archivedAt === null),
        nextCursor: null, hasNext: false,
      }),
      getAccountEncryptionCurrentness: async () => plainAccountEncryptionCurrentness,
    })).resolves.toEqual(['csm_live', 'csm_archived']);
  });

  it('returns materialization identity ids from inactive non-archived session metadata', async () => {
    const row = (id: string, identityId?: string) => ({
      id, active: false, archivedAt: null, encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: JSON.stringify({ v: 1 }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({
        v: 1, ...(identityId ? { connectedServices: {
          connectedServiceMaterializationIdentityV1: { v: 1, id: identityId, createdAt: 1_000 },
        } } : {}),
      })),
    });
    const fetchSessionsPage = vi
      .fn()
      .mockResolvedValue({ sessions: [], nextCursor: null, hasNext: false })
      .mockResolvedValueOnce({
        sessions: [
          row('inactive-1', 'identity-one'),
          row('without-identity'),
        ],
        nextCursor: 'cursor-2',
        hasNext: true,
      })
      .mockResolvedValueOnce({
        sessions: [
          row('inactive-2', 'identity-two'),
        ],
        nextCursor: null,
        hasNext: false,
      });
    await expect(readRetainedConnectedServiceMaterializationKeys({
      credentials,
      fetchSessionsPage,
      getAccountEncryptionCurrentness: async () => plainAccountEncryptionCurrentness,
      pageLimit: 2,
    })).resolves.toEqual(['identity-one', 'identity-two']);

    expect(fetchSessionsPage).toHaveBeenNthCalledWith(1, {
      token: 'token',
      limit: 2,
    });
    expect(fetchSessionsPage).toHaveBeenNthCalledWith(2, {
      token: 'token',
      cursor: 'cursor-2',
      limit: 2,
    });
    expect(fetchSessionsPage).toHaveBeenNthCalledWith(3, { token: 'token', limit: 2, archivedOnly: true });
  });
});
