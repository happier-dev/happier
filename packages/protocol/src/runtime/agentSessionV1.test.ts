import { describe, expect, it } from 'vitest';

import {
  AGENT_SESSION_RUNTIME_EVENT_KINDS_V1,
  AgentLaunchEnvironmentV1Schema,
  AgentRuntimeJsonValueV1Schema,
  AgentSessionConfigurationSnapshotV1Schema,
  AgentSessionConfigurationUpdateV1Schema,
  AgentSessionConversationRollbackReconciliationResultV1Schema,
  AgentSessionConversationRollbackRequestV1Schema,
  AgentSessionRuntimeEventV1Schema,
  AgentSessionSendRequestV1Schema,
} from './agentSessionV1.js';

const diagnostic = {
  code: 'provider_unavailable',
  severity: 'warning',
} as const;

describe('Agent session VB4 open inputs', () => {
  const configuration = {
    mode: { value: null, updatedAtMs: 11 },
    model: { value: 'sonnet', updatedAtMs: 12 },
    permissionIntent: { value: 'safe-yolo', updatedAtMs: 13 },
    options: {
      allowIndexing: { value: true, updatedAtMs: 14 },
      temperature: { value: 0.2, updatedAtMs: 10 },
      profile: { value: 'fast', updatedAtMs: 9 },
      optional: { value: null, updatedAtMs: 8 },
    },
  } as const;

  it('accepts bounded launch allow/unset data and preserves independent field timestamps', () => {
    expect(AgentLaunchEnvironmentV1Schema.parse({
      values: { AUGMENT_SESSION_AUTH: 'host-authorized-reference' },
      unset: ['AUGGIE_LEGACY_SETTING'],
    })).toEqual({
      values: { AUGMENT_SESSION_AUTH: 'host-authorized-reference' },
      unset: ['AUGGIE_LEGACY_SETTING'],
    });
    expect(AgentSessionConfigurationSnapshotV1Schema.parse(configuration)).toEqual(configuration);
  });

  it('accepts an exact Provider binding descriptor only on a configuration update', () => {
    const update = {
      ...configuration,
      providerBinding: {
        connectionId: 'pc_gateway',
        model: { id: 'gpt-5', name: 'GPT-5' },
        upstream: {
          protocol: 'openai-responses',
          normalizedUrl: 'https://provider.example/v1',
          credential: 'apiKey',
        },
        materialization: { v: 1, kind: 'spawnEnv' },
      },
    } as const;

    expect(AgentSessionConfigurationUpdateV1Schema.parse(update)).toEqual(update);
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse(update).success).toBe(false);
    expect(AgentSessionConfigurationUpdateV1Schema.safeParse({
      ...update,
      providerBinding: { ...update.providerBinding, connectionId: ' invalid-id ' },
    }).success).toBe(false);
  });

  it('accepts only a strict provider-session resume reference in a configuration snapshot', () => {
    const configurationWithResume = {
      ...configuration,
      providerSessionResume: {
        kind: 'provider_session.v1',
        providerSessionId: 'provider-session-1',
      },
    } as const;

    expect(AgentSessionConfigurationSnapshotV1Schema.parse(configurationWithResume)).toEqual(
      configurationWithResume,
    );
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse({
      ...configuration,
      providerSessionResume: 'provider-session-1',
    }).success).toBe(false);
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse({
      ...configurationWithResume,
      providerSessionResume: {
        ...configurationWithResume.providerSessionResume,
        backendTarget: { kind: 'backend', backendId: 'claude' },
      },
    }).success).toBe(false);
    expect(AgentSessionConfigurationSnapshotV1Schema.safeParse({
      ...configurationWithResume,
      providerSessionResume: {
        ...configurationWithResume.providerSessionResume,
        secret: 'must-not-cross-the-v2-boundary',
      },
    }).success).toBe(false);
  });

  it.each(['default', 'read-only', 'safe-yolo', 'yolo', 'plan', null])(
    'accepts the closed canonical permission intent %s',
    (permissionIntent) => {
      expect(AgentSessionConfigurationSnapshotV1Schema.safeParse({
        ...configuration,
        permissionIntent: { value: permissionIntent, updatedAtMs: 13 },
      }).success).toBe(true);
    },
  );

  it('rejects aliases, composite options, invalid timestamps, unknown fields, and leaked host-private data', () => {
    let accessorInvoked = false;
    const accessorLaunchEnvironment = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessorLaunchEnvironment, 'values', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return { UNSAFE: 'value' };
      },
    });
    accessorLaunchEnvironment.unset = [];
    for (const invalid of [
      { ...configuration, permissionIntent: { value: 'workspace_write', updatedAtMs: 13 } },
      { ...configuration, options: { allowIndexing: { value: [], updatedAtMs: 14 } } },
      { ...configuration, options: { allowIndexing: { value: {}, updatedAtMs: 14 } } },
      { ...configuration, model: { value: 'sonnet', updatedAtMs: -1 } },
      { ...configuration, mode: { value: null, updatedAtMs: 1.5 } },
      { ...configuration, permissionIntent: { value: 'default', updatedAtMs: Number.POSITIVE_INFINITY } },
      { ...configuration, mcpServers: [] },
      { ...configuration, credentials: { token: 'secret' } },
      { ...configuration, rawMetadata: {} },
      { ...configuration, mode: { value: null, updatedAtMs: 11, revision: 1 } },
    ]) {
      expect(AgentSessionConfigurationSnapshotV1Schema.safeParse(invalid).success).toBe(false);
    }
    for (const invalid of [
      { values: { OK: 'yes' }, unset: [], mcpServers: [] },
      { values: { INVALID: { nested: true } }, unset: [] },
      { values: { INVALID: ['nested'] }, unset: [] },
      { values: { OK: 'yes' }, unset: ['OK'] },
      { values: { OK: 'yes' }, unset: ['OK'], rawMetadata: {} },
      { values: { OK: 'yes' }, unset: [undefined] },
      accessorLaunchEnvironment,
    ]) {
      expect(AgentLaunchEnvironmentV1Schema.safeParse(invalid).success).toBe(false);
    }
    expect(accessorInvoked).toBe(false);
  });

  it('reuses the strict-JSON aggregate bound for launch data without inventing another limit', () => {
    const oversized = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`ENV_${index}`, 'x'.repeat(220_000)]),
    );
    expect(AgentLaunchEnvironmentV1Schema.safeParse({ values: oversized, unset: [] }).success).toBe(false);
  });
});

