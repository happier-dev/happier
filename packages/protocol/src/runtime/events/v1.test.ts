import { describe, expect, it } from 'vitest';

import * as protocol from '../../index.js';

type RuntimeEventSchemaLike = {
  parse(input: unknown): unknown;
};

function runtimeEventSchema(): RuntimeEventSchemaLike {
  const schema = (protocol as Record<string, unknown>).RuntimeEventV1Schema as RuntimeEventSchemaLike | undefined;
  expect(schema, 'RuntimeEventV1Schema must be exported').toBeDefined();
  expect(schema?.parse).toBeTypeOf('function');
  return schema!;
}

describe('RuntimeEventV1 A.14 contract', () => {
  it('exports the generic runtime event surface without ACP lifecycle vocabulary', () => {
    const kinds = (protocol as Record<string, unknown>).RUNTIME_EVENT_KINDS_V1;

    expect(kinds).toEqual([
      'message-delta',
      'tool-call',
      'tool-result',
      'tool-progress',
      'turn-start',
      'turn-complete',
      'turn-failed',
      'turn-cancelled',
      'turn-provider-id-observed',
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
      'context-compaction',
      'subagent-start',
      'subagent-status-change',
      'subagent-end',
    ]);
    expect(kinds).not.toContain('runtime-mode-change');
    expect(kinds).not.toContain('turn-aborted');
    expect(kinds).not.toContain('task_started');
    expect(kinds).not.toContain('task_complete');
  });

  it('parses representative events for every exported kind', () => {
    const eventSchema = runtimeEventSchema();
    const base = {
      sessionId: 'session-1',
      emittedAtMs: 1,
      sidechainId: 'sidechain-1',
      futureBaseField: 'kept',
    };
    const byKind: Record<string, unknown> = {
      'message-delta': { ...base, kind: 'message-delta', turnId: 'turn-1', delta: { text: 'hi' } },
      'tool-call': { ...base, kind: 'tool-call', turnId: 'turn-1', toolCallId: 'tool-1', toolName: 'shell', toolInput: {} },
      'tool-result': { ...base, kind: 'tool-result', turnId: 'turn-1', toolCallId: 'tool-1', output: {} },
      'tool-progress': { ...base, kind: 'tool-progress', turnId: 'turn-1', toolCallId: 'tool-1', progress: {} },
      'turn-start': { ...base, kind: 'turn-start', turnId: 'turn-1' },
      'turn-complete': { ...base, kind: 'turn-complete', turnId: 'turn-1' },
      'turn-failed': {
        ...base,
        kind: 'turn-failed',
        turnId: 'turn-1',
        issue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'provider_error',
          source: 'provider_status_error',
          occurredAt: 1,
          sanitizedPreview: 'provider failed',
          providerTurnId: 'provider-turn-1',
        },
      },
      'turn-cancelled': { ...base, kind: 'turn-cancelled', turnId: 'turn-1', reason: 'user_request' },
      'turn-provider-id-observed': {
        ...base,
        kind: 'turn-provider-id-observed',
        turnId: 'turn-1',
        providerTurnId: 'provider-turn-1',
      },
      'turn-input-appended': { ...base, kind: 'turn-input-appended', turnId: 'turn-1', userMessageSeq: 2 },
      'transcript-user-text': {
        ...base,
        kind: 'transcript-user-text',
        text: 'hello from the provider runtime',
        localId: 'turn-1:user',
        meta: { provider: 'opencode' },
      },
      'transcript-agent-message-committed': {
        ...base,
        kind: 'transcript-agent-message-committed',
        provider: 'opencode',
        localId: 'turn-1:turn_failed',
        body: { type: 'turn_failed', id: 'turn-1' },
        meta: { source: 'runtime' },
      },
      'turn-rollback-boundary-observed': {
        ...base,
        kind: 'turn-rollback-boundary-observed',
        turnId: 'turn-1',
        providerRollbackOrdinal: 3,
      },
      'turn-rollback-applied': {
        ...base,
        kind: 'turn-rollback-applied',
        turnId: 'turn-2',
        restoredToTurnId: 'turn-1',
      },
      'session-ended': { ...base, kind: 'session-ended', reason: 'runtime_exit' },
      'runtime-status-change': {
        ...base,
        kind: 'runtime-status-change',
        status: 'mode-switch',
        detail: { kind: 'runtime-mode-change', from: 'terminal', to: 'remote', reason: 'user_request' },
      },
      'session-id-publish': { ...base, kind: 'session-id-publish', publishedSessionId: 'session-1', source: 'runtime' },
      'descriptor-update': { ...base, kind: 'descriptor-update', descriptor: { v: 1, providerId: 'codex', provider: {} } },
      'diff-emit': { ...base, kind: 'diff-emit', diff: { files: [] } },
      'backend-error': { ...base, kind: 'backend-error', error: { message: 'failed' } },
      'token-count': { ...base, kind: 'token-count', source: 'provider', scope: 'cumulative', totals: { total: 1 } },
      'context-compaction': {
        ...base,
        kind: 'context-compaction',
        phase: 'started',
        source: 'provider-event',
        trigger: 'manual',
        lifecycleId: 'compact-1',
        backendId: 'pi',
      },
      'subagent-start': {
        ...base,
        kind: 'subagent-start',
        subagent: {
          id: 'subagent-1',
          parentSessionId: 'session-1',
          origin: 'provider',
          kind: 'native',
          status: 'running',
          createdAt: 1,
        },
      },
      'subagent-status-change': { ...base, kind: 'subagent-status-change', subagentId: 'subagent-1', status: 'running' },
      'subagent-end': { ...base, kind: 'subagent-end', subagentId: 'subagent-1', outcome: { status: 'completed' } },
    };

    for (const kind of (protocol as Record<string, readonly string[]>).RUNTIME_EVENT_KINDS_V1) {
      expect(eventSchema.parse(byKind[kind])).toMatchObject({
        kind,
        futureBaseField: 'kept',
      });
    }
  });

  it('keeps turnId session-owned and provider native ids separate', () => {
    const eventSchema = runtimeEventSchema();
    const base = {
      sessionId: 'session-1',
      emittedAtMs: 1,
    };

    expect(eventSchema.parse({
      ...base,
      kind: 'turn-provider-id-observed',
      turnId: 'happier-turn-1',
      providerTurnId: 'provider-turn-1',
    })).toMatchObject({
      turnId: 'happier-turn-1',
      providerTurnId: 'provider-turn-1',
    });

    expect(() => eventSchema.parse({
      ...base,
      kind: 'turn-provider-id-observed',
      turnId: 'happier-turn-1',
      providerTurnId: null,
    })).toThrow();

    expect(() => eventSchema.parse({
      ...base,
      kind: 'turn-provider-id-observed',
      providerTurnId: 'provider-turn-1',
    })).toThrow();
  });

  it('rejects context compaction summary and presentation writer fields', () => {
    const eventSchema = runtimeEventSchema();
    const base = {
      sessionId: 'session-1',
      emittedAtMs: 1,
      kind: 'context-compaction',
      phase: 'completed',
      source: 'provider-event',
      lifecycleId: 'compact-1',
    };

    expect(() => eventSchema.parse({ ...base, status: 'completed' })).toThrow();
    expect(() => eventSchema.parse({ ...base, presentation: { status: 'completed' } })).toThrow();
    expect(() => eventSchema.parse({ ...base, summary: 'provider summary' })).toThrow();
    expect(() => eventSchema.parse({ ...base, summaryPreview: 'provider summary' })).toThrow();
    expect(() => eventSchema.parse({ ...base, providerSummary: 'provider summary' })).toThrow();
    expect(() => eventSchema.parse({ ...base, provider: 'pi' })).toThrow();
  });

  it('validates runtime-mode-change detail when present while preserving unknown details', () => {
    const eventSchema = runtimeEventSchema();
    const base = {
      sessionId: 'session-1',
      emittedAtMs: 1,
      kind: 'runtime-status-change',
      status: 'mode-switch',
    };

    expect(() => eventSchema.parse({
      ...base,
      detail: { kind: 'runtime-mode-change', from: 'local', to: 'remote', reason: 'user_request' },
    })).toThrow();

    expect(eventSchema.parse({
      ...base,
      detail: { kind: 'future-status-detail', from: 'local' },
    })).toMatchObject({
      detail: { kind: 'future-status-detail', from: 'local' },
    });
  });
});
