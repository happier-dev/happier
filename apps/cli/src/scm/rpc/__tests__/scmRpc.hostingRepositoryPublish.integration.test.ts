import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    SCM_OPERATION_ERROR_CODES,
    type ScmHostingRepositoryDescribePublishTargetsRequest,
    type ScmHostingRepositoryDescribePublishTargetsResponse,
    type ScmHostingRepositoryPublishRequest,
    type ScmHostingRepositoryPublishResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

describe('git RPC handlers (hosting repository publish)', () => {
    it('registers publish-target discovery as an RPC action', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-hosting-targets-nonrepo-'));

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<ScmHostingRepositoryDescribePublishTargetsResponse, ScmHostingRepositoryDescribePublishTargetsRequest>(
            RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS,
            {
                cwd: '.',
                providerKind: 'github',
            },
        );

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        });
    });

    it('returns commit-required before provider or remote mutation when empty history push is requested', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-empty-'));
        git(workspace, ['init', '-b', 'main']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<ScmHostingRepositoryPublishResponse, ScmHostingRepositoryPublishRequest>(
            RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
            {
                cwd: '.',
                providerKind: 'github',
                owner: 'happier-dev',
                repositoryName: 'empty-history',
                visibility: 'private',
                remoteName: 'origin',
                pushCurrentBranch: true,
            },
        );

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
            remediation: { kind: 'commit_required' },
        });
        expect(git(workspace, ['remote'])).toBe('');
    });
});
