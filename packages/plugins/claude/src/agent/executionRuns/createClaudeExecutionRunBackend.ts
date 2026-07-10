import type {
    CreateExecutionRunBackendParamsV1,
    ExecutionRunHostBackendV1,
    PluginContextV1,
    SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';
import { createExecutionRunHostBackendFromSessionRuntime } from '@happier-dev/plugin-sdk';
import { composeSessionIsolationEnvironment } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { createClaudeAgentSdkTurnOperations } from '../runtime/remote/sdk/session.js';
import { resolveClaudeExecutionRunPermissionPolicy } from './permissionPolicy.js';

function normalizeString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readEnv(params: CreateExecutionRunBackendParamsV1): Readonly<Record<string, string>> | undefined {
    return composeSessionIsolationEnvironment({
        isolationEnvironment: params.isolation?.env,
        environment: params.env,
        unsetEnvKeys: params.isolation?.unsetEnvKeys,
    });
}

function withExecutionRunSessionIdentity(runtime: SessionRuntimeV1, fallbackSessionId: string): SessionRuntimeV1 {
    return {
        ...runtime,
        identity: {
            read: () => {
                const identity = runtime.identity.read();
                return {
                    ...identity,
                    providerSessionId: normalizeString(identity.providerSessionId) ?? fallbackSessionId,
                };
            },
        },
    };
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

    return createExecutionRunHostBackendFromSessionRuntime({
        createSessionRuntime: () => withExecutionRunSessionIdentity(
            createClaudeAgentSdkTurnOperations({
                ctx: params.ctx,
                directory: cwd,
                launchEnv: readEnv(params.executionRunParams) ?? {},
                permissionMode: 'default',
                happierSessionId: sessionId,
                toolPermissionPolicy: resolveClaudeExecutionRunPermissionPolicy(params.executionRunParams.permissionMode),
                abortSignal: params.executionRunParams.signal,
                initialModelId: normalizeString(params.executionRunParams.modelId),
                publishSdkMessages: true,
            }),
            sessionId,
        ),
        // The fallback identity above is only a local routing id. Claude resume can be
        // enabled here only after the shared adapter can use Claude's emitted session_id
        // as the persisted provider identity without racing this fallback.
        readResumeSupport: async () => false,
        diagnostics: {
            source: 'claude-agent-sdk-execution-run',
        },
        waitForTurnCompletion: {
            mode: 'untilIdle',
        },
    });
}
