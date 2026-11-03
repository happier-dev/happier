import { describe, expect, it } from 'vitest';

import { ReviewFindingsV2Schema } from '@happier-dev/protocol';

import { normalizeReviewOutput } from './normalizeReviewOutput';
import { normalizeStrictJsonReviewOutput } from './normalizeStrictJsonReviewOutput';

const codexBackendTarget = { kind: 'builtInAgent', agentId: 'codex' } as const;
const nativeReview = {
  findings: [{
    title: '[P1] Preserve authorization checks',
    body: 'The write runs without checking the supplied authorization scope.',
    priority: 1,
    confidence_score: 0.95,
    code_location: { absolute_file_path: '/repo/auth.ts', line_range: { start: 10, end: 12 } },
  }],
  overall_explanation: 'Authorization is missing.',
};

function normalizeCodex(rawText: string) {
  return normalizeReviewOutput({
    runId: 'run_1',
    callId: 'call_1',
    sidechainId: 'call_1',
    backendId: 'codex',
    backendTarget: codexBackendTarget,
    startedAtMs: 10,
    finishedAtMs: 20,
    rawText,
    retentionPolicy: 'resumable',
  });
}

function parseFindingsPayload(result: ReturnType<typeof normalizeCodex>) {
  expect(result.status).toBe('succeeded');
  expect(result.structuredMeta?.kind).toBe('review_findings.v2');
  return ReviewFindingsV2Schema.parse(result.structuredMeta?.payload);
}

