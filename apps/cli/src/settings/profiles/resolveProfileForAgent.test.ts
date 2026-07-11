import { describe, expect, it } from 'vitest';
import { AIBackendProfileSchema } from '@happier-dev/protocol';

import { ProviderProfileSetupRequiredError, RemovedLegacyProfileError, resolveProfileForAgent } from './resolveProfileForAgent';

describe('resolveProfileForAgent', () => {
  it('returns a stable removed-placeholder diagnostic with default-environment guidance', () => {
    for (const id of [
      'anthropic', 'Anthropic (Default)',
      'codex', 'Codex (Default)',
      'gemini', 'Gemini (Default)',
    ]) {
      expect(() => resolveProfileForAgent({ agentId: 'claude', query: id, customProfiles: [] }))
        .toThrow(RemovedLegacyProfileError);
      try {
        resolveProfileForAgent({ agentId: 'claude', query: id, customProfiles: [] });
      } catch (error) {
        expect(error).toMatchObject({ code: 'legacy_profile_removed' });
        expect((error as Error).message).toContain('omit --profile');
      }
    }
  });

  it('resolves a slim profile by id and enforces its target compatibility', () => {
    const profile = {
      v: 2 as const, id: 'focused', name: 'Focused', extraEnvironmentVariables: [],
      defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {},
      compatibilityByTargetKey: { 'agent:claude': true }, createdAt: 1, updatedAt: 1,
    };
    expect(resolveProfileForAgent({ agentId: 'claude', query: 'focused', customProfiles: [profile] })).toEqual(profile);
    expect(() => resolveProfileForAgent({ agentId: 'codex', query: 'focused', customProfiles: [profile] }))
      .toThrow(/not compatible/i);
  });

  it('rejects terminal migrated provider profiles instead of resolving generated legacy built-ins', () => {
    expect(() => resolveProfileForAgent({
      agentId: 'claude',
      query: 'deepseek',
      customProfiles: [],
      terminalMigratedProfileIds: new Set(['deepseek']),
    })).toThrow(/provider connection/i);
  });

  it('rejects fresh provider migration source ids without requiring generated legacy profile definitions', () => {
    expect(() => resolveProfileForAgent({ agentId: 'claude', query: 'deepseek', customProfiles: [] }))
      .toThrow(ProviderProfileSetupRequiredError);
  });

  it('allows an evidence-authorized legacy compatibility profile supplied by the visible-profile owner', () => {
    const visibleLegacy = AIBackendProfileSchema.parse({
      id: 'deepseek', name: 'DeepSeek', environmentVariables: [], envVarRequirements: [],
      compatibilityByTargetKey: { 'agent:claude': true }, isBuiltIn: true,
      defaultPermissionModeByTargetKey: {}, defaultPermissionModeByAgent: {},
      defaultPersistenceModeByTargetKey: {}, defaultPersistenceModeByAgent: {},
      createdAt: 0, updatedAt: 0, version: '1.0.0',
    });
    expect(resolveProfileForAgent({ agentId: 'claude', query: 'deepseek', customProfiles: [visibleLegacy] }))
      .toEqual(visibleLegacy);
  });

  it('prefers a retained slim profile by id or name after its legacy source migrated', () => {
    const slim = {
      v: 2 as const, id: 'deepseek', name: 'DeepSeek retained preferences', extraEnvironmentVariables: [{ name: 'API_TIMEOUT_MS', value: '600000' }],
      defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
      createdAt: 1, updatedAt: 2,
    };
    for (const query of ['deepseek', 'DeepSeek retained preferences']) {
      expect(resolveProfileForAgent({
        agentId: 'claude', query, customProfiles: [slim], terminalMigratedProfileIds: new Set(['deepseek']),
      })).toEqual(slim);
    }
  });
});
