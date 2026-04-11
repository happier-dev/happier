import { describe, expect, it } from 'vitest';

import { deriveCanonicalPatchFileDiffs } from './patch.js';

describe('deriveCanonicalPatchFileDiffs', () => {
  it('preserves empty-file additions', () => {
    expect(deriveCanonicalPatchFileDiffs({
      changes: {
        'empty.txt': {
          type: 'add',
          add: { content: '' },
        },
      },
    })).toEqual([
      {
        filePath: 'empty.txt',
        oldText: '',
        newText: '',
      },
    ]);
  });

  it('preserves empty-file additions expressed with top-level content shorthand', () => {
    expect(deriveCanonicalPatchFileDiffs({
      changes: {
        'empty-top-level.txt': {
          type: 'add',
          content: '',
        },
      },
    })).toEqual([
      {
        filePath: 'empty-top-level.txt',
        oldText: '',
        newText: '',
      },
    ]);
  });

  it('preserves updates that truncate a file to empty content', () => {
    expect(deriveCanonicalPatchFileDiffs({
      changes: {
        'truncate.txt': {
          type: 'update',
          modify: {
            old_content: 'before',
            new_content: '',
          },
        },
      },
    })).toEqual([
      {
        filePath: 'truncate.txt',
        oldText: 'before',
        newText: '',
      },
    ]);
  });

  it('preserves truncating updates expressed with top-level content shorthand', () => {
    expect(deriveCanonicalPatchFileDiffs({
      changes: {
        'truncate-top-level.txt': {
          type: 'update',
          old_content: 'before',
          new_content: '',
        },
      },
    })).toEqual([
      {
        filePath: 'truncate-top-level.txt',
        oldText: 'before',
        newText: '',
      },
    ]);
  });
});