describe('normalizeReviewOutput codex reviews', () => {
  it('preserves strict JSON output for prompt-based Codex reviews', () => {
    const rawText = JSON.stringify({
      summary: 'Strict review completed.',
      overviewMarkdown: 'Strict overview.',
      findings: [
        {
          id: 'strict_1',
          title: 'Strict finding',
          severity: 'medium',
          category: 'correctness',
          summary: 'Strict finding body.',
          filePath: 'src/strict.ts',
          startLine: 4,
          endLine: 5,
        },
      ],
      questions: [],
      assumptions: [],
    });

    const codexResult = normalizeCodex(rawText);
    const strictResult = normalizeStrictJsonReviewOutput({
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      backendId: 'codex',
      backendTarget: codexBackendTarget,
      startedAtMs: 10,
      finishedAtMs: 20,
      rawText,
      retentionPolicy: 'resumable',
    });

    expect(codexResult).toEqual(strictResult);
  });

  it('parses Codex full review comments into findings', () => {
    const result = normalizeCodex([
      'The review found two issues that should be fixed before merge.',
      '',
      'Full review comments:',
      '',
      '- Missing cancellation guard - /repo/src/session.ts:10-20',
      '  The async callback still commits state after cancellation.',
      '  Check the cancelled flag before writing the result.',
      '',
      '- Handle empty paths - /repo/src/path.ts:7',
      '  Empty path input currently falls through to the filesystem call.',
    ].join('\n'));

    const payload = parseFindingsPayload(result);
    expect(payload.summary).toBe('The review found two issues that should be fixed before merge.');
    expect(payload.overviewMarkdown).toContain('Full review comments:');
    expect(payload.findings).toHaveLength(2);
    expect(payload.findings[0]).toMatchObject({
      title: 'Missing cancellation guard',
      severity: 'medium',
      category: 'correctness',
      filePath: '/repo/src/session.ts',
      startLine: 10,
      endLine: 20,
      summary: 'The async callback still commits state after cancellation.\nCheck the cancelled flag before writing the result.',
    });
    expect(payload.findings[1]).toMatchObject({
      title: 'Handle empty paths',
      filePath: '/repo/src/path.ts',
      startLine: 7,
      endLine: 7,
    });
  });

  it('parses a single Codex review comment block', () => {
    const result = normalizeCodex([
      'One correctness issue is present.',
      '',
      'Review comment:',
      '',
      '- Reject stale cache entries -- src/cache.ts:42',
      '  Cache entries are read without checking the recorded generation.',
    ].join('\n'));

    const payload = parseFindingsPayload(result);
    expect(payload.findings).toHaveLength(1);
    expect(payload.findings[0]).toMatchObject({
      title: 'Reject stale cache entries',
      filePath: 'src/cache.ts',
      startLine: 42,
      endLine: 42,
      summary: 'Cache entries are read without checking the recorded generation.',
    });
  });

  it('returns overview-only success for Codex prose without findings', () => {
    const result = normalizeCodex([
      'No issues found.',
      '',
      'I reviewed the requested changes and did not find any correctness issues.',
    ].join('\n'));

    const payload = parseFindingsPayload(result);
    expect(payload.summary).toBe('No issues found.');
    expect(payload.overviewMarkdown).toContain('did not find any correctness issues');
    expect(payload.findings).toEqual([]);
  });

  it.each([
    'No correctness issues found. The configuration {"enabled":true} is valid.',
    'No correctness issues found.\n\nThe following configuration remains valid:\n```json\n{"enabled":true}\n```',
  ])('preserves no-findings prose containing a JSON example: %s', (rawText) => {
    const payload = parseFindingsPayload(normalizeCodex(rawText));
    expect(payload.overviewMarkdown).toBe(rawText);
    expect(payload.findings).toEqual([]);
  });

  it('keeps native prose findings whose evidence contains a JSON example', () => {
    const result = normalizeCodex([
      'One correctness issue is present.',
      '',
      'Review comment:',
      '',
      '- Reject stale cache entries -- src/cache.ts:42',
      '  The invalid cached value is {"generation":0}.',
    ].join('\n'));

    const payload = parseFindingsPayload(result);
    expect(payload.findings).toHaveLength(1);
    expect(payload.findings[0]).toMatchObject({
      filePath: 'src/cache.ts',
      summary: 'The invalid cached value is {"generation":0}.',
    });
  });

  it.each([
    'The code turns malformed responses into `{"findings":[]}`.',
    'The API returns {"findings":[]} when authorization is missing.',
    'The API wrongly returns {"overall_correctness":false}.',
  ])('keeps inline JSON examples in a native prose overview: %s', (overview) => {
    const payload = parseFindingsPayload(normalizeCodex([
      overview,
      '',
      'Review comment:',
      '- Preserve authorization -- /repo/auth.ts:10-12',
      '  The write skips authorization.',
    ].join('\n')));
    expect(payload.findings).toHaveLength(1);
    expect(payload.overviewMarkdown).toContain(overview);
  });

  it('fails clearly for empty Codex native review output', () => {
    const result = normalizeCodex('   \n  ');

    expect(result.status).toBe('failed');
    expect(result.toolResultOutput).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_output' },
    });
  });

  it('preserves findings from Codex native JSON reviews', () => {
    const result = normalizeCodex(JSON.stringify({
      findings: [{
        title: '[P2] Keep the deletion schedule within the retention requirement',
        body: 'The thirty-day schedule exceeds the seven-day retention requirement.',
        priority: 2,
        confidence_score: 1,
        code_location: {
          absolute_file_path: '/repo/retention.md',
          line_range: { start: 3, end: 3 },
        },
      }],
      overall_correctness: 'patch is incorrect',
      overall_explanation: 'The schedule conflicts with the retention requirement.',
      overall_confidence_score: 1,
    }));

    const payload = parseFindingsPayload(result);
    expect(payload.summary).toBe('The schedule conflicts with the retention requirement.');
    expect(payload.findings).toHaveLength(1);
    expect(payload.findings[0]).toMatchObject({
      title: '[P2] Keep the deletion schedule within the retention requirement',
      summary: 'The thirty-day schedule exceeds the seven-day retention requirement.',
      severity: 'medium',
      confidence: 1,
      filePath: '/repo/retention.md',
      startLine: 3,
      endLine: 3,
    });
    expect(result.toolResultOutput).toMatchObject({ findingsDigest: { total: 1 } });
  });

  it.each([
    `Review result: ${JSON.stringify(nativeReview)}`,
    `\`\`\`json\n${JSON.stringify(nativeReview, null, 2)}\n\`\`\``,
    `${JSON.stringify(nativeReview)}\n\nFor reference: {"enabled":true}`,
  ])('reads a single native review independently of surrounding prose and examples: %s', (rawText) => {
    const payload = parseFindingsPayload(normalizeCodex(rawText));
    expect(payload.findings).toHaveLength(1);
    expect(payload.findings[0]).toMatchObject({
      severity: 'high', confidence: 0.95, filePath: '/repo/auth.ts', startLine: 10, endLine: 12,
    });
  });

  it.each([
    JSON.stringify([nativeReview]),
    JSON.stringify([nativeReview, { ...nativeReview, findings: [], overall_explanation: 'No issues found.' }]),
    JSON.stringify([[nativeReview]]),
    JSON.stringify({ result: nativeReview }),
    JSON.stringify([{ result: nativeReview }]),
    `Review comment:\n- Preface observation -- /preface.ts:3\n  Preliminary text.\n\n${JSON.stringify(nativeReview)}`,
    `Review result: ${JSON.stringify(nativeReview)}\n\nReview comment:\n- Preface observation -- /preface.ts:3\n  Preliminary text.`,
  ])('rejects ambiguous review envelopes instead of dropping findings: %s', (rawText) => {
    const result = normalizeCodex(rawText);
    expect(result.status).toBe('failed');
    expect(result.toolResultOutput).toMatchObject({ error: { code: 'invalid_output' } });
  });

  it.each([
    '{"findings":[]}',
    '{"overall_correctness":false}',
    JSON.stringify({ ...nativeReview, findings: [] }),
  ])('keeps JSON evidence in a recognized native prose finding: %s', (example) => {
    const payload = parseFindingsPayload(normalizeCodex([
      'One correctness issue found.',
      '',
      'Review comment:',
      '- Preserve authorization -- /repo/auth.ts:10-12',
      '  The write skips authorization.',
      `  Example input: ${example}`,
    ].join('\n')));
    expect(payload.findings).toHaveLength(1);
    expect(payload.findings[0].summary).toContain(`Example input: ${example}`);
  });

  it.each([
    'The function starts with `{`.',
    'The token "{" opens an object.',
    '[Reviewer "Codex]',
  ])('finds the native JSON review after literal prose punctuation: %s', (prefix) => {
    const payload = parseFindingsPayload(normalizeCodex(`${prefix}\n\n${JSON.stringify(nativeReview)}`));
    expect(payload.findings).toHaveLength(1);
    expect(payload.findings[0]).toMatchObject({ severity: 'high', filePath: '/repo/auth.ts' });
  });

  it('accepts a valid Codex native JSON review with no findings', () => {
    const result = normalizeCodex(JSON.stringify({
      findings: [],
      overall_correctness: 'patch is correct',
      overall_explanation: 'No correctness issues found.',
      overall_confidence_score: 0.9,
    }));

    const payload = parseFindingsPayload(result);
    expect(payload.summary).toBe('No correctness issues found.');
    expect(payload.findings).toEqual([]);
  });

  it('preserves a Codex finding and priority when its overview is empty', () => {
    const result = normalizeCodex(JSON.stringify({
      findings: [{
        title: '[P1] Do not return a successful empty review',
        body: 'Malformed review output must remain an observable failure.',
        priority: 1,
        code_location: {
          absolute_file_path: '/repo/review.ts',
          line_range: { start: 10, end: 12 },
        },
      }],
      overall_explanation: '',
    }));

    const payload = parseFindingsPayload(result);
    expect(payload.summary).toBe('Codex review completed.');
    expect(payload.findings[0]).toMatchObject({ severity: 'high', startLine: 10, endLine: 12 });
  });

  it.each([
    '{"findings":[',
    '{"findings"',
    '{"findings',
    '{"findings" []}',
    '{"overall_correctness":"patch is incorrect"}',
    'Review result: {"findings":[',
    '```json\n{"findings":[\n```',
    'Review result:\n```json\n{"findings":[\n```',
    JSON.stringify({ findings: [{ title: 'Finding without a location', body: 'Details.' }] }),
    JSON.stringify({ summary: 'Invalid strict result', findings: [{ title: 'Incomplete' }] }),
  ])('does not turn malformed JSON into a successful empty review: %s', (rawText) => {
    const result = normalizeCodex(rawText);

    expect(result.status).toBe('failed');
    expect(result.toolResultOutput).toMatchObject({ error: { code: 'invalid_output' } });
  });
});
