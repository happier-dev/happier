import { describe, expect, it } from 'vitest';

import { shouldDenyAgentSessionTitleToolCall } from './codingPromptTitlePermission';

const settingsFor = (sessionTitleUpdates: string) => ({
  codingPromptBehaviorV1: { v: 1, sessionTitleUpdates, responseOptions: 'agent' },
});

const titleCall = { toolName: 'mcp__happier__change_title', input: { title: 'Renamed' } } as const;
const titled = { summary: { text: 'Existing title', updatedAt: 1 } };
const legacyNamed = { name: 'Legacy name' };

describe('shouldDenyAgentSessionTitleToolCall', () => {
  it('denies an agent rename in start-only mode once the session already has a title', () => {
    expect(shouldDenyAgentSessionTitleToolCall({ settings: settingsFor('initial'), sessionMetadata: titled, ...titleCall })).toBe(true);
    expect(shouldDenyAgentSessionTitleToolCall({ settings: settingsFor('initial'), sessionMetadata: legacyNamed, ...titleCall })).toBe(true);
    expect(shouldDenyAgentSessionTitleToolCall({
      settings: settingsFor('initial'),
      sessionMetadata: titled,
      toolName: 'happier_action_execute',
      input: { actionId: 'session.title.set' },
    })).toBe(true);
  });

  it('allows the initial naming of an untitled session in start-only mode', () => {
    expect(shouldDenyAgentSessionTitleToolCall({ settings: settingsFor('initial'), sessionMetadata: null, ...titleCall })).toBe(false);
    expect(shouldDenyAgentSessionTitleToolCall({ settings: settingsFor('initial'), sessionMetadata: { summary: { text: '  ' } }, ...titleCall })).toBe(false);
    expect(shouldDenyAgentSessionTitleToolCall({ settings: settingsFor('initial'), ...titleCall })).toBe(false);
  });

  it('allows renames in ongoing mode even when titled', () => {
    expect(shouldDenyAgentSessionTitleToolCall({ settings: settingsFor('ongoing'), sessionMetadata: titled, ...titleCall })).toBe(false);
  });

  it('still denies every rename when title updates are disabled', () => {
    expect(shouldDenyAgentSessionTitleToolCall({ settings: settingsFor('disabled'), sessionMetadata: null, ...titleCall })).toBe(true);
  });

  it('never denies unrelated tool calls', () => {
    expect(shouldDenyAgentSessionTitleToolCall({
      settings: settingsFor('initial'),
      sessionMetadata: titled,
      toolName: 'mcp__happier__execution_run_get',
      input: {},
    })).toBe(false);
  });
});
