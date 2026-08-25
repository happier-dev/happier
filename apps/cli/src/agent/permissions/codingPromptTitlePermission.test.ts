import { describe, expect, it } from 'vitest';

import { shouldDenyAgentSessionTitleToolCall } from './codingPromptTitlePermission';

function settingsWithProfile(
  overrides: unknown,
  accountTitleUpdates: 'disabled' | 'initial' | 'ongoing' = 'ongoing',
): Record<string, unknown> {
  return {
    codingPromptBehaviorV1: {
      v: 1,
      sessionTitleUpdates: accountTitleUpdates,
      responseOptions: 'agent',
    },
    profiles: [{
      v: 2,
      id: 'focused',
      name: 'Focused',
      extraEnvironmentVariables: [],
      defaultPermissionModeByTargetKey: {},
      defaultPersistenceModeByTargetKey: {},
      compatibilityByTargetKey: {},
      codingPromptBehaviorOverrides: overrides,
      createdAt: 1,
      updatedAt: 1,
    }],
  };
}

describe('shouldDenyAgentSessionTitleToolCall', () => {
  it('denies a title tool call when the selected launch profile disables title updates', () => {
    expect(shouldDenyAgentSessionTitleToolCall({
      settings: settingsWithProfile({ sessionTitleUpdates: 'disabled' }),
      profileId: 'focused',
      toolName: 'change_title',
      input: { title: 'x' },
    })).toBe(true);
  });

  it('allows the same call when the profile expresses no title override', () => {
    expect(shouldDenyAgentSessionTitleToolCall({
      settings: settingsWithProfile({ responseOptions: 'disabled' }),
      profileId: 'focused',
      toolName: 'change_title',
      input: { title: 'x' },
    })).toBe(false);
  });

  it('allows the same call when no profile is selected', () => {
    expect(shouldDenyAgentSessionTitleToolCall({
      settings: settingsWithProfile({ sessionTitleUpdates: 'disabled' }),
      profileId: null,
      toolName: 'change_title',
      input: { title: 'x' },
    })).toBe(false);
  });

  it('still denies from the account default alone', () => {
    expect(shouldDenyAgentSessionTitleToolCall({
      settings: { codingPromptBehaviorV1: { v: 1, sessionTitleUpdates: 'disabled', responseOptions: 'agent' } },
      profileId: null,
      toolName: 'change_title',
      input: { title: 'x' },
    })).toBe(true);
  });

  it('admits the call a profile re-enabled over a disabled account default', () => {
    // The prompt composer resolves account -> profile and emits
    // "you MUST call the change_title tool once" for this pair. Denying here
    // would order the agent to do something admission refuses, every turn.
    expect(shouldDenyAgentSessionTitleToolCall({
      settings: settingsWithProfile({ sessionTitleUpdates: 'ongoing' }, 'disabled'),
      profileId: 'focused',
      toolName: 'change_title',
      input: { title: 'x' },
    })).toBe(false);
  });

  it('denies the shell-bridge title call the profile disabled', () => {
    expect(shouldDenyAgentSessionTitleToolCall({
      settings: settingsWithProfile({ sessionTitleUpdates: 'disabled' }),
      profileId: 'focused',
      toolName: 'bash',
      input: {
        command: 'happier tools call --source happier --tool change_title --args-json \'{"title":"x"}\'',
      },
    })).toBe(true);
  });

  it('never denies a non-title tool call', () => {
    expect(shouldDenyAgentSessionTitleToolCall({
      settings: settingsWithProfile({ sessionTitleUpdates: 'disabled' }),
      profileId: 'focused',
      toolName: 'Read',
      input: { path: '/tmp/a' },
    })).toBe(false);
  });
});
