import { describe, expect, it } from 'vitest';

import { buildDeepSecCommand } from './command.js';

describe('buildDeepSecCommand', () => {
  it('honors the selected local harness', () => {
    expect(buildDeepSecCommand({ mode: 'staged', commentOutPath: '/tmp/comments.md', agentCli: 'claude' }))
      .toEqual(['process', '--diff-staged', '--comment-out', '/tmp/comments.md', '--agent', 'claude']);
  });

  it('passes selected reasoning effort to investigation but not the regex scan', () => {
    expect(buildDeepSecCommand({ mode: 'staged', commentOutPath: '/tmp/comments.md', thinkingLevel: 'high' }))
      .toEqual(['process', '--diff-staged', '--comment-out', '/tmp/comments.md', '--thinking-level', 'high']);
    expect(buildDeepSecCommand({ mode: 'repository_security_audit', thinkingLevel: 'high' })).toEqual(['scan']);
  });

  it('maps supported review actions to exact DeepSec args', () => {
    expect(buildDeepSecCommand({ mode: 'current_diff', filesFromPath: '/tmp/files.txt', commentOutPath: '/tmp/comments.md' })).toEqual([
      'process',
      '--files-from',
      '/tmp/files.txt',
      '--no-ignore',
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
    })).toEqual(['process', '--files-from', '/tmp/files.txt', '--no-ignore', '--comment-out', '/tmp/comments.md']);
    expect(buildDeepSecCommand({ mode: 'repository_security_audit' })).toEqual(['scan']);
    expect(buildDeepSecCommand({
      mode: 'repository_security_audit_process',
      rootPath: '/repo',
    })).toEqual(['process', '--root', '/repo']);
  });
});
