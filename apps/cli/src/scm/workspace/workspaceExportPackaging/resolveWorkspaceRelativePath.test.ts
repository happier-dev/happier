import { describe, expect, it } from 'vitest';

import { resolveWorkspaceRelativePath } from './resolveWorkspaceRelativePath';

describe('resolveWorkspaceRelativePath', () => {
  const workspaceRoot = '/tmp/workspaces/demo';

  it('resolves relative and absolute in-root paths to a normalized relative path', () => {
    expect(resolveWorkspaceRelativePath({ workspaceRoot, candidatePath: './src/../README.md' })).toEqual({
      ok: true,
      relativePath: 'README.md',
    });

    expect(resolveWorkspaceRelativePath({ workspaceRoot, candidatePath: '/tmp/workspaces/demo/src/index.ts' })).toEqual({
      ok: true,
      relativePath: 'src/index.ts',
    });
  });

  it('rejects candidate paths that resolve outside the workspace root', () => {
    expect(resolveWorkspaceRelativePath({ workspaceRoot, candidatePath: '../outside.txt' })).toEqual({
      errorCode: 'workspace_path_outside_root',
      ok: false,
    });

    expect(resolveWorkspaceRelativePath({ workspaceRoot, candidatePath: '/tmp/other/place.txt' })).toEqual({
      errorCode: 'workspace_path_outside_root',
      ok: false,
    });
  });
});
