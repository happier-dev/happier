import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    SCM_OPERATION_ERROR_CODES,
    type ScmPullRequestOpenOrReuseRequest,
    type ScmPullRequestOpenOrReuseResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

describe('git RPC handlers (pull request open or reuse)', () => {
    it('routes open-or-reuse through the backend and enforces default-branch safety before provider mutation', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-pr-open-rpc-'));
        git(workspace, ['init', '-b', 'main']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);
        writeFileSync(join(workspace, 'base.txt'), 'base\n');
        git(workspace, ['add', 'base.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', 'https://github.com/happier-dev/happier.git']);
        writeFileSync(join(workspace, 'change.txt'), 'change\n');
        git(workspace, ['add', 'change.txt']);
        git(workspace, ['commit', '-m', 'change on default branch']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<ScmPullRequestOpenOrReuseResponse, ScmPullRequestOpenOrReuseRequest>(
            RPC_METHODS.SCM_PULL_REQUEST_OPEN_OR_REUSE,
            {
                cwd: '.',
                base: 'main',
                title: 'Change on default branch',
            },
        );

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
    });
});
