import { describe, expect, it } from 'vitest';

import { decodeVoiceAssistantActions, getVoiceActionFunctionTool } from './actions.js';
import { getActionSpec, listVoiceActionBlockSpecs } from '../actions/actionSpecs.js';
import { zodSchemaToJsonSchemaObject } from '../actions/actionInputJsonSchema.js';

describe('Voice carrier advertisement', () => {
  it('describes the returned Action result and the named-model lookup', () => {
    const { description } = getVoiceActionFunctionTool();
    const spawn = getActionSpec('session.spawn_new');
    const resolveOptions = getActionSpec('action.options.resolve');
    expect(description).toContain('returned result');
    expect(description).toContain(spawn.bindings!.voiceClientToolName);
    expect(description).toContain(resolveOptions.bindings!.voiceClientToolName);
    expect(description).toContain(spawn.id);
    expect(description).toContain('modelSelection');
    expect(description).not.toContain('tool-results follow-up');
  });

  it('advertises one envelope instead of embedding the real Action catalog', () => {
    const catalog = listVoiceActionBlockSpecs();
    expect(catalog.length).toBeGreaterThanOrEqual(460); // Brief's incident-scale floor, not a runtime cap.
    const tools = [getVoiceActionFunctionTool()];
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const discoverySchemaBytes = bytes(zodSchemaToJsonSchemaObject(getActionSpec('action.spec.get').inputSchema));
    console.info(JSON.stringify({ catalogDescriptors: catalog.length, advertisedDescriptors: tools.length,
      advertisedBytes: bytes(tools), discoverySchemaBytes }));
    expect(bytes(tools[0].inputSchema)).toBeLessThan(discoverySchemaBytes);
    expect(tools[0].inputSchema).toMatchObject({ type: 'object', additionalProperties: false,
      properties: { t: { type: 'string' }, args: { type: 'object' } } });
    expect(tools[0].inputSchema).not.toHaveProperty('oneOf');
    expect(tools[0].inputSchema).not.toHaveProperty('definitions');
    // Discovery aliases and ordinary Actions still cross the same decoder.
    for (const action of [
      { t: getActionSpec('action.spec.get').bindings!.voiceClientToolName, args: { id: 'session.spawn_new' } },
      { t: 'sendSessionMessage', args: { message: 'Continue.' } },
    ]) expect(decodeVoiceAssistantActions([action]).actions).toEqual([action]);
  });
});

