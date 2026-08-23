import { describe, expect, it, vi, beforeEach } from 'vitest';

import { dispatchProviderNativeFork } from './providerNativeForkDispatch';

describe('dispatchProviderNativeFork', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches provider-native latest-turn conversation forks through the bridge-resolved fork surface', async () => {
    const fork = vi.fn().mockResolvedValue({
      providerSessionId: 'codex_child_1',
      launch: {
        environmentVariables: { CODEX_HOME: '/tmp/connected-codex-home' },
      },
    });

    const result = await dispatchProviderNativeFork({
      forkSurface: { fork },
      parentSessionId: 'happy_parent',
      parentMetadata: {
        agentRuntimeDescriptorV1: {
          v: 1,
          agentId: 'codex',
          provider: { backendMode: 'appServer', providerSessionId: 'codex_parent_1', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', connectedServiceGroupId: 'team', homePath: '/tmp/connected-codex-home' },
        },
        codexSessionId: 'codex_parent_1',
        codexBackendMode: 'mcp',
      },
      directory: '/tmp/project',
      forkPoint: { type: 'latest' },
    });

    expect(fork).toHaveBeenCalledWith({
      parentSessionId: 'happy_parent',
      parentMetadata: {
        providerSessionId: 'codex_parent_1',
        codexSessionId: 'codex_parent_1',
        codexBackendMode: 'appServer',
        codexHome: 'connectedService',
        codexConnectedServiceId: 'openai-codex',
        codexConnectedServiceProfileId: 'work',
        codexConnectedServiceGroupId: 'team',
        codexHomePath: '/tmp/connected-codex-home',
      },
      directory: '/tmp/project',
      forkPoint: { kind: 'latest' },
    });
    expect(result).toEqual({
      providerSessionId: 'codex_child_1',
      launch: {
        environmentVariables: { CODEX_HOME: '/tmp/connected-codex-home' },
      },
    });
  });

  it('passes the operation cancellation signal to the provider-native fork owner', async () => {
    const controller = new AbortController();
    const fork = vi.fn().mockResolvedValue(null);

    await dispatchProviderNativeFork({
      forkSurface: { fork },
      parentSessionId: 'happy_parent',
      parentMetadata: {
        codexSessionId: 'codex_parent_1',
        codexBackendMode: 'appServer',
      },
      directory: '/tmp/project',
      forkPoint: { type: 'latest' },
      signal: controller.signal,
    });

    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
  });

  it('projects OpenCode-safe fields from the canonical descriptor without forwarding the raw envelope', async () => {
    const fork = vi.fn().mockResolvedValue(null);

    await dispatchProviderNativeFork({
      forkSurface: { fork },
      parentSessionId: 'happy_opencode_parent',
      parentMetadata: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'opencode',
          agent: {
            backendMode: 'server',
            providerSessionId: ' opencode-parent-1 ',
            serverBaseUrl: 'http://127.0.0.1:49196',
            serverBaseUrlExplicit: true,
          },
        },
      },
      directory: '/tmp/project',
      forkPoint: { type: 'latest' },
    });

    expect(fork).toHaveBeenCalledWith(expect.objectContaining({
      parentMetadata: {
        providerSessionId: 'opencode-parent-1',
        opencodeSessionId: 'opencode-parent-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:49196/',
        opencodeServerBaseUrlExplicit: true,
      },
    }));
  });

  it('does not expose a provider-native fork when the bridge-resolved surface has no fork operation', async () => {
    expect(
      await dispatchProviderNativeFork({
        forkSurface: null,
        parentSessionId: 'happy_parent',
        parentMetadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'codex',
            provider: { backendMode: 'mcp', providerSessionId: 'codex_parent_1' },
          },
          codexSessionId: 'codex_parent_1',
          codexBackendMode: 'appServer',
        },
        directory: '/tmp/project',
        forkPoint: { type: 'latest' },
      }),
    ).toBeNull();
  });

});
