import { describe, expect, it } from 'vitest';

import { ReviewProfile } from './ReviewProfile';

describe('ReviewProfile', () => {
  it('parses trailing JSON when model output includes preamble text', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendId: 'claude',
      instructions: 'review this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = ReviewProfile.onBoundedComplete({
      start,
      rawText: [
        'Sure, here are the findings.',
        '{',
        '  "summary": "Ok",',
        '  "findings": []',
        '}',
      ].join('\n'),
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('review_findings.v1');
    expect((res.structuredMeta as any).payload?.summary).toBe('Ok');
  });

  it('fails deterministically when model output is not strict JSON', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendId: 'claude',
      instructions: 'review this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const res = ReviewProfile.onBoundedComplete({
      start,
      rawText: 'not json',
      finishedAtMs: 2,
    });

    expect(res.status).toBe('failed');
    expect((res.toolResultOutput as any)?.error?.code).toBe('invalid_output');
  });

  it('parses CodeRabbit plain output into review_findings.v1 when backendId=coderabbit', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendId: 'coderabbit',
      instructions: 'review this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const rawText = [
      'File: src/foo.ts',
      'Line: 10 to 12',
      'Type: Bug',
      'Comment:',
      'Null deref risk when value is missing.',
      '',
      'Prompt for AI Agent:',
      'Add a guard and unit test.',
      '============================================================================',
    ].join('\n');

    const res = ReviewProfile.onBoundedComplete({
      start,
      rawText,
      finishedAtMs: 2,
    });

    expect(res.status).toBe('succeeded');
    expect(res.structuredMeta?.kind).toBe('review_findings.v1');
    const payload = (res.structuredMeta as any)?.payload;
    expect(payload.summary).toContain('CodeRabbit');
    expect(Array.isArray(payload.findings)).toBe(true);
    expect(payload.findings.length).toBe(1);
    expect(payload.findings[0]).toEqual(
      expect.objectContaining({
        title: expect.any(String),
        category: 'correctness',
        severity: 'high',
        filePath: 'src/foo.ts',
        startLine: 10,
        endLine: 12,
        summary: expect.stringContaining('Null deref'),
        suggestion: expect.stringContaining('Add a guard'),
      }),
    );
  });

  it('rejects triage actions when start params are missing required policy fields', () => {
    const start = {
      sessionId: 'sess_1',
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      intent: 'review',
      backendId: 'claude',
      instructions: 'review this',
      permissionMode: 'read_only',
      retentionPolicy: 'ephemeral',
      runClass: 'bounded',
      ioMode: 'request_response',
      startedAtMs: 1,
    } as const;

    const completed = ReviewProfile.onBoundedComplete({
      start,
      rawText: '{ "summary": "Ok", "findings": [] }',
      finishedAtMs: 2,
    });

    expect(completed.status).toBe('succeeded');
    expect(completed.structuredMeta?.kind).toBe('review_findings.v1');

    const acted = ReviewProfile.applyAction?.({
      actionId: 'review.triage',
      input: { findings: [] },
      structuredMeta: completed.structuredMeta!,
      start: { ...start, permissionMode: '' },
    });

    expect(acted?.ok).toBe(false);
    expect((acted as any)?.errorCode).toBe('execution_run_invalid_action_input');
  });
});
