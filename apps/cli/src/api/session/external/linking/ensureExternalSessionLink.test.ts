import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexBackendMode } from '@happier-dev/agents';
import { buildCodexAgentRuntimeDescriptorV1 } from '@happier-dev/protocol/providers/runtimeDescriptorContributionsV1';
import { buildOpenCodeAgentRuntimeDescriptorV1 } from '@happier-dev/plugins-opencode/agent/identity/runtimeDescriptor';

const fetchSessionsPageMock = vi.fn();
const fetchSessionByIdMock = vi.fn();
const getOrCreateSessionByTagMock = vi.fn();
const tryDecryptSessionMetadataMock = vi.fn();
const updateSessionMetadataWithRetryMock = vi.fn();

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

import { ensureExternalSessionLink } from './ensureExternalSessionLink';

describe('ensureExternalSessionLink', () => {
  const legacyCodexBackendMode = '  mcp_resume  ' as unknown as CodexBackendMode;

  beforeEach(() => {
    vi.clearAllMocks();
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
