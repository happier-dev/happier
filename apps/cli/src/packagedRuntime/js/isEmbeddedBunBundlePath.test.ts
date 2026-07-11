import { describe, expect, it } from 'vitest';

import { isEmbeddedBunBundlePath } from './isEmbeddedBunBundlePath';

describe('isEmbeddedBunBundlePath', () => {
  it('detects unix bunfs embedded bundle paths', () => {
    expect(isEmbeddedBunBundlePath('/$bunfs/root/happier-linux-x64')).toBe(true);
  });

  it('detects Windows embedded bun bundle paths', () => {
    expect(isEmbeddedBunBundlePath('B:/~BUN/root/happier.exe')).toBe(true);
    expect(isEmbeddedBunBundlePath('C:\\~BUN\\root\\happier.exe')).toBe(true);
  });

  it('recognizes Windows Bun virtual paths parsed from file URLs', () => {
    expect(isEmbeddedBunBundlePath('/B:/%7EBUN/root/happier.exe')).toBe(true);
    expect(isEmbeddedBunBundlePath('/B:/~BUN/root/happier.exe')).toBe(true);
  });

  it('rejects ordinary filesystem paths', () => {
    expect(isEmbeddedBunBundlePath('C:/Users/test_qa/dev/apps/cli/dist/index.mjs')).toBe(false);
    expect(isEmbeddedBunBundlePath('/B:/Users/test/%7EBUN/root/happier.exe')).toBe(false);
  });
});
