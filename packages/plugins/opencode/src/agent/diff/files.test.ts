import { describe, expect, it } from 'vitest';

import { extractOpenCodeFileDiff } from './files.js';

describe('extractOpenCodeFileDiff', () => {
  it('reads filediff metadata nested under metadata', () => {
    expect(extractOpenCodeFileDiff({
      metadata: {
        filediff: {
          file: 'a.txt',
          before: 'before-1\n',
          after: 'after-2\n',
        },
      },
    })).toEqual({
      filePath: 'a.txt',
      oldText: 'before-1\n',
      newText: 'after-2\n',
    });
  });

  it('reads direct path records and ignores absent diff data', () => {
    expect(extractOpenCodeFileDiff({
      path: 'src/app.ts',
      oldText: 'old\n',
      newText: 'new\n',
    })).toEqual({
      filePath: 'src/app.ts',
      oldText: 'old\n',
      newText: 'new\n',
    });

    expect(extractOpenCodeFileDiff({ ok: true })).toBeNull();
  });
});
