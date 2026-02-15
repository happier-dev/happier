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
          { t: 'sendSessionMessage', args: { message: 'Please do X.' } },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Ok, I will send that to the session.');
    expect(result.actions).toEqual([{ t: 'sendSessionMessage', args: { message: 'Please do X.' } }]);
  });

  it('supports optional sessionId fields for message/permission actions', () => {
    const input = [
      'Ok.',
      '',
      '<voice_actions>',
      JSON.stringify({
        actions: [
          { t: 'sendSessionMessage', args: { sessionId: 's1', message: 'Please do X.' } },
          { t: 'processPermissionRequest', args: { sessionId: 's1', decision: 'allow', requestId: 'req_1' } },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Ok.');
    expect(result.actions).toEqual([
      { t: 'sendSessionMessage', args: { sessionId: 's1', message: 'Please do X.' } },
      { t: 'processPermissionRequest', args: { sessionId: 's1', decision: 'allow', requestId: 'req_1' } },
    ]);
  });

  it('ignores invalid action blocks (returns no actions and keeps text)', () => {
    const input = ['Hello', '<voice_actions>', '{not json}', '</voice_actions>'].join('\n');
    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.actions).toEqual([]);
    expect(result.assistantText).toContain('Hello');
  });

  it('supports session targeting actions for global voice', () => {
    const input = [
      'Sure.',
      '',
      '<voice_actions>',
      JSON.stringify({
        actions: [
          { t: 'setPrimaryActionSession', args: { sessionId: 's1' } },
          { t: 'setTrackedSessions', args: { sessionIds: ['s1', 's2'] } },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Sure.');
    expect(result.actions).toEqual([
      { t: 'setPrimaryActionSession', args: { sessionId: 's1' } },
      { t: 'setTrackedSessions', args: { sessionIds: ['s1', 's2'] } },
    ]);
  });

  it('supports execution run control actions', () => {
    const input = [
      'Starting a review.',
      '',
      '<voice_actions>',
      JSON.stringify({
        actions: [
          {
            t: 'startReview',
            args: { engineIds: ['claude'], instructions: 'Review the repo.', changeType: 'committed', base: { kind: 'none' } },
          },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Starting a review.');
    expect(result.actions).toEqual([
      {
        t: 'startReview',
        args: {
          engineIds: ['claude'],
          instructions: 'Review the repo.',
          changeType: 'committed',
          base: { kind: 'none' },
          engines: { coderabbit: {} },
          permissionMode: 'read_only',
        },
      },
    ]);
  });

  it('supports session navigation + lifecycle actions', () => {
    const input = [
      'Ok.',
      '',
      '<voice_actions>',
      JSON.stringify({
        actions: [
          { t: 'openSession', args: { sessionId: 's_other' } },
          { t: 'spawnSession', args: { tag: 't1' } },
          { t: 'resetGlobalVoiceAgent', args: {} },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Ok.');
    expect(result.actions).toEqual([
      { t: 'openSession', args: { sessionId: 's_other' } },
      { t: 'spawnSession', args: { tag: 't1' } },
      { t: 'resetGlobalVoiceAgent', args: {} },
    ]);
  });
});
