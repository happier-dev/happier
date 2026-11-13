import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import { isAbsolute } from 'node:path';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

import type {
  ExecSystemToolServiceV1,
  SystemToolLaunchGrantV1,
  SystemToolResolveRequestV1,
} from '@/plugins/runtime/exec/privateContract';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { PluginError } from '@happier-dev/plugin-sdk';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import {
  resolveAgentCliLaunchSpecForRuntime,
  type AgentCliLaunchSpec,
  type BoundAgentCliLaunchSpec,
} from '@/packagedRuntime/managedTools/agentCliLaunchSpec';

import { AGENT_CLI_MISSING_PREVIEW } from '@/packagedRuntime/managedTools/agentCliNotFoundError';

import type { PluginExecSystemToolDefinition } from './definitions';
import { issueAdmittedPluginExecSystemToolGrant } from './resolveGrant';
import { resolveMemberRunnableAgentCliLaunch, type MemberAgentCliLaunchContext } from './memberAgentCliLaunch';
export { createMemberAgentCliLaunchContext, readMemberAgentCliLaunchContext, resolveMemberRunnableAgentCliLaunch,
    type MemberAgentCliLaunchContext } from './memberAgentCliLaunch';

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
        ...(params.processEnv ?? sessionProcessEnvironment()),
        ...(params.happyHomeDir ? { HAPPIER_HOME_DIR: params.happyHomeDir } : {}),
    };
}

function failUnavailable(agentId: string, detail: string): never {
    throw new PluginError({
        code: 'plugin_exec_system_tool_unavailable',
        message: `Agent CLI system tool for '${agentId}' is unavailable: ${detail}`,
    });
}

function createBoundAgentCliSystemToolService(params: Readonly<{
    agentId: string;
    binding: AgentCliSystemToolBinding;
    definition: PluginExecSystemToolDefinition;
    resolveLaunch(request: SystemToolResolveRequestV1): AgentCliLaunchSpec | null | Promise<AgentCliLaunchSpec | null>;
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

            const resolved = issueAdmittedPluginExecSystemToolGrant({ definition: params.definition,
                request: { ...request, preferredPath: launch.resolvedPath }, executablePath: launch.resolvedPath,
                launch: { executablePath: launch.command, args: Object.freeze([...launch.args]) } });
            return Object.freeze({
                ...resolved,
                ...(launch.providerExitOwnership === 'direct' ? { providerExitOwnership: 'direct' as const } : {}),
            });
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
        delegate: params.delegate,
    });
}
