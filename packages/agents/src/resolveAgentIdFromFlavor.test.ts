import { describe, expect, it } from 'vitest';

import { resolveAgentIdFromFlavor, resolveCanonicalAgentIdFromFlavor } from './resolveAgentIdFromFlavor.js';
import { resolveAgentIdFromSessionMetadata, resolveDeclaredAgentIdFromSessionMetadata } from './resolveAgentIdFromSessionMetadata.js';
import { resolveLegacyCustomAcpCompatAgentIdFromFlavor } from './compat/customAcp.js';

describe('resolveAgentIdFromFlavor', () => {
  it('resolves canonical agent ids', () => {
    expect(resolveAgentIdFromFlavor('claude')).toBe('claude');
    expect(resolveAgentIdFromFlavor('codex')).toBe('codex');
    expect(resolveAgentIdFromFlavor('kiro')).toBe('kiro');
    expect(resolveAgentIdFromFlavor('ohMyPi')).toBe('ohMyPi');
  });

  it('resolves legacy flavor aliases', () => {
    expect(resolveAgentIdFromFlavor('gpt')).toBe('codex');
    expect(resolveAgentIdFromFlavor('openai')).toBe('codex');
    expect(resolveAgentIdFromFlavor('open-code')).toBe('opencode');
  });

  it('resolves manifest flavor aliases', () => {
    expect(resolveAgentIdFromFlavor('codex-acp')).toBe('codex');
    expect(resolveAgentIdFromFlavor('oh-my-pi')).toBe('ohMyPi');
  });

  it('does not treat configured ACP flavor ids as canonical provider identities', () => {
    expect(resolveAgentIdFromFlavor('acp:custom-kiro')).toBeNull();
  });

  it('returns null for unknown flavors', () => {
    expect(resolveAgentIdFromFlavor('unknown-provider')).toBeNull();
    expect(resolveAgentIdFromFlavor('')).toBeNull();
    expect(resolveAgentIdFromFlavor(null)).toBeNull();
  });

  it('keeps legacy customAcp carriers out of canonical flavor resolution', () => {
    expect(resolveAgentIdFromFlavor('customAcp')).toBeNull();
    expect(resolveAgentIdFromFlavor('custom-acp')).toBeNull();
    expect(resolveCanonicalAgentIdFromFlavor('claude')).toBe('claude');
    expect(resolveCanonicalAgentIdFromFlavor('gpt')).toBe('codex');
    expect(resolveCanonicalAgentIdFromFlavor('customAcp')).toBeNull();
    expect(resolveCanonicalAgentIdFromFlavor('custom-acp')).toBeNull();
    expect(resolveCanonicalAgentIdFromFlavor('acp:custom-kiro')).toBeNull();
    expect(resolveLegacyCustomAcpCompatAgentIdFromFlavor('customAcp')).toBe('customAcp');
    expect(resolveLegacyCustomAcpCompatAgentIdFromFlavor('custom-acp')).toBe('customAcp');
  });
});

