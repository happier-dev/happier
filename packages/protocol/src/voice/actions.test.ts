import { describe, expect, it } from 'vitest';

import {
  extractVoiceActionsFromAssistantText,
  VOICE_ACTIONS_BLOCK,
  VOICE_ACTIONS_TAG,
} from './actions.js';

describe('extractVoiceActionsFromAssistantText', () => {
  it('derives the action-block delimiters from one canonical tag', () => {
    expect(VOICE_ACTIONS_TAG).toBe('voice_actions');
    expect(VOICE_ACTIONS_BLOCK).toEqual({
      startTag: `<${VOICE_ACTIONS_TAG}>`,
      endTag: `</${VOICE_ACTIONS_TAG}>`,
    });
  });
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

  it('supports optional sessionId fields for messages and rejects permission actions', () => {
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
    ]);
  });

  it('strips invalid action blocks so protocol markup cannot reach speech or history', () => {
    const input = ['Hello', '<voice_actions>', '{not json}', '</voice_actions>'].join('\n');
    const result = extractVoiceActionsFromAssistantText(input);
    expect(result).toEqual({ assistantText: 'Hello', actions: [] });
  });

  it('strips an unterminated action block from the first opening tag', () => {
    const input = ['Hello', '<voice_actions>', '{"actions": ['].join('\n');
    expect(extractVoiceActionsFromAssistantText(input)).toEqual({
      assistantText: 'Hello',
      actions: [],
    });
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
          engines: {},
          permissionMode: 'read_only',
        },
      },
    ]);
  });

  it('supports session navigation + lifecycle actions', () => {
    const spawnArgs = {
      executionTarget: {
        serverId: 'server-a',
        machineId: 'machine-1',
      },
      directory: '/workspace/project',
      agentTarget: {
        kind: 'agent',
        identity: {
          pluginId: 'happier.agent.claude',
          localId: 'claude',
        },
      },
      initialInput: { text: 'Start a new session.' },
    };
    const input = [
      'Ok.',
      '',
      '<voice_actions>',
      JSON.stringify({
        actions: [
          { t: 'openSession', args: { sessionId: 's_other' } },
          { t: 'spawnSession', args: spawnArgs },
          { t: 'resetGlobalVoiceAgent', args: {} },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Ok.');
    expect(result.actions).toEqual([
      { t: 'openSession', args: { sessionId: 's_other' } },
      { t: 'spawnSession', args: spawnArgs },
      { t: 'resetGlobalVoiceAgent', args: {} },
    ]);
  });

  it('admits the canonical Session-associated execution-run start action for Voice', () => {
    const startArgs = {
      intent: 'voice_agent',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
    };
    const input = [
      '<voice_actions>',
      JSON.stringify({ actions: [{ t: 'startExecutionRun', args: startArgs }] }),
      '</voice_actions>',
    ].join('\n');

    expect(extractVoiceActionsFromAssistantText(input).actions).toEqual([
      { t: 'startExecutionRun', args: startArgs },
    ]);
  });

  it('coerces numeric and boolean string args for voice actions', () => {
    const input = [
      'Let me check.',
      '',
      '<voice_actions>',
      JSON.stringify({
        actions: [
          {
            t: 'listSessions',
            args: { limit: '10', includeLastMessagePreview: 'true' },
          },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Let me check.');
    expect(result.actions).toEqual([
      {
        t: 'listSessions',
        args: { limit: 10, includeLastMessagePreview: true },
      },
    ]);
  });

  it('coerces comma-separated string lists for text-list voice action args', () => {
    const input = [
      'Tracking them now.',
      '',
      '<voice_actions>',
      JSON.stringify({
        actions: [
          {
            t: 'setTrackedSessions',
            args: { sessionIds: 's1, s2' },
          },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Tracking them now.');
    expect(result.actions).toEqual([
      {
        t: 'setTrackedSessions',
        args: { sessionIds: ['s1', 's2'] },
      },
    ]);
  });

  it('normalizes canonical action ids onto voice tool names', () => {
    const input = [
      'Starting the voice agent.',
      '',
      '<voice_actions>',
      JSON.stringify({
        actions: [
          {
            t: 'voice_agent.start',
            args: {
              sessionId: 's1',
              backendTargetKeys: ['agent:claude'],
              instructions: 'Start the voice assistant.',
            },
          },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Starting the voice agent.');
    expect(result.actions).toEqual([
      {
        t: 'startVoiceAgentRun',
        args: {
          sessionId: 's1',
          backendTargetKeys: ['agent:claude'],
          instructions: 'Start the voice assistant.',
          permissionMode: 'read_only',
          retentionPolicy: 'ephemeral',
          runClass: 'long_lived',
          ioMode: 'streaming',
        },
      },
    ]);
  });

  it('keeps valid actions when one action has invalid args', () => {
    const input = [
      'Ok.',
      '',
      '<voice_actions>',
      JSON.stringify({
        actions: [
          { t: 'sendSessionMessage', args: { message: 'Please continue.' } },
          { t: 'listSessions', args: { limit: 'not-a-number' } },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Ok.');
    expect(result.actions).toEqual([{ t: 'sendSessionMessage', args: { message: 'Please continue.' } }]);
  });
});
