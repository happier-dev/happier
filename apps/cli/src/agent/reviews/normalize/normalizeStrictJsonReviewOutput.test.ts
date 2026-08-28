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

  it('preserves a validated structured review failure instead of rebuilding it as success', () => {
    const backendTarget: BackendTargetRefV1 = { kind: 'builtInAgent', agentId: 'deepsec' };
    const res = normalizeStrictJsonReviewOutput({
      runId: 'run_deepsec',
      callId: 'subagent_run_deepsec',
      sidechainId: 'subagent_run_deepsec',
      backendId: 'deepsec',
      backendTarget,
      startedAtMs: 1,
      finishedAtMs: 2,
      rawText: JSON.stringify({
        status: 'failed',
        error: { code: 'deepsec_readiness_failed' },
        runRef: {
          runId: 'provider-run-id',
          callId: 'provider-call-id',
          backendId: 'deepsec',
        },
        summary: 'DeepSec review readiness failed.',
        overviewMarkdown: 'DeepSec cannot start until Node 22 is available.',
        findings: [],
        questions: [],
        assumptions: [],
        readiness: {
          status: 'missing',
          missing: ['node>=22'],
        },
        diagnostics: [{ code: 'deepsec_readiness_failed', severity: 'error' }],
        limits: { findingsTruncated: true, patchesTruncated: false },
        generatedAtMs: 999,
      }),
    });

    expect(res.status).toBe('failed');
    expect(res.toolResultOutput).toMatchObject({
      status: 'failed',
      error: { code: 'deepsec_readiness_failed' },
    });
    expect(res.structuredMeta).toMatchObject({
      kind: 'review_findings.v2',
      payload: {
        status: 'failed',
        error: { code: 'deepsec_readiness_failed' },
        runRef: {
          runId: 'run_deepsec',
          callId: 'subagent_run_deepsec',
          backendId: 'deepsec',
          backendTarget,
        },
        readiness: {
          status: 'missing',
          missing: ['node>=22'],
        },
        diagnostics: [{ code: 'deepsec_readiness_failed', severity: 'error' }],
        limits: { findingsTruncated: true, patchesTruncated: false },
        generatedAtMs: 2,
      },
    });
  });
});
