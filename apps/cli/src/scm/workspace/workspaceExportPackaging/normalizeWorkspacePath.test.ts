import { describe, expect, it } from 'vitest';

import { normalizeWorkspacePath } from './normalizeWorkspacePath';

describe('normalizeWorkspacePath', () => {
  it('normalizes separators and dot segments for manifest-safe relative paths', () => {
    expect(normalizeWorkspacePath('.\\src//nested/../file.txt')).toBe('src/file.txt');
    expect(normalizeWorkspacePath('./.git/refs/heads/main')).toBe('.git/refs/heads/main');
  });

  it('collapses workspace-root references to an empty relative path', () => {
    expect(normalizeWorkspacePath('.')).toBe('');
    expect(normalizeWorkspacePath('./')).toBe('');
  });

  it('preserves parent traversal markers for later safety checks', () => {
    expect(normalizeWorkspacePath('../outside.txt')).toBe('../outside.txt');
  });
});
