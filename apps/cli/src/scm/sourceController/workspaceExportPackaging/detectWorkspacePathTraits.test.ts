import { describe, expect, it } from 'vitest';

import { detectWorkspacePathTraits } from './detectWorkspacePathTraits';

describe('detectWorkspacePathTraits', () => {
  it('returns normalized segments for relative workspace paths', () => {
    expect(detectWorkspacePathTraits('./.git/refs/heads/main')).toEqual({
      hasParentTraversal: false,
      isAbsolute: false,
      isRoot: false,
      normalizedPath: '.git/refs/heads/main',
      segments: ['.git', 'refs', 'heads', 'main'],
    });
  });

  it('flags parent traversal and absolute paths', () => {
    expect(detectWorkspacePathTraits('../outside.txt')).toMatchObject({
      hasParentTraversal: true,
      isAbsolute: false,
      normalizedPath: '../outside.txt',
    });

    expect(detectWorkspacePathTraits('/tmp/workspace/file.txt')).toMatchObject({
      hasParentTraversal: false,
      isAbsolute: true,
      normalizedPath: '/tmp/workspace/file.txt',
    });
  });
});
