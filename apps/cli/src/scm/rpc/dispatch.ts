import { resolve } from 'path';

import type { ScmBackendPreference } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { createScmBackendCatalog } from '@/scm/backends/catalog';
import { createScmBackendRegistry, type ScmBackendSelection } from '@/scm/registry';
import { createNonRepositorySnapshot, resolveCwd, resolveTildePath } from '@/scm/runtime';
import type { ScmBackendContext } from '@/scm/types';

type ScmRequestBase = {
    cwd?: string;
    backendPreference?: ScmBackendPreference;
};

type ScmErrorResponse = {
    success: boolean;
    error?: string;
    errorCode?: string;
};

type ScmSelectionResult = {
    selection: ScmBackendSelection;
    context: ScmBackendContext;
};

type ScmBackendRegistry = ReturnType<typeof createScmBackendRegistry>;

const scmRegistry: ScmBackendRegistry = createScmBackendRegistry(createScmBackendCatalog());

function fallbackError<TResponse extends ScmErrorResponse>(error: unknown): TResponse {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
        success: false,
        error: message,
        errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
    } as TResponse;
}

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

async function resolveSelection(input: {
    workingDirectory: string;
    cwd: string;
    backendPreference?: ScmBackendPreference;
    registry: ScmBackendRegistry;
}): Promise<ScmSelectionResult | null> {
    const selection = await input.registry.selectBackend({
        cwd: input.cwd,
        workingDirectory: input.workingDirectory,
        backendPreference: input.backendPreference,
    });
    if (!selection) return null;
    return {
        selection,
        context: {
            cwd: input.cwd,
            projectKey: `${resolve(input.workingDirectory)}:${input.cwd}`,
            detection: selection.detection,
        } satisfies ScmBackendContext,
    };
}

export async function runScmRoute<TRequest extends ScmRequestBase, TResponse extends ScmErrorResponse>(input: {
    request: TRequest;
    workingDirectory: string;
    onNonRepository: (args: { cwd: string; workingDirectory: string }) => Promise<TResponse> | TResponse;
    runWithBackend: (args: {
        context: ScmBackendContext;
        selection: ScmBackendSelection;
    }) => Promise<TResponse>;
    registry?: ScmBackendRegistry;
}): Promise<TResponse> {
    try {
        const normalizedWorkingDirectory = resolveTildePath(input.workingDirectory);
        const cwdResult = resolveCwd(input.request.cwd, normalizedWorkingDirectory);
        if (!cwdResult.ok) {
            return invalidPathResponse<TResponse>(cwdResult.error);
        }

        const resolved = await resolveSelection({
            workingDirectory: normalizedWorkingDirectory,
            cwd: cwdResult.cwd,
            backendPreference: input.request.backendPreference,
            registry: input.registry ?? scmRegistry,
        });
        if (!resolved) {
            return await input.onNonRepository({
                cwd: cwdResult.cwd,
                workingDirectory: normalizedWorkingDirectory,
            });
        }
        if (
            input.request.backendPreference?.kind === 'prefer'
            && resolved.selection.backend.id !== input.request.backendPreference.backendId
        ) {
            return backendUnavailableResponse<TResponse>({
                requestedBackendId: input.request.backendPreference.backendId,
                selectedBackendId: resolved.selection.backend.id,
            });
        }

        return await input.runWithBackend({
            context: resolved.context,
            selection: resolved.selection,
        });
    } catch (error) {
        return fallbackError<TResponse>(error);
    }
}

export function createNonRepositoryScmSnapshotResponse(input: {
    workingDirectory: string;
    cwd: string;
    fetchedAt?: number;
}) {
    return {
        success: true,
        snapshot: createNonRepositorySnapshot({
            projectKey: `${resolve(resolveTildePath(input.workingDirectory))}:${input.cwd}`,
            fetchedAt: input.fetchedAt ?? Date.now(),
        }),
    };
}
