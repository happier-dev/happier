import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    SCM_OPERATION_ERROR_CODES,
    type ScmRepositoryRemoveIndexLockRequest,
    type ScmRepositoryRemoveIndexLockResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { registerScmHandlers } from '@/rpc/handlers/scm';

function runGit(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function createScopedRpcManager(input: {
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
}) {
    const encryptionKey = new Uint8Array(32).fill(7);
    const encryptionVariant = 'legacy' as const;
    const scopePrefix = 'repository-remove-index-lock-test';
    const manager = new RpcHandlerManager({
        scopePrefix,
        encryptionKey,
        encryptionVariant,
        logger: () => undefined,
    });
    registerScmHandlers(manager, input.workingDirectory, {
        accessPolicy: input.accessPolicy,
    });

    async function call<TResponse, TRequest>(method: string, request: TRequest): Promise<TResponse> {
        const encryptedParams = encodeBase64(encrypt(encryptionKey, encryptionVariant, request));
        const rpcRequest: RpcRequest = {
            method: `${scopePrefix}:${method}`,
            params: encryptedParams,
        };
        const encryptedResponse = await manager.handleRequest(rpcRequest);
        const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(encryptedResponse));
        return decrypted as TResponse;
    }

    return { call };
}

function confirmedRequest(cwd: string): ScmRepositoryRemoveIndexLockRequest {
    return {
        cwd,
        confirmed: true,
        confirmationToken: 'remove-stale-index-lock',
    };
}

describe('git RPC handlers (remove index lock)', () => {
    it('removes an authorized repository index.lock through the canonical SCM RPC', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-remove-index-lock-rpc-'));
        runGit(workspace, ['init']);
        const lockPath = join(workspace, '.git', 'index.lock');
        writeFileSync(lockPath, 'stale lock');
        const { call } = createScopedRpcManager({
            workingDirectory: workspace,
            accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
        });

        const response = await call<ScmRepositoryRemoveIndexLockResponse, ScmRepositoryRemoveIndexLockRequest>(
            RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
            confirmedRequest(workspace),
        );

        expect(response).toMatchObject({
            success: true,
            removed: true,
            reason: 'removed',
        });
        expect(existsSync(lockPath)).toBe(false);
    });

    it('rejects unauthorized cwd before attempting unlink', async () => {
        const suiteDir = mkdtempSync(join(tmpdir(), 'happier-git-remove-index-lock-rpc-'));
        const workspace = join(suiteDir, 'workspace');
        const outside = join(suiteDir, 'outside');
        mkdirSync(workspace, { recursive: true });
        mkdirSync(outside, { recursive: true });
        runGit(outside, ['init']);
        const outsideLock = join(outside, '.git', 'index.lock');
        writeFileSync(outsideLock, 'do not remove');
        const { call } = createScopedRpcManager({
            workingDirectory: workspace,
            accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
        });

        const response = await call<ScmRepositoryRemoveIndexLockResponse, ScmRepositoryRemoveIndexLockRequest>(
            RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
            confirmedRequest(outside),
        );

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        });
        expect(existsSync(outsideLock)).toBe(true);
    });

    it('reports Sapling as unsupported for index-lock removal without unlinking', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-remove-index-lock-rpc-'));
        runGit(workspace, ['init']);
        const lockPath = join(workspace, '.git', 'index.lock');
        writeFileSync(lockPath, 'do not remove');
        const { call } = createScopedRpcManager({ workingDirectory: workspace });

        const response = await call<ScmRepositoryRemoveIndexLockResponse, ScmRepositoryRemoveIndexLockRequest>(
            RPC_METHODS.SCM_REPOSITORY_REMOVE_INDEX_LOCK,
            {
                ...confirmedRequest(workspace),
                backendPreference: {
                    kind: 'prefer',
                    backendId: 'sapling',
                },
            },
        );

        expect(response.success).toBe(false);
        if (!response.success) {
            expect([
                SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
                SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            ]).toContain(response.errorCode);
        }
        expect(existsSync(lockPath)).toBe(true);
    });
});