describe('resolveAgentIdFromSessionMetadata', () => {
  it('uses metadata.flavor when canonical runtime metadata is absent', () => {
    expect(resolveAgentIdFromSessionMetadata({ flavor: 'gpt' })).toBe('codex');
  });

  it('prefers canonical runtimeDescriptorV1 provider ids over stale metadata.flavor', () => {
    expect(resolveAgentIdFromSessionMetadata({
      flavor: 'claude',
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: { backendMode: 'appServer', providerSessionId: 'codex_1' },
      },
    })).toBe('codex');
  });

  it('imports structured Oh My Pi runtime identity before stale flavor for resume and fork routing', () => {
    expect(resolveAgentIdFromSessionMetadata({
      flavor: 'claude',
      runtimeDescriptorV1: {
        v: 1,
        agentIdentity: {
          pluginId: 'happier.agent.ohmypi',
          localId: 'ohmypi',
        },
        agent: {
          providerSessionId: 'omp_1',
        },
      },
    })).toBe('ohMyPi');
  });

  it('falls back to vendor resume id fields when flavor is missing', () => {
    expect(resolveAgentIdFromSessionMetadata({ opencodeSessionId: 'o1' })).toBe('opencode');
    expect(resolveAgentIdFromSessionMetadata({ claudeSessionId: 'c1' })).toBe('claude');
  });

  it('does not treat vendor resume id fields as declared runtime owners', () => {
    expect(resolveDeclaredAgentIdFromSessionMetadata({ opencodeSessionId: 'o1' })).toBeNull();
    expect(resolveDeclaredAgentIdFromSessionMetadata({ claudeSessionId: 'c1' })).toBeNull();
  });

  it('prefers agentRuntimeDescriptorV1 provider ids when flavor and legacy fields are missing', () => {
    expect(resolveAgentIdFromSessionMetadata({
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        provider: { backendMode: 'server', providerSessionId: 'oc_1' },
      },
    })).toBe('opencode');
    expect(resolveAgentIdFromSessionMetadata({
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'ohMyPi',
        provider: { resumeStrategy: 'sessionFileBySessionId', providerSessionId: 'omp_1' },
      },
    })).toBe('ohMyPi');
  });

  it('prefers linked external-session Agent ids when flavor and runtime descriptor are missing', () => {
    expect(resolveAgentIdFromSessionMetadata({
      directSessionV1: {
        v: 1,
        providerId: 'opencode',
        machineId: 'm1',
        remoteSessionId: 'o1',
        source: { kind: 'opencodeServer', directory: '/repo' },
        linkedAtMs: 1,
      },
    })).toBe('opencode');
    expect(resolveAgentIdFromSessionMetadata({
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'm1',
        remoteSessionId: 'codex-1',
        source: { kind: 'codexHome', home: 'user' },
      },
    })).toBe('codex');
  });

  it('prefers linked external-session Agent ids over stale metadata.flavor', () => {
    expect(resolveAgentIdFromSessionMetadata({
      flavor: 'claude',
      directSessionV1: {
        v: 1,
        providerId: 'opencode',
        machineId: 'm1',
        remoteSessionId: 'o1',
        source: { kind: 'opencodeServer', directory: '/repo' },
        linkedAtMs: 1,
      },
    })).toBe('opencode');
  });

  it('uses the canonical linked-session reader for conflict and malformed fail-closed behavior', () => {
    const conflictingLinkedSessionMetadata = {
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'm1',
        remoteSessionId: 'codex-current',
        source: { kind: 'codexHome', home: 'user' },
      },
      directSessionV1: {
        v: 1,
        providerId: 'opencode',
        machineId: 'm1',
        remoteSessionId: 'opencode-legacy',
        source: { kind: 'opencodeServer', directory: '/repo' },
      },
    };

    expect(resolveDeclaredAgentIdFromSessionMetadata(conflictingLinkedSessionMetadata)).toBeNull();
    expect(resolveAgentIdFromSessionMetadata(conflictingLinkedSessionMetadata)).toBeNull();

    expect(resolveDeclaredAgentIdFromSessionMetadata({
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        source: { kind: 'codexHome', home: 'user' },
      },
    })).toBeNull();
  });

  it('does not let legacy customAcp flavor carriers override canonical runtime metadata', () => {
    expect(resolveAgentIdFromSessionMetadata({
      flavor: 'customAcp',
      agentRuntimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        provider: { backendMode: 'appServer', providerSessionId: 'codex_1' },
      },
    })).toBe('codex');
  });

  it('reports identity as unavailable when no evidence matches instead of selecting a default Agent', () => {
    expect(resolveAgentIdFromSessionMetadata({})).toBeNull();
    expect(resolveAgentIdFromSessionMetadata(null)).toBeNull();
  });
});
