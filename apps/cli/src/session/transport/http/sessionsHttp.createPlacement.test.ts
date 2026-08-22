import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const plainAccountEncryptionCurrentness = {
  mode: 'plain' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
};

describe('getOrCreateSessionByTag creation placement transport', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('@/api/session/resolveSessionCreateEncryptionMode');
  });

  it('carries a requested organization placement through the existing create-or-load request', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.doMock('@/api/session/resolveSessionCreateEncryptionMode', () => ({
      resolveSessionCreateEncryptionMode: vi.fn(async () => ({
        desiredSessionEncryptionMode: 'plain',
        accountEncryptionCurrentness: plainAccountEncryptionCurrentness,
        serverSupportsFeatureSnapshot: true,
      })),
    }));
    const { getOrCreateSessionByTag } = await import('./sessionsHttp');
    const organizationPlacement = {
      folderId: 'folder-1',
      tagIds: ['tag-1'],
    };
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        created: true,
        organizationPlacement,
        session: {
          id: 'session-1',
          seq: 0,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          metadata: '{}',
          metadataVersion: 0,
          agentState: null,
          agentStateVersion: 0,
          dataEncryptionKey: null,
        },
      },
    } as never);

    // The owner has not yet typed this new field. Invoke the boundary with an
    // extra request property to prove the transport does not silently discard it.
    await Reflect.apply(getOrCreateSessionByTag, undefined, [{
      credentials: { token: 'token-1', encryption: null },
      tag: 'create-placement-tag',
      metadata: {},
      agentState: null,
      organizationPlacement,
    }]);

    expect(post).toHaveBeenCalledWith(
      'http://server.example.test/v1/sessions',
      expect.objectContaining({ organizationPlacement }),
      expect.any(Object),
    );
  });

  it('reads the current mutable organization placement for one existing Session', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    const { fetchSessionOrganizationPlacement } = await import('./sessionsHttp');
    const get = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        snapshot: {
          schemaVersion: 1,
          version: 7,
          pins: [],
          folders: [],
          folderAssignments: [{ sessionId: 'session-existing', folderId: 'folder-current' }],
          tags: [],
          tagAssignments: [{ sessionId: 'session-existing', tagIds: ['tag-z', 'tag-a'] }],
          orderEntries: [],
          labels: [],
        },
      },
    } as never);

    await expect(fetchSessionOrganizationPlacement({
      token: 'token-1',
      sessionId: 'session-existing',
    })).resolves.toEqual({
      folderId: 'folder-current',
      tagIds: ['tag-a', 'tag-z'],
    });

    expect(get).toHaveBeenCalledWith(
      'http://server.example.test/v2/session-organization?includeFolders=false&includeTags=false&includeLabels=false&assignmentSessionIds=session-existing',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
      }),
    );
  });
});
