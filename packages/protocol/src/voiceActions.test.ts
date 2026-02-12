import { describe, expect, it } from 'vitest';

import { extractVoiceActionsFromAssistantText } from './voiceActions.js';

describe('extractVoiceActionsFromAssistantText', () => {
  it('returns the original text and no actions when no action block is present', () => {
    const result = extractVoiceActionsFromAssistantText('Hello.');
    expect(result).toEqual({ assistantText: 'Hello.', actions: [] });
  });

  it('extracts actions from a tagged JSON block and strips it from assistantText', () => {
    const input = [
      'Ok, I will send that to the session.',
      '',
      '<voice_actions>',
      JSON.stringify({
        actions: [
          { t: 'messageClaudeCode', args: { message: 'Please do X.' } },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Ok, I will send that to the session.');
    expect(result.actions).toEqual([{ t: 'messageClaudeCode', args: { message: 'Please do X.' } }]);
  });

  it('ignores invalid action blocks (returns no actions and keeps text)', () => {
    const input = ['Hello', '<voice_actions>', '{not json}', '</voice_actions>'].join('\n');
    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.actions).toEqual([]);
    expect(result.assistantText).toContain('Hello');
  });
});

