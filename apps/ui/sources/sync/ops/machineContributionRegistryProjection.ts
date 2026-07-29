import {
    DaemonContributionRegistryProjectionDescribeRequestSchema,
    DaemonPluginSettingsGetRequestSchema,
    DaemonPluginSettingsGetResponseSchema,
    DaemonPluginSettingsSetRequestSchema,
    DaemonPluginSettingsSetResponseSchema,
    DaemonPluginStructuredMessageResolveRequestSchema,
    DaemonPluginStructuredMessageResolveResponseSchema,
    DaemonPluginStructuredMessageActionExecuteRequestSchema,
    DaemonPluginStructuredMessageActionExecuteResponseSchema,
    type DaemonPluginSettingsSnapshot,
    type DaemonPluginStructuredMessageResolveRequest,
    type DaemonPluginStructuredMessageResolveResponse,
    type DaemonPluginStructuredMessageActionExecuteRequest,
    type DaemonPluginStructuredMessageActionExecuteResponse,
} from '@happier-dev/protocol';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import {
    parseDaemonContributionRegistryProjectionDescribeResponse,
    type DaemonContributionRegistryProjection,
} from '@/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import {
    resolveNativeReactNativeHostRuntimeIdentity,
    resolveReactNativeWebLoaderCapability,
} from '@/components/plugins/reactNative/hostRuntimeIdentity';

export type MachineContributionRegistryProjectionDescribeResult =
    | Readonly<{ supported: true; projection: DaemonContributionRegistryProjection }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' }>;

export type MachinePluginSettingsResult =
    | Readonly<{ supported: true; snapshot: DaemonPluginSettingsSnapshot }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' }>;

export type MachinePluginStructuredMessageResolveResult =
    | Readonly<{ supported: true; resolution: DaemonPluginStructuredMessageResolveResponse }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' }>;

export type MachinePluginStructuredMessageActionResult =
    | Readonly<{ supported: true; result: DaemonPluginStructuredMessageActionExecuteResponse }>
    | Readonly<{ supported: false; reason: 'not-supported' | 'error' }>;

export type MachineContributionRegistryProjectionScope = Readonly<{
    machineId: string;
    serverId: string | null;
}>;

const projectionRevisionByScope = new Map<string, number>();
const projectionListenersByScope = new Map<string, Set<() => void>>();
const projectionDescribeInflightByKey = new Map<string, Promise<MachineContributionRegistryProjectionDescribeResult>>();

function projectionScopeKey(scope: MachineContributionRegistryProjectionScope): string {
    return JSON.stringify([scope.serverId, scope.machineId]);
}

export function getMachineContributionRegistryProjectionRevision(
    scope: MachineContributionRegistryProjectionScope,
): number {
    return projectionRevisionByScope.get(projectionScopeKey(scope)) ?? 0;
}

export function subscribeMachineContributionRegistryProjectionInvalidation(
    scope: MachineContributionRegistryProjectionScope,
    listener: () => void,
): () => void {
    const key = projectionScopeKey(scope);
    const listeners = projectionListenersByScope.get(key) ?? new Set<() => void>();
    listeners.add(listener);
    projectionListenersByScope.set(key, listeners);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) projectionListenersByScope.delete(key);
    };
}

export function publishMachineContributionRegistryProjectionInvalidation(
    scope: MachineContributionRegistryProjectionScope,
): void {
    const key = projectionScopeKey(scope);
    projectionRevisionByScope.set(key, (projectionRevisionByScope.get(key) ?? 0) + 1);
    for (const listener of projectionListenersByScope.get(key) ?? []) listener();
}

export function publishMachineContributionRegistryProjectionReconnect(): void {
    for (const key of [...projectionListenersByScope.keys()]) {
        projectionRevisionByScope.set(key, (projectionRevisionByScope.get(key) ?? 0) + 1);
        for (const listener of projectionListenersByScope.get(key) ?? []) listener();
    }
}

function projectionDescribeInflightKey(params: Readonly<{
    scope: MachineContributionRegistryProjectionScope;
    timeoutMs: number | null;
    revision: number;
    requestEpoch: string | number | null;
    payload: unknown;
}>): string {
    return JSON.stringify([
        projectionScopeKey(params.scope),
        params.timeoutMs,
        params.revision,
        params.requestEpoch,
        params.payload,
    ]);
}

async function waitForProjectionDescribeResult(
    request: Promise<MachineContributionRegistryProjectionDescribeResult>,
    signal: AbortSignal | undefined,
): Promise<MachineContributionRegistryProjectionDescribeResult> {
    if (!signal) return await request;
    if (signal.aborted) return { supported: false, reason: 'error' };

    return await new Promise((resolve) => {
        const onAbort = () => resolve({ supported: false, reason: 'error' });
        signal.addEventListener('abort', onAbort, { once: true });
        request.then((result) => {
            signal.removeEventListener('abort', onAbort);
            resolve(result);
        });
    });
}

