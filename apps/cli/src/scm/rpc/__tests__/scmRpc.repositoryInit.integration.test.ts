import { existsSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { ScmWorkingSnapshot } from '@happier-dev/protocol';
import type { ScmStatusSnapshotRequest, ScmStatusSnapshotResponse } from '@happier-dev/protocol';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

type ScmRepositoryInitResponse = Readonly<{
    success: boolean;
    alreadyInitialized?: boolean;
    snapshot?: ScmWorkingSnapshot;
    error?: string;
    errorCode?: string;
}>;

function scmMethod(key: string): string {
    return (RPC_METHODS as Record<string, string>)[key] ?? '';
}

describe('git repository initialization RPC handler', () => {
    it('initializes a non-repository folder without staging files', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-init-'));
        writeFileSync(join(workspace, 'README.md'), '# Project\n');

        expect(scmMethod('SCM_REPOSITORY_INIT')).toBe('scm.repository.init');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const beforeInit = await call<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '.' }
        );
        expect(beforeInit.success).toBe(true);
        expect(beforeInit.snapshot?.repo.isRepo).toBe(false);
        expect((beforeInit.snapshot?.capabilities as Record<string, unknown> | undefined)?.writeRepositoryInit).toBe(true);

        const response = await call<ScmRepositoryInitResponse, { cwd: string; initialBranch: string }>(
            scmMethod('SCM_REPOSITORY_INIT'),
            {
                cwd: '.',
                initialBranch: 'main',
            }
        );

        expect(response.success).toBe(true);
        expect(response.alreadyInitialized).toBe(false);
        expect(response.snapshot?.repo.isRepo).toBe(true);
        expect((response.snapshot?.capabilities as Record<string, unknown> | undefined)?.writeRepositoryInit).toBe(true);
        expect(existsSync(join(workspace, '.git'))).toBe(true);
        expect(git(workspace, ['status', '--porcelain'])).toBe('?? README.md');
    });

    it('returns the existing repository snapshot when initialization is repeated', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-rpc-init-existing-'));
        git(workspace, ['init']);

        expect(scmMethod('SCM_REPOSITORY_INIT')).toBe('scm.repository.init');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<ScmRepositoryInitResponse, { cwd: string }>(
            scmMethod('SCM_REPOSITORY_INIT'),
            { cwd: '.' }
        );

        expect(response.success).toBe(true);
        expect(response.alreadyInitialized).toBe(true);
        expect(response.snapshot?.repo.backendId).toBe('git');
    });
});
