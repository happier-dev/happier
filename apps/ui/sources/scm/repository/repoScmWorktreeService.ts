import {
    SCM_OPERATION_ERROR_CODES,
    SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
    type ScmWorktree,
    type ScmWorktreeCreateResponse,
    type ScmWorktreePruneResponse,
    type ScmWorktreeRemoveResponse,
} from '@happier-dev/protocol';

import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';
import { machineScmWorktreeCreate, machineScmWorktreePrune, machineScmWorktreeRemove } from '@/sync/ops/scm/machineScm';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { generateWorktreeName } from '@/utils/worktree/generateWorktreeName';
import { resolveRepoScmMachinePathRequest } from './resolveRepoScmMachinePathRequest';

function normalizePath(value: unknown, homeDir?: string | null): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    return normalizeFileSystemPath(resolveAbsolutePath(value, homeDir || undefined));
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

function resolveRemoteNames(snapshot: ScmWorkingSnapshot | null): ReadonlyArray<string> {
    const names = new Set<string>();
    for (const remote of snapshot?.repo.remotes ?? []) {
        const name = remote.name.trim();
        if (name.length > 0) {
            names.add(name);
        }
    }

    return (names.size > 0 ? [...names] : ['origin'])
        .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function stripKnownRemotePrefix(branchName: string, remoteNames: ReadonlyArray<string>): string {
    for (const remoteName of remoteNames) {
        const prefix = `${remoteName}/`;
        if (branchName.startsWith(prefix) && branchName.length > prefix.length) {
            return branchName.slice(prefix.length);
        }
    }

    return branchName;
}

function worktreeBranchMatchesSelectedRef(params: Readonly<{
    worktreeBranch: string | null;
    selectedBranchName: string;
    remoteNames: ReadonlyArray<string>;
}>): boolean {
    if (params.worktreeBranch === params.selectedBranchName) {
        return true;
    }

    return params.worktreeBranch === stripKnownRemotePrefix(params.selectedBranchName, params.remoteNames);
}

export function findReusableRepoWorktreeForBranch(params: Readonly<{
    snapshot: ScmWorkingSnapshot | null;
    selectedBaseRef: string | null;
    currentBranch: string | null;
    currentPath: string | null;
    machineHomeDir?: string | null;
}>): ScmWorktree | null {
    const selectedBranchName = resolveSelectedBranchName(params);
    if (!selectedBranchName) {
        return null;
    }

    const currentPath = normalizePath(params.currentPath, params.machineHomeDir);
    const remoteNames = resolveRemoteNames(params.snapshot);
    for (const worktree of params.snapshot?.repo.worktrees ?? []) {
        const worktreePath = normalizePath(worktree.path, params.machineHomeDir);
        if (!worktreePath) {
            continue;
        }
        if (!worktreeBranchMatchesSelectedRef({
            worktreeBranch: worktree.branch,
            selectedBranchName,
            remoteNames,
        })) {
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
        serverId?: string | null;
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

        const worktreeRequest = {
            cwd: request.resolvedPath,
            displayName: input.displayName?.trim() || generateWorktreeName(),
            baseRef: input.baseRef?.trim() || undefined,
            branchMode: input.branchMode ?? 'new',
        };
        if (input.serverId) {
            return await machineScmWorktreeCreate(request.machineId, worktreeRequest, { serverId: input.serverId });
        }
        return await machineScmWorktreeCreate(request.machineId, worktreeRequest);
    }

    async removeWorktreeForMachinePath(input: Readonly<{
        serverId?: string | null;
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

        const worktreeRemoveRequest = {
            cwd: request.resolvedPath,
            worktreePath: input.worktreePath,
            confirmed: true as const,
            authorizationToken: SCM_WORKTREE_REMOVE_AUTHORIZATION_TOKEN,
        };
        return input.serverId
            ? await machineScmWorktreeRemove(request.machineId, worktreeRemoveRequest, { serverId: input.serverId })
            : await machineScmWorktreeRemove(request.machineId, worktreeRemoveRequest);
    }

    async pruneWorktreesForMachinePath(input: Readonly<{
        serverId?: string | null;
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

        const worktreePruneRequest = {
            cwd: request.resolvedPath,
        };
        return input.serverId
            ? await machineScmWorktreePrune(request.machineId, worktreePruneRequest, { serverId: input.serverId })
            : await machineScmWorktreePrune(request.machineId, worktreePruneRequest);
    }
}

export const repoScmWorktreeService = new RepoScmWorktreeService();
