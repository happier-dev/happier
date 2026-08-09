import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexBackendMode } from '@happier-dev/agents';
import { buildCodexAgentRuntimeDescriptorV1 } from '@happier-dev/protocol';
import { buildOpenCodeAgentRuntimeDescriptorV1 } from '@happier-dev/protocol';
import type {
  ConnectedServiceBindingsV1,
  ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

const fetchSessionsPageMock = vi.fn();
const fetchSessionByIdMock = vi.fn();
const getOrCreateSessionByTagMock = vi.fn();
const tryDecryptSessionMetadataMock = vi.fn();
const updateSessionMetadataWithRetryMock = vi.fn();
const listSessionMarkersMock = vi.fn();

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: (...args: unknown[]) => fetchSessionByIdMock(...args),
  fetchSessionsPage: (...args: unknown[]) => fetchSessionsPageMock(...args),
  getOrCreateSessionByTag: (...args: unknown[]) => getOrCreateSessionByTagMock(...args),
}));

vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  tryDecryptSessionMetadata: (...args: unknown[]) => tryDecryptSessionMetadataMock(...args),
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: (...args: unknown[]) => updateSessionMetadataWithRetryMock(...args),
}));

vi.mock('@/daemon/sessionRegistry', () => ({
  listSessionMarkers: (...args: unknown[]) => listSessionMarkersMock(...args),
}));