describe('AgentRuntimeJsonValueV1Schema', () => {
  it('accepts plain/null-prototype own data and preserves inert prototype-like keys', () => {
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, '__proto__', {
      value: { constructor: 'inert' },
      enumerable: true,
    });

    const parsed = AgentRuntimeJsonValueV1Schema.parse(value);
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.hasOwn(parsed as object, '__proto__')).toBe(true);
    expect((parsed as Record<string, unknown>).__proto__).toEqual({ constructor: 'inert' });
  });

  it('rejects accessors, classes, cycles, sparse arrays, and non-JSON values', () => {
    let accessorInvoked = false;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', {
      enumerable: true,
      get() {
        accessorInvoked = true;
        return 'unsafe';
      },
    });
    class ProviderPayload { value = 'native'; }
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);
    sparse[1] = 'present';

    for (const invalid of [
      accessor,
      new ProviderPayload(),
      cyclic,
      sparse,
      { value: undefined },
      { value: 1n },
      { value: () => undefined },
      { value: Symbol('native') },
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(AgentRuntimeJsonValueV1Schema.safeParse(invalid).success).toBe(false);
    }
    expect(accessorInvoked).toBe(false);
  });

  it('enforces the owner aggregate byte bound without inventing field-local quotas', () => {
    const maximumEncodedBytes = 1_024 * 1_024;
    expect(AgentRuntimeJsonValueV1Schema.safeParse('x'.repeat(maximumEncodedBytes - 2)).success).toBe(true);
    expect(AgentRuntimeJsonValueV1Schema.safeParse('x'.repeat(maximumEncodedBytes - 1)).success).toBe(false);
    expect(AgentRuntimeJsonValueV1Schema.safeParse({ ['k'.repeat(257)]: true }).success).toBe(true);
    expect(AgentRuntimeJsonValueV1Schema.safeParse(Array.from({ length: 6 }, () => 'x'.repeat(200_000))).success).toBe(false);
  });

  it('does not invent depth or node quotas below the aggregate byte boundary', () => {
    const nested = (depth: number): unknown => {
      let value: unknown = true;
      for (let index = 0; index < depth; index += 1) value = { value };
      return value;
    };

    expect(AgentRuntimeJsonValueV1Schema.safeParse(nested(25)).success).toBe(true);
    expect(AgentRuntimeJsonValueV1Schema.safeParse(Array.from({ length: 8_192 }, () => true)).success).toBe(true);
  });
});

