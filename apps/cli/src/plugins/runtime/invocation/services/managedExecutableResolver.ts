import type { ManagedExecutableRef } from '@happier-dev/protocol';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';

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

type PackagedRuntimeBinaryRef = Extract<
    ManagedExecutableRef,
    Readonly<{ kind: 'packaged-runtime-binary' }>
>;
type DeclaredSystemToolRef = Extract<
    ManagedExecutableRef,
    Readonly<{ kind: 'systemTool' }>
>;

export type ManagedProviderRuntimeExecutableResolutionContext = Readonly<{
    kind: 'managedProviderRuntime';
    pluginId: string;
    providerLocalId: string;
    contributionQualifiedId: string;
    generation: string;
    isCurrent(): boolean;
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

function isManagedProviderRuntimeResolutionContext(
    value: unknown,
): value is ManagedProviderRuntimeExecutableResolutionContext {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return candidate.kind === 'managedProviderRuntime'
        && typeof candidate.pluginId === 'string'
        && typeof candidate.providerLocalId === 'string'
        && typeof candidate.contributionQualifiedId === 'string'
        && typeof candidate.generation === 'string'
        && typeof candidate.isCurrent === 'function';
}

function refIdentity(ref: DeclaredSystemToolRef, requestingPluginId: string): Readonly<{
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
    resolvePackagedRuntimeBinary?(
        ref: PackagedRuntimeBinaryRef,
        context: ManagedProviderRuntimeExecutableResolutionContext,
    ): Promise<ResolvedExecutable>;
}>, hostPlatform: NodeJS.Platform = process.platform): (
    ref: ManagedExecutableRef,
    requestingPluginId: string,
    context?: unknown,
) => Promise<ResolvedExecutable> {
    const systemTools = new Map<string, ResolvedSystemToolContribution>();
    for (const contribution of params.systemTools) {
        const pluginId = contribution.pluginId;
        if (!pluginId) continue;
        systemTools.set(`${pluginId}/${contribution.definition.id}`, contribution);
    }

    return async (ref, requestingPluginId, context) => {
        if (ref.kind === 'managedDependency') {
            return await params.managedDependencies.resolveExecutable(ref, requestingPluginId);
        }
        if (ref.kind === 'packaged-runtime-binary') {
            if (
                !isManagedProviderRuntimeResolutionContext(context)
                || context.pluginId !== requestingPluginId
                || context.pluginId.length === 0
                || context.pluginId !== context.pluginId.trim()
                || context.providerLocalId.length === 0
                || context.providerLocalId !== context.providerLocalId.trim()
                || context.contributionQualifiedId
                    !== `${context.pluginId}/providers/${context.providerLocalId}`
                || context.generation.length === 0
                || context.generation !== context.generation.trim()
                || !context.isCurrent()
                || !params.resolvePackagedRuntimeBinary
            ) {
                return fail(
                    'plugin_packaged_runtime_binary_unavailable',
                    'Packaged runtime binary is unavailable outside its exact current managed Provider invocation',
                );
            }
            return await params.resolvePackagedRuntimeBinary(ref, context);
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
            if (isPluginError(error)) throw error;
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
