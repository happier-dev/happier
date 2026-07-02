import { describe, expect, it } from 'vitest';

import { isAbsolutePathLike } from './isAbsolutePathLike.js';

describe('isAbsolutePathLike', () => {
  it('accepts posix absolute paths', () => {
    expect(isAbsolutePathLike('/tmp/pi/sessions/session.jsonl')).toBe(true);
  });

  it('accepts windows drive absolute paths', () => {
    expect(isAbsolutePathLike('C:\\Users\\alice\\session.jsonl')).toBe(true);
    expect(isAbsolutePathLike('C:/Users/alice/session.jsonl')).toBe(true);
  });

  it('accepts windows unc absolute paths', () => {
    expect(isAbsolutePathLike('\\\\server\\share\\session.jsonl')).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(isAbsolutePathLike('tmp/session.jsonl')).toBe(false);
    expect(isAbsolutePathLike('./session.jsonl')).toBe(false);
    expect(isAbsolutePathLike('../session.jsonl')).toBe(false);
  });
});
