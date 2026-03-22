import { resolve } from 'path';

import type { ScmBackendPreference } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { defaultScmBackendRegistry } from '@/scm/defaultRegistry';
import type { ScmBackendRegistry } from '@/scm/registry';
import type { ScmBackendSelection } from '@/scm/registry';
import { resolveScmSelection } from '@/scm/resolveScmSelection';
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

        const resolved = await resolveScmSelection({
            workingDirectory: normalizedWorkingDirectory,
            cwd: cwdResult.cwd,
            backendPreference: input.request.backendPreference,
            registry: input.registry ?? defaultScmBackendRegistry,
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
