import { describe, expect, it, vi, beforeEach } from 'vitest';

const forkCodexAppServerConversationNativeMock = vi.fn();
const forkOpenCodeSessionNativeMock = vi.fn();

vi.mock('@/backends/codex/appServer/nativeFork', () => ({
  forkCodexAppServerConversationNative: (...args: unknown[]) => forkCodexAppServerConversationNativeMock(...args),
}));

vi.mock('@/backends/opencode/server/nativeFork', () => ({
  forkOpenCodeSessionNative: (...args: unknown[]) => forkOpenCodeSessionNativeMock(...args),
}));

import { dispatchProviderNativeFork } from './providerNativeForkDispatch';

describe('dispatchProviderNativeFork', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches Codex app-server latest-turn conversation forks through the native provider path', async () => {
    forkCodexAppServerConversationNativeMock.mockResolvedValueOnce({ vendorSessionId: 'codex_child_1' });

    const result = await dispatchProviderNativeFork({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      agentId: 'codex',
      parentSessionId: 'happy_parent',
      parentRawSession: {},
      parentMetadata: {
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: { backendMode: 'appServer', vendorSessionId: 'codex_parent_1', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', homePath: '/tmp/connected-codex-home' },
        },
        codexSessionId: 'codex_parent_1',
        codexBackendMode: 'mcp',
      },
      directory: '/tmp/project',
      forkPoint: { type: 'latest' },
      targetSeqInclusive: 17,
    });

    expect(forkCodexAppServerConversationNativeMock).toHaveBeenCalledWith({
      directory: '/tmp/project',
      parentCodexSessionId: 'codex_parent_1',
      processEnv: expect.objectContaining({ CODEX_HOME: '/tmp/connected-codex-home' }),
    });
    expect(result).toEqual({
      vendorSessionId: 'codex_child_1',
      spawn: {
        resume: 'codex_child_1',
        codexBackendMode: 'appServer',
        environmentVariables: { CODEX_HOME: '/tmp/connected-codex-home' },
      },
      metadata: {
        codexSessionId: 'codex_child_1',
        codexBackendMode: 'appServer',
        agentRuntimeDescriptorV1: expect.objectContaining({
          provider: expect.objectContaining({
            backendMode: 'appServer',
            vendorSessionId: 'codex_child_1',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
            homePath: '/tmp/connected-codex-home',
          }),
        }),
      },
      providerHint: {
        providerId: 'codex',
        backendMode: 'appServer',
        vendorSessionId: 'codex_child_1',
      },
    });
  });

  it('does not expose a Codex native fork for non-app-server or message-point requests', async () => {
    expect(
      await dispatchProviderNativeFork({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
        agentId: 'codex',
        parentSessionId: 'happy_parent',
        parentRawSession: {},
        parentMetadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
            provider: { backendMode: 'mcp', vendorSessionId: 'codex_parent_1' },
          },
          codexSessionId: 'codex_parent_1',
          codexBackendMode: 'appServer',
        },
        directory: '/tmp/project',
        forkPoint: { type: 'latest' },
        targetSeqInclusive: 17,
      }),
    ).toBeNull();

    expect(
      await dispatchProviderNativeFork({
        credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
        agentId: 'codex',
        parentSessionId: 'happy_parent',
        parentRawSession: {},
        parentMetadata: {
          codexSessionId: 'codex_parent_1',
          codexBackendMode: 'appServer',
        },
        directory: '/tmp/project',
        forkPoint: { type: 'seq', upToSeqInclusive: 17 },
        targetSeqInclusive: 17,
      }),
    ).toBeNull();
  });

  it('dispatches OpenCode provider-native forks through the shared provider registry path', async () => {
    forkOpenCodeSessionNativeMock.mockResolvedValueOnce({ vendorSessionId: 'oc_child_1' });

    const result = await dispatchProviderNativeFork({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      agentId: 'opencode',
      parentSessionId: 'happy_parent',
      parentRawSession: {},
      parentMetadata: {
        opencodeSessionId: 'legacy_parent_1',
        opencodeBackendMode: 'acp',
        opencodeServerBaseUrl: 'http://127.0.0.1:1111',
        opencodeServerBaseUrlExplicit: true,
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 'oc_parent_1',
            serverBaseUrl: 'http://127.0.0.1:4096',
            serverBaseUrlExplicit: true,
          },
        },
      },
      directory: '/tmp/project',
      forkPoint: { type: 'seq', upToSeqInclusive: 42 },
      targetSeqInclusive: 42,
    });

    expect(forkOpenCodeSessionNativeMock).toHaveBeenCalledWith({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      parentHappySessionId: 'happy_parent',
      parentRawSession: {},
      directory: '/tmp/project',
      parentOpenCodeSessionId: 'oc_parent_1',
      forkPoint: { type: 'seq', upToSeqInclusive: 42 },
    });
    expect(result).toMatchObject({
      vendorSessionId: 'oc_child_1',
      spawn: {
        resume: 'oc_child_1',
        environmentVariables: {
          HAPPIER_OPENCODE_BACKEND_MODE: 'server',
          HAPPIER_OPENCODE_SERVER_URL: 'http://127.0.0.1:4096/',
          HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
        },
      },
      providerHint: {
        providerId: 'opencode',
        backendMode: 'server',
        vendorSessionId: 'oc_child_1',
      },
    });
  });
});
