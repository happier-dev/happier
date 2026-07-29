import type { ManagedExecutableRef } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';

import type { ResolvedSystemToolContribution } from '@/plugins/projection/registry/types';
import { isPluginExecSystemToolSupportedOnHost } from '@/plugins/runtime/exec/system/tools/definitions';
import type { StablePluginManagedDependenciesHost } from './managedDependencies';

type ResolvedExecutable = Readonly<{
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
    allowedArguments?: readonly string[];
    release?: () => void;
}>;

type ResolveSystemTool = (request: Readonly<{
    toolId: string;
    executableNames: readonly string[];
}>) => Promise<Readonly<{
    toolId: string;
    command: string;
    args?: readonly string[];
    env?: Readonly<Record<string, string>>;
}>>;

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function refIdentity(ref: ManagedExecutableRef, requestingPluginId: string): Readonly<{
    pluginId: string;
    localId: string;
}> {
    return typeof ref.id === 'string'
        ? Object.freeze({ pluginId: requestingPluginId, localId: ref.id })
        : ref.id;
}

export function createStableManagedExecutableResolver(params: Readonly<{
    systemTools: readonly ResolvedSystemToolContribution[];
    managedDependencies: Pick<StablePluginManagedDependenciesHost, 'resolveExecutable'>;
    resolveSystemTool: ResolveSystemTool;
}>, hostPlatform: NodeJS.Platform = process.platform): (ref: ManagedExecutableRef, requestingPluginId: string) => Promise<ResolvedExecutable> {
    const systemTools = new Map<string, ResolvedSystemToolContribution>();
    for (const contribution of params.systemTools) {
        const pluginId = contribution.pluginId;
        if (!pluginId) continue;
        systemTools.set(`${pluginId}/${contribution.definition.id}`, contribution);
    }

    return async (ref, requestingPluginId) => {
        if (ref.kind === 'managedDependency') {
            return await params.managedDependencies.resolveExecutable(ref, requestingPluginId);
        }
        const identity = refIdentity(ref, requestingPluginId);
        const qualifiedId = `${identity.pluginId}/${identity.localId}`;
        const contribution = systemTools.get(qualifiedId);
        if (!contribution) {
            return fail('plugin_system_tool_undeclared', 'System tool is not declared for this plugin');
        }
        if (!isPluginExecSystemToolSupportedOnHost(contribution.definition, hostPlatform)) {
            return fail(
                'plugin_system_tool_platform_unsupported',
                'System tool is not supported on this host platform',
            );
        }
        let resolved: Awaited<ReturnType<ResolveSystemTool>>;
        try {
            resolved = await params.resolveSystemTool({
                toolId: qualifiedId,
                executableNames: contribution.definition.executableNames,
            });
        } catch (error) {
            if (error instanceof PluginError) throw error;
            return fail('plugin_system_tool_unavailable', 'System tool is unavailable');
        }
        return Object.freeze({
            command: resolved.command,
            ...(resolved.args ? { args: Object.freeze([...resolved.args]) } : {}),
            ...(resolved.env ? { env: Object.freeze({ ...resolved.env }) } : {}),
            ...(contribution.definition.allowedArguments ? {
                allowedArguments: Object.freeze([...contribution.definition.allowedArguments]),
            } : {}),
        });
    };
}
