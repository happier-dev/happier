import { randomUUID } from 'node:crypto';

import {
    McpDetectedProviderV1Schema,
    type DaemonMcpServersDetectWarningV1,
} from '@happier-dev/protocol';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginMcpDiscoveryRequest, PluginMcpDiscoveryResult } from '@happier-dev/plugin-sdk/runtime';
import type {
    McpDiscoveryProviderReturnV1,
    McpResolveForSessionInputV1,
} from '@happier-dev/plugin-sdk/experimental/mcp';

import type { ContributionRuntimeRegistration } from '@/plugins/runtime/api/registrationRightsHost';

import type { ActivationTarget } from '../activation/targets';
import { createPluginInvocationUi } from '../../invocation/services/ui';
import type { PluginInvocationServicesSeed } from '../../invocation/services/types';
import { createUnavailablePluginServices } from '../../invocation/services/unavailable';
import type { TargetInvocationServiceOwner } from './targetHooks';

type TargetRegistration = Readonly<{
    pluginId: string;
    generation: string;
    registration: ContributionRuntimeRegistration;
}>;

export type TargetMcpDiscoveryProviderEntry = Readonly<{
    pluginId: string;
    registration: Readonly<{
        id: string;
        discover(
            input?: McpResolveForSessionInputV1,
        ): Promise<McpDiscoveryProviderReturnV1> | McpDiscoveryProviderReturnV1;
    }>;
}>;

export function projectPluginMcpDiscoveryWarnings(
    warnings: PluginMcpDiscoveryResult['warnings'],
): NonNullable<PluginMcpDiscoveryResult['warnings']> {
    return Object.freeze((warnings ?? []).map((warning) => Object.freeze({
        code: warning.code,
        ...(warning.path === undefined ? {} : { path: warning.path }),
        ...(warning.detail === undefined ? {} : { detail: warning.detail }),
    })));
}

export function projectPluginMcpDiscoveryWarningsToLegacyDetection(
    provider: unknown,
    warnings: PluginMcpDiscoveryResult['warnings'],
): readonly DaemonMcpServersDetectWarningV1[] {
    const parsedProvider = McpDetectedProviderV1Schema.safeParse(provider);
    if (!parsedProvider.success) return Object.freeze([]);
    return Object.freeze(projectPluginMcpDiscoveryWarnings(warnings).map((warning) => Object.freeze({
        provider: parsedProvider.data,
        ...warning,
    })));
}

export function createTargetMcpDiscoveryProviders(params: Readonly<{
    generation: number;
    activationTargets: readonly ActivationTarget[];
    targetRegistrations: readonly TargetRegistration[];
    isGenerationActive(): boolean;
    invocationServices?: TargetInvocationServiceOwner;
}>): readonly TargetMcpDiscoveryProviderEntry[] {
    return Object.freeze(params.targetRegistrations.flatMap((entry) => {
        if (entry.registration.family !== 'mcp.discoveryProviders') return [];
        if (entry.generation !== String(params.generation)) {
            throw new Error(`Target MCP discovery provider '${entry.pluginId}/${entry.registration.localId}' was published for the wrong generation`);
        }
        const target = params.activationTargets.find((candidate) => candidate.pluginId === entry.pluginId);
        const declaration = target?.manifest.contributes.mcp.discoveryProviders.find(
            (provider) => provider.id === entry.registration.localId,
        );
        if (!target || !declaration) {
            throw new Error(`Target MCP discovery registration '${entry.pluginId}/${entry.registration.localId}' has no matching manifest contribution`);
        }
        const discover = entry.registration.value;
        const registration: TargetMcpDiscoveryProviderEntry['registration'] = Object.freeze({
            id: declaration.id,
            async discover(input?: McpResolveForSessionInputV1) {
                if (!params.isGenerationActive()) {
                    throw new Error(`Plugin '${target.pluginId}' MCP discovery provider is no longer active`);
                }
                const request: PluginMcpDiscoveryRequest = Object.freeze({
                    ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
                    ...(input?.accountId !== undefined ? { accountId: input.accountId } : {}),
                    ...(input?.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
                    ...(input?.directory !== undefined ? { directory: input.directory } : {}),
                });
                const signal = new AbortController().signal;
                const plugin = Object.freeze({ id: target.pluginId, version: target.manifest.version });
                const contribution = Object.freeze({
                    id: declaration.id,
                    qualifiedId: `${target.pluginId}/mcp.discoveryProviders/${declaration.id}`,
                });
                const invocationServices = params.invocationServices;
                const services = invocationServices
                    ? (() => {
                        const seed: PluginInvocationServicesSeed = Object.freeze({
                            plugin,
                            contribution,
                            generation: entry.generation,
                            correlationId: randomUUID(),
                            surface: 'mcp',
                            ...(input?.sessionId ? { session: Object.freeze({ id: input.sessionId }) } : {}),
                            signal,
                            isGenerationCurrent: params.isGenerationActive,
                        });
                        const serviceBinding = invocationServices.createOrdinaryServiceBinding(
                            entry.generation,
                            `${contribution.qualifiedId}:binding`,
                        );
                        return invocationServices.createServices(seed, serviceBinding);
                    })()
                    : createUnavailablePluginServices();
                const context: PluginInvocationContext = Object.freeze({
                    plugin,
                    contribution,
                    surface: 'mcp',
                    ...(input?.sessionId ? { session: Object.freeze({ id: input.sessionId }) } : {}),
                    signal,
                    services,
                    ui: createPluginInvocationUi({
                        currentSession: null,
                        signal,
                        isGenerationCurrent: params.isGenerationActive,
                    }),
                });
                let result: PluginMcpDiscoveryResult;
                try {
                    result = await discover(request, context);
                } catch (error) {
                    if (!params.isGenerationActive()) {
                        throw new Error(`Plugin '${target.pluginId}' MCP discovery provider is no longer active`);
                    }
                    throw error;
                }
                if (!params.isGenerationActive()) {
                    throw new Error(`Plugin '${target.pluginId}' MCP discovery provider is no longer active`);
                }
                return Object.freeze({
                    servers: Object.freeze([...(result.servers ?? [])]),
                    ...(result.warnings
                        ? {
                            warnings: projectPluginMcpDiscoveryWarningsToLegacyDetection(
                                declaration.metadata?.agentId,
                                result.warnings,
                            ),
                        }
                        : {}),
                });
            },
        });
        return [Object.freeze({ pluginId: target.pluginId, registration })];
    }));
}
