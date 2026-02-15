import { describe, expect, it } from 'vitest';

import { PlanProfile } from './PlanProfile';

describe('PlanProfile', () => {
  it('parses trailing JSON when model output includes preamble text', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'plan',
      backendId: 'claude',
      instructions: 'plan this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = PlanProfile.onBoundedComplete({
      start,
      rawText: [
        'Sure, here is the plan.',
        '{',
        '  \"summary\": \"Ok\",',
        '  \"sections\": [{ \"title\": \"Approach\", \"items\": [\"Step 1\"] }],',
        '  \"risks\": [\"Risk\"],',
        '  \"milestones\": [{ \"title\": \"M1\" }],',
        '  \"recommendedBackendId\": \"claude\"',
        '}',
      ].join('\n'),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('plan_output.v1');
    expect((res.structuredMeta as any).payload?.summary).toBe('Ok');
    expect((res.toolResultMeta as any)?.happier?.kind).toBe('plan_output.v1');
  });

  it('fails deterministically when model output is not strict JSON', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'plan',
      backendId: 'claude',
      instructions: 'plan this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = PlanProfile.onBoundedComplete({
      start,
      rawText: 'not json',
      finishedAtMs: 2,
    });

    expect(res.status).toBe('failed');
    expect((res.toolResultOutput as any)?.error?.code).toBe('invalid_output');
  });
});
