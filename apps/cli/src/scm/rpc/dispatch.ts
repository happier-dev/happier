import { resolve } from 'path';
import { runWithScmCommandOperation } from '../commandOperation';

import { createScmCapabilities } from '@happier-dev/protocol/scm/capabilities';
import type { ScmBackendPreference } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { projectScmBackendFailure } from '@happier-dev/plugin-sdk/scm/backend';

import { runWithScmBackendRegistryLease } from '@/scm/scmBackendCatalog';
import {
    resolveScmBackendById,
    type ScmBackendRegistry,
    type ScmBackendSelection,
} from '@/scm/registry';
import { resolveScmSelectionOutcome } from '@/scm/resolveScmSelection';
import { createNonRepositorySnapshot, resolveCwd, resolveTildePath } from '@/scm/runtime';
import type { ScmBackendContext } from '@/scm/types';
import {
    resolveFilesystemAccessPolicy,
    type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { authorizeFilesystemPath } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';

type ScmRequestBase = {
    cwd?: string;
    backendPreference?: ScmBackendPreference;
};

type ScmErrorResponse = {
    success: boolean;
    error?: string;
    errorCode?: string;
};

function invalidPathResponse<TResponse extends ScmErrorResponse>(error: string): TResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        error,
    } as TResponse;
}

function backendUnavailableResponse<TResponse extends ScmErrorResponse>(input: {
    requestedBackendId: string;
    selectedBackendId: string;
}): TResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE,
        error: `Requested backend "${input.requestedBackendId}" is unavailable for this repository (selected: "${input.selectedBackendId}").`,
    } as TResponse;
}

export function notRepositoryResponse<TResponse extends ScmErrorResponse>(
    message = 'The selected path is not a source-control repository.'
): TResponse {
    return {
        success: false,
        errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
        error: message,
    } as TResponse;
}

export async function runScmRoute<TRequest extends ScmRequestBase, TResponse extends ScmErrorResponse>(input: {
    request: TRequest;
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    onNonRepository: (args: { cwd: string; workingDirectory: string }) => Promise<TResponse> | TResponse;
    runWithBackend: (args: {
        context: ScmBackendContext;
        selection: ScmBackendSelection;
    }) => Promise<TResponse>;
    registry?: ScmBackendRegistry;
    signal?: AbortSignal;
}): Promise<TResponse> {
    try {
        if (input.signal?.aborted) throw new Error('SCM operation was aborted');
        const normalizedWorkingDirectory = resolveTildePath(input.workingDirectory);
        const cwdResult = resolveCwd(
            input.request.cwd,
            normalizedWorkingDirectory,
            input.accessPolicy ?? resolveFilesystemAccessPolicy(),
        );
        if (!cwdResult.ok) {
            return invalidPathResponse<TResponse>(cwdResult.error);
        }

        return await runWithScmCommandOperation(input.signal, () => runWithScmBackendRegistryLease(input.registry, async (registry) => {
            if (input.signal?.aborted) throw new Error('SCM operation was aborted');
            const outcome = await resolveScmSelectionOutcome({
                workingDirectory: normalizedWorkingDirectory,
                cwd: cwdResult.cwd,
                backendPreference: input.request.backendPreference,
                registry,
            });
            if (input.signal?.aborted) throw new Error('SCM operation was aborted');
            // `undetermined` means no backend could look, so the caller must not be handed the
            // domain fact "this is not a repository" (`F-SCM-1`). The detector's own carried code
            // makes this the source-control-unavailable surface rather than the non-repository one.
            if (outcome.kind === 'undetermined') {
                return projectScmBackendFailure(outcome.error) as TResponse;
            }
            if (outcome.kind === 'not_a_repository') {
                return await input.onNonRepository({
                    cwd: cwdResult.cwd,
                    workingDirectory: normalizedWorkingDirectory,
                });
            }
            const resolved = outcome;
            if (
                input.request.backendPreference?.kind === 'prefer'
                && resolveScmBackendById(
                    registry.listBackends(),
                    input.request.backendPreference.backendId,
                )?.id !== resolved.selection.backend.id
            ) {
                return backendUnavailableResponse<TResponse>({
                    requestedBackendId: input.request.backendPreference.backendId,
                    selectedBackendId: resolved.selection.backend.id,
                });
            }

            return await input.runWithBackend({
                context: Object.freeze({
                    ...resolved.context,
                    assertFilesystemPathAuthorized: (targetPath: string) => {
                        const target = authorizeFilesystemPath({
                            targetPath,
                            defaultDirectory: cwdResult.cwd,
                            accessPolicy: input.accessPolicy ?? resolveFilesystemAccessPolicy(),
                        });
                        if (!target.valid) {
                            throw Object.assign(new Error(target.error), { errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH });
                        }
                    },
                    ...(input.signal ? { signal: input.signal } : {}),
                }),
                selection: resolved.selection,
            });
        }));
    } catch (error) {
        return projectScmBackendFailure(error) as TResponse;
    }
}

export function createNonRepositoryScmSnapshotResponse(input: {
    workingDirectory: string;
    cwd: string;
    fetchedAt?: number;
}) {
    const snapshot = createNonRepositorySnapshot({
        projectKey: `${resolve(resolveTildePath(input.workingDirectory))}:${input.cwd}`,
        fetchedAt: input.fetchedAt ?? Date.now(),
    });

    return {
        success: true,
        snapshot: {
            ...snapshot,
            capabilities: createScmCapabilities({
                ...snapshot.capabilities,
                writeRepositoryInit: true,
            }),
        },
    };
}
