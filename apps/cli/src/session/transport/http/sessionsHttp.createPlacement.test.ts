import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';

const plainAccountEncryptionCurrentness = {
  mode: 'plain' as const,
  version: 1,
  signingKeyFingerprint: null,
  contentKeyFingerprint: null,
  updatedAt: 1,
};

describe('getOrCreateSessionByTag creation placement transport', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
  let releaseHome: () => void;

  beforeEach(async () => {
    const { publishServerHttpRuntimeOrigin } = await import('@/api/client/serverHttpBaseUrl');
    releaseHome = publishServerHttpRuntimeOrigin('http://server.example.test', 'https');
  });

  afterEach(() => {
    releaseHome();
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.doUnmock('@/api/session/resolveSessionCreateEncryptionMode');
  });

  it.each([true, false, undefined])('retains affirmative creation provenance independently of legacy created semantics (%s)', async created => {
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { encryption: {
      storagePolicy: 'optional', defaultAccountMode: 'plain', allowAccountOptOut: true,
    } } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features), {
      status: 200, headers: { 'content-type': 'application/json' },
    })));
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 200, data: {
      ...(created === undefined ? {} : { created }),
      session: createSessionRecordFixture({ id: 'creation-provenance', encryptionMode: 'plain' }),
    } });
    const { getOrCreateSessionByTag } = await import('./sessionsHttp');
    const result = await getOrCreateSessionByTag({
      credentials: { token: 'synthetic-creation-account', encryption: null }, tag: 'creation-provenance',
      metadata: {}, agentState: null, accountEncryptionCurrentness: createAccountEncryptionCurrentnessFixture(),
    });
    expect(result).toMatchObject({ created: created !== false, creationConfirmed: created === true });
  });

  it('carries a requested organization placement through the existing create-or-load request', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.doMock('@/api/session/resolveSessionCreateEncryptionMode', () => ({
      resolveSessionCreateEncryptionMode: vi.fn(async () => ({
        status: 'resolved',
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
  it('does not replace a denied signed assignment read with the installed Account token', async () => {
    const { fetchSessionOrganizationPlacement } = await import('./sessionsHttp');
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { snapshot: {
      schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
    } } } as never);
    const input = { token: 'installed-alice', sessionId: 'bob-session', resolveAuthorizationHeaders: () => null };
    await expect(fetchSessionOrganizationPlacement(input)).rejects.toThrow('External Action authorization unavailable');
    expect(get).not.toHaveBeenCalled();
  });
  it('loads a complete assignment corpus in the canonical snapshot batches rather than one request per Session', async () => {
    const { fetchSessionOrganizationPlacements } = await import('./sessionsHttp');
    const { SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS } = await import('@happier-dev/protocol/sessions/organization/constants');
    const sessionIds = Array.from({ length: SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS + 1 }, (_, index) => `session-${index}`);
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      const ids = new URL(url).searchParams.get('assignmentSessionIds')!.split(',');
      expect(config?.headers?.Authorization).toBeUndefined();
      expect(config?.headers?.['signed-assignment']).toBe('requester');
      return { status: 200, data: { snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [],
        tags: [], tagAssignments: ids.map(sessionId => ({ sessionId, tagIds: [`tag-${sessionId}`] })), orderEntries: [], labels: [] } } } as never;
    });
    const placements = await fetchSessionOrganizationPlacements({ token: 'installed-alice', sessionIds,
      resolveAuthorizationHeaders: () => ({ 'signed-assignment': 'requester' }) });
    expect(placements.size).toBe(sessionIds.length);
    for (const sessionId of sessionIds) expect(placements.get(sessionId)?.tagIds).toEqual([`tag-${sessionId}`]);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('stops the remaining assignment batches when the caller cancels', async () => {
    const { fetchSessionOrganizationPlacements } = await import('./sessionsHttp');
    const { SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS } = await import('@happier-dev/protocol/sessions/organization/constants');
    const controller = new AbortController();
    const get = vi.spyOn(axios, 'get').mockImplementation(async () => {
      controller.abort();
      return { status: 200, data: { snapshot: { schemaVersion: 1, version: 1, pins: [], folders: [],
        folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] } } } as never;
    });
    await expect(fetchSessionOrganizationPlacements({ token: 'token-1', signal: controller.signal,
      sessionIds: Array.from({ length: SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS + 1 }, (_, index) => `session-${index}`),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(get).toHaveBeenCalledOnce();
  });
});
