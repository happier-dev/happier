import { describe, expect, it } from 'vitest';

import { AgentStartSessionCallerV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';

import {
  createSessionAgentTitleWriteGuard,
  SessionAgentTitleUpdateDenied,
  shouldDenyAgentSessionTitleToolCall,
} from './codingPromptTitlePermission';

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

  it('leaves ordinary shell title calls alone', () => {
    expect(shouldDenyAgentSessionTitleToolCall({
      settings: settingsWithProfile({ sessionTitleUpdates: 'disabled' }),
      profileId: 'focused',
      toolName: 'bash',
      input: {
        command: 'happier tools call --source happier --tool change_title --args-json \'{"title":"x"}\'',
      },
    })).toBe(false);
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

describe('Session-agent title writes', () => {
  it.each([
    ['initial', { summary: { text: '  ' } }, true],
    ['initial', { name: 'Existing title' }, false],
    ['ongoing', { summary: { text: 'Existing title' } }, true],
    ['disabled', {}, false],
  ] as const)('applies %s mode to current metadata %j', (sessionTitleUpdates, metadata, allow) => {
    const sessionId = 'session-1';
    const actionCaller = AgentStartSessionCallerV1Schema.parse({ kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 });
    const guard = createSessionAgentTitleWriteGuard({
      actionId: 'session.title.set',
      fieldId: 'display.title',
      value: 'New title',
      sessionId,
      serverId: null,
      context: { surface: 'agent', actionCaller },
    }, () => settingsWithProfile({ sessionTitleUpdates }, 'disabled'));
    if (!guard) throw new Error('Expected the authenticated Session-agent title guard');
    const write = () => guard({ ...metadata, profileId: 'focused' });
    if (allow) {
      expect(write).not.toThrow();
    } else {
      expect(write).toThrow(SessionAgentTitleUpdateDenied);
    }
  });
});
