import { describe, expect, it } from 'vitest';

import { ExecutionRunStructuredRunRefSchema } from './executionRunStructuredRunRef.js';

describe('execution_run structured run ref schema', () => {
  it('parses legacy V1 backend targets and preserves additive fields', () => {
    const parsed = ExecutionRunStructuredRunRefSchema.parse({
      runId: 'run_1',
      callId: 'call_1',
      backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      retentionPolicy: 'resumable',
      futureField: 'keep-me',
      futureEnvelope: {
        kind: 'execution_run_structured_run_ref.v2',
        sourceKind: 'built_in',
      },
    });

    expect(parsed.backendTarget).toEqual({ kind: 'builtInAgent', agentId: 'claude' });
    expect((parsed as any).futureField).toBe('keep-me');
    expect((parsed as any).futureEnvelope).toEqual({
      kind: 'execution_run_structured_run_ref.v2',
      sourceKind: 'built_in',
    });
  });

  it('accepts legacy payloads without backendTarget for backward compatibility', () => {
    const parsed = ExecutionRunStructuredRunRefSchema.parse({
      runId: 'run_1',
      callId: 'call_1',
      backendId: 'claude',
    });

    expect(parsed.backendTarget).toBeUndefined();
    expect(parsed.backendId).toBe('claude');
  });
});
