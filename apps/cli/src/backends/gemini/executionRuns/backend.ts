import { createCatalogProviderExecutionRunBackend } from '@/agent/runtime/bridges/executionRun/runtime/catalog';
import type { AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import {
    requireExecutionRunHostRuntime,
    type ExecutionRunHostRuntime,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { CreateCliExecutionRunBackendParams } from '@/agent/runtime/registry/engineRegistryTypes';
import type { PermissionMode } from '@/api/types';

import { createGeminiBackend } from '@/backends/gemini/acp/backend';

function normalizeNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

type GeminiExecutionRunLeafParams = Readonly<{
    cwd: string;
    env?: NodeJS.ProcessEnv;
    permissionHandler?: AcpPermissionHandler;
    permissionMode: PermissionMode;
    modelId?: string;
}>;

function createGeminiExecutionRunLeafRuntime(
    params: GeminiExecutionRunLeafParams,
): ExecutionRunHostRuntime {
    const selectedModel = normalizeNonEmptyString(params.modelId);

    return requireExecutionRunHostRuntime(
        createGeminiBackend({
            cwd: params.cwd,
            env: params.env,
            permissionHandler: params.permissionHandler,
            permissionMode: params.permissionMode,
            ...(selectedModel ? { model: selectedModel } : {}),
        }).backend,
        'Gemini execution-run backend must implement ExecutionRunHostRuntime',
    );
}

export function backend(
    params: CreateCliExecutionRunBackendParams,
): ExecutionRunHostRuntime {
    const selectedModel = normalizeNonEmptyString(params.modelId);

    return createCatalogProviderExecutionRunBackend({
        providerId: 'gemini',
        createRuntime: ({ cwd, env, permissionHandler, permissionMode }) =>
            createGeminiExecutionRunLeafRuntime({
                cwd,
                env,
                permissionHandler: permissionHandler ?? undefined,
                permissionMode,
                modelId: selectedModel,
            }),
    }, params);
}
