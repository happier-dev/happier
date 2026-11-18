import { describe, expect, it } from 'vitest';

import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { AIBackendProfileSchema } from '@happier-dev/protocol';
import { resolveSpawnLaunchProfileDefaults } from './resolveSpawnLaunchProfileDefaults';

const baseOptions: SpawnSessionOptions = {
  directory: '/repo',
  profileId: 'team-focused',
  backendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
};

const profile = {
  v: 2 as const,
  id: 'team-focused',
  name: 'Focused',
  extraEnvironmentVariables: [{ name: 'TEAM_FLAG', value: 'profile' }],
  defaultPermissionModeByTargetKey: { 'agent:happier.agent.codex/codex': 'acceptEdits' as const },
  defaultPersistenceModeByTargetKey: { 'agent:happier.agent.codex/codex': 'direct' as const },
  compatibilityByTargetKey: { 'agent:happier.agent.codex/codex': true },
  preferredAgentTargetKey: 'agent:happier.agent.codex/codex',
  preferredModelSelection: {
    v: 1 as const,
    updatedAt: 17,
    ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-profile' },
  },
  createdAt: 10,
  updatedAt: 20,
};

describe('resolveSpawnLaunchProfileDefaults', () => {
  it('restores retained legacy profile environment on resume through the admitted profile snapshot', () => {
    const legacy = AIBackendProfileSchema.parse({ id: 'custom-profile', name: 'Custom provider',
      environmentVariables: [{ name: 'CUSTOM_ENDPOINT', value: 'https://provider.example' }], createdAt: 0, updatedAt: 0 });
    const rawSettings = { profiles: [legacy] };
    const result = resolveSpawnLaunchProfileDefaults({
      options: { ...baseOptions, existingSessionId: 'session', profileId: legacy.id },
      effectiveBackendTarget: baseOptions.backendTarget!, rawSettings,
      profilesSnapshot: readProfilesFromAccountSettings(rawSettings),
    });
    expect(result).toMatchObject({ ok: true, options: { environmentVariables: { CUSTOM_ENDPOINT: 'https://provider.example' } } });
  });

  it('allows an unspecified native target and applies its profile environment', () => {
    const result = resolveSpawnLaunchProfileDefaults({ options: baseOptions,
      effectiveBackendTarget: { kind: 'backend', sourceKind: 'built_in', backendId: 'claude' }, rawSettings: { profiles: [profile] } });
    expect(result).toMatchObject({ ok: true, options: { environmentVariables: { TEAM_FLAG: 'profile' } } });
  });
  it('fills absent spawn fields from the canonical V2 profile', () => {
    expect(resolveSpawnLaunchProfileDefaults({
      options: baseOptions,
      effectiveBackendTarget: baseOptions.backendTarget!,
      rawSettings: { profiles: [profile] },
    })).toEqual({
      ok: true,
      options: {
        ...baseOptions,
        environmentVariables: { TEAM_FLAG: 'profile' },
        permissionMode: 'acceptEdits',
        permissionModeUpdatedAt: 20,
        transcriptStorage: 'direct',
        modelSelection: profile.preferredModelSelection,
      },
    });
  });

  it('uses other Profile defaults while the Team binding owns model selection', () => {
    const teamCredentialBindings: SpawnSessionOptions['teamCredentialBindings'] = [{
      v: 1, slot: { kind: 'provider_model' }, resourceId: 'team-provider', teamId: 'team', expectedResourceRevision: 1,
      deliveryMode: 'brokered', providerModelSelection: { agentTargetKey: profile.preferredAgentTargetKey, modelId: 'team-model' },
    }];
    const result = resolveSpawnLaunchProfileDefaults({
      options: { ...baseOptions, teamCredentialBindings },
      effectiveBackendTarget: baseOptions.backendTarget!, rawSettings: { profiles: [profile] },
    });
    expect(result).toMatchObject({ ok: true, options: { teamCredentialBindings, permissionMode: 'acceptEdits' } });
    expect(result).not.toHaveProperty('options.modelSelection');
  });

  it('preserves every explicit sparse spawn override', () => {
    const explicit: SpawnSessionOptions = {
      ...baseOptions,
      environmentVariables: { TEAM_FLAG: 'caller-substituted', LOCAL: '1' },
      permissionMode: 'read-only',
      permissionModeUpdatedAt: 99,
      transcriptStorage: 'persisted',
      modelSelection: {
        v: 1,
        updatedAt: 100,
        ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-explicit' },
      },
    };
    expect(resolveSpawnLaunchProfileDefaults({
      options: explicit,
      effectiveBackendTarget: explicit.backendTarget!,
      rawSettings: { profiles: [profile] },
    })).toEqual({
      ok: true,
      options: {
        ...explicit,
        // Profile-owned names stay canonical so the daemon's existing profile
        // validator cannot disagree with this defaulting pass. Explicit
        // non-conflicting environment survives.
        environmentVariables: { TEAM_FLAG: 'profile', LOCAL: '1' },
      },
    });
  });

  it.each([
    ['absent', []],
    ['duplicated', [profile, profile]],
    ['opaque future-version', [{ v: 99, id: profile.id, payload: { preserve: true } }]],
    ['malformed', [{ ...profile, compatibilityByTargetKey: 'invalid' }]],
    ['incompatible', [{ ...profile, compatibilityByTargetKey: { 'agent:happier.agent.codex/codex': false } }]],
  ] as const)('fails closed for an %s V2 profile', (_reason, profiles) => {
      expect(resolveSpawnLaunchProfileDefaults({
        options: baseOptions,
        effectiveBackendTarget: baseOptions.backendTarget!,
        rawSettings: { profiles },
      })).toMatchObject({ ok: false });
  });

  it('keeps the canonical retained legacy profile compatibility path', () => {
    expect(resolveSpawnLaunchProfileDefaults({
      options: { ...baseOptions, profileId: 'azure-openai' },
      effectiveBackendTarget: baseOptions.backendTarget!,
      rawSettings: {},
    })).toEqual({
      ok: true,
      options: { ...baseOptions, profileId: 'azure-openai' },
    });
  });
});
