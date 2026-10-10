import { describe, expect, it } from 'vitest';

import { DEFAULT_CODING_PROMPT_BEHAVIOR_V1 } from './codingPromptBehaviorV1.js';
import { resolveEffectiveCodingPromptBehaviorV1 } from './effectiveCodingPromptBehaviorV1.js';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import type { LaunchProfileV2 } from '../profiles/v2/schema.js';

function launchProfile(overrides: unknown): unknown {
  return {
    v: 2,
    id: 'focused',
    name: 'Focused',
    extraEnvironmentVariables: [],
    defaultPermissionModeByTargetKey: {},
    defaultPersistenceModeByTargetKey: {},
    compatibilityByTargetKey: {},
    ...(overrides === undefined ? {} : { codingPromptBehaviorOverrides: overrides }),
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('resolveEffectiveCodingPromptBehaviorV1', () => {
  it('uses the admitted Profile instead of stale Settings and honors authoritative absence', () => {
    const profile = { v: 2, id: 'focused', name: 'Focused', extraEnvironmentVariables: [],
      defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {},
      codingPromptBehaviorOverrides: { responseOptions: 'disabled' }, createdAt: 1, updatedAt: 1 } satisfies LaunchProfileV2;
    const settings = { codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'initial', responseOptions: 'agent' },
      profiles: [launchProfile({ sessionTitleUpdates: 'disabled' })] };
    expect(resolveEffectiveCodingPromptBehaviorV1({ settings, profileId: profile.id, selectedProfile: profile }))
      .toEqual({ v: 1, sessionTitleUpdates: 'initial', responseOptions: 'disabled' });
    expect(resolveEffectiveCodingPromptBehaviorV1({ settings, profileId: profile.id, selectedProfile: null }))
      .toEqual({ v: 1, sessionTitleUpdates: 'initial', responseOptions: 'agent' });
  });
  it('returns the Account default when no profile is selected', () => {
    expect(resolveEffectiveCodingPromptBehaviorV1({
      settings: { codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'initial', responseOptions: 'disabled' } },
      profileId: null,
    })).toEqual({ v: 1, sessionTitleUpdates: 'initial', responseOptions: 'disabled' });
  });

  it('returns the built-in default when the Account setting is absent', () => {
    expect(resolveEffectiveCodingPromptBehaviorV1({ settings: {}, profileId: null }))
      .toEqual(DEFAULT_CODING_PROMPT_BEHAVIOR_V1);
  });

  it('applies a sparse profile override on top of the Account default', () => {
    expect(resolveEffectiveCodingPromptBehaviorV1({
      settings: {
        codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'ongoing', responseOptions: 'agent' },
        profiles: [launchProfile({ sessionTitleUpdates: 'disabled' })],
      },
      profileId: 'focused',
    })).toEqual({ v: 1, sessionTitleUpdates: 'disabled', responseOptions: 'agent' });
  });

  it.each(['owner', 'view'] as const)('resolves the selected %s published profile through the authorized Artifact collection', (access) => {
    const artifact = { artifactId: 'published', access,
      header: { kind: 'launch-profile.v1', profileId: 'focused', name: 'Focused' },
      body: JSON.stringify({ kind: 'launch-profile.v1', profile: launchProfile({ sessionTitleUpdates: 'disabled' }) }),
    } satisfies ArtifactSharingResourceV1;
    const settings = { codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'initial', responseOptions: 'disabled' },
      profiles: access === 'owner' ? [{ artifactId: artifact.artifactId }] : [] };
    const input = { settings, profileId: 'focused', artifactsById: new Map([[artifact.artifactId, artifact]]) };
    expect(resolveEffectiveCodingPromptBehaviorV1(input))
      .toEqual({ v: 1, sessionTitleUpdates: 'disabled', responseOptions: 'disabled' });
    expect(resolveEffectiveCodingPromptBehaviorV1({ ...input, artifactsById: new Map() }))
      .toEqual({ v: 1, sessionTitleUpdates: 'initial', responseOptions: 'disabled' });
  });

  it('inherits every key the profile does not override', () => {
    expect(resolveEffectiveCodingPromptBehaviorV1({
      settings: {
        codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'initial', responseOptions: 'disabled' },
        profiles: [launchProfile({})],
      },
      profileId: 'focused',
    })).toEqual({ v: 1, sessionTitleUpdates: 'initial', responseOptions: 'disabled' });
  });

  it('applies the moving predecessor legacy profile override through the canonical collection reader', () => {
    expect(resolveEffectiveCodingPromptBehaviorV1({
      settings: {
        codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'initial', responseOptions: 'agent' },
        profiles: [{
          id: 'remote-dev-profile',
          name: 'Remote Dev Profile',
          environmentVariables: [],
          envVarRequirements: [],
          defaultPermissionModeByTargetKey: {},
          defaultPermissionModeByAgent: {},
          defaultPersistenceModeByTargetKey: {},
          defaultPersistenceModeByAgent: {},
          compatibilityByTargetKey: {},
          compatibility: {},
          isBuiltIn: false,
          defaultEnabled: true,
          createdAt: 1,
          updatedAt: 1,
          version: '1.0.0',
          codingPromptBehaviorV1: { v: 1, responseOptions: 'disabled' },
        }],
      },
      profileId: 'remote-dev-profile',
    })).toEqual({ v: 1, sessionTitleUpdates: 'initial', responseOptions: 'disabled' });
  });

  it('ignores an unknown profile id and a profile that expresses no override', () => {
    const settings = {
      codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'ongoing', responseOptions: 'agent' },
      profiles: [launchProfile(undefined)],
    };
    expect(resolveEffectiveCodingPromptBehaviorV1({ settings, profileId: 'missing' }))
      .toEqual({ v: 1, sessionTitleUpdates: 'ongoing', responseOptions: 'agent' });
    expect(resolveEffectiveCodingPromptBehaviorV1({ settings, profileId: 'focused' }))
      .toEqual({ v: 1, sessionTitleUpdates: 'ongoing', responseOptions: 'agent' });
  });
});
