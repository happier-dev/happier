import { isAbsolute, resolve } from 'node:path';

import {
    SCM_OPERATION_ERROR_CODES,
    type ScmHostingRepositoryDescribePublishTargetsRequest,
    type ScmHostingRepositoryDescribePublishTargetsResponse,
    type ScmHostingRepositoryPublishRequest,
    type ScmHostingRepositoryPublishResponse,
    type ScmRepositoryCloneInput,
    type ScmRepositoryCloneOutput,
    type ScmRepositoryInitRequest,
    type ScmRepositoryInitResponse,
    type ScmRepositoryRemoveIndexLockRequest,
    type ScmRepositoryRemoveIndexLockResponse,
} from '@happier-dev/protocol';

import { resolveScmBackendRegistry } from '@/scm/scmBackendCatalog';
import type { ScmBackendRegistry } from '@/scm/registry';
import { runScmRoute } from '@/scm/rpc/dispatch';
import { resolveTildePath } from '@/scm/runtime';
import type { ScmBackend, ScmBackendContext } from '@/scm/types';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { validatePath } from '@/rpc/handlers/pathSecurity';

function hasUnsafeCloneParentPath(value: string): boolean {
    return value.includes('\0') || value.startsWith('~') || value.split(/[\\/]+/).includes('..');
}

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

function hostingRepositoryPublishUnsupportedResponse(message: string): ScmHostingRepositoryPublishResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: message,
    };
}

function hostingRepositoryDescribePublishTargetsUnsupportedResponse(
    message: string,
): ScmHostingRepositoryDescribePublishTargetsResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: message,
        remediation: {
            kind: 'unsupported_provider',
        },
    };
}

function repositoryCloneUnsupportedResponse(message: string): ScmRepositoryCloneOutput {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        error: message,
        remediation: {
            kind: 'unsupported_provider',
        },
    };
}

function findGitRepositoryInitBackend(registry: ScmBackendRegistry): ScmBackend | null {
    return registry.listBackends().find((backend) => backend.id === 'git' && backend.repositoryInit) ?? null;
}

function findGitRepositoryCloneBackend(registry: ScmBackendRegistry): ScmBackend | null {
    return registry.listBackends().find((backend) => backend.id === 'git' && backend.repositoryClone) ?? null;
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

export async function runScmRepositoryInitRoute(input: {
    request: ScmRepositoryInitRequest;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    registry?: ScmBackendRegistry;
}): Promise<ScmRepositoryInitResponse> {
    const registry = await resolveScmBackendRegistry(input.registry);
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

export async function runScmRepositoryCloneRoute(input: {
    request: ScmRepositoryCloneInput;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    registry?: ScmBackendRegistry;
}): Promise<ScmRepositoryCloneOutput> {
    const registry = await resolveScmBackendRegistry(input.registry);
    const normalizedWorkingDirectory = resolveTildePath(input.workingDirectory);
    if (
        !isAbsolute(input.request.destinationParentPath)
        || hasUnsafeCloneParentPath(input.request.destinationParentPath)
    ) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            error: 'Repository clone destination parent must be an absolute path without home expansion or traversal segments.',
        };
    }
    const destinationParent = validatePath(
        input.request.destinationParentPath,
        normalizedWorkingDirectory,
        [],
        input.accessPolicy,
    );
    if (!destinationParent.valid || !destinationParent.resolvedPath) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
            error: destinationParent.error ?? 'Repository clone destination parent is not allowed.',
        };
    }

    const gitBackend = findGitRepositoryCloneBackend(registry);
    if (!gitBackend?.repositoryClone) {
        return repositoryCloneUnsupportedResponse('Git repository clone is unavailable.');
    }

    return gitBackend.repositoryClone({
        context: createNonRepositoryGitContext({
            workingDirectory: normalizedWorkingDirectory,
            cwd: destinationParent.resolvedPath,
        }),
        request: {
            ...input.request,
            destinationParentPath: destinationParent.resolvedPath,
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
        registry: input.registry,
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

export function runScmHostingRepositoryPublishRoute(input: {
    request: ScmHostingRepositoryPublishRequest;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    registry?: ScmBackendRegistry;
}): Promise<ScmHostingRepositoryPublishResponse> {
    return runScmRoute<ScmHostingRepositoryPublishRequest, ScmHostingRepositoryPublishResponse>({
        request: input.request,
        workingDirectory: input.workingDirectory,
        accessPolicy: input.accessPolicy,
        registry: input.registry,
        onNonRepository: async () =>
            hostingRepositoryPublishUnsupportedResponse('The selected path is not a Git repository.'),
        runWithBackend: async ({ context, selection }) => {
            if (!selection.backend.hostingRepositoryPublish) {
                return hostingRepositoryPublishUnsupportedResponse(
                    `The selected backend "${selection.backend.id}" does not support hosting repository publishing.`,
                );
            }
            return selection.backend.hostingRepositoryPublish({
                context,
                request: input.request,
            });
        },
    });
}

export function runScmHostingRepositoryDescribePublishTargetsRoute(input: {
    request: ScmHostingRepositoryDescribePublishTargetsRequest;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    registry?: ScmBackendRegistry;
}): Promise<ScmHostingRepositoryDescribePublishTargetsResponse> {
    return runScmRoute<ScmHostingRepositoryDescribePublishTargetsRequest, ScmHostingRepositoryDescribePublishTargetsResponse>({
        request: input.request,
        workingDirectory: input.workingDirectory,
        accessPolicy: input.accessPolicy,
        registry: input.registry,
        onNonRepository: async () =>
            hostingRepositoryDescribePublishTargetsUnsupportedResponse('The selected path is not a Git repository.'),
        runWithBackend: async ({ context, selection }) => {
            if (!selection.backend.hostingRepositoryDescribePublishTargets) {
                return hostingRepositoryDescribePublishTargetsUnsupportedResponse(
                    `The selected backend "${selection.backend.id}" does not support hosting repository publish target discovery.`,
                );
            }
            return selection.backend.hostingRepositoryDescribePublishTargets({
                context,
                request: input.request,
            });
        },
    });
}
