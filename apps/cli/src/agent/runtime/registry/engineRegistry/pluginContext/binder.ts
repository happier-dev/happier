import type { TerminalRuntimeHostOrchestrationV1 } from '@happier-dev/agents';
import type { PluginContextV1, PluginDisposable } from '@happier-dev/plugin-sdk';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { TranscriptSessionPort } from '@/api/session/transcriptPort';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import type { ExecutionRunSessionStateTarget } from '@/agent/runtime/bridges/executionRun/sessionStateDelivery';

export const PLUGIN_CONTEXT_V1_BINDER = Symbol('happier.pluginContextV1.binder');

export type BoundContextScope =
    | Readonly<{
        kind: 'hostSession';
        serverId: string;
        machineId: string;
        rootPath: string;
        getSession: () => ApiSessionClient;
        getTranscriptSession: () => TranscriptSessionPort;
        messageQueue?: HostSessionRuntimeFactoryParams['messageQueue'];
        getPermissionHandler: () => ProviderEnforcedPermissionHandler;
        getPermissionMode: () => unknown;
    }>
    | Readonly<{
        kind: 'executionRun';
        runId: string | null;
        permissionMode: string;
        rootPath: string | null;
        parentSessionStateTarget: ExecutionRunSessionStateTarget | null;
        permissionHandler: ReturnType<typeof createExecutionRunPermissionHandler>;
    }>;

export type HostSessionContextScope = Extract<BoundContextScope, Readonly<{ kind: 'hostSession' }>>;
export type ExecutionRunContextScope = Extract<BoundContextScope, Readonly<{ kind: 'executionRun' }>>;

export type PluginContextV1Binder = Readonly<{
    bindHostSessionRuntime: (params: HostSessionRuntimeFactoryParams) => HostSessionContextScope;
    resolveTerminalRuntimeHostOrchestration: (sessionId: string) => TerminalRuntimeHostOrchestrationV1 | null;
    bindExecutionRun: (params: Readonly<{
        runId?: string | null;
        permissionMode?: string | null;
        rootPath?: string | null;
        parentSessionStateTarget?: ExecutionRunSessionStateTarget | null;
    }>) => ExecutionRunContextScope;
    grantExternalSessionTranscriptPath: (request: Readonly<{
        path: string;
        sourceId: string;
        sessionId?: string | null;
    }>) => Promise<void>;
    revokeTranscriptFileFollowScope: (scope: Readonly<{ sessionId?: string | null }>) => Promise<void>;
    runWithTranscriptFileFollowSession: <T>(sessionId: string | null, fn: () => Promise<T>) => Promise<T>;
    runWithScope: <T>(scope: BoundContextScope, fn: () => T) => T;
}>;

export function readPluginContextV1Binder(ctx: PluginContextV1): PluginContextV1Binder | null {
    const record = ctx as unknown as Record<PropertyKey, unknown>;
    const binder = record[PLUGIN_CONTEXT_V1_BINDER];
    return binder && typeof binder === 'object' ? (binder as PluginContextV1Binder) : null;
}

export function hasRuntimeDisposableRegistrar(
    value: unknown,
): value is Readonly<{ addRuntimeDisposable: (pluginId: string, disposable: PluginDisposable) => PluginDisposable }> {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && typeof (value as { addRuntimeDisposable?: unknown }).addRuntimeDisposable === 'function';
}
