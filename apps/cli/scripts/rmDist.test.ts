import { describe, expect, it } from 'vitest';

import { resolveDistDir } from './rmDist.mjs';

describe('rmDist', () => {
  it('defaults to dist when no directory is provided', () => {
    expect(resolveDistDir(['node', 'rmDist.mjs'])).toBe('dist');
  });

  it('defaults to dist when the first arg looks like a flag', () => {
    expect(resolveDistDir(['node', 'rmDist.mjs', '--foo'])).toBe('dist');
  });

  it('uses the first arg when it looks like a directory name', () => {
    expect(resolveDistDir(['node', 'rmDist.mjs', 'build-out'])).toBe('build-out');
  });

  it('rejects absolute paths', () => {
    expect(resolveDistDir(['node', 'rmDist.mjs', '/'])).toBe('dist');
  });

  it('rejects path traversal segments', () => {
    expect(resolveDistDir(['node', 'rmDist.mjs', '../../..'])).toBe('dist');
    expect(resolveDistDir(['node', 'rmDist.mjs', 'dist/../..'])).toBe('dist');
  });

  it('rejects dot segments (avoid deleting the current directory)', () => {
    expect(resolveDistDir(['node', 'rmDist.mjs', '.'])).toBe('dist');
    expect(resolveDistDir(['node', 'rmDist.mjs', './dist'])).toBe('dist');
  });
});
