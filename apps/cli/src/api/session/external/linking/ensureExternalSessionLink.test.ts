import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCodexAgentRuntimeDescriptorV1 } from '@happier-dev/protocol/providers/runtimeDescriptorContributionsV1';
import type { CodexBackendMode } from '@happier-dev/protocol';
import { buildOpenCodeAgentRuntimeDescriptorV1 } from '@happier-dev/plugins-opencode/agent/identity/runtimeDescriptor';

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

import { ensureExternalSessionLink } from './ensureExternalSessionLink';

describe('ensureExternalSessionLink', () => {
  const legacyCodexBackendMode = '  mcp_resume  ' as unknown as CodexBackendMode;
  const connectedServices = {
    v: 1 as const,
    bindingsByServiceId: {
      'openai-codex': {
        source: 'connected' as const,
        selection: 'group' as const,
        groupId: 'codex-main',
        profileId: 'backup',
      },
    },
  };
  const materializationIdentity = {
    v: 1 as const,
    id: 'csm_direct_link',
    createdAt: 123,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listSessionMarkersMock.mockResolvedValue([]);
    fetchSessionsPageMock.mockResolvedValue({ sessions: [], hasNext: false, nextCursor: null });
    fetchSessionByIdMock.mockResolvedValue(null);
    tryDecryptSessionMetadataMock.mockReturnValue(null);
    updateSessionMetadataWithRetryMock.mockResolvedValue(undefined);
  });

  it('stores the canonical codex runtime descriptor for linked direct sessions', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_1',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'codex',
      remoteSessionId: 'thread_legacy',
      codexBackendMode: 'mcp',
      runtimeDescriptor: buildCodexAgentRuntimeDescriptorV1({
        backendMode: 'appServer',
        providerSessionId: 'thread_runtime',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
        homePath: '/tmp/connected-codex-home',
      }),
      source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', homePath: '/tmp/connected-codex-home' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      codexSessionId: 'thread_runtime',
      codexBackendMode: 'appServer',
      summary: {
        text: 'Codex linked session',
        updatedAt: expect.any(Number),
      },
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'thread_runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          homePath: '/tmp/connected-codex-home',
        },
      },
      externalSessionV1: {
        remoteSessionId: 'thread_runtime',
        source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', homePath: '/tmp/connected-codex-home' },
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'thread_runtime',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
            homePath: '/tmp/connected-codex-home',
          },
        },
      },
    });
    expect(createdMetadata).not.toHaveProperty('name');
    expect(createdMetadata).not.toHaveProperty('agentRuntimeDescriptorV1');
    expect(createdMetadata?.externalSessionV1).not.toHaveProperty('agentRuntimeDescriptorV1');
  });

  it('copies non-secret connected-service runtime identity from the tracked source session when creating a direct link', async () => {
    listSessionMarkersMock.mockResolvedValueOnce([
      {
        pid: 321,
        happySessionId: 'sess_source',
        happyHomeDir: '/tmp/happier-test-home',
        createdAt: 1,
        updatedAt: 10,
        flavor: 'codex',
        cwd: '/repo',
        metadata: {
          flavor: 'codex',
          codexSessionId: 'thread_runtime',
          connectedServices,
          connectedServicesUpdatedAt: 456,
        },
        respawn: {
          resume: 'thread_runtime',
          connectedServiceMaterializationIdentityV1: materializationIdentity,
          environmentVariables: {
            OPENAI_API_KEY: 'must-not-copy',
          },
        },
      },
    ]);
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_connected',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'codex',
      remoteSessionId: 'thread_runtime',
      source: { kind: 'codexHome', home: 'user' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      connectedServices,
      connectedServicesUpdatedAt: 456,
      connectedServiceMaterializationIdentityV1: materializationIdentity,
    });
    expect(JSON.stringify(createdMetadata)).not.toContain('must-not-copy');
  });

  it('recovers connected-service runtime identity from a catalog-backed ohMyPi tracked marker when creating a direct link', async () => {
    listSessionMarkersMock.mockResolvedValueOnce([
      {
        pid: 322,
        happySessionId: 'sess_source_ohmypi',
        happyHomeDir: '/tmp/happier-test-home',
        createdAt: 1,
        updatedAt: 10,
        flavor: 'ohMyPi',
        cwd: '/repo',
        metadata: {
          flavor: 'ohMyPi',
          ohMyPiSessionId: 'omp_thread_runtime',
          connectedServices,
          connectedServicesUpdatedAt: 456,
        },
        respawn: {
          directory: '/repo',
          connectedServiceMaterializationIdentityV1: materializationIdentity,
          environmentVariables: {
            GEMINI_API_KEY: 'must-not-copy',
          },
        },
      },
    ]);
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_connected_ohmypi',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'ohMyPi',
      remoteSessionId: 'omp_thread_runtime',
      source: { kind: 'ohMyPiAgentDir', agentDir: null },
      titleHint: 'OhMyPi linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata).toMatchObject({
      connectedServices,
      connectedServicesUpdatedAt: 456,
      connectedServiceMaterializationIdentityV1: materializationIdentity,
      ohMyPiSessionId: 'omp_thread_runtime',
    });
    expect(JSON.stringify(createdMetadata)).not.toContain('must-not-copy');
  });

  it('refreshes canonical runtime descriptor metadata when relinking an existing direct session', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array([1]) } };
    const runtimeDescriptor = buildCodexAgentRuntimeDescriptorV1({
      backendMode: 'appServer',
      providerSessionId: 'thread_runtime',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/connected-codex-home',
    });
    const linkInput = {
      credentials,
      machineId: 'machine_1',
      providerId: 'codex' as const,
      remoteSessionId: 'thread_legacy',
      codexBackendMode: 'mcp',
      runtimeDescriptor,
      source: { kind: 'codexHome' as const, home: 'connectedService' as const, connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', homePath: '/tmp/connected-codex-home' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    };
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_existing',
        metadata: {},
      },
    });

    await ensureExternalSessionLink(linkInput);

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    const staleMetadata = JSON.parse(JSON.stringify(createdMetadata));
    delete staleMetadata.runtimeDescriptorV1;
    delete staleMetadata.externalSessionV1.runtimeDescriptorV1;
    const existingRawSession = {
      id: 'sess_direct_existing',
      metadata: 'encrypted-metadata-placeholder',
    };
    let refreshedMetadata: Record<string, unknown> | null = null;

    getOrCreateSessionByTagMock.mockClear();
    fetchSessionsPageMock.mockResolvedValueOnce({
      sessions: [existingRawSession],
      hasNext: false,
      nextCursor: null,
    });
    fetchSessionByIdMock.mockResolvedValueOnce(existingRawSession);
    tryDecryptSessionMetadataMock.mockImplementation(({ rawSession }: { rawSession?: unknown }) =>
      rawSession === existingRawSession ? staleMetadata : null,
    );
    updateSessionMetadataWithRetryMock.mockImplementationOnce(async ({ updater }: { updater: (metadata: Record<string, unknown>) => Record<string, unknown> }) => {
      refreshedMetadata = updater(staleMetadata);
    });

    const relinked = await ensureExternalSessionLink(linkInput);

    expect(relinked).toEqual({
      sessionId: 'sess_direct_existing',
      created: false,
      tag: createdMetadata.tag,
    });
    expect(getOrCreateSessionByTagMock).not.toHaveBeenCalled();
    expect(updateSessionMetadataWithRetryMock).toHaveBeenCalledTimes(1);
    expect(refreshedMetadata).toMatchObject({
      codexSessionId: 'thread_runtime',
      codexBackendMode: 'appServer',
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'codex',
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'thread_runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          homePath: '/tmp/connected-codex-home',
        },
      },
      externalSessionV1: {
        remoteSessionId: 'thread_runtime',
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'thread_runtime',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
            homePath: '/tmp/connected-codex-home',
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

    await ensureExternalSessionLink({
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
          providerSessionId: 'thread_top_level',
          home: 'user',
          providerExtra: {
            owner: 'codex',
            schemaId: 'codex.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeAffinity: {
              backendMode: 'appServer',
              providerSessionId: 'thread_runtime',
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
      runtimeDescriptorV1: {
        provider: {
          backendMode: 'appServer',
          providerSessionId: 'thread_runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
      },
      externalSessionV1: {
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
      },
    });
  });

  it('preserves the existing codex source identity when the runtime descriptor is only partially populated', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_codex_partial_source',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'codex',
      remoteSessionId: 'thread_legacy',
      runtimeDescriptor: buildCodexAgentRuntimeDescriptorV1({
        backendMode: 'appServer',
        providerSessionId: 'thread_runtime',
        home: 'connectedService',
      }),
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'work',
        homePath: '/tmp/connected-codex-home',
      },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
    expect(createdMetadata?.externalSessionV1?.source).toEqual({
      kind: 'codexHome',
      home: 'connectedService',
      connectedServiceId: 'openai-codex',
      connectedServiceProfileId: 'work',
      homePath: '/tmp/connected-codex-home',
    });
  });

  it('normalizes legacy codex backend aliases when linking direct sessions without a runtime descriptor', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_alias',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
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
      runtimeDescriptorV1: {
        providerId: 'codex',
        provider: {
          backendMode: 'acp',
          providerSessionId: 'thread_alias',
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

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'opencode',
      remoteSessionId: 'oc_legacy',
      runtimeDescriptor: buildOpenCodeAgentRuntimeDescriptorV1({
        backendMode: 'server',
        providerSessionId: 'oc_runtime',
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
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'oc_runtime',
          serverBaseUrl: 'http://127.0.0.1:4096/',
          serverBaseUrlExplicit: true,
        },
      },
      externalSessionV1: {
        remoteSessionId: 'oc_runtime',
        runtimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            providerSessionId: 'oc_runtime',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
          },
        },
      },
    });
    expect(createdMetadata).not.toHaveProperty('agentRuntimeDescriptorV1');
    expect(createdMetadata?.externalSessionV1).not.toHaveProperty('agentRuntimeDescriptorV1');
  });

  it('forces OpenCode direct-session runtime descriptors to server mode when the source is opencodeServer', async () => {
    getOrCreateSessionByTagMock.mockResolvedValueOnce({
      session: {
        id: 'sess_direct_oc_force_server',
        metadata: {},
      },
    });

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'opencode',
      remoteSessionId: 'oc_legacy',
      runtimeDescriptor: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'acp',
          providerSessionId: 'oc_runtime',
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
      runtimeDescriptorV1: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          providerSessionId: 'oc_runtime',
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

    await ensureExternalSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'opencode',
      remoteSessionId: 'oc_legacy',
      runtimeDescriptor: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'acp',
          providerSessionId: 'oc_top_level',
          serverBaseUrl: 'http://legacy.example/',
          providerExtra: {
            owner: 'opencode',
            schemaId: 'opencode.agentRuntimeDescriptorExtra',
            v: 1,
            runtimeHandle: {
              backendMode: 'server',
              providerSessionId: 'oc_runtime',
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
});
