import { describe, expect, it } from 'vitest';

import { DEFAULT_CODING_PROMPT_BEHAVIOR_V1 } from './codingPromptBehaviorV1.js';
import { resolveEffectiveCodingPromptBehaviorV1 } from './effectiveCodingPromptBehaviorV1.js';

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

  it('inherits every key the profile does not override', () => {
    expect(resolveEffectiveCodingPromptBehaviorV1({
      settings: {
        codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'initial', responseOptions: 'disabled' },
        profiles: [launchProfile({})],
      },
      profileId: 'focused',
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
