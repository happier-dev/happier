import { describe, expect, it } from 'vitest';

import { normalizeGrepResult } from './search';

describe('normalizeGrepResult (Grok ACP shapes)', () => {
  it('decodes JSON byte arrays in textual process fields', () => {
    const normalized = normalizeGrepResult({
      type: 'GrepSearch',
      stdout: [102, 111, 111, 10],
      stderr: [119, 97, 114, 110],
      exit_code: 0,
      match_count: 1,
      file_matches: [
        {
          path: '/repo/example.ts',
          matches: [{ line_number: 3, content: 'foo' }],
        },
      ],
    });

    expect(normalized).toMatchObject({
      stdout: 'foo\n',
      stderr: 'warn',
      exit_code: 0,
      match_count: 1,
    });
  });
});
