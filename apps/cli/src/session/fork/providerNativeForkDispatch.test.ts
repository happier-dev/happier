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
          providerId: 'codex',
          provider: { backendMode: 'appServer', providerSessionId: 'codex_parent_1', home: 'connectedService', connectedServiceId: 'openai-codex', connectedServiceProfileId: 'work', homePath: '/tmp/connected-codex-home' },
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
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'codex',
          provider: {
            backendMode: 'appServer',
            providerSessionId: 'codex_parent_1',
            home: 'connectedService',
            connectedServiceId: 'openai-codex',
            connectedServiceProfileId: 'work',
            homePath: '/tmp/connected-codex-home',
          },
        },
        codexSessionId: 'codex_parent_1',
        codexBackendMode: 'mcp',
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

  it('does not expose a provider-native fork when the bridge-resolved surface has no fork operation', async () => {
    expect(
      await dispatchProviderNativeFork({
        forkSurface: null,
        parentSessionId: 'happy_parent',
        parentMetadata: {
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'codex',
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
