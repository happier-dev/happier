import { describe, expect, it } from 'vitest';
import { buildCodexAgentRuntimeDescriptorV1 as buildCodexRuntimeIdentityDescriptorV1 } from '@happier-dev/protocol/agents/runtimeDescriptorContributionsV1';

import { resolveSessionRuntimeIdentityFallback } from '@/agent/runtime/identity';

describe('resolveSessionRuntimeIdentityFallback', () => {
  it('prefers canonical runtime descriptor identity over legacy metadata fields', () => {
    const result = resolveSessionRuntimeIdentityFallback({
      metadata: {
        flavor: 'claude',
        codexSessionId: 'legacy-session',
        externalSessionV1: {
          v: 1,
          providerId: 'codex',
          remoteSessionId: 'legacy-session',
          source: { kind: 'codexHome', home: 'user' },
          linkedAtMs: 1,
        },
        agentRuntimeDescriptorV1: buildCodexRuntimeIdentityDescriptorV1({
          backendMode: 'appServer',
          providerSessionId: 'runtime-session',
          home: 'connectedService',
          connectedServiceId: 'svc_1',
        }),
      },
    });

    expect(result.providerId).toBe('codex');
    expect(result.providerSessionId).toBe('runtime-session');
    expect(result.sourceTier).toBe('canonical_runtime_descriptor');
    expect(result.runtimeIdentityPublication.runtimeDescriptor?.providerId).toBe('codex');
    expect(result.runtimeIdentityPublication.runtimeDescriptor?.providerSessionId).toBe('runtime-session');
    expect(result.runtimeIdentityPublication.compatibilitySources).toEqual(['runtimeDescriptorV1']);
  });

  it('falls back to legacy session metadata when runtime descriptor identity is unavailable', () => {
    const result = resolveSessionRuntimeIdentityFallback({
      metadata: {
        flavor: 'claude',
        claudeSessionId: 'claude-session-1',
        externalSessionV1: {
          v: 1,
          providerId: 'claude',
          remoteSessionId: 'claude-session-1',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
          linkedAtMs: 1,
        },
      },
    });

    expect(result.providerId).toBe('claude');
    expect(result.providerSessionId).toBe('claude-session-1');
    expect(result.sourceTier).toBe('legacy_session_metadata');
    expect(result.runtimeIdentityPublication.runtimeDescriptor).toBeNull();
    expect(result.runtimeIdentityPublication.compatibilitySources).toEqual(['legacy_provider_metadata']);
  });

  it('falls back to provider defaults when no persisted runtime identity exists', () => {
    const result = resolveSessionRuntimeIdentityFallback({
      metadata: {},
      providerDefaults: {
        agentId: 'opencode',
        providerSessionId: 'default-runtime-session',
      },
    });

    expect(result.providerId).toBe('opencode');
    expect(result.providerSessionId).toBe('default-runtime-session');
    expect(result.sourceTier).toBe('provider_defaults');
  });

  it('reads provider identity from direct-session metadata when legacy flavor fields are absent', () => {
    const result = resolveSessionRuntimeIdentityFallback({
      metadata: {
        machineId: 'machine-source',
        externalSessionV1: {
          v: 1,
          providerId: 'opencode',
          machineId: 'machine-source',
          remoteSessionId: 'direct-runtime-session',
          source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
          linkedAtMs: 1,
        },
      },
    });

    expect(result.providerId).toBe('opencode');
    expect(result.providerSessionId).toBe('direct-runtime-session');
    expect(result.sourceTier).toBe('legacy_session_metadata');
  });

  it('reads provider identity from legacy directSessionV1 metadata', () => {
    const result = resolveSessionRuntimeIdentityFallback({
      metadata: {
        directSessionV1: {
          v: 1,
          providerId: 'opencode',
          machineId: 'machine-source',
          remoteSessionId: 'legacy-direct-runtime-session',
          source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
          linkedAtMs: 1,
        },
      },
    });

    expect(result.providerId).toBe('opencode');
    expect(result.providerSessionId).toBe('legacy-direct-runtime-session');
    expect(result.sourceTier).toBe('legacy_session_metadata');
  });
});
