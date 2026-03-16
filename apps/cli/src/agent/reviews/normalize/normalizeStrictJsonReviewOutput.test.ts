import { describe, expect, it } from 'vitest';

import type { BackendTargetRefV1 } from '@happier-dev/protocol';

import { normalizeStrictJsonReviewOutput } from './normalizeStrictJsonReviewOutput';

describe('normalizeStrictJsonReviewOutput', () => {
  it('carries retentionPolicy into the structured runRef when provided', () => {
    const backendTarget: BackendTargetRefV1 = { kind: 'builtInAgent', agentId: 'claude' };
    const params = {
      runId: 'run_1',
      callId: 'subagent_run_1',
      sidechainId: 'subagent_run_1',
      backendId: 'claude',
      backendTarget,
      startedAtMs: 1,
      finishedAtMs: 2,
      rawText: JSON.stringify({
        summary: 'Summary.',
        findings: [{ id: 'f1', title: 'Example', severity: 'low', category: 'style', summary: 'One paragraph.' }],
      }),
      retentionPolicy: 'resumable',
    } as const;

    const res = normalizeStrictJsonReviewOutput(params);
    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('review_findings.v2');

    const payload = res.structuredMeta?.payload as unknown as Record<string, unknown>;
    const runRef = payload.runRef as unknown as Record<string, unknown>;
    expect(runRef).toMatchObject({
      runId: 'run_1',
      callId: 'subagent_run_1',
      backendId: 'claude',
      retentionPolicy: 'resumable',
    });
  });
});
