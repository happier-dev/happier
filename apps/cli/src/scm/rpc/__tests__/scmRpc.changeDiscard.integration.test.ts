import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createTestRpcManager, runGit } from './testRpcHarness';

describe('scm rpc change discard (git)', () => {
    function createGitWorkspace(): string {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-discard-git-'));
        runGit(workspace, ['init']);
        runGit(workspace, ['config', 'user.email', 'test@example.com']);
        runGit(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        runGit(workspace, ['add', 'a.txt']);
        runGit(workspace, ['commit', '-m', 'init']);
        return workspace;
    }

    it('discards pending modifications to a tracked file', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'changed\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const discard = await call<any, { cwd?: string; entries: Array<{ path: string; kind: string }> }>(
            RPC_METHODS.SCM_CHANGE_DISCARD,
            {
                cwd: '.',
                entries: [{ path: 'a.txt', kind: 'modified' }],
            }
        );

        expect(discard.success).toBe(true);
        expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('base\n');
    });

    it('removes untracked files when discarded', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'b.txt'), 'tmp\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const discard = await call<any, { cwd?: string; entries: Array<{ path: string; kind: string }> }>(
            RPC_METHODS.SCM_CHANGE_DISCARD,
            {
                cwd: '.',
                entries: [{ path: 'b.txt', kind: 'untracked' }],
            }
        );

        expect(discard.success).toBe(true);
        const status = await call<any, { cwd?: string }>(RPC_METHODS.SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.success).toBe(true);
        expect((status.snapshot.entries as Array<{ path: string }>).some((e) => e.path === 'b.txt')).toBe(false);
    });
});

