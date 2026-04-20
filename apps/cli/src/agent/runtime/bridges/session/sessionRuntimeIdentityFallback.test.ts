import { describe, expect, it } from 'vitest';
import { buildCodexRuntimeIdentityDescriptorV1 } from '@happier-dev/protocol';

import { resolveSessionRuntimeIdentityFallback } from '@/agent/runtime/identity';

describe('resolveSessionRuntimeIdentityFallback', () => {
  it('prefers canonical runtime descriptor identity over legacy metadata fields', () => {
    const result = resolveSessionRuntimeIdentityFallback({
      metadata: {
        flavor: 'claude',
        codexSessionId: 'legacy-session',
        directSessionV1: {
          v: 1,
          providerId: 'codex',
          remoteSessionId: 'legacy-session',
          source: { kind: 'codexHome', home: 'user' },
          linkedAtMs: 1,
        },
        agentRuntimeDescriptorV1: buildCodexRuntimeIdentityDescriptorV1({
          backendMode: 'appServer',
          vendorSessionId: 'runtime-session',
          home: 'connectedService',
          connectedServiceId: 'svc_1',
        }),
      },
    });

    expect(result.providerId).toBe('codex');
    expect(result.vendorSessionId).toBe('runtime-session');
    expect(result.sourceTier).toBe('canonical_runtime_descriptor');
    expect(result.runtimeIdentityPublication.runtimeDescriptor?.providerId).toBe('codex');
    expect(result.runtimeIdentityPublication.runtimeDescriptor?.vendorSessionId).toBe('runtime-session');
    expect(result.runtimeIdentityPublication.compatibilitySources).toEqual(['runtimeDescriptorV1']);
  });

  it('falls back to legacy session metadata when runtime descriptor identity is unavailable', () => {
    const result = resolveSessionRuntimeIdentityFallback({
      metadata: {
        flavor: 'claude',
        claudeSessionId: 'claude-session-1',
        directSessionV1: {
          v: 1,
          providerId: 'claude',
          remoteSessionId: 'claude-session-1',
          source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
          linkedAtMs: 1,
        },
      },
    });

    expect(result.providerId).toBe('claude');
    expect(result.vendorSessionId).toBe('claude-session-1');
    expect(result.sourceTier).toBe('legacy_session_metadata');
    expect(result.runtimeIdentityPublication.runtimeDescriptor).toBeNull();
    expect(result.runtimeIdentityPublication.compatibilitySources).toEqual(['legacy_provider_metadata']);
  });

  it('falls back to provider defaults when no persisted runtime identity exists', () => {
    const result = resolveSessionRuntimeIdentityFallback({
      metadata: {},
      providerDefaults: {
        providerId: 'opencode',
        vendorSessionId: 'default-runtime-session',
      },
    });

    expect(result.providerId).toBe('opencode');
    expect(result.vendorSessionId).toBe('default-runtime-session');
    expect(result.sourceTier).toBe('provider_defaults');
  });

  it('reads provider identity from direct-session metadata when legacy flavor fields are absent', () => {
    const result = resolveSessionRuntimeIdentityFallback({
      metadata: {
        machineId: 'machine-source',
        directSessionV1: {
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
    expect(result.vendorSessionId).toBe('direct-runtime-session');
    expect(result.sourceTier).toBe('legacy_session_metadata');
  });
});
