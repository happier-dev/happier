import {
    SCM_OPERATION_ERROR_CODES,
    type ScmWorktree,
    type ScmWorktreeCreateResponse,
    type ScmWorktreePruneResponse,
    type ScmWorktreeRemoveResponse,
} from '@happier-dev/protocol';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { machineScmWorktreeCreate, machineScmWorktreePrune, machineScmWorktreeRemove } from '@/sync/ops/scm/machineScm';
import { generateWorktreeName } from '@/utils/worktree/generateWorktreeName';
import { resolveRepoScmMachinePathRequest } from './resolveRepoScmMachinePathRequest';

function normalizePath(value: unknown): string | null {
    return normalizeFileSystemPath(value);
}

function isPathAtOrWithinWorktree(path: string | null, worktreePath: string | null): boolean {
    if (!path || !worktreePath) {
        return false;
    }

    if (path === worktreePath) {
        return true;
    }

    return path.startsWith(`${worktreePath}/`);
}

function resolveSelectedBranchName(params: Readonly<{
    selectedBaseRef: string | null;
    currentBranch: string | null;
}>): string | null {
    return params.selectedBaseRef?.trim() || params.currentBranch?.trim() || null;
}

export function findReusableRepoWorktreeForBranch(params: Readonly<{
    snapshot: ScmWorkingSnapshot | null;
    selectedBaseRef: string | null;
    currentBranch: string | null;
    currentPath: string | null;
}>): ScmWorktree | null {
    const selectedBranchName = resolveSelectedBranchName(params);
    if (!selectedBranchName) {
        return null;
    }

    const currentPath = normalizePath(params.currentPath);
    for (const worktree of params.snapshot?.repo.worktrees ?? []) {
        const worktreePath = normalizePath(worktree.path);
        if (!worktreePath) {
            continue;
        }
        if (worktree.branch !== selectedBranchName) {
            continue;
        }
        if (isPathAtOrWithinWorktree(currentPath, worktreePath)) {
            continue;
        }
        return worktree;
    }

    return null;
}

export class RepoScmWorktreeService {
    async createWorktreeForMachinePath(input: Readonly<{
        machineId: string;
        path: string;
        displayName?: string | null;
        baseRef?: string | null;
        branchMode?: 'new' | 'existing';
    }>): Promise<ScmWorktreeCreateResponse> {
        const request = resolveRepoScmMachinePathRequest({ machineId: input.machineId, path: input.path });
        if (!request) {
            return {
                success: false,
                worktreePath: '',
                branchName: '',
                error: 'Invalid worktree request',
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            };
        }

        return await machineScmWorktreeCreate(request.machineId, {
            cwd: request.resolvedPath,
            displayName: input.displayName?.trim() || generateWorktreeName(),
            baseRef: input.baseRef?.trim() || undefined,
            branchMode: input.branchMode ?? 'new',
        });
    }

    async removeWorktreeForMachinePath(input: Readonly<{
        machineId: string;
        path: string;
        worktreePath: string;
    }>): Promise<ScmWorktreeRemoveResponse> {
        const request = resolveRepoScmMachinePathRequest({ machineId: input.machineId, path: input.path });
        if (!request) {
            return {
                success: false,
                stdout: '',
                stderr: 'Invalid worktree request',
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            };
        }

        return await machineScmWorktreeRemove(request.machineId, {
            cwd: request.resolvedPath,
            worktreePath: input.worktreePath,
        });
    }

    async pruneWorktreesForMachinePath(input: Readonly<{
        machineId: string;
        path: string;
    }>): Promise<ScmWorktreePruneResponse> {
        const request = resolveRepoScmMachinePathRequest({ machineId: input.machineId, path: input.path });
        if (!request) {
            return {
                success: false,
                stdout: '',
                stderr: 'Invalid worktree request',
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
            };
        }

        return await machineScmWorktreePrune(request.machineId, {
            cwd: request.resolvedPath,
        });
    }
}

export const repoScmWorktreeService = new RepoScmWorktreeService();
