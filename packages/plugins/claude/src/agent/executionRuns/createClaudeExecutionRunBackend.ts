import type {
    CreateExecutionRunBackendParamsV1,
    ExecutionRunHostBackendV1,
    PluginContextV1,
} from '@happier-dev/plugin-sdk';
import { createExecutionRunHostBackendFromTurnOperations } from '@happier-dev/plugin-sdk/internal/runtime/executionRun';

import { createClaudeAgentSdkTurnOperations } from '../runtime/remote/sdk/session.js';
import { resolveClaudeExecutionRunPermissionPolicy } from './permissionPolicy.js';

function normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readEnv(params: CreateExecutionRunBackendParamsV1): Readonly<Record<string, string>> | undefined {
    return params.isolation?.env ?? params.env;
}

export function createClaudeExecutionRunBackend(params: Readonly<{
    ctx: PluginContextV1;
    executionRunParams: CreateExecutionRunBackendParamsV1;
}>): ExecutionRunHostBackendV1 {
    const cwd = normalizeString(params.executionRunParams.cwd)
        ?? normalizeString(params.executionRunParams.directory)
        ?? '.';
    const runId = normalizeString(params.executionRunParams.runId) ?? 'default';
    const sessionId = `claude-execution-run:${runId}`;

    return createExecutionRunHostBackendFromTurnOperations({
        createOperations: () => createClaudeAgentSdkTurnOperations({
            ctx: params.ctx,
            directory: cwd,
            launchEnv: readEnv(params.executionRunParams) ?? {},
            permissionMode: 'default',
            happierSessionId: sessionId,
            toolPermissionPolicy: resolveClaudeExecutionRunPermissionPolicy(params.executionRunParams.permissionMode),
            abortSignal: params.executionRunParams.signal,
            publishSdkMessages: true,
        }),
        readResumeSupport: async (opts) => opts?.captureReplay === true ? false : true,
        diagnostics: {
            source: 'claude-agent-sdk-execution-run',
        },
    });
}
