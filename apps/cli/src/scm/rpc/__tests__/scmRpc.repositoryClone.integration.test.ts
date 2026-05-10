import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    SCM_OPERATION_ERROR_CODES,
    type ScmRepositoryCloneInput,
    type ScmRepositoryCloneOutput,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

import { createTestRpcManager } from './testRpcHarness';

function makeCloneRequest(parent: string): ScmRepositoryCloneInput {
    return {
        provider: {
            id: 'github:github.com',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
            urlSafety: { allowedSchemes: ['https:'] },
        },
        repository: {
            nameWithOwner: 'happier-dev/happier',
            webUrl: 'https://github.com/happier-dev/happier',
            cloneUrl: 'https://github.com/happier-dev/happier.git',
            visibility: 'public',
            defaultBranch: 'main',
        },
        destinationParentPath: parent,
        destinationDirectoryName: 'happier',
        protocol: 'https',
        confirmed: true,
        authorizationToken: 'clone-repository',
    };
}

describe('git RPC handlers (repository clone)', () => {
    it('registers repository clone and rejects conflicting destination contents before cloning', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-clone-rpc-'));
        const destination = join(workspace, 'happier');
        mkdirSync(destination);
        writeFileSync(join(destination, 'existing.txt'), 'keep\n');
        const { call } = createTestRpcManager({ workingDirectory: workspace });

        const response = await call<ScmRepositoryCloneOutput, ScmRepositoryCloneInput>(
            RPC_METHODS.SCM_REPOSITORY_CLONE,
            makeCloneRequest(workspace),
        );

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        });
        expect(existsSync(join(destination, 'existing.txt'))).toBe(true);
        expect(existsSync(join(destination, '.git'))).toBe(false);
    });

    it('rejects home-expanded destination parents before filesystem authorization', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-clone-rpc-'));
        const { call } = createTestRpcManager({ workingDirectory: workspace });

        const response = await call<ScmRepositoryCloneOutput, ScmRepositoryCloneInput>(
            RPC_METHODS.SCM_REPOSITORY_CLONE,
            {
                ...makeCloneRequest(workspace),
                destinationParentPath: '~/Code',
            },
        );

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        });
        expect(existsSync(join(workspace, '~'))).toBe(false);
    });
});
