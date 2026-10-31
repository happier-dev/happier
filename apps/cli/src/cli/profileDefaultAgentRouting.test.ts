import { describe, expect, it } from 'vitest';

import { AIBackendProfileSchema, type AIBackendProfile } from '@happier-dev/protocol';

import { resolveProfileRoutedBackendTarget } from './profileDefaultAgentRouting';

function customProfile(overrides: Record<string, unknown>): AIBackendProfile {
  return AIBackendProfileSchema.parse({ id: 'work', name: 'Work', isBuiltIn: false, ...overrides });
}

describe('resolveProfileRoutedBackendTarget', () => {
  it('routes a configured ACP profile default', async () => {
    expect(resolveProfileRoutedBackendTarget({
      profileQuery: 'work',
      customProfiles: [customProfile({ defaultBackendTargetKey: 'acpBackend:review-bot' })],
    })).toEqual({ kind: 'configuredAcpBackend', backendId: 'review-bot' });
  });
  it('routes a built-in profile to its default agent without account settings', async () => {
    expect(resolveProfileRoutedBackendTarget({
      profileQuery: 'openai',
      customProfiles: [],
    })).toEqual({ kind: 'builtInAgent', agentId: 'codex' });
    expect(resolveProfileRoutedBackendTarget({
      profileQuery: 'deepseek',
      customProfiles: [],
    })).toEqual({ kind: 'builtInAgent', agentId: 'claude' });
  });

  it('routes a custom profile by id using its allowed default agent', async () => {
    const work = customProfile({
      id: 'work',
      name: 'Work Codex',
      defaultBackendTargetKey: 'agent:codex',
      compatibilityByTargetKey: { 'agent:codex': true, 'agent:claude': false },
    });
    expect(resolveProfileRoutedBackendTarget({
      profileQuery: 'work',
      customProfiles: [work],
    })).toEqual({ kind: 'builtInAgent', agentId: 'codex' });
  });

  it('does not route when the default is missing', async () => {
    const noDefault = customProfile({ id: 'plain', name: 'Plain' });
    expect(resolveProfileRoutedBackendTarget({
      profileQuery: 'plain',
      customProfiles: [noDefault],
    })).toBeNull();

  });

  it('reports an incompatible declared default instead of substituting another backend', () => {
    const notAllowed = customProfile({
      id: 'broken',
      name: 'Broken',
      defaultBackendTargetKey: 'agent:codex',
      compatibilityByTargetKey: { 'agent:codex': false },
    });
    expect(() => resolveProfileRoutedBackendTarget({
      profileQuery: 'broken',
      customProfiles: [notAllowed],
    })).toThrow('not compatible');

  });

  it('does not route when profile lookup fails or is ambiguous', async () => {
    expect(resolveProfileRoutedBackendTarget({
      profileQuery: 'missing',
      customProfiles: [],
    })).toBeNull();

    const a = customProfile({ id: 'a', name: 'Same Name' });
    const b = customProfile({ id: 'b', name: 'same name' });
    expect(resolveProfileRoutedBackendTarget({
      profileQuery: 'same name',
      customProfiles: [a, b],
    })).toBeNull();
  });
});
