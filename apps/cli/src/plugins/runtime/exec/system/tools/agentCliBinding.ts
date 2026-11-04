import { agentCliPathRequiresJavaScriptRuntime, resolveAgentCliCommandForRuntime, resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { managedJavaScriptRuntimeBinPath, resolveDirectJavaScriptRuntimeCommand } from '@happier-dev/cli-common/agents/managedJavaScriptRuntime';
import { isAbsolute } from 'node:path';

import type {
  ExecSystemToolServiceV1,
  SystemToolLaunchGrantV1,
  SystemToolResolveRequestV1,
} from '@/plugins/runtime/exec/privateContract';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { PluginError } from '@happier-dev/plugin-sdk';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { resolveMachineAgentExecutionPlacementV1 } from '@happier-dev/protocol';
import {
  resolveAgentCliLaunchSpecForRuntime,
  buildAgentCliLaunchSpecFromResolution,
  type AgentCliLaunchSpec,
  type BoundAgentCliLaunchSpec,
} from '@/packagedRuntime/managedTools/agentCliLaunchSpec';

import { AGENT_CLI_MISSING_PREVIEW } from '@/packagedRuntime/managedTools/agentCliNotFoundError';

import type { PluginExecSystemToolDefinition } from './definitions';
import { createPluginExecSystemToolResolver } from './resolveGrant';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

export type MemberAgentCliLaunchContext = Readonly<{
    signal?: AbortSignal;
}>;

/** Consume the operation/Session owner's existing native selection. */
export function readMemberAgentCliLaunchContext(context?: HostAgentIsolationLaunchContext): MemberAgentCliLaunchContext | undefined {
    const snapshot = context?.read();
    if (!snapshot || resolveMachineAgentExecutionPlacementV1({ policy: snapshot, platform: process.platform }) !== 'member') return undefined;
    const installedCli = snapshot.launch?.managedHappierBinaryPath ?? context?.managedHappierBinaryPath;
    if (!snapshot.memberIdentity || !installedCli) throw new PluginError({ code: 'agent_isolation_unavailable',
        message: 'Current member launch material is unavailable', retryable: false });
    return {};
}

/** The admitted member consumes machine-wide managed code, never the owner's
 * PATH or overrides. The native launch shim enforces the selected identity. */
export async function resolveMemberRunnableAgentCliLaunch(params: Readonly<{
    agentId: string;
    runtimeSpec: AgentCliRuntimeDescriptor;
    processEnv: NodeJS.ProcessEnv;
    memberLaunch: MemberAgentCliLaunchContext;
}>): Promise<AgentCliLaunchSpec> {
    const refuse = (): never => { throw new PluginError({ code: 'agent_cli_not_runnable', retryable: false,
        message: `Agent '${params.runtimeSpec.title}' cannot run as this member. Install its Happier-managed runtime.`,
        details: { agentId: params.agentId, remedy: 'install_managed_runtime' } }); };
    const processEnv = { ...params.processEnv,
        HAPPIER_JS_RUNTIME_PATH: managedJavaScriptRuntimeBinPath(params.processEnv),
        HAPPIER_MANAGED_NODE_BIN: undefined, HAPPIER_NODE_PATH: undefined };
    params.memberLaunch.signal?.throwIfAborted();
    const resolved = resolveAgentCliCommandForRuntime(params.runtimeSpec, { processEnv, sourcePolicy: 'managed_only' });
    if (!resolved) return refuse();
    let managedRuntime: string | undefined;
    if (agentCliPathRequiresJavaScriptRuntime(resolved.command)) {
        const runtime = resolveDirectJavaScriptRuntimeCommand({ processEnv, isBunRuntime: false });
        if (!runtime) return refuse();
        managedRuntime = runtime;
        processEnv.HAPPIER_JS_RUNTIME_PATH = runtime;
    }
    const launch = buildAgentCliLaunchSpecFromResolution(resolved, { processEnv });
    if (!launch || managedRuntime && launch.command !== managedRuntime) return refuse();
    return launch;
}

/** Shared composition for current and retained Agent CLI system-tool consumers. */
export function createDeclaredAgentCliSystemToolService<T extends ExecSystemToolServiceV1 | undefined>(params: Readonly<{
    agentId: string;
    localAgentId: string;
    binding?: AgentCliSystemToolBinding;
    runtimeSpec?: AgentCliRuntimeDescriptor | null;
    agentCliLaunch?: BoundAgentCliLaunchSpec;
    definitions: readonly PluginExecSystemToolDefinition[];
    processEnv: NodeJS.ProcessEnv;
    memberLaunch?: MemberAgentCliLaunchContext;
    delegate: T;
}>): ExecSystemToolServiceV1 | T {
    if (params.agentCliLaunch && params.agentCliLaunch.localAgentId !== params.localAgentId) {
        throw new PluginError({
            code: 'plugin_agent_cli_system_tool_unavailable',
            message: `Agent '${params.agentId}' CLI launch binding does not match its declared identity`,
        });
    }
    const binding = params.binding;
    if (!binding) return params.delegate;
    const definition = params.definitions.find(candidate => candidate.toolId === binding.toolId);
    if (!definition || !params.delegate) {
        throw new PluginError({
            code: 'plugin_agent_cli_system_tool_unavailable',
            message: `Agent '${params.agentId}' CLI system tool is unavailable`,
        });
    }
    if (params.agentCliLaunch) {
        return createRetainedAgentCliSystemToolService({
            agentId: params.agentId, binding, definition,
            launch: params.agentCliLaunch.spec, delegate: params.delegate,
        });
    }
    if (!params.runtimeSpec) {
        throw new PluginError({
            code: 'plugin_agent_cli_runtime_metadata_unavailable',
            message: `Agent '${params.agentId}' CLI runtime metadata is unavailable`,
        });
    }
    return createAgentCliSystemToolService({
        agentId: params.agentId, binding, definition,
        runtimeSpec: params.runtimeSpec, processEnv: params.processEnv, delegate: params.delegate,
        ...(params.memberLaunch ? { memberLaunch: params.memberLaunch } : {}),
    });
}

export type AgentCliSystemToolBinding = Readonly<{
    toolId: string;
}>;

export function createAgentCliHostResolutionEnvironment(params: Readonly<{
    processEnv?: NodeJS.ProcessEnv;
    happyHomeDir?: string;
}> = {}): NodeJS.ProcessEnv {
    return {
        ...(params.processEnv ?? process.env),
        ...(params.happyHomeDir ? { HAPPIER_HOME_DIR: params.happyHomeDir } : {}),
    };
}

function failUnavailable(agentId: string, detail: string): never {
    throw new PluginError({
        code: 'plugin_exec_system_tool_unavailable',
        message: `Agent CLI system tool for '${agentId}' is unavailable: ${detail}`,
    });
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function createBoundAgentCliSystemToolService(params: Readonly<{
    agentId: string;
    binding: AgentCliSystemToolBinding;
    definition: PluginExecSystemToolDefinition;
    resolveLaunch(request: SystemToolResolveRequestV1): AgentCliLaunchSpec | null | Promise<AgentCliLaunchSpec | null>;
    resolutionEnvironment(launch: AgentCliLaunchSpec): NodeJS.ProcessEnv;
    delegate: ExecSystemToolServiceV1;
}>): ExecSystemToolServiceV1 {
    if (params.binding.toolId !== params.definition.toolId) {
        throw new Error(
            `Agent CLI system-tool binding '${params.binding.toolId}' does not match definition '${params.definition.toolId}'`,
        );
    }

    return Object.freeze({
        async resolve(request: SystemToolResolveRequestV1): Promise<SystemToolLaunchGrantV1> {
            if (request.toolId !== params.binding.toolId) {
                return await params.delegate.resolve(request);
            }

            const launch = await params.resolveLaunch(request);
            if (!launch) {
                throw new PluginError({
                    code: SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING,
                    message: AGENT_CLI_MISSING_PREVIEW,
                    retryable: false,
                });
            }
            if (!isAbsolute(launch.resolvedPath) || !isAbsolute(launch.command)) {
                return failUnavailable(params.agentId, 'canonical Agent CLI resolution was not absolute');
            }

            const resolver = createPluginExecSystemToolResolver({
                definitions: Object.freeze([params.definition]),
                baseEnv: Object.freeze({
                    ...params.resolutionEnvironment(launch),
                    PATH: '',
                }),
                preferredPathAccess: 'readable-javascript',
                registerGrant() {},
            });
            const resolved = await resolver.resolve({
                ...request,
                preferredPath: launch.resolvedPath,
            });
            const exactLaunch = Object.freeze({
                ...resolved.launch,
                executablePath: launch.command,
                args: Object.freeze([...launch.args]),
            });
            const exactResolved = Object.freeze({
                ...resolved,
                ...(launch.providerExitOwnership === 'direct' ? { providerExitOwnership: 'direct' as const } : {}),
                launch: exactLaunch,
            });
            if (
                exactResolved.executablePath !== launch.resolvedPath
                || exactResolved.launch.executablePath !== launch.command
                || !sameArgs(exactResolved.launch.args ?? [], launch.args)
            ) {
                return failUnavailable(
                    params.agentId,
                    'system-tool launch did not preserve canonical Agent CLI identity',
                );
            }
            return exactResolved;
        },
    });
}

/**
 * Binds one explicitly declared system tool to the canonical Agent CLI
 * resolver without exposing the host-resolved path through the public SDK.
 */
export function createAgentCliSystemToolService(params: Readonly<{
    agentId: string;
    runtimeSpec: AgentCliRuntimeDescriptor;
    binding: AgentCliSystemToolBinding;
    definition: PluginExecSystemToolDefinition;
    processEnv: NodeJS.ProcessEnv;
    memberLaunch?: MemberAgentCliLaunchContext;
    delegate: ExecSystemToolServiceV1;
}>): ExecSystemToolServiceV1 {
    return createBoundAgentCliSystemToolService({
        agentId: params.agentId,
        binding: params.binding,
        definition: params.definition,
        resolveLaunch: (request) => params.memberLaunch ? resolveMemberRunnableAgentCliLaunch({
            agentId: params.agentId, runtimeSpec: params.runtimeSpec, processEnv: params.processEnv,
            memberLaunch: { ...params.memberLaunch, signal: request.signal ?? params.memberLaunch.signal },
        }) : resolveAgentCliLaunchSpecForRuntime(
            params.runtimeSpec,
            { processEnv: request.preferredPath ? {
                ...params.processEnv,
                [resolveAgentCliOverrideEnvKey(params.runtimeSpec.id)]: request.preferredPath,
            } : params.processEnv },
        ),
        resolutionEnvironment: launch => params.memberLaunch
            ? { HAPPIER_JS_RUNTIME_PATH: launch.command } : params.processEnv,
        delegate: params.delegate,
    });
}

/**
 * Uses the daemon-admitted launch exactly as captured, without consulting the
 * current daemon environment or exposing that launch spec through plugin APIs.
 */
export function createRetainedAgentCliSystemToolService(params: Readonly<{
    agentId: string;
    binding: AgentCliSystemToolBinding;
    definition: PluginExecSystemToolDefinition;
    launch: AgentCliLaunchSpec;
    delegate: ExecSystemToolServiceV1;
}>): ExecSystemToolServiceV1 {
    return createBoundAgentCliSystemToolService({
        agentId: params.agentId,
        binding: params.binding,
        definition: params.definition,
        resolveLaunch: () => params.launch,
        // The generic grant owner needs a JavaScript runner only when the
        // already-admitted CLI is a script. Pin it to the admitted command;
        // do not read the current daemon process environment.
        resolutionEnvironment: (launch) => ({
            HAPPIER_JS_RUNTIME_PATH: launch.command,
        }),
        delegate: params.delegate,
    });
}
