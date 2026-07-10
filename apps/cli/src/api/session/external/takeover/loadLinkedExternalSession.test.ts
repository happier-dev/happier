import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSessionByIdMock = vi.fn();
const tryDecryptSessionMetadataMock = vi.fn();

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: (...args: unknown[]) => fetchSessionByIdMock(...args),
}));

vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  tryDecryptSessionMetadata: (...args: unknown[]) => tryDecryptSessionMetadataMock(...args),
}));

import { loadLinkedExternalSession } from './loadLinkedExternalSession';

describe('loadLinkedExternalSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('loads legacy directSessionV1 metadata as a canonical linked external session', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_legacy_direct' });
    tryDecryptSessionMetadataMock.mockReturnValueOnce({
      path: '/repo',
      directSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine_1',
        remoteSessionId: 'claude-session',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/claude-config',
        },
        linkedAtMs: 1,
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_legacy_direct',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'claude',
        machineId: 'machine_1',
        remoteSessionId: 'claude-session',
        metadata: expect.objectContaining({
          externalSessionV1: expect.objectContaining({
            remoteSessionId: 'claude-session',
          }),
        }),
      }),
    });
  });

  it('prefers the nested OpenCode runtime descriptor over stale legacy metadata', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_1' });
    tryDecryptSessionMetadataMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'legacy-session',
      opencodeBackendMode: 'acp',
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'legacy-session',
        source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
        linkedAtMs: 1,
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'opencode',
          provider: {
            backendMode: 'server',
            providerSessionId: 'runtime-session',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
            providerExtra: {
              owner: 'opencode',
              schemaId: 'opencode.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                providerSessionId: 'runtime-session',
                serverBaseUrl: 'http://127.0.0.1:4096/',
                serverBaseUrlExplicit: true,
              },
            },
          },
        },
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_1',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'opencode',
        remoteSessionId: 'runtime-session',
      }),
    });
  });

  it('preserves the stored OpenCode source identity when the runtime descriptor does not carry a server base URL', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_open_code_partial_source' });
    tryDecryptSessionMetadataMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'opencode',
      externalSessionV1: {
        v: 1,
        agentId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'legacy-session',
        source: { kind: 'opencodeServer', directory: '/repo/opencode' },
        linkedAtMs: 1,
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'opencode',
          provider: {
            backendMode: 'server',
            providerSessionId: 'runtime-session',
          },
        },
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_open_code_partial_source',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'opencode',
        remoteSessionId: 'runtime-session',
        source: {
          kind: 'opencodeServer',
          directory: '/repo/opencode',
        },
      }),
    });
  });

  it('canonicalizes Codex direct-session identity from the nested runtime descriptor instead of stale source metadata', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_2' });
    tryDecryptSessionMetadataMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'codex',
      codexSessionId: 'legacy-thread',
      codexBackendMode: 'appServer',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'legacy-thread',
        source: { kind: 'codexHome', home: 'user', homePath: '/tmp/stale-home' },
        linkedAtMs: 1,
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'runtime-thread',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
            homePath: '/tmp/connected-home',
            providerExtra: {
              owner: 'codex',
              schemaId: 'codex.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeAffinity: {
                backendMode: 'appServer',
                providerSessionId: 'runtime-thread',
                home: 'connectedService',
                connectedServiceId: 'openai-codex',
                connectedServiceProfileId: 'work',
                homePath: '/tmp/connected-home',
              },
            },
          },
        },
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_2',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'codex',
        remoteSessionId: 'runtime-thread',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          homePath: '/tmp/connected-home',
        },
      }),
    });
  });

  it('preserves the stored codex source identity when the runtime descriptor only updates the session id', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_codex_partial_source' });
    tryDecryptSessionMetadataMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'codex',
      codexSessionId: 'legacy-thread',
      codexBackendMode: 'appServer',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine_1',
        remoteSessionId: 'legacy-thread',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          homePath: '/tmp/connected-home',
        },
        linkedAtMs: 1,
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'runtime-thread',
            home: 'connectedService',
          },
        },
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_codex_partial_source',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'codex',
        remoteSessionId: 'runtime-thread',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
          connectedServiceProfileId: 'work',
          homePath: '/tmp/connected-home',
        },
      }),
    });
  });

  it('re-canonicalizes linked Claude configDir from the current environment instead of stale stored metadata', async () => {
    vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '/tmp/live-claude-config');
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_claude_current_config' });
    tryDecryptSessionMetadataMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'claude',
      externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine_1',
        remoteSessionId: 'claude-session',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/stale-claude-config',
          projectId: 'proj-current',
        },
        linkedAtMs: 1,
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_claude_current_config',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'claude',
        remoteSessionId: 'claude-session',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/live-claude-config',
          projectId: 'proj-current',
        },
      }),
    });
  });

  it('re-canonicalizes linked ohMyPi agentDir from the current environment instead of stale stored metadata', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/tmp/live-omp-agent');
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_omp_current_agent_dir' });
    tryDecryptSessionMetadataMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'ohMyPi',
      externalSessionV1: {
        v: 1,
        agentId: 'ohMyPi',
        machineId: 'machine_1',
        remoteSessionId: 'omp-session',
        source: {
          kind: 'ohMyPiAgentDir',
          agentDir: '/tmp/stale-omp-agent',
        },
        linkedAtMs: 1,
      },
    });

    const result = await loadLinkedExternalSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_omp_current_agent_dir',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        agentId: 'ohMyPi',
        remoteSessionId: 'omp-session',
        source: {
          kind: 'ohMyPiAgentDir',
          agentDir: '/tmp/live-omp-agent',
        },
      }),
    });
  });
});
