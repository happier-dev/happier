import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeSchema } from '@happier-dev/protocol/actions/externalActionApi';
import { encodeTemplateBirthExecutionAuthorizationV1, TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    vi.doUnmock('@/api/session/resolveSessionCreateEncryptionMode');
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

  it.each([true, false])('returns the birth-bound authorization before handing the committed Session to its caller (valid header: %s)', async validHeader => {
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { encryption: {
      storagePolicy: 'optional', defaultAccountMode: 'plain', allowAccountOptOut: true,
    } } });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(features)));
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'birth-proof', binding: {
      accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      custodianAccountId: 'owner', serverIdentityId: 'home', machineId: 'machine-1', installationId: 'installation-1',
      actionId: 'template.instantiate', requestId: 'template-birth', target: { kind: 'machine', machineId: 'machine-1' },
      requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const originalActionEnvelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'template-birth',
      input: {}, target: { kind: 'machine', machineId: 'machine-1' } });
    const carrier = { authorization, originalActionEnvelope };
    const birthAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
      binding: { ...authorization.binding, templateRequesterBirth: { sessionId: 'birth-session',
        creationTag: `create:v1:${'b'.repeat(43)}` } } });
    const post = vi.spyOn(axios, 'post').mockResolvedValueOnce({ status: 200, headers: {
      [TEMPLATE_BIRTH_EXECUTION_AUTHORIZATION_HEADER_V1]: validHeader ? encodeTemplateBirthExecutionAuthorizationV1(birthAuthorization) : 'malformed-proof',
    }, data: { created: false, session: createSessionRecordFixture({ id: 'birth-session', encryptionMode: 'plain' }) } });
    const received: typeof authorization[] = [];
    const { getOrCreateSessionByTag } = await import('./sessionsHttp');
    const result = getOrCreateSessionByTag({
      credentials: { token: 'synthetic-creation-account', encryption: null }, tag: 'birth-session',
      metadata: {}, agentState: null, accountEncryptionCurrentness: createAccountEncryptionCurrentnessFixture(),
      templateRequesterAuthorization: carrier, onCreationAuthorization: (proof: typeof authorization) => received.push(proof),
    });
    if (validHeader) await expect(result).resolves.toMatchObject({ created: false, session: { id: 'birth-session' } });
    else await expect(result).rejects.toThrow('Unexpected /v1/sessions birth authorization shape');
    expect(received).toEqual(validHeader ? [birthAuthorization] : []);
    expect(post.mock.calls[0]?.[1]).toMatchObject({ templateRequesterAuthorization: carrier });
  });

});
