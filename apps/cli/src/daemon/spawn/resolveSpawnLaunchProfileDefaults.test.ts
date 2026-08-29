import { describe, expect, it } from 'vitest';

import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
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
  defaultPermissionModeByTargetKey: { 'backend:codex': 'acceptEdits' as const },
  defaultPersistenceModeByTargetKey: { 'backend:codex': 'direct' as const },
  compatibilityByTargetKey: { 'backend:codex': true },
  preferredAgentTargetKey: 'backend:codex',
  preferredModelSelection: {
    v: 1 as const,
    updatedAt: 17,
    ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'gpt-profile' },
  },
  createdAt: 10,
  updatedAt: 20,
};

describe('resolveSpawnLaunchProfileDefaults', () => {
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
        ref: { agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'gpt-explicit' },
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
    ['incompatible', [{ ...profile, compatibilityByTargetKey: { 'backend:codex': false } }]],
  ] as const)('fails closed for an %s V2 profile', (_reason, profiles) => {
      expect(resolveSpawnLaunchProfileDefaults({
        options: baseOptions,
        effectiveBackendTarget: baseOptions.backendTarget!,
        rawSettings: { profiles },
      })).toMatchObject({ ok: false });
  });

  it('keeps the canonical pre-migration built-in compatibility path', () => {
    expect(resolveSpawnLaunchProfileDefaults({
      options: { ...baseOptions, profileId: 'deepseek' },
      effectiveBackendTarget: baseOptions.backendTarget!,
      rawSettings: {},
    })).toEqual({
      ok: true,
      options: { ...baseOptions, profileId: 'deepseek' },
    });
  });
});