export async function machineContributionRegistryProjectionDescribe(
    machineId: string,
    opts?: Readonly<{
        serverId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
        requestEpoch?: string | number;
    }>,
): Promise<MachineContributionRegistryProjectionDescribeResult> {
    if (opts?.signal?.aborted) return { supported: false, reason: 'error' };
    try {
        const reactNativeHostRuntimeIdentity = resolveNativeReactNativeHostRuntimeIdentity();
        const reactNativeWebLoaderCapability = resolveReactNativeWebLoaderCapability();
        const payload = DaemonContributionRegistryProjectionDescribeRequestSchema.parse({
            machineId,
            ...(reactNativeHostRuntimeIdentity ? { reactNativeHostRuntimeIdentity } : {}),
            ...(reactNativeWebLoaderCapability ? { reactNativeWebLoaderCapability } : {}),
        });
        const scope = {
            machineId: payload.machineId,
            serverId: opts?.serverId ?? null,
        } satisfies MachineContributionRegistryProjectionScope;
        const timeoutMs = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : null;
        const key = projectionDescribeInflightKey({
            scope,
            timeoutMs,
            revision: getMachineContributionRegistryProjectionRevision(scope),
            requestEpoch: opts?.requestEpoch ?? null,
            payload,
        });
        let request = projectionDescribeInflightByKey.get(key);
        if (!request) {
            request = (async (): Promise<MachineContributionRegistryProjectionDescribeResult> => {
                try {
                    const response = await machineRpcWithServerScope<unknown, typeof payload>({
                        machineId: payload.machineId,
                        serverId: opts?.serverId,
                        timeoutMs: timeoutMs ?? undefined,
                        method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
                        payload,
                    });
                    if (isRpcMethodNotFoundResult(response)) {
                        return { supported: false, reason: 'not-supported' };
                    }
                    const parsed = parseDaemonContributionRegistryProjectionDescribeResponse(response);
                    if (!parsed) {
                        return { supported: false, reason: 'error' };
                    }
                    return { supported: true, projection: parsed };
                } catch {
                    return { supported: false, reason: 'error' };
                }
            })();
            projectionDescribeInflightByKey.set(key, request);
            void request.then(() => {
                if (projectionDescribeInflightByKey.get(key) === request) {
                    projectionDescribeInflightByKey.delete(key);
                }
            });
        }
        return await waitForProjectionDescribeResult(request, opts?.signal);
    } catch {
        return { supported: false, reason: 'error' };
    }
}

export async function machinePluginSettingsGet(
    machineId: string,
    opts: Readonly<{ serverId?: string | null; pluginId: string; timeoutMs?: number | null }>,
): Promise<MachinePluginSettingsResult> {
    try {
        const payload = DaemonPluginSettingsGetRequestSchema.parse({
            machineId,
            pluginId: opts.pluginId,
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_GET,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) {
            return { supported: false, reason: 'not-supported' };
        }
        const parsed = DaemonPluginSettingsGetResponseSchema.safeParse(response);
        if (!parsed.success) {
            return { supported: false, reason: 'error' };
        }
        return { supported: true, snapshot: parsed.data };
    } catch {
        return { supported: false, reason: 'error' };
    }
}

export async function machinePluginSettingsSet(
    machineId: string,
    opts: Readonly<{
        serverId?: string | null;
        pluginId: string;
        fieldId: string;
        value: unknown;
        expectedRevision?: string;
        timeoutMs?: number | null;
    }>,
): Promise<MachinePluginSettingsResult> {
    try {
        const payload = DaemonPluginSettingsSetRequestSchema.parse({
            machineId,
            pluginId: opts.pluginId,
            fieldId: opts.fieldId,
            value: opts.value,
            ...(opts.expectedRevision === undefined ? {} : { expectedRevision: opts.expectedRevision }),
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            method: RPC_METHODS.DAEMON_PLUGIN_SETTINGS_SET,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) {
            return { supported: false, reason: 'not-supported' };
        }
        const parsed = DaemonPluginSettingsSetResponseSchema.safeParse(response);
        if (!parsed.success) {
            return { supported: false, reason: 'error' };
        }
        return { supported: true, snapshot: parsed.data };
    } catch {
        return { supported: false, reason: 'error' };
    }
}

export async function machinePluginStructuredMessageResolve(
    machineId: string,
    opts: Readonly<Omit<DaemonPluginStructuredMessageResolveRequest, 'machineId'> & {
        serverId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginStructuredMessageResolveResult> {
    try {
        const payload = DaemonPluginStructuredMessageResolveRequestSchema.parse({
            machineId,
            expectedGeneration: opts.expectedGeneration,
            kind: opts.kind,
            payload: opts.payload,
            ...(opts.resourceRefs ? { resourceRefs: opts.resourceRefs } : {}),
            facts: opts.facts,
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            signal: opts.signal,
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_RESOLVE,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) {
            return { supported: false, reason: 'not-supported' };
        }
        const parsed = DaemonPluginStructuredMessageResolveResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, resolution: parsed.data }
            : { supported: false, reason: 'error' };
    } catch {
        return { supported: false, reason: 'error' };
    }
}

export async function machinePluginStructuredMessageActionExecute(
    machineId: string,
    opts: Readonly<Omit<DaemonPluginStructuredMessageActionExecuteRequest, 'machineId' | 'executionSurface'> & {
        executionSurface: NonNullable<DaemonPluginStructuredMessageActionExecuteRequest['executionSurface']>;
        serverId?: string | null;
        timeoutMs?: number | null;
        signal?: AbortSignal;
    }>,
): Promise<MachinePluginStructuredMessageActionResult> {
    try {
        const payload = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse({
            machineId,
            expectedGeneration: opts.expectedGeneration,
            qualifiedActionId: opts.qualifiedActionId,
            input: opts.input,
            ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
            executionSurface: opts.executionSurface,
        });
        const response = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId,
            serverId: opts.serverId,
            timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined,
            signal: opts.signal,
            method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
            payload,
        });
        if (isRpcMethodNotFoundResult(response)) return { supported: false, reason: 'not-supported' };
        const parsed = DaemonPluginStructuredMessageActionExecuteResponseSchema.safeParse(response);
        return parsed.success
            ? { supported: true, result: parsed.data }
            : { supported: false, reason: 'error' };
    } catch {
        return { supported: false, reason: 'error' };
    }
}
