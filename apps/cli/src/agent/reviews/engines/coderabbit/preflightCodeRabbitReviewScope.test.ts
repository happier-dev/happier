import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runGit } from '@/scm/rpc/__tests__/testRpcHarness';

import { preflightCodeRabbitReviewScope } from './preflightCodeRabbitReviewScope';

describe('preflightCodeRabbitReviewScope', () => {
  it('normalizes partial intentInput the same way as execution (committed scope without engineIds/instructions)', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'happier-coderabbit-preflight-partial-remote-'));
    runGit(remote, ['init', '--bare', '--initial-branch=main']);

    const workspace = mkdtempSync(join(tmpdir(), 'happier-coderabbit-preflight-partial-workspace-'));
    runGit(workspace, ['init', '--initial-branch=main']);
    runGit(workspace, ['config', 'user.email', 'test@example.com']);
    runGit(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'a.txt'), 'base\n');
    runGit(workspace, ['add', 'a.txt']);
    runGit(workspace, ['commit', '-m', 'base']);
    runGit(workspace, ['remote', 'add', 'origin', remote]);
    runGit(workspace, ['push', '-u', 'origin', 'main']);

    writeFileSync(join(workspace, 'a.txt'), 'changed\n');
    runGit(workspace, ['add', 'a.txt']);
    runGit(workspace, ['commit', '-m', 'change']);

    const result = await preflightCodeRabbitReviewScope({
      cwd: workspace,
      intentInput: {
        changeType: 'committed',
        base: { kind: 'none' },
      },
    });

    expect(result).toEqual({ ok: true, eligibleFileCount: 1 });
  });

  it('fails when a committed review has no eligible files in the current session scope', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'happier-coderabbit-preflight-remote-'));
    runGit(remote, ['init', '--bare', '--initial-branch=main']);

    const workspace = mkdtempSync(join(tmpdir(), 'happier-coderabbit-preflight-workspace-'));
    runGit(workspace, ['init', '--initial-branch=main']);
    runGit(workspace, ['config', 'user.email', 'test@example.com']);
    runGit(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'a.txt'), 'base\n');
    runGit(workspace, ['add', 'a.txt']);
    runGit(workspace, ['commit', '-m', 'base']);
    runGit(workspace, ['remote', 'add', 'origin', remote]);
    runGit(workspace, ['push', '-u', 'origin', 'main']);

    const result = await preflightCodeRabbitReviewScope({
      cwd: workspace,
      intentInput: {
        engineIds: ['coderabbit'],
        instructions: 'Review the current scope.',
        changeType: 'committed',
        base: { kind: 'none' },
      },
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('No reviewable files'),
    });
  });

  it('fails when the eligible file count exceeds the configured CodeRabbit limit', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'happier-coderabbit-preflight-remote-'));
    runGit(remote, ['init', '--bare', '--initial-branch=main']);

    const workspace = mkdtempSync(join(tmpdir(), 'happier-coderabbit-preflight-workspace-'));
    runGit(workspace, ['init', '--initial-branch=main']);
    runGit(workspace, ['config', 'user.email', 'test@example.com']);
    runGit(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'a.txt'), 'base\n');
    writeFileSync(join(workspace, 'b.txt'), 'base\n');
    runGit(workspace, ['add', 'a.txt', 'b.txt']);
    runGit(workspace, ['commit', '-m', 'base']);
    runGit(workspace, ['remote', 'add', 'origin', remote]);
    runGit(workspace, ['push', '-u', 'origin', 'main']);

    writeFileSync(join(workspace, 'a.txt'), 'changed\n');
    writeFileSync(join(workspace, 'b.txt'), 'changed\n');
    runGit(workspace, ['add', 'a.txt', 'b.txt']);
    runGit(workspace, ['commit', '-m', 'change']);

    const result = await preflightCodeRabbitReviewScope({
      cwd: workspace,
      intentInput: {
        engineIds: ['coderabbit'],
        instructions: 'Review the current scope.',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      maxEligibleFiles: 1,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining('Too many reviewable files'),
    });
  });
});
