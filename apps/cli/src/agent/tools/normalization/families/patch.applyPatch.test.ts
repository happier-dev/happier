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
});
