import { describe, expect, it } from 'vitest';

import { parseDeepSecCommentOutMarkdown } from './commentOut.js';

describe('parseDeepSecCommentOutMarkdown', () => {
  it('extracts anchors taxonomy and low-confidence file-level fallbacks', () => {
    const parsed = parseDeepSecCommentOutMarkdown(`
### src/auth.ts:42

**Severity:** high
**Rule:** CWE-601
**Category:** open_redirect

Validate redirect destinations before use.

### src/ambiguous.ts

Could not resolve a precise line, but this file needs attention.
`);

    expect(parsed[0]).toMatchObject({
      anchor: { kind: 'line', filePath: 'src/auth.ts', line: 42 },
      severity: 'high',
      ruleId: 'CWE-601',
      body: 'Validate redirect destinations before use.',
      confidence: 'high',
    });
    expect(parsed[1]).toMatchObject({
      anchor: { kind: 'file', filePath: 'src/ambiguous.ts' },
      tags: ['deepsec.low_confidence_anchor'],
      confidence: 'low',
    });
  });

  it('extracts line ranges from comment headings', () => {
    const parsed = parseDeepSecCommentOutMarkdown(`
### src/auth.ts:42-45

Validate the whole redirect block.
`);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.anchor).toEqual({
      kind: 'range',
      filePath: 'src/auth.ts',
      startLine: 42,
      endLine: 45,
    });
  });

  it('skips unsafe paths from tool output instead of creating leaking anchors', () => {
    const parsed = parseDeepSecCommentOutMarkdown(`
### /Users/alice/repo/src/auth.ts:42

Do not leak this absolute path.

### ../outside.ts:1

Do not anchor traversal paths.

### src/safe.ts:7

Keep this one.
`);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.anchor).toEqual({ kind: 'line', filePath: 'src/safe.ts', line: 7 });
  });
});
