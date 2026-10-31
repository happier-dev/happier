import { describe, expect, it } from 'vitest';

import { AIBackendProfileSchema, type AIBackendProfile } from '@happier-dev/protocol';

import { readProfileQueryFromArgs, resolveProfileRoutedAgentId } from './profileDefaultAgentRouting';

function customProfile(overrides: Record<string, unknown>): AIBackendProfile {
  return AIBackendProfileSchema.parse({ id: 'work', name: 'Work', isBuiltIn: false, ...overrides });
}

describe('readProfileQueryFromArgs', () => {
  it('reads --profile and --launch-profile values in both spellings', () => {
    expect(readProfileQueryFromArgs(['--profile', 'openai'])).toBe('openai');
    expect(readProfileQueryFromArgs(['--launch-profile', 'work'])).toBe('work');
    expect(readProfileQueryFromArgs(['--profile=openai'])).toBe('openai');
    expect(readProfileQueryFromArgs(['--launch-profile=work'])).toBe('work');
  });

  it('returns null without a usable profile flag value', () => {
    expect(readProfileQueryFromArgs(['--model', 'gpt-5'])).toBeNull();
    expect(readProfileQueryFromArgs(['--profile'])).toBeNull();
    expect(readProfileQueryFromArgs(['--profile', '-v'])).toBeNull();
  });
});

describe('resolveProfileRoutedAgentId', () => {
  it('routes a built-in profile to its default agent without account settings', async () => {
    await expect(resolveProfileRoutedAgentId({
      profileQuery: 'openai',
      fetchCustomProfiles: async () => [],
    })).resolves.toBe('codex');
    await expect(resolveProfileRoutedAgentId({
      profileQuery: 'deepseek',
      fetchCustomProfiles: async () => [],
    })).resolves.toBe('claude');
  });

  it('routes a custom profile by id using its allowed default agent', async () => {
    const work = customProfile({
      id: 'work',
      name: 'Work Codex',
      defaultBackendTargetKey: 'agent:codex',
      compatibilityByTargetKey: { 'agent:codex': true, 'agent:claude': false },
    });
    await expect(resolveProfileRoutedAgentId({
      profileQuery: 'work',
      fetchCustomProfiles: async () => [work],
    })).resolves.toBe('codex');
  });

  it('does not route when the default is missing, not allowed, or not a built-in agent', async () => {
    const noDefault = customProfile({ id: 'plain', name: 'Plain' });
    await expect(resolveProfileRoutedAgentId({
      profileQuery: 'plain',
      fetchCustomProfiles: async () => [noDefault],
    })).resolves.toBeNull();

    const notAllowed = customProfile({
      id: 'broken',
      name: 'Broken',
      defaultBackendTargetKey: 'agent:codex',
      compatibilityByTargetKey: { 'agent:codex': false },
    });
    await expect(resolveProfileRoutedAgentId({
      profileQuery: 'broken',
      fetchCustomProfiles: async () => [notAllowed],
    })).resolves.toBeNull();

    const acpDefault = customProfile({ id: 'acp', name: 'Acp', defaultBackendTargetKey: 'acpBackend:review-bot' });
    await expect(resolveProfileRoutedAgentId({
      profileQuery: 'acp',
      fetchCustomProfiles: async () => [acpDefault],
    })).resolves.toBeNull();
  });

  it('does not route when profile lookup fails or is ambiguous', async () => {
    await expect(resolveProfileRoutedAgentId({
      profileQuery: 'missing',
      fetchCustomProfiles: async () => [],
    })).resolves.toBeNull();

    const a = customProfile({ id: 'a', name: 'Same Name' });
    const b = customProfile({ id: 'b', name: 'same name' });
    await expect(resolveProfileRoutedAgentId({
      profileQuery: 'same name',
      fetchCustomProfiles: async () => [a, b],
    })).resolves.toBeNull();
  });
});