describe('AgentSessionRuntimeEventV1Schema', () => {
  it('accepts only internally consistent complete runtime activity snapshots', () => {
    const base = { kind: 'runtime-activity-snapshot', sequence: 1, sessionId: 'session-1', emittedAtMs: 1 } as const;

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      state: 'active',
      activeCount: 1,
    }).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      state: 'active',
      activeCount: 2,
    }).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      state: 'idle',
      activeCount: 0,
    }).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      state: 'unknown',
      activeCount: 0,
    }).success).toBe(true);

    for (const invalid of [
      { ...base, state: 'active', activeCount: 0 },
      { ...base, state: 'idle', activeCount: 1 },
      { ...base, state: 'unknown', activeCount: 1 },
      { ...base, state: 'active', activeCount: 1, sourceClass: 'agent_detached_task' },
      { ...base, state: 'idle', activeCount: 0, sourceClass: null },
      { ...base, state: 'idle', activeCount: 0, sourceId: 'forged' },
    ]) {
      expect(AgentSessionRuntimeEventV1Schema.safeParse(invalid).success).toBe(false);
    }
    expect(AGENT_SESSION_RUNTIME_EVENT_KINDS_V1).toContain('runtime-activity-snapshot');
  });

  it('has one strict stable replacement for every retained current event fact', () => {
    const base = { sequence: 1, sessionId: 'session-1', emittedAtMs: 1 } as const;
    const turn = { ...base, turnId: 'turn-1' } as const;
    const fixtures: readonly Record<string, unknown>[] = [
      { ...turn, kind: 'message-delta', channel: 'assistant', text: 'delta' },
      { ...turn, kind: 'tool-call', toolCallId: 'tool-1', toolName: 'read', input: null },
      { ...turn, kind: 'tool-progress', toolCallId: 'tool-1', progress: { percent: 0.5 } },
      { ...turn, kind: 'tool-result', toolCallId: 'tool-1', output: { ok: true } },
      { ...turn, kind: 'turn-start', startedBy: 'host' },
      { ...turn, kind: 'turn-progress' },
      { ...turn, kind: 'turn-complete' },
      { ...turn, kind: 'turn-failed', diagnostic },
      { ...turn, kind: 'turn-cancelled', cause: 'user' },
      { ...turn, kind: 'turn-agent-id-observed', agentTurnId: 'native-turn-1' },
      { ...base, kind: 'transcript-message-committed', messageId: 'message-1', role: 'user', text: 'hello' },
      {
        ...turn,
        kind: 'turn-rollback-boundary',
        agentRollbackOrdinal: 3,
        providerCheckpoint: { promptIndex: 7 },
      },
      { ...base, kind: 'runtime-ended', cause: 'providerEnded', retryable: false },
      { ...base, kind: 'provider-session-id', providerSessionId: 'native-session-1' },
      {
        ...base,
        kind: 'available-commands',
        commands: [{ name: '/goal', description: 'Set a session goal' }],
      },
      { ...turn, kind: 'file-edit', editId: 'edit-1', path: '/tmp/file', diff: '+hello' },
      { ...base, kind: 'usage-observed', observationId: 'usage-1', source: 'provider', scope: 'session_final', tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 } },
      { ...base, kind: 'context-compaction', compactionId: 'compact-1', trigger: 'automatic', phase: 'completed' },
    ];

    for (const fixture of fixtures) {
      expect(AgentSessionRuntimeEventV1Schema.safeParse(fixture), String(fixture.kind)).toMatchObject({ success: true });
    }
  });

  it('admits a tool payload between the Action gate and the event bound, and rejects past the event bound', () => {
    // The boundary a runtime event payload actually has is the event's own
    // aggregate byte bound. A payload above the plugin Action gate but below
    // that bound was admissible when these events were written, so it is still
    // readable: this schema is parsed on read (Host Event dispatch, external
    // transcript replay), and narrowing it would orphan already-written data.
    const base = { sequence: 1, sessionId: 'session-1', emittedAtMs: 1, turnId: 'turn-1' } as const;
    const inBand = 'x'.repeat(1_500_000);
    for (const event of [
      { ...base, kind: 'tool-call', toolCallId: 'tool-1', toolName: 'read', input: { text: inBand } },
      { ...base, kind: 'tool-progress', toolCallId: 'tool-1', progress: { text: inBand } },
      { ...base, kind: 'tool-result', toolCallId: 'tool-1', output: { text: inBand } },
    ]) {
      expect(
        AgentSessionRuntimeEventV1Schema.safeParse(event),
        String(event.kind),
      ).toMatchObject({ success: true });
    }

    const pastEventBound = AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      kind: 'tool-result',
      toolCallId: 'tool-1',
      output: { text: 'x'.repeat(2_500_001) },
    });
    expect(pastEventBound.success).toBe(false);
    expect(pastEventBound.error?.issues.some((issue) => (
      issue.message === 'Agent runtime event exceeds the CORE-A candidate byte bound'
    ))).toBe(true);
  });

  it('rejects provider checkpoints larger than the canonical turn checkpoint limit', () => {
    const oversizedCheckpoint = 'x'.repeat(4_097);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      kind: 'turn-rollback-boundary',
      turnId: 'turn-1',
      providerCheckpoint: oversizedCheckpoint,
    }).success).toBe(false);
    expect(AgentSessionConversationRollbackRequestV1Schema.safeParse({
      operationId: 'rollback-1',
      target: { kind: 'beforeTurn', turnId: 'turn-1' },
      affectedTurns: [{
        turnId: 'turn-1',
        providerCheckpoint: oversizedCheckpoint,
      }],
      providerSessionId: 'provider-session-1',
      runtimeIncarnationId: 'runtime-1',
    }).success).toBe(false);
  });

  it('rejects every host-derived or retired current event writer', () => {
    const base = { sequence: 1, sessionId: 'session-1', emittedAtMs: 1 } as const;
    for (const kind of [
      'turn-input-appended',
      'transcript-user-text',
      'transcript-agent-message-committed',
      'turn-rollback-boundary-observed',
      'turn-rollback-applied',
      'session-ended',
      'runtime-status-change',
      'session-id-publish',
      'descriptor-update',
      'diff-emit',
      'backend-error',
      'token-count',
      'subagent-start',
      'subagent-status-change',
      'subagent-end',
    ]) {
      expect(AgentSessionRuntimeEventV1Schema.safeParse({ ...base, kind }).success, kind).toBe(false);
    }
  });

  it('accepts the strict provider-neutral lifecycle and product facts', () => {
    expect(AgentSessionRuntimeEventV1Schema.parse({
      kind: 'message-delta',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      turnId: 'turn-1',
      channel: 'assistant',
      text: 'hello',
    })).toMatchObject({ kind: 'message-delta', text: 'hello' });

    expect(AgentSessionRuntimeEventV1Schema.parse({
      kind: 'context-compaction',
      sequence: 2,
      sessionId: 'session-1',
      emittedAtMs: 2,
      compactionId: 'compaction-1',
      trigger: 'manual',
      phase: 'outcomeUnknown',
      diagnostic,
    })).toMatchObject({ kind: 'context-compaction', phase: 'outcomeUnknown' });

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'input-accepted',
      sequence: 3,
      sessionId: 'session-1',
      emittedAtMs: 3,
      inputIds: ['input-1'],
      delivery: { kind: 'followUp', turnId: 'turn-2' },
    }).success).toBe(true);

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'input-accepted',
      sequence: 4,
      sessionId: 'session-1',
      emittedAtMs: 4,
      inputIds: ['input-1'],
      delivery: { kind: 'followUp', turnId: 'turn-2', afterTurnId: 'plugin-echo' },
    }).success).toBe(false);
  });

  it('rejects retired writers, unknown fields, and fields on the wrong branch', () => {
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'backend-error',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      error: { message: 'native payload' },
    }).success).toBe(false);

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'turn-complete',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      turnId: 'turn-1',
      summary: { native: true },
    }).success).toBe(false);

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'usage-observed',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      observationId: 'observation-1',
      source: 'provider',
      scope: 'turn_delta',
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      sidechainId: 'not-legal-here',
    }).success).toBe(false);

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'file-edit',
      sequence: 3,
      sessionId: 'session-1',
      emittedAtMs: 3,
      turnId: 'turn-1',
      editId: 'edit-1',
      path: '/tmp/file',
      oldContent: 'x'.repeat(1_000_000),
      newContent: 'y'.repeat(1_000_000),
    }).success).toBe(false);

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'usage-observed',
      sequence: 4,
      sessionId: 'session-1',
      emittedAtMs: 4,
      observationId: 'usage-1',
      source: 'provider',
      scope: 'turn_delta',
      cost: {
        reportedUsd: 0,
        estimatedUsd: 0,
        currency: 'USD',
        breakdown: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key-${index}`, 1])),
      },
    }).success).toBe(false);
  });

  it('enforces stable exact bounds and spellings without trimming identifiers', () => {
    const base = {
      kind: 'message-delta',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      turnId: 'turn-1',
      channel: 'assistant',
    } as const;

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      text: 'x'.repeat(65_536),
      sidechainId: 's'.repeat(191),
    }).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      text: 'x'.repeat(65_537),
    }).success).toBe(false);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      text: 'ok',
      sidechainId: 's'.repeat(192),
    }).success).toBe(false);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...base,
      sessionId: ' session-1',
      text: 'ok',
    }).success).toBe(false);

    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'context-compaction',
      sequence: 2,
      sessionId: 'session-1',
      emittedAtMs: 2,
      compactionId: 'compaction-1',
      trigger: 'auto',
      phase: 'completed',
    }).success).toBe(false);

    const usageBase = {
      kind: 'usage-observed',
      sequence: 3,
      sessionId: 'session-1',
      emittedAtMs: 3,
      observationId: 'usage-1',
      source: 'provider',
      scope: 'turn_delta',
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 2,
      },
    } as const;
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...usageBase,
      modelId: 'm'.repeat(512),
    }).success).toBe(true);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...usageBase,
      modelId: 'm'.repeat(513),
    }).success).toBe(false);
    expect(AgentSessionRuntimeEventV1Schema.safeParse({
      ...usageBase,
      modelId: ' model-1',
    }).success).toBe(false);
  });
});

describe('conversation rollback wire schemas', () => {
  const request = {
    operationId: 'rollback-1',
    target: { kind: 'beforeTurn', turnId: 'turn-1' },
    affectedTurns: [
      { turnId: 'turn-1', providerCheckpoint: 'provider-turn-1' },
      { turnId: 'turn-2', providerCheckpoint: { promptIndex: 7 } },
    ],
    providerSessionId: 'provider-session-1',
    runtimeIncarnationId: 'runtime-1',
  } as const;

  it('accepts the exact host-resolved attempt and provider-authoritative result', () => {
    expect(AgentSessionConversationRollbackRequestV1Schema.parse(request)).toMatchObject(request);
    expect(AgentSessionConversationRollbackReconciliationResultV1Schema.parse({
      status: 'notApplied',
    })).toEqual({ status: 'notApplied' });
  });

  it('rejects duplicate/over-bound affected turns and provider-selected extras', () => {
    expect(AgentSessionConversationRollbackRequestV1Schema.safeParse({
      ...request,
      affectedTurns: [{ turnId: 'turn-1' }, { turnId: 'turn-1' }],
    }).success).toBe(false);
    expect(AgentSessionConversationRollbackRequestV1Schema.safeParse({
      ...request,
      affectedTurns: Array.from({ length: 4_097 }, (_, index) => ({ turnId: `turn-${index}` })),
    }).success).toBe(false);
    expect(AgentSessionConversationRollbackReconciliationResultV1Schema.safeParse({
      status: 'applied',
      affectedTurns: [{ turnId: 'provider-chosen' }],
    }).success).toBe(false);
  });
});

describe('AgentSessionSendRequestV1Schema', () => {
  it('preserves nonblank opaque input ids across send and custody evidence', () => {
    const opaqueInputId = ' input-opaque ';
    const sendRequest = AgentSessionSendRequestV1Schema.safeParse({
      inputIds: [opaqueInputId],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-opaque' },
    });
    expect(sendRequest.success).toBe(true);
    if (sendRequest.success) {
      expect(sendRequest.data.inputIds).toEqual([opaqueInputId]);
    }
    expect(AgentSessionSendRequestV1Schema.safeParse({
      inputIds: [opaqueInputId, 'input-opaque'],
      input: { text: 'distinct ids' },
      delivery: { kind: 'newTurn', turnId: 'turn-distinct' },
    }).success).toBe(true);

    const acceptance = AgentSessionRuntimeEventV1Schema.safeParse({
      kind: 'input-accepted',
      sequence: 1,
      sessionId: 'session-1',
      emittedAtMs: 1,
      inputIds: [opaqueInputId],
      delivery: { kind: 'newTurn', turnId: 'turn-opaque' },
    });
    expect(acceptance.success).toBe(true);
    if (acceptance.success) {
      expect(acceptance.data.inputIds).toEqual([opaqueInputId]);
    }

    expect(AgentSessionSendRequestV1Schema.safeParse({
      inputIds: ['   '],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-blank' },
    }).success).toBe(false);
  });

  it('accepts one atomic duplicate-free host-issued input tuple', () => {
    expect(AgentSessionSendRequestV1Schema.parse({
      inputIds: ['input-1', 'input-2'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    })).toMatchObject({ inputIds: ['input-1', 'input-2'] });

    expect(AgentSessionSendRequestV1Schema.safeParse({
      inputIds: ['input-3'],
      input: { text: 'follow up' },
      delivery: { kind: 'followUp', turnId: 'turn-2', afterTurnId: 'turn-1' },
    }).success).toBe(true);
  });

  it('carries only a strict admitted-input causal permission authority', () => {
    const request = {
      inputIds: ['input-causal'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn' as const, turnId: 'turn-causal' },
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1' as const,
        admittedPermissionCeiling: 'read-only' as const,
      },
    };
    expect(AgentSessionSendRequestV1Schema.safeParse(request)).toMatchObject({
      success: true,
      data: { causalPermissionAuthority: request.causalPermissionAuthority },
    });
    expect(AgentSessionSendRequestV1Schema.safeParse({
      ...request,
      causalPermissionAuthority: {
        ...request.causalPermissionAuthority,
        admittedPermissionCeiling: 'not-a-permission-mode',
      },
    }).success).toBe(false);
  });

  it('rejects empty, duplicate, oversized, and unknown request data', () => {
    const request = {
      inputIds: ['input-1'],
      input: { text: 'hello' },
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    } as const;

    expect(AgentSessionSendRequestV1Schema.safeParse({ ...request, inputIds: [] }).success).toBe(false);
    expect(AgentSessionSendRequestV1Schema.safeParse({ ...request, inputIds: ['input-1', 'input-1'] }).success).toBe(false);
    expect(AgentSessionSendRequestV1Schema.safeParse({ ...request, inputIds: Array.from({ length: 513 }, (_, index) => `input-${index}`) }).success).toBe(false);
    expect(AgentSessionSendRequestV1Schema.safeParse({ ...request, authorSelectedId: 'forbidden' }).success).toBe(false);
    expect(AgentSessionSendRequestV1Schema.safeParse({
      ...request,
      delivery: { kind: 'followUp', turnId: 'turn-2' },
    }).success).toBe(false);
  });

  it('rejects non-plain and over-bound structured JSON values', () => {
    class ProviderPayload {
      value = 'native';
    }
    const request = {
      inputIds: ['input-1'],
      delivery: { kind: 'newTurn', turnId: 'turn-1' },
    } as const;

    expect(AgentSessionSendRequestV1Schema.safeParse({
      ...request,
      input: { text: 'hello', structuredInput: new ProviderPayload() },
    }).success).toBe(false);
    expect(AgentSessionSendRequestV1Schema.safeParse({
      ...request,
      input: { text: 'hello', structuredInput: 'x'.repeat(1_024 * 1_024) },
    }).success).toBe(false);
  });
});
