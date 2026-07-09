import { describe, expect, it } from 'vitest';

import {
  getPluginHookDefinitionV1,
  PLUGIN_HOOK_IDS_V1,
  validatePluginHookPayloadV1,
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
  'agent.response.after',
  'agent.context.before',
  'agent.request.before',
  'agent.stream.token',
  'tool.call.before',
  'tool.result.after',
  'resource.discovery',
  'plugin.reload.before',
  'plugin.reload.after',
  'session.attached',
  'session.detached',
  'voice.session.started',
  'voice.session.ended',
  'voice.turn.started',
  'voice.turn.ended',
  'voice.transcript.partial',
  'voice.transcript.final',
  'memory.shard.generated',
  'memory.search.performed',
  'memory.index.updated',
  'memory.gc.performed',
  'automation.scheduled',
  'automation.claimed',
  'automation.run.started',
  'automation.run.succeeded',
  'automation.run.failed',
  'automation.run.expired',
  'approval.decision.made',
  'subagent.started',
  'subagent.ended',
] as const;

describe('plugin hook catalog v1', () => {
  it('exposes the locked 39 public hook ids without stale provider request, sidechain, or connected-service materialization vocabulary', () => {
    expect(EXPECTED_PLUGIN_HOOK_IDS_V1).toHaveLength(39);
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
      'agent.response.after': {
        agentId: 'codex',
        sessionId: 'session-1',
        requestId: 'request-1',
        status: 'ok',
        durationMs: 1,
        byteCount: 1,
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
      'tool.call.before': {
        toolName: 'shell',
        callId: 'call-1',
        sessionId: 'session-1',
        input: { command: 'pwd' },
        timestampMs: 1,
      },
      'tool.result.after': {
        toolName: 'shell',
        callId: 'call-1',
        sessionId: 'session-1',
        output: { ok: true },
        ok: true,
        durationMs: 1,
        timestampMs: 1,
      },
      'resource.discovery': {
        resourceKind: 'mcp',
        context: { cwd: '/tmp/project' },
        timestampMs: 1,
      },
      'plugin.reload.before': {
        pluginId: 'acme.plugin',
        reason: 'dev',
        timestampMs: 1,
      },
      'plugin.reload.after': {
        pluginId: 'acme.plugin',
        success: true,
        timestampMs: 1,
      },
      'session.attached': {
        sessionId: 'session-1',
        clientId: 'client-1',
        attachMechanism: 'native',
        attacherCount: 1,
        timestampMs: 1,
      },
      'session.detached': {
        sessionId: 'session-1',
        clientId: 'client-1',
        remainingAttacherCount: 0,
        reason: 'user_detach',
        timestampMs: 1,
      },
      'voice.session.started': {
        sessionId: 'session-1',
        voiceSessionId: 'voice-session-1',
        providerId: 'realtime',
        capability: 'realtime',
        timestampMs: 1,
      },
      'voice.session.ended': {
        sessionId: 'session-1',
        voiceSessionId: 'voice-session-1',
        reason: 'user_ended',
        durationMs: 1,
        timestampMs: 1,
      },
      'voice.turn.started': {
        sessionId: 'session-1',
        voiceTurnId: 'voice-turn-1',
        speakerRole: 'user',
        timestampMs: 1,
      },
      'voice.turn.ended': {
        sessionId: 'session-1',
        voiceTurnId: 'voice-turn-1',
        durationMs: 1,
        timestampMs: 1,
      },
      'voice.transcript.partial': {
        sessionId: 'session-1',
        voiceTurnId: 'voice-turn-1',
        speakerRole: 'user',
        text: 'hel',
        timestampMs: 1,
      },
      'voice.transcript.final': {
        sessionId: 'session-1',
        voiceTurnId: 'voice-turn-1',
        speakerRole: 'user',
        text: 'hello',
        timestampMs: 1,
      },
      'memory.shard.generated': {
        shardId: 'shard-1',
        kind: 'hints',
        summaryCharCount: 12,
        seqFrom: 1,
        seqTo: 2,
        timestampMs: 1,
      },
      'memory.search.performed': {
        query: 'previous decision',
        mode: 'hints',
        resultCount: 2,
        durationMs: 1,
        timestampMs: 1,
      },
      'memory.index.updated': {
        indexerId: 'indexer-1',
        sessionsIndexed: 1,
        shardsAdded: 1,
        shardsUpdated: 0,
        shardsRemoved: 0,
        timestampMs: 1,
      },
      'memory.gc.performed': {
        indexerId: 'indexer-1',
        reason: 'manual',
        bytesReclaimed: 1,
        shardsEvicted: 1,
        timestampMs: 1,
      },
      'automation.scheduled': {
        automationId: 'automation-1',
        scheduleKind: 'manual',
        timestampMs: 1,
      },
      'automation.claimed': {
        automationId: 'automation-1',
        runId: 'run-1',
        claimedBy: 'machine-1',
        leaseExpiresAtMs: 2,
        timestampMs: 1,
      },
      'automation.run.started': {
        automationId: 'automation-1',
        runId: 'run-1',
        targetType: 'new_session',
        templateDigest: 'template-1',
        timestampMs: 1,
      },
      'automation.run.succeeded': {
        automationId: 'automation-1',
        runId: 'run-1',
        durationMs: 1,
        timestampMs: 1,
      },
      'automation.run.failed': {
        automationId: 'automation-1',
        runId: 'run-1',
        durationMs: 1,
        errorCode: 'failed',
        error: 'failed',
        timestampMs: 1,
      },
      'automation.run.expired': {
        automationId: 'automation-1',
        runId: 'run-1',
        leaseExpiredAtMs: 2,
        timestampMs: 1,
      },
      'approval.decision.made': {
        requestId: 'request-1',
        actionId: 'session.open',
        decision: 'approved',
        decidedAtMs: 1,
        createdBy: { surface: 'cli' },
        timestampMs: 1,
      },
      'subagent.started': {
        subagentRef: {
          id: 'subagent-1',
          parentSessionId: 'session-1',
          origin: 'happier',
          kind: 'execution-run',
          status: 'running',
          createdAt: 1,
          runRef: { runId: 'run-1' },
        },
      },
      'subagent.ended': {
        subagentRef: {
          id: 'subagent-1',
          parentSessionId: 'session-1',
          origin: 'happier',
          kind: 'execution-run',
          status: 'completed',
          createdAt: 1,
          completedAt: 2,
          runRef: { runId: 'run-1' },
        },
        outcome: { status: 'completed' },
      },
    } satisfies Readonly<Record<typeof EXPECTED_PLUGIN_HOOK_IDS_V1[number], unknown>>;

    for (const hookId of EXPECTED_PLUGIN_HOOK_IDS_V1) {
      expect(validatePluginHookPayloadV1({ hookId, payload: validPayloads[hookId] }), hookId)
        .toMatchObject({ success: true });
      expect(validatePluginHookPayloadV1({ hookId, payload: {} }), hookId)
        .toMatchObject({ success: false });
    }
  });
});
