import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeDescriptorV1 } from '@happier-dev/protocol';

const fetchSessionsPageMock = vi.fn();
const fetchSessionByIdMock = vi.fn();
const getOrCreateSessionByTagMock = vi.fn();
const tryDecryptSessionMetadataMock = vi.fn();
const updateSessionMetadataWithRetryMock = vi.fn();

vi.mock('@/sessionControl/sessionsHttp', () => ({
  fetchSessionById: (...args: unknown[]) => fetchSessionByIdMock(...args),
  fetchSessionsPage: (...args: unknown[]) => fetchSessionsPageMock(...args),
  getOrCreateSessionByTag: (...args: unknown[]) => getOrCreateSessionByTagMock(...args),
}));

vi.mock('@/sessionControl/sessionEncryptionContext', () => ({
  tryDecryptSessionMetadata: (...args: unknown[]) => tryDecryptSessionMetadataMock(...args),
}));

vi.mock('@/sessionControl/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry: (...args: unknown[]) => updateSessionMetadataWithRetryMock(...args),
}));

import { ensureDirectSessionLink } from './ensureDirectSessionLink';

describe('ensureDirectSessionLink', () => {
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
          backendMode: 'appServer',
          vendorSessionId: 'thread_runtime',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          homePath: '/tmp/connected-codex-home',
        },
      } satisfies AgentRuntimeDescriptorV1,
      source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', homePath: '/tmp/connected-codex-home' },
      titleHint: 'Codex linked session',
      directoryHint: '/repo',
      nowMs: () => 123,
    });

    const createdMetadata = getOrCreateSessionByTagMock.mock.calls[0]?.[0]?.metadata;
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
          homePath: '/tmp/connected-codex-home',
        },
      },
      directSessionV1: {
        remoteSessionId: 'thread_runtime',
        source: { kind: 'codexHome', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', homePath: '/tmp/connected-codex-home' },
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            vendorSessionId: 'thread_runtime',
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

    const runtimeDescriptor = {
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
    } satisfies AgentRuntimeDescriptorV1;

    await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'codex',
      remoteSessionId: 'thread_legacy',
      codexBackendMode: 'mcp',
      runtimeDescriptor,
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
      runtimeDescriptor: {
        v: 1,
        providerId: 'opencode',
        provider: {
          backendMode: 'server',
          vendorSessionId: 'oc_runtime',
          serverBaseUrl: 'http://127.0.0.1:4096/',
          serverBaseUrlExplicit: true,
        },
      } satisfies AgentRuntimeDescriptorV1,
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
      } satisfies AgentRuntimeDescriptorV1,
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

    const runtimeDescriptor = {
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
    } satisfies AgentRuntimeDescriptorV1;

    await ensureDirectSessionLink({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      machineId: 'machine_1',
      providerId: 'opencode',
      remoteSessionId: 'oc_legacy',
      runtimeDescriptor,
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
