import {
    createCatalogHostSessionRuntimeConfig,
    createCatalogHostSessionRuntimePlan,
} from '@/agent/runtime/session/loop/catalogPlan';
import type { HostSessionRuntimePlan } from '@/agent/runtime/session/loop/lifecycle';
import { resolveContributionProviderAgentId } from '@/plugins/projection/registry/resolveContributionProviderAgentId';
import type {
    ResolvedBackendContribution,
    ResolvedProviderContribution,
} from '@/plugins/projection/registry/types';
import { createProviderTerminalDisplay } from '@/ui/providers/providerTerminalDisplay';
import type { AgentId } from '@happier-dev/agents';

import {
    decorateRuntimeTurnOperationsWithMetadata,
    normalizePluginSessionLaunchResult,
} from './sessionMetadata';
import {
    buildPluginHostSessionRuntimeOptions,
    type PluginSessionBindingInput,
    type PluginSessionLaunchHandler,
    buildPluginSessionLaunchParams,
} from './sessionLaunch';

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function buildPluginDisplayName(provider: ResolvedProviderContribution, backend: ResolvedBackendContribution): string {
    const providerTitle = normalizeNonEmptyString(provider.runtimeSpec?.title);
    if (providerTitle) return providerTitle;

    const richDisplayName = provider.richDefinition?.provenance === 'external'
        ? normalizeNonEmptyString(provider.richDefinition.definition.display?.name)
        : null;
    if (richDisplayName) return richDisplayName;

    return normalizeNonEmptyString(backend.id) ?? normalizeNonEmptyString(provider.id) ?? 'Plugin Runtime';
}

function resolvePluginPolicyAgentId(params: Readonly<{
    backend: ResolvedBackendContribution;
    provider: ResolvedProviderContribution;
}>): AgentId {
    const policyAgentId = resolveContributionProviderAgentId({
        backend: params.backend,
        provider: params.provider,
    });
    if (policyAgentId) {
        return policyAgentId;
    }

    throw new Error(
        `Plugin backend '${params.backend.id}' requires providerAgentId to resolve to an exact built-in policy agent id before it can become a live session runtime`,
    );
}

export async function createPluginSessionRuntimePlan(params: Readonly<{
    backend: ResolvedBackendContribution;
    provider: ResolvedProviderContribution;
    launch: PluginSessionLaunchHandler;
    sessionInput: PluginSessionBindingInput;
}>): Promise<HostSessionRuntimePlan> {
    const displayName = buildPluginDisplayName(params.provider, params.backend);
    const policyAgentId = resolvePluginPolicyAgentId({
        backend: params.backend,
        provider: params.provider,
    });
    const TerminalDisplay = createProviderTerminalDisplay({
        title: displayName,
        footerName: displayName,
        accentColor: 'cyan',
    });

    return createCatalogHostSessionRuntimePlan({
        providerId: params.backend.id,
        opts: buildPluginHostSessionRuntimeOptions(params.sessionInput),
        config: createCatalogHostSessionRuntimeConfig({
            providerId: params.backend.id,
            config: {
                displayName,
                flavor: params.backend.id,
                policyAgentId,
                terminalDisplay: TerminalDisplay,
                formatPromptErrorMessage: (error) => `Error: ${error instanceof Error ? error.message : String(error)}`,
                createNativeRuntime: async (runtimeParams) => {
                    const sessionLaunchParams = buildPluginSessionLaunchParams({
                        backend: params.backend,
                        provider: params.provider,
                        input: params.sessionInput,
                        runtime: {
                            sessionId: runtimeParams.session.sessionId,
                            directory: runtimeParams.directory,
                            metadata: runtimeParams.metadata,
                        },
                    });
                    const launchResult = await params.launch(sessionLaunchParams);
                    const normalized = normalizePluginSessionLaunchResult({
                        result: launchResult,
                        backend: params.backend,
                    });
                    return decorateRuntimeTurnOperationsWithMetadata(normalized);
                },
            },
        }),
    });
}
