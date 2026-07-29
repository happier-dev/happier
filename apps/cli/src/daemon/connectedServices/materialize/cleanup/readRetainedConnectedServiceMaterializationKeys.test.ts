import { describe, expect, it, vi } from 'vitest';
import {
  sealSessionOwnerMetadataV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { readRetainedConnectedServiceMaterializationKeys } from './readRetainedConnectedServiceMaterializationKeys';

const legacySecret = new Uint8Array(32).fill(1);
const credentials: Credentials = {
  token: 'token',
  encryption: { type: 'legacy', secret: legacySecret },
};

describe('readRetainedConnectedServiceMaterializationKeys', () => {
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
        ownerMetadata: sealSessionOwnerMetadataV1({
          material: { type: 'legacy', secret: legacySecret },
          ownerMetadata,
          randomBytes: (length) => new Uint8Array(length).fill(7),
        }),
      }],
      nextCursor: null,
      hasNext: false,
    });

    await expect(readRetainedConnectedServiceMaterializationKeys({
      credentials,
      fetchSessionsPage,
    })).resolves.toEqual(['layout-v1-retained']);
  });

  it('returns materialization identity ids from inactive non-archived session metadata', async () => {
    const fetchSessionsPage = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [
          { id: 'inactive-1', active: false, archivedAt: null },
          { id: 'active-1', active: true, archivedAt: null },
          { id: 'archived-1', active: false, archivedAt: 1_000 },
        ],
        nextCursor: 'cursor-2',
        hasNext: true,
      })
      .mockResolvedValueOnce({
        sessions: [
          { id: 'inactive-2', active: false, archivedAt: null },
        ],
        nextCursor: null,
        hasNext: false,
      });
    const decryptSessionMetadata = vi.fn((_input: {
      credentials: Credentials;
      rawSession: { id?: unknown };
    }) => {
      if (_input.rawSession.id === 'inactive-1') {
        return {
          connectedServiceMaterializationIdentityV1: {
            v: 1,
            id: 'identity-one',
            createdAt: 1_000,
          },
        };
      }
      if (_input.rawSession.id === 'inactive-2') {
        return {
          connectedServiceMaterializationIdentityV1: {
            v: 1,
            id: 'identity-two',
            createdAt: 2_000,
          },
        };
      }
      return null;
    });

    await expect(readRetainedConnectedServiceMaterializationKeys({
      credentials,
      fetchSessionsPage,
      decryptSessionMetadata,
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
    expect(decryptSessionMetadata).toHaveBeenCalledTimes(2);
  });
});