describe('decodeVoiceAssistantActions', () => {
  it('retains content-free repair facts when global Voice supplies a null optional target', () => {
    const result = decodeVoiceAssistantActions([{ t: 'sendSessionMessage', args: { sessionId: null, message: 'private content' } }]);
    expect(result.actions).toEqual([]);
    expect(result.failure).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: {
      issues: expect.arrayContaining([expect.objectContaining({ path: ['sessionId'], expected: 'string' })]),
    } });
    expect(JSON.stringify(result.failure)).not.toContain('private content');
  });

  it('returns ordinary assistant text when no native Actions were requested', () => {
    const result = decodeVoiceAssistantActions([], 'Hello.');
    expect(result).toEqual({ assistantText: 'Hello.', actions: [] });
  });

  it('decodes a structured native Action alongside assistant text', () => {
    const input = [
      { t: 'sendSessionMessage', args: { message: 'Please do X.' } },
    ];

    const result = decodeVoiceAssistantActions(input, 'Ok, I will send that to the session.');
    expect(result.assistantText).toBe('Ok, I will send that to the session.');
    expect(result.actions).toEqual([{ t: 'sendSessionMessage', args: { message: 'Please do X.' } }]);
  });

  it('rejects all native Actions when a permission action accompanies a valid message', () => {
    const input = [
      { t: 'sendSessionMessage', args: { sessionId: 's1', message: 'Please do X.' } },
      { t: 'processPermissionRequest', args: { sessionId: 's1', decision: 'allow', requestId: 'req_1' } },
    ];

    const result = decodeVoiceAssistantActions(input, 'Ok.');
    expect(result.invalidActionBlock).toBe(true);
    expect(result.assistantText).not.toBe('Ok.');
    expect(result.actions).toEqual([]);
  });

  it('refuses malformed message input plainly without executing its valid sibling', () => {
    const result = decodeVoiceAssistantActions([
      { t: 'sendSessionMessage', args: { sessionId: 's1', message: 'Valid request.' } },
      { t: 'sendSessionMessage', args: { sessionId: 's2', message: { text: 'private request content' } } },
    ], 'Sending both messages now.');
    expect(result.invalidActionBlock).toBe(true);
    expect(result.actions).toEqual([]);
    expect(result.assistantText).toContain("couldn't run");
    expect(result.assistantText).not.toContain('sendSessionMessage');
    expect(result.assistantText).not.toContain('Sending both messages now');
    expect(result.assistantText).not.toContain('private request content');
  });

  it.each([
    { t: 'listSessions', args: { limit: { title: 'VOICE-RUN96 R118 approval target' } }, field: 'limit' },
    { t: 'sendSessionMessage', args: { sessionId: 'cmw806d1u006bmcraf5efazah', message: { text: 'private request content' } }, field: 'message' },
  ])('refuses invalid $t input without disclosing fields or values', ({ t, args, field }) => {
    const result = decodeVoiceAssistantActions([{ t, args }]);
    expect(result.actions).toEqual([]);
    expect(result.invalidActionBlock).toBe(true);
    expect(result.assistantText).toContain("couldn't run");
    expect(result.assistantText).not.toContain(t);
    expect(result.assistantText).not.toContain(field);
    expect(result.assistantText).not.toContain('private request content');
    expect(result.assistantText).not.toContain('VOICE-RUN96 R118 approval target');
  });

  it('replaces creation narration with a plain refusal', () => {
    const result = decodeVoiceAssistantActions([{ t: 'spawnSession', args: {} }], 'Creating the Session now.');
    expect(result.actions).toEqual([]);
    expect(result.invalidActionBlock).toBe(true);
    expect(result.assistantText).toContain("couldn't run");
    expect(result.assistantText).not.toContain('spawnSession');
    expect(result.assistantText).not.toContain('Creating the Session now');
  });

  it('supports session targeting actions for global voice', () => {
    const input = [
      { t: 'setPrimaryActionSession', args: { serverId: 'server-1', sessionId: 's1' } },
      { t: 'setTrackedSessions', args: { sessionIds: ['s1', 's2'] } },
    ];

    const result = decodeVoiceAssistantActions(input, 'Sure.');
    expect(result.assistantText).toBe('Sure.');
    expect(result.actions).toEqual([
      { t: 'setPrimaryActionSession', args: { serverId: 'server-1', sessionId: 's1' } },
      { t: 'setTrackedSessions', args: { sessionIds: ['s1', 's2'] } },
    ]);
  });

  it('supports execution run control actions', () => {
    const input = [
      {
        t: 'startReview',
        args: { engineIds: ['claude'], instructions: 'Review the repo.', changeType: 'committed', base: { kind: 'none' } },
      },
    ];

    const result = decodeVoiceAssistantActions(input, 'Starting a review.');
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
      { t: 'openSession', args: { sessionId: 's_other' } },
      { t: 'spawnSession', args: spawnArgs },
      { t: 'resetGlobalVoiceAgent', args: {} },
    ];

    const result = decodeVoiceAssistantActions(input, 'Ok.');
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
    const input = [{ t: 'startExecutionRun', args: startArgs }];

    expect(decodeVoiceAssistantActions(input, '').actions).toEqual([
      { t: 'startExecutionRun', args: startArgs },
    ]);
  });

  it('coerces numeric and boolean string args for voice actions', () => {
    const input = [
      {
        t: 'listSessions',
        args: { limit: '10' },
      },
      { t: 'getSessionRecentMessages', args: { sessionId: 's1', includeUser: 'true' } },
    ];

    const result = decodeVoiceAssistantActions(input, 'Let me check.');
    expect(result.assistantText).toBe('Let me check.');
    expect(result.actions).toEqual([
      {
        t: 'listSessions',
        args: { limit: 10 },
      },
      { t: 'getSessionRecentMessages', args: { sessionId: 's1', includeUser: true } },
    ]);
  });

  it.each([
    { t: 'inbox_get', args: {} },
    { t: 'searchActionSpecs', args: { query: 'recent paths directory', limit: 5 } },
  ])('decodes Muse JSON-encoded $t arguments through the canonical Action schema', (action) => {
    const expected = decodeVoiceAssistantActions([action]);
    expect(expected.actions).toHaveLength(1);
    expect(decodeVoiceAssistantActions([{ ...action, args: JSON.stringify(action.args) }])).toEqual(expected);
  });

  it.each(['{"limit":', '[]', '{"limit":"private invalid limit"}'])('refuses invalid JSON-encoded Action args without disclosure (%s)', (args) => {
    const result = decodeVoiceAssistantActions([{ t: 'listSessions', args }]);
    expect(result.actions).toEqual([]);
    expect(result.failure).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(JSON.stringify(result)).not.toContain('private invalid limit');
  });

  it('coerces comma-separated string lists for text-list voice action args', () => {
    const input = [
      {
        t: 'setTrackedSessions',
        args: { sessionIds: 's1, s2' },
      },
    ];

    const result = decodeVoiceAssistantActions(input, 'Tracking them now.');
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
      {
        t: 'voice_agent.start',
        args: {
          sessionId: 's1',
          backendTargetKeys: ['agent:claude'],
          instructions: 'Start the voice assistant.',
          retentionPolicy: 'ephemeral',
        },
      },
    ];

    const result = decodeVoiceAssistantActions(input, 'Starting the voice agent.');
    expect(result.assistantText).toBe('Starting the voice agent.');
    expect(result.actions).toEqual([
      {
        t: 'startVoiceAgentRun',
        args: {
          sessionId: 's1',
          backendTargetKeys: ['agent:claude'],
          instructions: 'Start the voice assistant.',
          retentionPolicy: 'ephemeral',
          runClass: 'long_lived',
          ioMode: 'streaming',
        },
      },
    ]);
  });

  it('rejects all native Actions when one action has invalid numeric args', () => {
    const input = [
      { t: 'sendSessionMessage', args: { message: 'Please continue.' } },
      { t: 'listSessions', args: { limit: 'not-a-number' } },
    ];

    const result = decodeVoiceAssistantActions(input, 'Ok.');
    expect(result.invalidActionBlock).toBe(true);
    expect(result.assistantText).toContain("couldn't run");
    expect(result.assistantText).not.toContain('listSessions');
    expect(result.assistantText).not.toContain('limit');
    expect(result.actions).toEqual([]);
  });
});
