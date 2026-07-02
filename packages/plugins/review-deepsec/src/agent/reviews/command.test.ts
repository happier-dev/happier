import { describe, expect, it } from 'vitest';

import { buildDeepSecCommand } from './command.js';

describe('buildDeepSecCommand', () => {
  it('maps supported review actions to exact DeepSec args', () => {
    expect(buildDeepSecCommand({ mode: 'current_diff', commentOutPath: '/tmp/comments.md' })).toEqual([
      'process',
      '--diff',
      '--comment-out',
      '/tmp/comments.md',
    ]);
    expect(buildDeepSecCommand({ mode: 'staged', commentOutPath: '/tmp/comments.md' })).toEqual([
      'process',
      '--diff-staged',
      '--comment-out',
      '/tmp/comments.md',
    ]);
    expect(buildDeepSecCommand({ mode: 'working_tree', commentOutPath: '/tmp/comments.md' })).toEqual([
      'process',
      '--diff-working',
      '--comment-out',
      '/tmp/comments.md',
    ]);
    expect(buildDeepSecCommand({
      mode: 'selected_files',
      filesFromPath: '/tmp/files.txt',
      commentOutPath: '/tmp/comments.md',
    })).toEqual(['process', '--files-from', '/tmp/files.txt', '--comment-out', '/tmp/comments.md']);
    expect(buildDeepSecCommand({ mode: 'repository_security_audit' })).toEqual(['scan']);
    expect(buildDeepSecCommand({
      mode: 'repository_security_audit_process',
      commentOutPath: '/tmp/comments.md',
    })).toEqual(['process', '--comment-out', '/tmp/comments.md']);
  });
});
