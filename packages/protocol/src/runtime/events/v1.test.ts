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
  it('exports the D-293 16-kind event ledger without runtime-mode-change as a top-level kind', () => {
    const kinds = (protocol as Record<string, unknown>).RUNTIME_EVENT_KINDS_V1;

    expect(kinds).toEqual([
      'message-delta',
      'tool-call',
      'tool-result',
      'tool-progress',
      'turn-start',
      'turn-complete',
      'turn-aborted',
      'runtime-status-change',
      'session-id-publish',
      'descriptor-update',
      'diff-emit',
      'backend-error',
      'token-count',
      'subagent-start',
      'subagent-status-change',
      'subagent-end',
    ]);
    expect(kinds).not.toContain('runtime-mode-change');
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
      'turn-aborted': { ...base, kind: 'turn-aborted', turnId: 'turn-1' },
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
