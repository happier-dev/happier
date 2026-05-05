import { describe, expect, it } from 'vitest';

import { resolveReviewOutputNormalizer } from './reviewEngineRegistry';

describe('reviewEngineRegistry', () => {
  it('normalizes CodeRabbit plain-text review output through the shared review registry', () => {
    const normalize = resolveReviewOutputNormalizer('coderabbit');
    expect(normalize).toEqual(expect.any(Function));

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

    const result = normalize!({
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
    expect((result.structuredMeta as { payload?: { findings?: unknown[] } }).payload?.findings).toHaveLength(1);
  });

  it('does not provide a review normalizer for unknown review backends', () => {
    expect(resolveReviewOutputNormalizer('acme.review.backend')).toBeNull();
  });
});
