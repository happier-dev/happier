import { resolve } from 'node:path';

import {
    SCM_OPERATION_ERROR_CODES,
    type ScmRepositoryInitRequest,
    type ScmRepositoryInitResponse,
    type ScmRepositoryRemoveIndexLockRequest,
    type ScmRepositoryRemoveIndexLockResponse,
} from '@happier-dev/protocol';

import { defaultScmBackendRegistry } from '@/scm/scmBackendCatalog';
import type { ScmBackendRegistry } from '@/scm/registry';
import { runScmRoute } from '@/scm/rpc/dispatch';
import { resolveTildePath } from '@/scm/runtime';
import type { ScmBackend, ScmBackendContext } from '@/scm/types';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

function repositoryInitUnsupportedResponse(message: string): ScmRepositoryInitResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: message,
    };
}

function repositoryInitBackendUnavailableResponse(message: string): ScmRepositoryInitResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
        error: message,
    };
}

function removeIndexLockUnsupportedResponse(message: string): ScmRepositoryRemoveIndexLockResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: message,
    };
}

function findGitRepositoryInitBackend(registry: ScmBackendRegistry): ScmBackend | null {
    return registry.listBackends().find((backend) => backend.id === 'git' && backend.repositoryInit) ?? null;
}

function createNonRepositoryGitContext(input: {
    workingDirectory: string;
    cwd: string;
}): ScmBackendContext {
    return {
        cwd: input.cwd,
        projectKey: `${resolve(resolveTildePath(input.workingDirectory))}:${input.cwd}`,
        detection: {
            isRepo: false,
            rootPath: null,
            mode: null,
        },
    };
}

export function runScmRepositoryInitRoute(input: {
    request: ScmRepositoryInitRequest;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    registry?: ScmBackendRegistry;
}): Promise<ScmRepositoryInitResponse> {
    const registry = input.registry ?? defaultScmBackendRegistry;
    return runScmRoute<ScmRepositoryInitRequest, ScmRepositoryInitResponse>({
        request: input.request,
        workingDirectory: input.workingDirectory,
        accessPolicy: input.accessPolicy,
        registry,
        onNonRepository: async ({ cwd, workingDirectory }) => {
            const preferredBackendId = input.request.backendPreference?.kind === 'prefer'
                ? input.request.backendPreference.backendId
                : null;
            if (preferredBackendId && preferredBackendId !== 'git') {
                return repositoryInitUnsupportedResponse(
                    `The selected backend "${preferredBackendId}" does not support repository initialization.`,
                );
            }

            const gitBackend = findGitRepositoryInitBackend(registry);
            if (!gitBackend?.repositoryInit) {
                return repositoryInitBackendUnavailableResponse(
                    'Git repository initialization is unavailable.',
                );
            }

            return gitBackend.repositoryInit({
                context: createNonRepositoryGitContext({ workingDirectory, cwd }),
                request: input.request,
            });
        },
        runWithBackend: async ({ context, selection }) => {
            if (!selection.backend.repositoryInit) {
                return repositoryInitUnsupportedResponse(
                    `The selected backend "${selection.backend.id}" does not support repository initialization.`,
                );
            }
            return selection.backend.repositoryInit({
                context,
                request: input.request,
            });
        },
    });
}

export function runScmRepositoryRemoveIndexLockRoute(input: {
    request: ScmRepositoryRemoveIndexLockRequest;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    registry?: ScmBackendRegistry;
}): Promise<ScmRepositoryRemoveIndexLockResponse> {
    return runScmRoute<ScmRepositoryRemoveIndexLockRequest, ScmRepositoryRemoveIndexLockResponse>({
        request: input.request,
        workingDirectory: input.workingDirectory,
        accessPolicy: input.accessPolicy,
        registry: input.registry ?? defaultScmBackendRegistry,
        onNonRepository: async () =>
            removeIndexLockUnsupportedResponse('The selected path is not a Git repository.'),
        runWithBackend: async ({ context, selection }) => {
            if (!selection.backend.removeIndexLock) {
                return removeIndexLockUnsupportedResponse(
                    `The selected backend "${selection.backend.id}" does not support stale Git index-lock removal.`,
                );
            }
            return selection.backend.removeIndexLock({
                context,
                request: input.request,
            });
        },
    });
}
