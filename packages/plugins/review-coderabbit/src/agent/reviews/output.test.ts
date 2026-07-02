import { describe, expect, it } from 'vitest';

import { normalizeCodeRabbitPlainReviewOutput } from './plainOutput.js';

describe('normalizeCodeRabbitPlainReviewOutput', () => {
  it('maps CodeRabbit plain output into shared review findings', () => {
    const findings = normalizeCodeRabbitPlainReviewOutput(`
==============================
File: src/auth.ts
Line: 10 to 12
Type: Security
Comment:
Validate the redirect target before use.
Prompt for AI Agent:
Add an allow-list check.
==============================
`);

    expect(findings).toEqual([
      expect.objectContaining({
        severity: 'blocker',
        category: 'security',
        filePath: 'src/auth.ts',
        startLine: 10,
        endLine: 12,
        summary: 'Validate the redirect target before use.',
        suggestion: 'Add an allow-list check.',
      }),
    ]);
  });
});
