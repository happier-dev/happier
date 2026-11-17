import { isAbsolute, resolve } from 'node:path';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { ScmRepositoryCloneInputSchema } from '@happier-dev/protocol';
import type { WorkspaceManifest } from '@happier-dev/protocol';
import type { SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import type { ScmHostingRepositoryDescribePublishTargetsRequest, ScmHostingRepositoryDescribePublishTargetsResponse, ScmHostingRepositoryPublishRequest, ScmHostingRepositoryPublishResponse, ScmRepositoryCloneInput, ScmRepositoryCloneOutput, ScmRepositoryInitRequest, ScmRepositoryInitResponse, ScmRepositoryRemoveIndexLockRequest, ScmRepositoryRemoveIndexLockResponse } from '@happier-dev/protocol';

import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';
import { resolveScmBackendById, type ScmBackendRegistry } from '@/scm/registry';
import { runScmRoute } from '@/scm/rpc/dispatch';
import { resolveTildePath } from '@/scm/runtime';
import type { ScmBackend, ScmBackendContext } from '@/scm/types';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { validatePath } from '@/rpc/handlers/pathSecurity';
import { normalizeScmOperationOutcome } from '@happier-dev/protocol/scm/operationOutcome';
import { observeCloneInitialCheckout } from './repositoryCloneInitialCheckout';
import type { ManagedSessionTarget } from '@/machines/managed/acquire';
import { runWithHolderWorkspaceSource } from '@/workspaces/source/holderWorkspaceSource';
import { resolveWorkspaceReplicationSourceInputsWithScmWorkspace } from '@/scm/workspace/workspaceTransferResolution';
import { buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries } from '@/scm/workspace/workspaceExportPackaging/artifacts/fromTransferEntries';

/** Finite pre-Session clone through the existing SCM owner on the admitted target. */
export async function materializeManagedProjectClone(input: Readonly<{
    target: Pick<ManagedSessionTarget, 'id' | 'holderPath' | 'helperPath' | 'openChannel' | 'exec'>;
    selection: Extract<SessionProjectFilesV1, { kind: 'git_clone' }>;
    destinationParentPath: string;
    destinationDirectoryName: string;
    registry?: ScmBackendRegistry;
    signal: AbortSignal;
}>): Promise<Readonly<{ targetRoot: string; baseline?: WorkspaceManifest }>> {
    const request = ScmRepositoryCloneInputSchema.parse({
        ...input.selection.source,
        protocol: 'https',
        initialCheckout: { branch: input.selection.branch },
        authentication: 'connected_account',
        destinationParentPath: input.destinationParentPath,
        destinationDirectoryName: input.destinationDirectoryName,
        confirmed: true,
        authorizationToken: 'clone-repository',
    });
    input.signal.throwIfAborted();
    const prepared = await input.target.exec(`umask 077; mkdir -p ${safeBashSingleQuote(request.destinationParentPath)}`, input.signal);
    if (prepared.status !== 0) throw new PluginError({ code: 'workspace_source_operation_unavailable',
        message: 'The target clone parent could not be prepared', retryable: false });
    return await runWithHolderWorkspaceSource({ target: input.target, rootPath: request.destinationParentPath, signal: input.signal }, async () => {
        const result = await runScmRepositoryCloneRoute({ request,
            workingDirectory: request.destinationParentPath, registry: input.registry, signal: input.signal });
        if (!result.success) throw new PluginError({ code: result.errorCode ?? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            message: result.error ?? 'The target repository could not be cloned', retryable: false });
        const transfer = await resolveWorkspaceReplicationSourceInputsWithScmWorkspace({ sourcePath: result.destinationPath,
            workspaceTransfer: { includeIgnoredMode: 'exclude', ignoredIncludeGlobs: [] }, registry: input.registry });
        const built = await buildWorkspaceExportArtifactsWithSourcePathBlobProviderFromTransferEntries({ entries: transfer.entries });
        try { return { targetRoot: result.destinationPath, baseline: built.manifest }; }
        finally { await built.blobProvider.dispose?.(); }
    });
}

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
        outcome: normalizeScmOperationOutcome({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED, error: message }),
        remediation: {
            kind: 'unsupported_provider',
        },
    };
}

function isGitBackend(backend: ScmBackend): boolean {
    return backend.kind === 'git' || (!backend.kind && backend.id === 'git');
}

function supportsProvisioningOperation(
    backend: ScmBackend,
    operation: 'init' | 'clone' | 'describePublishTargets',
): boolean {
    if (operation === 'describePublishTargets') {
        return typeof backend.hostingRepositoryDescribePublishTargets === 'function';
    }
    const declared = backend.declaredCapabilities?.lifecycle?.[operation];
    return declared
        ? declared.support !== 'unsupported'
        : operation === 'init'
            ? typeof backend.repositoryInit === 'function'
            : typeof backend.repositoryClone === 'function';
}

function findGitRepositoryProvisioningBackend(
    registry: ScmBackendRegistry,
    operation: 'init' | 'clone' | 'describePublishTargets',
    preferredBackendId?: string | null,
): ScmBackend | null {
    const candidates = registry.listBackends().filter((backend) => (
        isGitBackend(backend)
        && supportsProvisioningOperation(backend, operation)
    ));
    if (preferredBackendId) {
        const preferredBackend = resolveScmBackendById(
            registry.listBackends(),
            preferredBackendId,
        );
        return preferredBackend && candidates.some((backend) => backend.id === preferredBackend.id)
            ? preferredBackend
            : null;
    }

    return candidates
        .slice()
        .sort((left, right) => (
            (right.selection.modeSelectionScores['.git'] ?? 0)
            - (left.selection.modeSelectionScores['.git'] ?? 0)
        ))[0] ?? null;
}