import { ensureDirectSessionLink } from './ensureDirectSessionLink';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('ensureDirectSessionLink', () => {
  const legacyCodexBackendMode = '  mcp_resume  ' as unknown as CodexBackendMode;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchSessionsPageMock.mockResolvedValue({ sessions: [], hasNext: false, nextCursor: null });
    fetchSessionByIdMock.mockResolvedValue(null);
    tryDecryptSessionMetadataMock.mockReturnValue(null);
    updateSessionMetadataWithRetryMock.mockResolvedValue(undefined);
    listSessionMarkersMock.mockResolvedValue([]);
  });

  it('stores the canonical codex runtime descriptor for linked direct sessions', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_1',
        metadata: {},
      },
    });

    const result = await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'codex',
      remoteSessionId: 'thread_legacy',
      codexBackendMode: 'mcp',
      runtimeDescriptor: buildCodexAgentRuntimeDescriptorV1({
        backendMode: 'appServer',
        vendorSessionId: 'thread_runtime',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
        connectedServiceGroupId: 'happier',
        homePath: '/tmp/connected-codex-home',
      }),
      source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', connectedServiceGroupId: 'happier', homePath: '/tmp/connected-codex-home' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    const expectedTag = `direct:v1:${sha256Hex('machine_1|codex|thread_runtime|codexHome:connectedService:openai-codex:group:happier:/tmp/connected-codex-home')}`;
    expect(result.tag).toBe(expectedTag);
    expect(getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.tag).toBe(expectedTag);
    expect(createdMetadata).toMatchObject({
      codexSessionId: 'thread_runtime',
      codexBackendMode: 'appServer',
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'thread_runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          connectedServiceGroupId: 'happier',
          homePath: '/tmp/connected-codex-home',
        },
      },
      directSessionV1: {
        remoteSessionId: 'thread_runtime',
        source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', connectedServiceGroupId: 'happier', homePath: '/tmp/connected-codex-home' },
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            vendorSessionId: 'thread_runtime',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
            connectedServiceGroupId: 'happier',
            homePath: '/tmp/connected-codex-home',
          },
        },
      },
    });
  });

  it('reuses an exact group-proven predecessor tag after member rotation and repairs canonical linked identity', async () => {
    const legacyTag = `direct:v1:${sha256Hex('machine_1|codex|thread_group|codexHome:connectedService:openai-codex:member-a:/tmp/connected-codex-home')}`;
    const canonicalTag = `direct:v1:${sha256Hex('machine_1|codex|thread_group|codexHome:connectedService:openai-codex:group:primary-pool:/tmp/connected-codex-home')}`;
    const existingMetadata = {
      tag: legacyTag,
      path: '/repo',
      flavor: 'codex',
      codexSessionId: 'thread_group',
      directSessionV1: {
        v: 1,
        providerId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'thread_group',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'member-a',
          connectedServiceGroupId: 'primary-pool',
          homePath: '/tmp/connected-codex-home',
        },
        linkedAtMs: 1,
      },
    };
    fetchSessionsPageMock
      .mockResolvedValueOnce({ sessions: [], hasNext: false, nextCursor: null })
      .mockResolvedValueOnce({ sessions: [], hasNext: false, nextCursor: null })
      .mockResolvedValueOnce({ sessions: [{ id: 'sess_group', metadata: existingMetadata }], hasNext: false, nextCursor: null });
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_group', metadata: existingMetadata });
    tryDecryptSessionMetadataMock.mockImplementation(({ rawSession }: { rawSession: { metadata?: unknown } }) => rawSession.metadata);

    const result = await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'codex',
      remoteSessionId: 'thread_group',
      codexBackendMode: 'appServer',
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'member-b',
        connectedServiceGroupId: 'primary-pool',
        homePath: '/tmp/connected-codex-home',
      },
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    expect(result).toEqual({ sessionId: 'sess_group', created: false, tag: canonicalTag });
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
    const updater = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0]?.updater;
    expect(typeof updater).toBe('function');
    expect(updater(existingMetadata)).toMatchObject({
      tag: canonicalTag,
      codexSessionId: 'thread_group',
      agentRuntimeDescriptorV1: {
        provider: {
          vendorSessionId: 'thread_group',
          connectedServiceGroupId: 'primary-pool',
        },
      },
      directSessionV1: {
        remoteSessionId: 'thread_group',
        source: {
          connectedServiceGroupId: 'primary-pool',
        },
        agentRuntimeDescriptorV1: {
          provider: {
            connectedServiceGroupId: 'primary-pool',
          },
        },
      },
    });
  });

  it('prefers providerExtra when linked direct-session runtime descriptors carry stale top-level codex fields', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_2',
        metadata: {},
      },
    });

    await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'codex',
      remoteSessionId: 'thread_legacy',
      codexBackendMode: 'mcp',
      runtimeDescriptor: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'mcp',
          vendorSessionId: 'thread_top_level',
          home: 'user',
          providerExtra: {
            owner: 'codex',
            schemaId: 'codex.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeAffinity: {
              backendMode: 'appServer',
              vendorSessionId: 'thread_runtime',
              home: 'connectedService',
              connectedServiceId: 'openai-codex',
            },
          },
        },
      },
      source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      codexSessionId: 'thread_runtime',
      codexBackendMode: 'appServer',
      agentRuntimeDescriptorV1: {
        provider: {
          backendMode: 'appServer',
          vendorSessionId: 'thread_runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
      },
      directSessionV1: {
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
      },
    });
  });

  it('normalizes legacy codex backend aliases when linking direct sessions without a runtime descriptor', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_alias',
        metadata: {},
      },
    });

    await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'codex',
      remoteSessionId: 'thread_alias',
      codexBackendMode: legacyCodexBackendMode,
      source: { kind: 'codexHome', home: 'user' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      codexSessionId: 'thread_alias',
      codexBackendMode: 'acp',
      agentRuntimeDescriptorV1: {
        providerId: 'codex',
        provider: {
          backendMode: 'acp',
          vendorSessionId: 'thread_alias',
        },
      },
    });
  });

  it('stores the canonical OpenCode runtime descriptor for linked direct sessions', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_oc_1',
        metadata: {},
      },
    });

    await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'opencode',
      remoteSessionId: 'oc_legacy',
      runtimeDescriptor: buildOpenCodeAgentRuntimeDescriptorV1({
        backendMode: 'server',
        vendorSessionId: 'oc_runtime',
        serverBaseUrl: 'http://127.0.0.1:4096/',
        serverBaseUrlExplicit: true,
      }),
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/', directory: '/repo' },
      titleHint: 'OpenCode linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      opencodeSessionId: 'oc_runtime',
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
      opencodeServerBaseUrlExplicit: true,
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          vendorSessionId: 'oc_runtime',
          serverBaseUrl: 'http://127.0.0.1:4096/',
          serverBaseUrlExplicit: true,
        },
      },
      directSessionV1: {
        remoteSessionId: 'oc_runtime',
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 'oc_runtime',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
          },
        },
      },
    });
  });

  it('forces OpenCode direct-session runtime descriptors to server mode when the source is opencodeServer', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_oc_force_server',
        metadata: {},
      },
    });

    await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'opencode',
      remoteSessionId: 'oc_legacy',
      runtimeDescriptor: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'acp',
          vendorSessionId: 'oc_runtime',
          serverBaseUrl: 'http://127.0.0.1:4096/',
          serverBaseUrlExplicit: true,
        },
      } as any,
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/', directory: '/repo' },
      titleHint: 'OpenCode linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      opencodeSessionId: 'oc_runtime',
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
      opencodeServerBaseUrlExplicit: true,
      agentRuntimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          vendorSessionId: 'oc_runtime',
        },
      },
    });
  });

  it('prefers providerExtra when linked direct-session runtime descriptors carry stale top-level OpenCode fields', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_oc_2',
        metadata: {},
      },
    });

    await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'opencode',
      remoteSessionId: 'oc_legacy',
      runtimeDescriptor: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'acp',
          vendorSessionId: 'oc_top_level',
          serverBaseUrl: 'http://legacy.example/',
          providerExtra: {
            owner: 'opencode',
            schemaId: 'opencode.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeHandle: {
              backendMode: 'server',
              vendorSessionId: 'oc_runtime',
              serverBaseUrl: 'http://127.0.0.1:4096/',
              serverBaseUrlExplicit: true,
            },
          },
        },
      },
      source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/', directory: '/repo' },
      titleHint: 'OpenCode linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      opencodeSessionId: 'oc_runtime',
      opencodeBackendMode: 'server',
      opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
      opencodeServerBaseUrlExplicit: true,
    });
  });

  it('persists non-secret connected-service identity from a matching daemon marker when creating an OpenCode direct link', async () => {
    const connectedServices = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'group',
          groupId: 'happier',
          profileId: 'batiplus',
        },
      },
    } satisfies ConnectedServiceBindingsV1;
    const materializationIdentity = {
      v: 1,
      id: 'csm_opencode_link',
      createdAtMs: 1_718_719_900_000,
    } satisfies ConnectedServiceMaterializationIdentityV1;
    listSessionMarkersMock.mockResolvedValueOnce([
      {
        pid: 12345,
        updatedAt: 200,
        flavor: 'opencode',
        cwd: '/repo',
        metadata: {
          flavor: 'opencode',
          path: '/repo',
        },
        respawn: {
          version: 1,
          directory: '/repo',
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
          connectedServices,
          connectedServicesUpdatedAt: 1_718_719_899_000,
          connectedServiceMaterializationIdentityV1: materializationIdentity,
          environmentVariables: {
            OPENCODE_AUTH_CONTENT: 'must-not-be-copied',
          },
        },
      },
    ]);
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_oc_connected',
        metadata: {},
      },
    });

    await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'opencode',
      remoteSessionId: 'oc_connected',
      runtimeDescriptor: buildOpenCodeAgentRuntimeDescriptorV1({
        backendMode: 'server',
        vendorSessionId: 'oc_connected',
      }),
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      titleHint: 'OpenCode linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      connectedServices,
      connectedServicesUpdatedAt: 1_718_719_899_000,
      connectedServiceMaterializationIdentityV1: materializationIdentity,
      directSessionV1: {
        remoteSessionId: 'oc_connected',
      },
    });
    expect(JSON.stringify(createdMetadata)).not.toContain('OPENCODE_AUTH_CONTENT');
    expect(JSON.stringify(createdMetadata)).not.toContain('must-not-be-copied');
  });

  it('refreshes existing OpenCode direct links with non-secret connected-service identity from matching daemon markers', async () => {
    const connectedServices = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'profile',
          profileId: 'work',
        },
      },
    } satisfies ConnectedServiceBindingsV1;
    const materializationIdentity = {
      v: 1,
      id: 'csm_opencode_existing_link',
      createdAtMs: 1_718_720_000_000,
    } satisfies ConnectedServiceMaterializationIdentityV1;
    const tag = `direct:v1:${sha256Hex('machine_1|opencode|oc_existing|opencodeServer::')}`;
    const existingMetadata = {
      tag,
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'oc_existing',
      directSessionV1: {
        v: 1,
        providerId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'oc_existing',
        source: { kind: 'opencodeServer', baseUrl: null, directory: null },
        linkedAtMs: 1,
      },
    };
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [{ id: 'sess_existing_oc', metadata: existingMetadata }],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_existing_oc', metadata: existingMetadata });
    tryDecryptSessionMetadataMock.mockImplementation(({ rawSession }: { rawSession: { metadata?: unknown } }) => rawSession.metadata);
    listSessionMarkersMock.mockResolvedValueOnce([
      {
        pid: 12346,
        updatedAt: 300,
        flavor: 'opencode',
        cwd: '/repo',
        metadata: {
          flavor: 'opencode',
          path: '/repo',
        },
        respawn: {
          version: 1,
          directory: '/repo',
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
          connectedServices,
          connectedServicesUpdatedAt: 1_718_719_999_000,
          connectedServiceMaterializationIdentityV1: materializationIdentity,
          environmentVariables: {
            OPENCODE_AUTH_CONTENT: 'must-not-be-copied',
          },
        },
      },
    ]);

    const result = await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'opencode',
      remoteSessionId: 'oc_existing',
      source: { kind: 'opencodeServer', baseUrl: null, directory: null },
      titleHint: 'OpenCode linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    expect(result).toEqual({
      sessionId: 'sess_existing_oc',
      created: false,
      tag,
    });
    const updater = updateSessionMetadataWithRetryMock.mock.calls[0]?.[0]?.updater;
    expect(typeof updater).toBe('function');
    const updatedMetadata = updater(existingMetadata);
    expect(updatedMetadata).toMatchObject({
      connectedServices,
      connectedServicesUpdatedAt: 1_718_719_999_000,
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    });
    expect(JSON.stringify(updatedMetadata)).not.toContain('OPENCODE_AUTH_CONTENT');
    expect(JSON.stringify(updatedMetadata)).not.toContain('must-not-be-copied');
  });

  it('creates a pi direct link with piSessionId metadata and a piAgentDir source key', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: { id: 'sess_direct_pi_1', metadata: {} },
    });

    const result = await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'pi',
      remoteSessionId: 'pi_sess_1',
      source: { kind: 'piAgentDir', agentDir: '/home/user/.pi/agent' },
      titleHint: 'Pi linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const expectedTag = `direct:v1:${sha256Hex('machine_1|pi|pi_sess_1|piAgentDir:/home/user/.pi/agent')}`;
    expect(result.tag).toBe(expectedTag);
    expect(getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.tag).toBe(expectedTag);
    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      flavor: 'pi',
      piSessionId: 'pi_sess_1',
      directSessionV1: {
        v: 1,
        providerId: 'pi',
        machineId: 'machine_1',
        remoteSessionId: 'pi_sess_1',
        source: { kind: 'piAgentDir', agentDir: '/home/user/.pi/agent' },
      },
    });
  });

  it('discriminates pi direct sessions by agentDir so identical remote ids do not collide', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({ session: { id: 'sess_direct_pi_a', metadata: {} } });
    getOrCreateSessionByTagMock.mockResolvedValueOnce({ session: { id: 'sess_direct_pi_b', metadata: {} } });

    const resultAlice = await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'pi',
      remoteSessionId: 'pi_sess_shared',
      source: { kind: 'piAgentDir', agentDir: '/home/alice/.pi/agent' },
      nowMs: () => 123,
    });
    const resultBob = await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'pi',
      remoteSessionId: 'pi_sess_shared',
      source: { kind: 'piAgentDir', agentDir: '/home/bob/.pi/agent' },
      nowMs: () => 123,
    });

    expect(resultAlice.tag).not.toBe(resultBob.tag);
    expect(resultAlice.tag).toBe(`direct:v1:${sha256Hex('machine_1|pi|pi_sess_shared|piAgentDir:/home/alice/.pi/agent')}`);
    expect(resultBob.tag).toBe(`direct:v1:${sha256Hex('machine_1|pi|pi_sess_shared|piAgentDir:/home/bob/.pi/agent')}`);
  });

  it('recognizes a pi daemon marker by flavor and resolves its remoteSessionId from piSessionId metadata', async () => {
    const connectedServices = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier', profileId: 'work' },
      },
    } satisfies ConnectedServiceBindingsV1;
    const materializationIdentity = {
      v: 1,
      id: 'csm_pi_link',
      createdAtMs: 1_718_719_900_000,
    } satisfies ConnectedServiceMaterializationIdentityV1;
    listSessionMarkersMock.mockResolvedValueOnce([
      {
        pid: 12345,
        updatedAt: 200,
        flavor: 'pi',
        cwd: '/repo',
        metadata: { flavor: 'pi', path: '/repo', piSessionId: 'pi_connected' },
        respawn: {
          version: 1,
          directory: '/repo',
          backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
          connectedServices,
          connectedServicesUpdatedAt: 1_718_719_899_000,
          connectedServiceMaterializationIdentityV1: materializationIdentity,
        },
      },
    ]);
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: { id: 'sess_direct_pi_connected', metadata: {} },
    });

    await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'pi',
      remoteSessionId: 'pi_connected',
      source: { kind: 'piAgentDir', agentDir: '/home/user/.pi/agent' },
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      connectedServices,
      connectedServicesUpdatedAt: 1_718_719_899_000,
      connectedServiceMaterializationIdentityV1: materializationIdentity,
      directSessionV1: { remoteSessionId: 'pi_connected' },
    });
  });
});
