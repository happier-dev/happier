import { describe, expect, it } from 'vitest';

import {
  getPluginHookDefinitionV1,
  PLUGIN_HOOK_IDS_V1,
  validatePluginHookPayloadV1,
  validatePluginHookResultV1,
} from '../../index.js';

const EXPECTED_PLUGIN_HOOK_IDS_V1 = [
  'session.spawned',
  'session.message.send',
  'session.input.transform',
  'executionRun.started',
  'executionRun.messageSent',
  'executionRun.stopped',
  'executionRun.completed',
  'agent.resolvePrerequisites',
  'agent.spawnEnv.augment',
  'agent.context.before',
  'agent.request.before',
  'agent.stream.token',
] as const;

describe('plugin hook catalog v1', () => {
  it('exposes only hook ids with a reachable product emitter', () => {
    expect(EXPECTED_PLUGIN_HOOK_IDS_V1).toHaveLength(12);
    expect(PLUGIN_HOOK_IDS_V1).toEqual([...EXPECTED_PLUGIN_HOOK_IDS_V1]);

    const definitions = EXPECTED_PLUGIN_HOOK_IDS_V1.map((hookId) => getPluginHookDefinitionV1(hookId));

    expect(definitions.map((definition) => definition?.id)).toEqual([...EXPECTED_PLUGIN_HOOK_IDS_V1]);
    expect(getPluginHookDefinitionV1('connectedServices.materialization.githubScmHostingToken')).toBe(null);
    expect(getPluginHookDefinitionV1('connectedServices.materialization.bitbucketScmHostingBasicAuth')).toBe(null);
    expect(getPluginHookDefinitionV1('provider.request.before')).toBe(null);
    expect(getPluginHookDefinitionV1('sidechain.start')).toBe(null);
    expect(getPluginHookDefinitionV1('sidechain.end')).toBe(null);
  });

  it('declares supported runtime families for v1 turn interception hooks', () => {
    const readSupportedRuntimes = (hookId: string): readonly string[] | undefined => {
      const definition = getPluginHookDefinitionV1(hookId) as Readonly<{ supportedRuntimes?: readonly string[] }> | null;
      return definition?.supportedRuntimes;
    };

    expect(getPluginHookDefinitionV1('session.input.transform')).toMatchObject({
      category: 'augmentation',
      scope: 'session',
      aggregation: 'replace',
      failureMode: 'bestEffort',
    });
    expect(readSupportedRuntimes('session.input.transform')).toEqual(['hostSession']);

    expect(getPluginHookDefinitionV1('agent.context.before')).toMatchObject({
      category: 'augmentation',
      scope: 'agent',
      aggregation: 'replace',
      failureMode: 'bestEffort',
    });
    expect(readSupportedRuntimes('agent.context.before')).toEqual(['hostSession']);

    expect(getPluginHookDefinitionV1('agent.request.before')).toMatchObject({
      category: 'augmentation',
      scope: 'agent',
      aggregation: 'replace',
      failureMode: 'bestEffort',
    });
    expect(readSupportedRuntimes('agent.request.before')).toEqual(['acpSession']);

    expect(getPluginHookDefinitionV1('agent.stream.token')).toMatchObject({
      category: 'lifecycle',
      scope: 'agent',
      purity: 'observer',
      aggregation: 'orderedList',
      failureMode: 'bestEffort',
    });
    expect(readSupportedRuntimes('agent.stream.token')).toEqual(['hostSession']);
  });

  it('validates typed payloads for every locked public hook id', () => {
    const validPayloads = {
      'session.spawned': {
        sessionId: 'session-1',
        agentId: 'codex',
        runtimeTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        timestampMs: 1,
      },
      'session.message.send': {
        sessionId: 'session-1',
        text: 'hello',
        source: 'user',
        timestampMs: 1,
      },
      'session.input.transform': {
        sessionId: 'session-1',
        localId: 'local-1',
        text: 'hello',
        meta: { source: 'ui' },
        timestampMs: 1,
      },
      'executionRun.started': {
        runId: 'run-1',
        intent: 'review',
        runtimeTargetKeys: ['agent:codex'],
        retentionPolicy: 'ephemeral',
        runClass: 'bounded',
        ioMode: 'request_response',
        timestampMs: 1,
      },
      'executionRun.messageSent': {
        runId: 'run-1',
        message: 'continue',
        timestampMs: 1,
      },
      'executionRun.stopped': {
        runId: 'run-1',
        reason: 'user',
        timestampMs: 1,
      },
      'executionRun.completed': {
        runId: 'run-1',
        status: 'succeeded',
        timestampMs: 1,
      },
      'agent.resolvePrerequisites': {
        agentId: 'codex',
        runtimeTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        timestampMs: 1,
      },
      'agent.spawnEnv.augment': {
        agentId: 'codex',
        timestampMs: 1,
      },
      'agent.context.before': {
        sessionId: 'session-1',
        agentId: 'codex',
        runtimeFamily: 'hostSession',
        prompt: 'system\n\nhello',
        messages: [
          { role: 'user', content: 'hello' },
        ],
        timestampMs: 1,
      },
      'agent.request.before': {
        sessionId: 'session-1',
        agentId: 'codex',
        runtimeFamily: 'acpSession',
        method: 'session/prompt',
        request: {
          sessionId: 'provider-session-1',
          prompt: [{ type: 'text', text: 'hello' }],
        },
        timestampMs: 1,
      },
      'agent.stream.token': {
        sessionId: 'session-1',
        agentId: 'codex',
        runtimeFamily: 'hostSession',
        turnId: 'turn-1',
        tokenText: 'hel',
        streamKind: 'assistant',
        timestampMs: 1,
      },
    } satisfies Readonly<Record<typeof EXPECTED_PLUGIN_HOOK_IDS_V1[number], unknown>>;

    for (const hookId of EXPECTED_PLUGIN_HOOK_IDS_V1) {
      expect(validatePluginHookPayloadV1({ hookId, payload: validPayloads[hookId] }), hookId)
        .toMatchObject({ success: true });
      expect(validatePluginHookPayloadV1({ hookId, payload: {} }), hookId)
        .toMatchObject({ success: false });
    }
  });

  it('validates decision, replacement, augmentation, and observation results by hook contract', () => {
    expect(validatePluginHookResultV1({
      hookId: 'agent.resolvePrerequisites',
      result: { decision: 'allow' },
    })).toMatchObject({ success: true });
    expect(validatePluginHookResultV1({
      hookId: 'agent.resolvePrerequisites',
      result: { decision: 'deny', reasonCode: 'missing_binary' },
    })).toMatchObject({ success: true });
    expect(validatePluginHookResultV1({
      hookId: 'agent.resolvePrerequisites',
      result: { decision: 'abstain' },
    })).toMatchObject({ success: true });
    expect(validatePluginHookResultV1({
      hookId: 'agent.resolvePrerequisites',
      result: undefined,
    })).toMatchObject({ success: false });
    expect(validatePluginHookResultV1({
      hookId: 'agent.resolvePrerequisites',
      result: { allowed: true },
    })).toMatchObject({ success: false });

    expect(validatePluginHookResultV1({
      hookId: 'session.input.transform',
      result: {
        sessionId: 'session-1',
        text: 'transformed',
        timestampMs: 1,
      },
    })).toMatchObject({ success: true });
    expect(validatePluginHookResultV1({
      hookId: 'session.input.transform',
      result: { text: 'missing required session identity' },
    })).toMatchObject({ success: false });
    expect(validatePluginHookResultV1({
      hookId: 'session.input.transform',
      result: {
        sessionId: 'session-1',
        text: 'looks valid structurally',
        timestampMs: 1,
        nonJsonValue: () => undefined,
      },
    })).toMatchObject({ success: false });

    expect(validatePluginHookResultV1({
      hookId: 'agent.spawnEnv.augment',
      result: { NODE_OPTIONS: '--no-warnings' },
    })).toMatchObject({ success: true });
    expect(validatePluginHookResultV1({
      hookId: 'agent.spawnEnv.augment',
      result: { invalid: undefined },
    })).toMatchObject({ success: false });

    expect(validatePluginHookResultV1({
      hookId: 'session.spawned',
      result: undefined,
    })).toMatchObject({ success: true });
    expect(validatePluginHookResultV1({
      hookId: 'session.spawned',
      result: { handled: true },
    })).toMatchObject({ success: false });
  });
});