function createNonRepositoryGitContext(input: {
    workingDirectory: string;
    cwd: string;
    signal?: AbortSignal;
}): ScmBackendContext {
    return {
        cwd: input.cwd,
        projectKey: `${resolve(resolveTildePath(input.workingDirectory))}:${input.cwd}`,
        detection: {
            isRepo: false,
            rootPath: null,
            mode: null,
        },
        ...(input.signal ? { signal: input.signal } : {}),
    };
}

export async function runScmRepositoryInitRoute(input: {
    request: ScmRepositoryInitRequest;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    registry?: ScmBackendRegistry;
    signal?: AbortSignal;
}): Promise<ScmRepositoryInitResponse> {
    if (input.signal?.aborted) throw new Error('SCM operation was aborted');
    return runWithScmBackendRegistryLease(input.registry, async (registry) => {
        if (input.signal?.aborted) throw new Error('SCM operation was aborted');
        return runScmRoute<ScmRepositoryInitRequest, ScmRepositoryInitResponse>({
            request: input.request,
            workingDirectory: input.workingDirectory,
            accessPolicy: input.accessPolicy,
            registry,
            signal: input.signal,
            onNonRepository: async ({ cwd, workingDirectory }) => {
                const preferredBackendId = input.request.backendPreference?.kind === 'prefer'
                    ? input.request.backendPreference.backendId
                    : null;
                const gitBackend = findGitRepositoryProvisioningBackend(
                    registry,
                    'init',
                    preferredBackendId,
                );
                if (!gitBackend?.repositoryInit) {
                    return preferredBackendId
                        ? repositoryInitUnsupportedResponse(
                            `The selected backend "${preferredBackendId}" does not support repository initialization.`,
                        )
                        : repositoryInitBackendUnavailableResponse(
                            'Git repository initialization is unavailable.',
                        );
                }

                return gitBackend.repositoryInit({
                    context: createNonRepositoryGitContext({ workingDirectory, cwd, signal: input.signal }),
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
    });
}

export async function runScmRepositoryCloneRoute(input: {
    request: ScmRepositoryCloneInput;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    registry?: ScmBackendRegistry;
    signal?: AbortSignal;
}): Promise<ScmRepositoryCloneOutput> {
    if (input.signal?.aborted) throw new Error('SCM operation was aborted');
    return runWithScmBackendRegistryLease(input.registry, async (registry) => {
        if (input.signal?.aborted) throw new Error('SCM operation was aborted');
        const normalizedWorkingDirectory = resolveTildePath(input.workingDirectory);
        if (
            !isAbsolute(input.request.destinationParentPath)
            || hasUnsafeCloneParentPath(input.request.destinationParentPath)
        ) {
            return {
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
                error: 'Repository clone destination parent must be an absolute path without home expansion or traversal segments.',
                outcome: normalizeScmOperationOutcome({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH }),
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
                outcome: normalizeScmOperationOutcome({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH }),
            };
        }

        const gitBackend = findGitRepositoryProvisioningBackend(registry, 'clone');
        if (!gitBackend?.repositoryClone) {
            return repositoryCloneUnsupportedResponse('Git repository clone is unavailable.');
        }

        const clone = await gitBackend.repositoryClone({
            context: createNonRepositoryGitContext({
                workingDirectory: normalizedWorkingDirectory,
                cwd: destinationParent.resolvedPath,
                signal: input.signal,
            }),
            request: {
                ...input.request,
                destinationParentPath: destinationParent.resolvedPath,
            },
        });
        return clone.success && input.request.initialCheckout
            ? observeCloneInitialCheckout(input.request.initialCheckout, clone) : clone;
    });
}

export function runScmRepositoryRemoveIndexLockRoute(input: {
    request: ScmRepositoryRemoveIndexLockRequest;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    registry?: ScmBackendRegistry;
    signal?: AbortSignal;
}): Promise<ScmRepositoryRemoveIndexLockResponse> {
    return runScmRoute<ScmRepositoryRemoveIndexLockRequest, ScmRepositoryRemoveIndexLockResponse>({
        request: input.request,
        workingDirectory: input.workingDirectory,
        accessPolicy: input.accessPolicy,
        registry: input.registry,
        signal: input.signal,
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
    signal?: AbortSignal;
}): Promise<ScmHostingRepositoryPublishResponse> {
    return runScmRoute<ScmHostingRepositoryPublishRequest, ScmHostingRepositoryPublishResponse>({
        request: input.request,
        workingDirectory: input.workingDirectory,
        accessPolicy: input.accessPolicy,
        registry: input.registry,
        signal: input.signal,
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
    signal?: AbortSignal;
}): Promise<ScmHostingRepositoryDescribePublishTargetsResponse> {
    return runWithScmBackendRegistryLease(input.registry, async (registry) => runScmRoute<ScmHostingRepositoryDescribePublishTargetsRequest, ScmHostingRepositoryDescribePublishTargetsResponse>({
        request: input.request,
        workingDirectory: input.workingDirectory,
        accessPolicy: input.accessPolicy,
        registry,
        signal: input.signal,
        onNonRepository: async ({ cwd, workingDirectory }) => {
            const backend = findGitRepositoryProvisioningBackend(registry, 'describePublishTargets',
                input.request.backendPreference?.kind === 'prefer' ? input.request.backendPreference.backendId : null);
            if (!backend?.hostingRepositoryDescribePublishTargets) {
                return hostingRepositoryDescribePublishTargetsUnsupportedResponse('Git hosting repository publish target discovery is unavailable.');
            }
            return backend.hostingRepositoryDescribePublishTargets({
                context: createNonRepositoryGitContext({ workingDirectory, cwd, signal: input.signal }),
                request: input.request,
            });
        },
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
    }));
}
