import { describe, expect, it } from 'vitest';

import { normalizeCodeRabbitPlainReviewOutput } from './normalizeCodeRabbitPlainReviewOutput';

describe('normalizeCodeRabbitPlainReviewOutput', () => {
  it('classifies security-critical findings from CodeRabbit comment text when the type is generic', () => {
    const rawText = [
      '============================================================================',
      'File: src/configLoader.js',
      'Line: 3 to 5',
      'Type: potential_issue',
      '',
      'Comment:',
      'Critical: eval() introduces a code injection vulnerability.',
      '',
      'Replacing JSON.parse() with eval() allows arbitrary JavaScript execution.',
      '',
      'Prompt for AI Agent:',
      'Restore JSON.parse(raw).',
      '============================================================================',
      'File: src/configLoader.js',
      'Line: 7 to 9',
      'Type: potential_issue',
      '',
      'Comment:',
      'Critical: Path traversal vulnerability due to removed validation.',
      '',
      'Restore the root-prefix validation to prevent path traversal attacks.',
      '============================================================================',
    ].join('\n');

    const result = normalizeCodeRabbitPlainReviewOutput({
      runId: 'run_1',
      callId: 'call_1',
      sidechainId: 'call_1',
      backendId: 'coderabbit',
      backendTarget: { kind: 'builtInAgent', agentId: 'coderabbit' },
      startedAtMs: 1,
      finishedAtMs: 2,
      rawText,
    });

    expect(result.status).toBe('succeeded');
    expect(result.structuredMeta?.kind).toBe('review_findings.v2');
    const findings = (result.structuredMeta as any)?.payload?.findings ?? [];
    expect(findings).toHaveLength(2);
    expect(findings[0]).toEqual(
      expect.objectContaining({
        severity: 'blocker',
        category: 'security',
      }),
    );
    expect(findings[1]).toEqual(
      expect.objectContaining({
        severity: 'blocker',
        category: 'security',
      }),
    );
  });
});
