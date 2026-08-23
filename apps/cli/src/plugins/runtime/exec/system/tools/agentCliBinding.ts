import { isAbsolute } from 'node:path';

import type {
  ExecSystemToolServiceV1,
  SystemToolLaunchGrantV1,
  SystemToolResolveRequestV1,
} from '@/plugins/runtime/exec/privateContract';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { PluginError } from '@happier-dev/plugin-sdk';
import {
  resolveAgentCliLaunchSpecForRuntime,
  type AgentCliLaunchSpec,
} from '@/packagedRuntime/managedTools/agentCliLaunchSpec';

import type { PluginExecSystemToolDefinition } from './definitions';
import { createPluginExecSystemToolResolver } from './resolveGrant';

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
    resolveLaunch(): AgentCliLaunchSpec | null;
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

            const launch = params.resolveLaunch();
            if (!launch) {
                return failUnavailable(params.agentId, 'canonical Agent CLI resolution failed');
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
    delegate: ExecSystemToolServiceV1;
}>): ExecSystemToolServiceV1 {
    return createBoundAgentCliSystemToolService({
        agentId: params.agentId,
        binding: params.binding,
        definition: params.definition,
        resolveLaunch: () => resolveAgentCliLaunchSpecForRuntime(
            params.runtimeSpec,
            { processEnv: params.processEnv },
        ),
        resolutionEnvironment: () => params.processEnv,
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
