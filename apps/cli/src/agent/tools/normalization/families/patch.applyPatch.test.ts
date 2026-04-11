import { describe, expect, it } from 'vitest';

import { normalizePatchInput } from './patch';

describe('normalizePatchInput (apply_patch patchText)', () => {
  it('infers a non-empty changes map from apply_patch patchText headers', () => {
    const normalized = normalizePatchInput({
      patchText: [
        '*** Begin Patch',
        '*** Update File: e2e-edit-diff.txt',
        '@@',
        '-BEFORE',
        '+AFTER',
        '*** End Patch',
      ].join('\n'),
    });

    expect(normalized).toMatchObject({
      changes: {
        'e2e-edit-diff.txt': { type: 'update' },
      },
    });
  });

  it('normalizes change arrays with per-file diffs into canonical changes', () => {
    const normalized = normalizePatchInput({
      changes: [
        {
          path: '/tmp/notes.md',
          kind: { type: 'update', move_path: null },
          diff: [
            '@@ -1 +1,2 @@',
            '-old line',
            '+old line',
            '+new line',
          ].join('\n'),
        },
        {
          path: '/tmp/new.txt',
          kind: { type: 'add', move_path: null },
          diff: 'hello\nworld\n',
        },
        {
          path: '/tmp/removed.txt',
          kind: { type: 'delete', move_path: null },
          diff: 'goodbye\n',
        },
      ],
    });

    expect(normalized).toMatchObject({
      changes: {
        '/tmp/notes.md': {
          type: 'update',
          modify: {
            old_content: 'old line',
            new_content: 'old line\nnew line',
          },
        },
        '/tmp/new.txt': {
          type: 'add',
          add: {
            content: 'hello\nworld\n',
          },
        },
        '/tmp/removed.txt': {
          type: 'delete',
          delete: {
            content: 'goodbye\n',
          },
        },
      },
    });
  });
});
