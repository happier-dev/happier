import { describe, expect, it } from 'vitest';

import { ScmComparisonSchema, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { normalizeParsedReviewContent, normalizeStrictJsonReviewOutput } from './normalizeStrictJsonReviewOutput';

describe('normalizeParsedReviewContent', () => {
  it('normalizes Session content without trusting native run identity or host-owned materialization', () => {
    const content = normalizeParsedReviewContent({ generatedAtMs: 42, intentInput: { comparisonId: 'captured' }, value: {
      summary: 'Reviewed.', reviewOutcome: 'complete', generatedAtMs: 999, comparisonId: 'spoofed',
      runRef: { runId: 'spoofed', callId: 'spoofed', backendId: 'spoofed' }, fileCount: 999,
      triage: {}, publication: {}, commentIds: ['spoofed'], materialization: 'spoofed',
      materializationFailures: [], perEngineOutcome: [], reviewedFingerprint: 'spoofed', engineId: 'spoofed',
      findings: [{ id: 'f1', title: 'Issue', severity: 'high', category: 'correctness', summary: 'Fix it.',
        filePath: null, patch: '', comment: { id: 'spoofed' }, scopeAttribution: 'in_selected_changes' }],
    } });
    expect(content).toEqual({
      summary: 'Reviewed.', overviewMarkdown: 'Reviewed.', reviewOutcome: 'complete', generatedAtMs: 42,
      comparisonId: 'captured', questions: [], assumptions: [],
      findings: [{ id: 'f1', title: 'Issue', severity: 'high', category: 'correctness', summary: 'Fix it.', scopeAttribution: 'unknown' }],
    });
  });

  it.each([null, {}, { summary: 'Reviewed.', findings: [null] }, { summary: 'Reviewed.', findings: [], proposedComments: {} }])(
    'returns invalid content without fabricating a native run for %j', (value) => {
      expect(normalizeParsedReviewContent({ value, generatedAtMs: 1 })).toBeNull();
    },
  );
});

describe('normalizeStrictJsonReviewOutput', () => {
  it('preserves opaque plugin evidence and suggested fixes but rejects malformed extension namespaces', () => {
    const finding = { id: 'f1', title: 'Issue', severity: 'high', category: 'correctness', summary: 'Check this.',
      suggestion: 'Use the owner.', patch: '+fixed', extensions: { 'acme.review': { evidence: ['slice-1'], nested: { score: 0.8 } } } };
    const normalize = (value: unknown) => normalizeStrictJsonReviewOutput({
      runId: 'review', callId: 'review-call', sidechainId: 'review-sidechain', backendId: 'reviewer',
      backendTarget: { kind: 'builtInAgent', agentId: 'reviewer' }, startedAtMs: 1, finishedAtMs: 2,
      rawText: JSON.stringify({ summary: 'Reviewed.', reviewOutcome: 'complete', findings: [value] }),
    });
    expect(normalize(finding).structuredMeta).toMatchObject({ kind: 'review_findings.v2', payload: { findings: [finding] } });
    expect(normalize({ ...finding, extensions: { arbitrary: { decision: 'approved' } } })).toMatchObject({
      status: 'failed', toolResultOutput: { error: { code: 'invalid_output' } },
    });
  });

  it('derives scope attribution from captured locations and ignores model classifications', () => {
    const comparison = ScmComparisonSchema.parse({ id: 'captured', source: { kind: 'branch', base: 'base', head: 'selected-head' },
      repository: { rootPath: '/repo' }, endpoints: { before: 'before', after: 'after' },
      inventory: { state: 'complete', reasons: [], files: [{ path: 'renamed.ts', previousPath: 'original.ts',
        changeKind: 'renamed', binary: false, generated: false, lockfile: false,
        beforeBlobId: 'old-blob', afterBlobId: 'new-blob',
        evidence: { state: 'available', unifiedDiff: '@@ -1,3 +1,4 @@\n oldIssue();\n safe();\n-oldCall();\n+newIssue();\n+oldCall();\n' },
        occurrences: [{ id: 'occurrence', alias: 'c1', path: 'renamed.ts', previousPath: 'original.ts',
          beforeBlobId: 'old-blob', afterBlobId: 'new-blob', before: { startLine: 1, lineCount: 3 },
          after: { startLine: 1, lineCount: 4 }, position: 0, evidence: { state: 'available' } }],
      }] } });
    const base = { title: 'Issue', severity: 'high', category: 'correctness', summary: 'Check this.' };
    const findings = [
      { ...base, id: 'old', filePath: 'renamed.ts', startLine: 1, scopeAttribution: 'in_selected_changes' },
      { ...base, id: 'new', filePath: '/repo/renamed.ts', startLine: 3, scopeAttribution: 'pre_existing' },
      { ...base, id: 'repeated', filePath: 'renamed.ts', startLine: 4 },
      { ...base, id: 'unresolved', filePath: 'renamed.ts', startLine: 100 },
      { ...base, id: 'transcript', scopeAttribution: 'pre_existing' },
      { ...base, id: 'mixed', filePath: 'renamed.ts', startLine: 1, endLine: 3 },
      { ...base, id: 'outside', filePath: 'outside.ts', startLine: 1 },
    ];
    const normalize = (intentInput: unknown) => normalizeStrictJsonReviewOutput({
      runId: 'review', callId: 'call', sidechainId: 'sidechain', backendId: 'agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'agent' }, startedAtMs: 1, finishedAtMs: 2,
      rawText: JSON.stringify({ summary: 'Reviewed', reviewOutcome: 'complete', findings }), intentInput,
    }).structuredMeta?.payload;
    expect(normalize({ comparisonId: comparison.id, comparison })).toMatchObject({ findings: [
      { id: 'old', scopeAttribution: 'pre_existing' }, { id: 'new', scopeAttribution: 'in_selected_changes' },
      ...['repeated', 'unresolved', 'transcript', 'mixed', 'outside'].map(id => ({ id, scopeAttribution: 'unknown' })),
    ] });
    const capturedFile = comparison.inventory.files[0]!;
    const occurrence = capturedFile.occurrences[0]!;
    for (const input of [{}, { comparisonId: 'mismatch', comparison }, { comparisonId: comparison.id,
      comparison: { ...comparison, inventory: { ...comparison.inventory, state: 'incomplete', reasons: ['Missing evidence'] } } },
      ...[
        { ...capturedFile, evidence: { state: 'unavailable', reason: 'Missing evidence' } },
        { ...capturedFile, occurrences: [{ ...occurrence, beforeBlobId: 'conflicting-blob' }] },
        { ...capturedFile, evidence: { state: 'available', unifiedDiff: '@@ -1,3 +1,4 @@\n oldIssue();\n' } },
      ].map(file => ({ comparisonId: comparison.id,
        comparison: { ...comparison, inventory: { ...comparison.inventory, files: [file] } } })),
    ]) {
      const payload = normalize(input) as { findings: Array<{ scopeAttribution?: unknown }> };
      expect(payload.findings.map(finding => finding.scopeAttribution)).toEqual(findings.map(() => 'unknown'));
    }
  });
  it.each([
    ['## Authorization change\n\nThe **grant** now checks `scope` before [dispatch](https://example.test).\n\nLater detail.',
      'The grant now checks scope before dispatch.'],
    ['Authorization change\n====================\n\n```ts\nthrow new Error();\n```\n\n> - The _existing_ grant stays valid.',
      'The existing grant stays valid.'],
    ['\n## Heading only\n\n---', 'Review follow-up completed.'],
    ['The first paragraph wraps\nonto another line.\n\nThe next paragraph stays in the full answer.',
      'The first paragraph wraps onto another line.'],
    ['## Authorization implications\n\nChanging `&&` to `||` means either matching check is sufficient for deletion.',
      'Changing && to || means either matching check is sufficient for deletion.'],
  ])('summarizes substantive follow-up prose and preserves the full answer: %s', (answerMarkdown, summary) => {
    const result = normalizeStrictJsonReviewOutput({
      runId: 'review', callId: 'review-call', sidechainId: 'review-sidechain', backendId: 'installed-agent',
      backendTarget: { kind: 'builtInAgent', agentId: 'installed-agent' }, startedAtMs: 1, finishedAtMs: 2,
      intentInput: { kind: 'review_follow_up.v1',
        parentRunRef: { runId: 'parent', callId: 'parent-call', backendId: 'installed-agent' },
        threadId: 'thread', messageMarkdown: 'Explain', summary: 'Original', overviewMarkdown: 'Original' },
      rawText: JSON.stringify({ answerMarkdown }),
    });
    expect(result.status).toBe('succeeded');
    expect(result.summary).toBe(summary);
    expect(result.toolResultOutput).toMatchObject({ summary });
    expect(result.structuredMeta).toMatchObject({ kind: 'review_follow_up.v1', payload: { answerMarkdown } });
  });

  it.each([
    { report: {}, outcome: 'partial', status: 'succeeded' },
    { report: { reviewOutcome: 'failed' }, outcome: 'failed', status: 'failed' },
    { report: { reviewOutcome: 'partial' }, outcome: 'partial', status: 'succeeded' },
    { report: { reviewOutcome: 'complete' }, outcome: 'complete', status: 'succeeded' },
    { report: { reviewOutcome: 'complete', status: 'failed' }, outcome: 'failed', status: 'failed' },
    { report: { reviewOutcome: 'complete', limits: { findingsTruncated: true } }, outcome: 'partial', status: 'succeeded' },
  ])('does not infer complete inspection from an empty findings array: $report', ({ report, outcome, status }) => {
    const res = normalizeStrictJsonReviewOutput({
      runId: 'review', callId: 'review-call', sidechainId: 'review-sidechain', backendId: 'codex',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, startedAtMs: 1, finishedAtMs: 2,
      rawText: JSON.stringify({
        ...report,
        summary: 'Workspace inspection outcome.',
        overviewMarkdown: 'The inspection result is carried as structured data, independently of this prose.',
        findings: [],
      }),
    });

    expect(res.status).toBe(status);
    expect(res.toolResultOutput).toMatchObject({ status, reviewOutcome: outcome });
    expect(res.structuredMeta).toMatchObject({ kind: 'review_findings.v2', payload: { reviewOutcome: outcome, findings: [] } });
  });

  it.each([false, true])('omits absent optional model finding fields without losing findings (follow-up: %s)', (followUp) => {
    const finding = { id: 'f1', title: 'Issue', severity: 'high', category: 'correctness', summary: 'Check this.' };
    const retainedFinding = { ...finding, id: 'f2', patch: '+fixed', confidence: 0.8 };
    const res = normalizeStrictJsonReviewOutput({
      runId: 'review', callId: 'review-call', sidechainId: 'review-sidechain', backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, startedAtMs: 1, finishedAtMs: 2,
      ...(followUp ? { intentInput: {
        kind: 'review_follow_up.v1', parentRunRef: { runId: 'parent', callId: 'parent-call', backendId: 'claude' },
        threadId: 'thread', messageMarkdown: 'Explain', summary: 'Original', overviewMarkdown: 'Original',
      } } : {}),
      rawText: JSON.stringify({
        summary: 'Reviewed.', answerMarkdown: 'Explained.',
        [followUp ? 'updatedFindings' : 'findings']: [{
          ...finding, filePath: null, startLine: null, endLine: null, whyItMatters: null, evidence: null,
          confidence: null, suggestion: null, patch: '', attributionConfidence: null,
        }, retainedFinding],
      }),
    });

    expect(res.status).toBe('succeeded');
    const payload = res.structuredMeta?.payload as Record<string, unknown> | undefined;
    const findings = payload?.[followUp ? 'updatedFindings' : 'findings'];
    expect(findings).toEqual([finding, retainedFinding].map(value => ({ ...value, scopeAttribution: 'unknown' })));
  });

  it('keeps required finding fields and non-null optional values strict', () => {
    const finding = { id: 'f1', title: 'Issue', severity: 'high', category: 'correctness', summary: 'Check this.' };
    for (const invalid of [
      ...Object.keys(finding).map((key) => ({ ...finding, [key]: null })),
      { ...finding, patch: 123 },
    ]) {
      const res = normalizeStrictJsonReviewOutput({
        runId: 'review', callId: 'review-call', sidechainId: 'review-sidechain', backendId: 'claude',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, startedAtMs: 1, finishedAtMs: 2,
        rawText: JSON.stringify({ summary: 'Reviewed.', findings: [invalid] }),
      });

      expect(res.status).toBe('failed');
      expect(res.toolResultOutput).toMatchObject({ error: { code: 'invalid_output' } });
      expect(res.structuredMeta).toBeUndefined();
    }
  });

  it('publishes only the captured inventory file count, preserving zero and rejecting model counts', () => {
    const comparison = ScmComparisonSchema.parse({ id: 'captured', source: { kind: 'workingTree' },
      repository: { rootPath: '/repo' }, endpoints: {}, inventory: { state: 'complete', reasons: [],
        files: [{ path: 'a.ts', changeKind: 'modified', binary: false, generated: false, lockfile: false,
          evidence: { state: 'available', unifiedDiff: '' }, occurrences: [] }] } });
    const normalize = (intentInput?: unknown) => normalizeStrictJsonReviewOutput({
      runId: 'review', callId: 'review-call', sidechainId: 'review-sidechain', backendId: 'claude',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, startedAtMs: 1, finishedAtMs: 2,
      rawText: JSON.stringify({ summary: 'Reviewed.', findings: [], fileCount: 999 }), intentInput,
    }).structuredMeta?.payload;
    expect(normalize({ comparisonId: comparison.id, comparison })).toMatchObject({ fileCount: 1 });
    expect(normalize({ comparisonId: comparison.id,
      comparison: { ...comparison, inventory: { ...comparison.inventory, files: [] } } })).toMatchObject({ fileCount: 0 });
    expect(normalize()).not.toHaveProperty('fileCount');
    expect(normalize({ comparisonId: 'different', comparison })).not.toHaveProperty('fileCount');
    expect(normalize({ comparisonId: comparison.id, comparison: { inventory: { files: [1] } } })).not.toHaveProperty('fileCount');
  });

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
