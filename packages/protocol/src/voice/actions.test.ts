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

  it('rejects the whole block when a permission action accompanies a valid message', () => {
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
    expect(result.invalidActionBlock).toBe(true);
    expect(result.assistantText).not.toBe('Ok.');
    expect(result.actions).toEqual([]);
  });

  it('discloses malformed message input in a mixed block without executing its valid sibling', () => {
    const result = extractVoiceActionsFromAssistantText(`Sending both messages now. <voice_actions>${JSON.stringify({ actions: [
      { t: 'sendSessionMessage', args: { sessionId: 's1', message: 'Valid request.' } },
      { t: 'sendSessionMessage', args: { sessionId: 's2', message: { text: 'private request content' } } },
    ] })}</voice_actions>`);
    expect(result.invalidActionBlock).toBe(true);
    expect(result.actions).toEqual([]);
    expect(result.assistantText).toContain('sendSessionMessage');
    expect(result.assistantText).toContain('message');
    expect(result.assistantText).not.toContain('Sending both messages now');
    expect(result.assistantText).not.toContain('private request content');
  });

  it('reports malformed action blocks as a failure instead of preserving success narration', () => {
    const input = ['Hello', '<voice_actions>', '{not json}', '</voice_actions>'].join('\n');
    const result = extractVoiceActionsFromAssistantText(input);
    expect(result).toEqual({ assistantText: "I couldn't run that action because its request was invalid. Please try again.", actions: [], invalidActionBlock: true });
  });

  it.each([
    { t: 'listSessions', args: { limit: { title: 'VOICE-RUN96 R118 approval target' } }, field: 'limit' },
    { t: 'sendSessionMessage', args: { sessionId: 'cmw806d1u006bmcraf5efazah', message: { text: 'private request content' } }, field: 'message' },
  ])('identifies the invalid $t input field without disclosing its value', ({ t, args, field }) => {
    const result = extractVoiceActionsFromAssistantText(`<voice_actions>${JSON.stringify({ actions: [{ t, args }] })}</voice_actions>`);
    expect(result.actions).toEqual([]);
    expect(result.invalidActionBlock).toBe(true);
    expect(result.assistantText).toContain(t);
    expect(result.assistantText).toContain(field);
    expect(result.assistantText).not.toContain('private request content');
    expect(result.assistantText).not.toContain('VOICE-RUN96 R118 approval target');
  });

  it('strips an unterminated action block from the first opening tag', () => {
    const input = ['Hello', '<voice_actions>', '{"actions": ['].join('\n');
    expect(extractVoiceActionsFromAssistantText(input)).toEqual({
      assistantText: "I couldn't run that action because its request was invalid. Please try again.",
      actions: [],
      invalidActionBlock: true,
    });
  });

  it.each(['null', '[]', '{"actions":{}}'])(
    'does not retain creation narration when the action block cannot execute: %s', (block) => {
      expect(extractVoiceActionsFromAssistantText(`Creating the Session now. <voice_actions>${block}</voice_actions>`))
        .toEqual({ assistantText: "I couldn't run that action because its request was invalid. Please try again.", actions: [], invalidActionBlock: true });
    },
  );

  it('replaces creation narration with the invalid creation fields', () => {
    const result = extractVoiceActionsFromAssistantText('Creating the Session now. <voice_actions>{"actions":[{"t":"spawnSession","args":{}}]}</voice_actions>');
    expect(result.actions).toEqual([]);
    expect(result.invalidActionBlock).toBe(true);
    expect(result.assistantText).toContain('spawnSession');
    expect(result.assistantText).not.toContain('Creating the Session now');
  });

  it('supports session targeting actions for global voice', () => {
    const input = [
      'Sure.',
      '',
      '<voice_actions>',
      JSON.stringify({
        actions: [
          { t: 'setPrimaryActionSession', args: { serverId: 'server-1', sessionId: 's1' } },
          { t: 'setTrackedSessions', args: { sessionIds: ['s1', 's2'] } },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Sure.');
    expect(result.actions).toEqual([
      { t: 'setPrimaryActionSession', args: { serverId: 'server-1', sessionId: 's1' } },
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
          reviewCommentAuthorIntent: 'propose',
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
      directory: { kind: 'path', path: '/workspace/project' },
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
            args: { limit: '10' },
          },
          { t: 'getSessionRecentMessages', args: { sessionId: 's1', includeUser: 'true' } },
        ],
      }),
      '</voice_actions>',
    ].join('\n');

    const result = extractVoiceActionsFromAssistantText(input);
    expect(result.assistantText).toBe('Let me check.');
    expect(result.actions).toEqual([
      {
        t: 'listSessions',
        args: { limit: 10 },
      },
      { t: 'getSessionRecentMessages', args: { sessionId: 's1', includeUser: true } },
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
              retentionPolicy: 'ephemeral',
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

  it('rejects the whole block when one action has invalid numeric args', () => {
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
    expect(result.invalidActionBlock).toBe(true);
    expect(result.assistantText).toContain('listSessions');
    expect(result.assistantText).toContain('limit');
    expect(result.actions).toEqual([]);
  });
});
