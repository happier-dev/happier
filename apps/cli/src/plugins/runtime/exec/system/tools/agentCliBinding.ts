import { isAbsolute } from 'node:path';

import type {
  ExecSystemToolServiceV1,
  SystemToolLaunchGrantV1,
  SystemToolResolveRequestV1,
} from '@/plugins/runtime/exec/privateContract';
import type { AgentCliRuntimeDescriptor } from '@happier-dev/cli-common/agents';
import { PluginError } from '@happier-dev/plugin-sdk';
import { resolveAgentCliLaunchSpecForRuntime } from '@/packagedRuntime/managedTools/agentCliLaunchSpec';

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

            const launch = resolveAgentCliLaunchSpecForRuntime(params.runtimeSpec, {
                processEnv: params.processEnv,
            });
            if (!launch) {
                return failUnavailable(params.agentId, 'canonical Agent CLI resolution failed');
            }
            if (!isAbsolute(launch.resolvedPath) || !isAbsolute(launch.command)) {
                return failUnavailable(params.agentId, 'canonical Agent CLI resolution was not absolute');
            }

            const resolver = createPluginExecSystemToolResolver({
                definitions: Object.freeze([params.definition]),
                baseEnv: Object.freeze({
                    ...params.processEnv,
                    PATH: '',
                }),
                preferredPathAccess: 'readable-javascript',
                registerGrant() {},
            });
            const resolved = await resolver.resolve({
                ...request,
                preferredPath: launch.resolvedPath,
            });
            if (
                resolved.executablePath !== launch.resolvedPath
                || resolved.launch.executablePath !== launch.command
                || !sameArgs(resolved.launch.args ?? [], launch.args)
            ) {
                return failUnavailable(
                    params.agentId,
                    'system-tool launch did not preserve canonical Agent CLI identity',
                );
            }
            return resolved;
        },
    });
}
