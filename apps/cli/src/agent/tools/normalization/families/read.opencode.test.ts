import { describe, expect, it } from 'vitest';

import { normalizeReadResult } from './read';

describe('normalizeReadResult (OpenCode ACP shapes)', () => {
  it('parses <path>/<type>/<content> wrappers into { file.content, startLine, numLines, totalLines }', () => {
    const rawOutput = {
      output: [
        '<path>/tmp/example.txt</path>',
        '<type>file</type>',
        '<content>1: READ_SENTINEL_123',
        '',
        '(End of file - total 1 lines)',
        '</content>',
      ].join('\n'),
      metadata: {
        preview: 'READ_SENTINEL_123',
        truncated: false,
        loaded: [],
      },
    };

    const normalized = normalizeReadResult(rawOutput);

    expect(normalized).toMatchObject({
      output: rawOutput.output,
      metadata: {
        preview: 'READ_SENTINEL_123',
        truncated: false,
      },
      file: {
        content: 'READ_SENTINEL_123',
        startLine: 1,
        numLines: 1,
        totalLines: 1,
      },
    });
    expect((normalized as any).metadata.loaded).toBeUndefined();
  });
});
