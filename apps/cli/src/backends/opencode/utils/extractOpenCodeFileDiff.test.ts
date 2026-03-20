import { describe, expect, it } from 'vitest';

import { extractOpenCodeFileDiff } from './extractOpenCodeFileDiff';

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

  it('reads filediff metadata nested under output.metadata', () => {
    expect(extractOpenCodeFileDiff({
      output: {
        metadata: {
          filediff: {
            file: 'b.txt',
            before: 'b0',
            after: 'b1',
          },
        },
      },
    })).toEqual({
      filePath: 'b.txt',
      oldText: 'b0',
      newText: 'b1',
    });
  });

  it('reads direct path/oldText/newText records', () => {
    expect(extractOpenCodeFileDiff({
      path: 'src/app.ts',
      oldText: 'old\n',
      newText: 'new\n',
    })).toEqual({
      filePath: 'src/app.ts',
      oldText: 'old\n',
      newText: 'new\n',
    });
  });

  it('returns null when no file diff data is present', () => {
    expect(extractOpenCodeFileDiff({ ok: true })).toBeNull();
  });
});
