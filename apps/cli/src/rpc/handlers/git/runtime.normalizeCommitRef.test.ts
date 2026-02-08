import { describe, expect, it } from 'vitest';

import { normalizeCommitRef } from './runtime';

describe('normalizeCommitRef', () => {
  it('rejects extended revision syntax using ~', () => {
    expect(normalizeCommitRef('main~3')).toEqual({
      ok: false,
      error: 'Commit reference contains invalid characters',
    });
  });

  it('accepts 64-char sha256 commit hashes', () => {
    const hash64 = '0123456789abcdef'.repeat(4);
    expect(normalizeCommitRef(hash64)).toEqual({
      ok: true,
      commit: hash64,
    });
  });

  it('rejects refs that start with "."', () => {
    expect(normalizeCommitRef('.hidden-ref')).toEqual({
      ok: false,
      error: 'Commit reference contains unsupported syntax',
    });
  });

  it('rejects refs that start with "/"', () => {
    expect(normalizeCommitRef('/refs/heads/main')).toEqual({
      ok: false,
      error: 'Commit reference contains unsupported syntax',
    });
  });
});
