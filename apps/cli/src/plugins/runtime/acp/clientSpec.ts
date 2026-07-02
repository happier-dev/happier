import type {
    AcpBackendSpecV1,
    CreateAcpRuntimeParamsV1,
    ExecJsonRpcClientSpecV1,
    ExecLaunchInputV1,
    JsonRpcMessageHookDecisionV1,
    JsonRpcMessageHookV1,
    PluginContextV1,
} from '@happier-dev/plugin-sdk';

import { redactBugReportSensitiveText } from '@happier-dev/protocol';

import {
    normalizePluginAcpDefinition,
    type AcpExecutableLaunch,
    resolveAcpRuntimeLaunch,
    runAcpTier2Preflight,
} from '@/agent/acp/runtime/definition';

export type CreateUnsupportedAcpTransportError = (transportKind: string) => Error;

const MAX_ACP_TRANSPORT_HOOK_ERROR_CHARS = 500;

function sanitizeDiagnostic(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = redactBugReportSensitiveText(message);
    return redacted.length > MAX_ACP_TRANSPORT_HOOK_ERROR_CHARS
        ? `${redacted.slice(0, MAX_ACP_TRANSPORT_HOOK_ERROR_CHARS)}...`
        : redacted;
}

async function runCustomTransportPreDial(params: Readonly<{
    spec: AcpBackendSpecV1;
    runtimeParams: CreateAcpRuntimeParamsV1;
}>): Promise<void> {
    const preDial = params.spec.transport.customHandler?.preDial;
    if (!preDial) {
        return;
    }
    try {
        await preDial({
            sessionId: params.runtimeParams.sessionId,
            cwd: params.runtimeParams.cwd,
        });
    } catch (error) {
        throw new Error(
            `ACP backend '${params.spec.backendId}' transport.customHandler.preDial callback failed: ${sanitizeDiagnostic(error)}`,
            { cause: error },
        );
    }
}

function buildJsonRpcHook(params: Readonly<{
    spec: AcpBackendSpecV1;
    runtimeParams: CreateAcpRuntimeParamsV1;
}>): ExecJsonRpcClientSpecV1['hooks'] | undefined {
    const onMessage = params.spec.transport.customHandler?.onMessage;
    if (!onMessage) {
        return undefined;
    }
    const hook: JsonRpcMessageHookV1 = async (message, context): Promise<JsonRpcMessageHookDecisionV1> => {
        try {
            return await onMessage(message, {
                sessionId: params.runtimeParams.sessionId,
                phase: context.phase,
            });
        } catch (error) {
            throw new Error(
                `ACP backend '${params.spec.backendId}' transport.customHandler.onMessage callback failed: ${sanitizeDiagnostic(error)}`,
                { cause: error },
            );
        }
    };
    return Object.freeze({
        jsonRpc: Object.freeze({
            onMessage: hook,
        }),
    });
}

function removeAgentCliRuntimePrefix(
    args: readonly string[],
    prefix: readonly string[],
): readonly string[] {
    if (prefix.length === 0) {
        return args;
    }
    const hasPrefix = prefix.every((value, index) => args[index] === value);
    return hasPrefix ? args.slice(prefix.length) : args;
}

function buildExecLaunchInput(params: Readonly<{
    launch: AcpExecutableLaunch;
    cwd: string;
}>): ExecLaunchInputV1 {
    const grant = params.launch.agentCliGrant;
    if (grant) {
        return Object.freeze({
            kind: 'agent-cli',
            agentId: grant.agentId,
            args: removeAgentCliRuntimePrefix(params.launch.args, grant.runtimeArgsPrefix),
            cwd: params.cwd,
            env: params.launch.env,
        });
    }
    return Object.freeze({
        kind: 'binary',
        executablePath: params.launch.command,
        args: params.launch.args,
        cwd: params.cwd,
        env: params.launch.env,
    });
}

export async function buildClientSpecFromAcpSpec(params: Readonly<{
    spec: AcpBackendSpecV1;
    runtimeParams: CreateAcpRuntimeParamsV1;
    createUnsupportedTransportError: CreateUnsupportedAcpTransportError;
    pluginContext?: PluginContextV1;
}>): Promise<ExecJsonRpcClientSpecV1> {
    const definition = normalizePluginAcpDefinition({ spec: params.spec });
    await runAcpTier2Preflight({
        definition,
        cwd: params.runtimeParams.cwd,
    });
    await runCustomTransportPreDial({
        spec: params.spec,
        runtimeParams: params.runtimeParams,
    });
    if (definition.transport.kind !== 'stdio') {
        throw params.createUnsupportedTransportError(definition.transport.kind);
    }
    const launch = await resolveAcpRuntimeLaunch({
        definition,
        cwd: params.runtimeParams.cwd,
        permissionMode: params.runtimeParams.permissionMode,
        pluginContext: params.pluginContext,
    });
    const hooks = buildJsonRpcHook({
        spec: params.spec,
        runtimeParams: params.runtimeParams,
    });
    return Object.freeze({
        launch: buildExecLaunchInput({
            launch,
            cwd: params.runtimeParams.cwd,
        }),
        transport: Object.freeze({
            kind: 'stdio',
            framing: Object.freeze({ kind: 'strict-lf-json' }),
            encoding: 'utf8',
        }),
        protocol: Object.freeze({ kind: 'json-rpc-2.0' }),
        ...(hooks ? { hooks } : {}),
        lifecycle: Object.freeze({
            requestTimeoutMs: definition.transport.timeouts?.idleMs,
        }),
    });
}
