import {
  AGENTS_CORE,
  getAllBackendDefinitions,
  getAllBackendDefinitionContracts,
  getAllProviderDefinitionContracts,
  getProviderDefinition,
  getProviderCliRuntimeSpec,
} from '@happier-dev/agents';

import { agent as auggie } from '../../backends/auggie';
import { agent as claude } from '../../backends/claude';
import { agent as codex } from '../../backends/codex';
import { agent as copilot } from '../../backends/copilot';
import { agent as gemini } from '../../backends/gemini';
import { agent as kimi } from '../../backends/kimi';
import { agent as kilo } from '../../backends/kilo';
import { agent as kiro } from '../../backends/kiro';
import { agent as ohMyPi } from '../../backends/ohMyPi';
import { agent as pi } from '../../backends/pi';
import { agent as qwen } from '../../backends/qwen';
import type { AgentCatalogEntry, CatalogAgentId } from '../../backends/types';

import type { ResolvedActivationTarget, ResolvedContributionInputs, ResolvedProviderContribution } from './types';

const OPENCODE_CATALOG_ENTRY = Object.freeze({
    id: AGENTS_CORE.opencode.id,
    cliSubcommand: AGENTS_CORE.opencode.cliSubcommand,
    getCliDetect: async () => (await import('@/agent/acp/catalog/builtIn/detect')).createBuiltInCliDetect('opencode'),
    getCliAuthSpec: async () => (await import('@/agent/acp/catalog/builtIn/auth')).createBuiltInCliAuthSpec('opencode'),
    getDirectSessionProviderOps: async () =>
        (await import('@/session/directSessions/providers/opencode/providerOps'))
            .openCodeDirectSessionProviderOps,
    getConnectedServicesMaterializer: async () =>
        (await import('@/daemon/connectedServices/materialize/providers/opencode/createOpenCodeConnectedServicesMaterializer'))
            .createOpenCodeConnectedServicesMaterializer(),
    getManagedServerLaunchSpec: async () =>
        (await import('@/runtime/managedTools/requireProviderCliLaunchSpec'))
            .requireProviderCliLaunchSpec('opencode'),
    getProviderAttachOps: async () =>
        (await import('@/session/attach/providers/opencode/providerAttachOps'))
            .openCodeProviderAttachOps,
    getProviderNativeForkHandler: async () =>
        (await import('@/session/fork/providers/opencode/providerNativeForkHandler'))
            .openCodeProviderNativeForkHandler,
	    getAcpForkContinuationHandler: async () =>
	        (await import('@/session/fork/providers/opencode/acpForkContinuationHandler'))
	            .openCodeAcpForkContinuationHandler,
	    getReplayForkContinuationHandler: async () =>
	        (await import('@happier-dev/extensions-opencode'))
	            .opencodeReplayForkContinuationHandler,
	    getSessionHandoffProviderOps: async () =>
	        (await import('@/session/handoff/providers/opencode/providerOps'))
	            .openCodeSessionHandoffProviderOps,
	    vendorResumeSupport: AGENTS_CORE.opencode.resume.vendorResume,
} satisfies AgentCatalogEntry);

const OPENCODE_BUNDLED_ACTIVATION_TARGET = Object.freeze({
    provenance: 'external' as const,
    source: { kind: 'bundled' as const },
    pluginId: 'opencode',
    manifestPath: 'bundled:opencode',
    manifestDigest: 'bundled:opencode@0.0.0',
    daemonEntryPath: '@happier-dev/extensions-opencode',
    sourceSpec: {
        kind: 'package' as const,
        locator: '@happier-dev/extensions-opencode',
        trustPolicy: 'local_trusted' as const,
        installPolicy: 'link' as const,
        resolvedVersion: '0.0.0',
        resolvedDigest: 'bundled:opencode@0.0.0',
    },
} satisfies ResolvedActivationTarget);

const BUILT_IN_AGENT_CATALOG_ENTRIES = Object.freeze({
    claude,
    codex,
    gemini,
    opencode: OPENCODE_CATALOG_ENTRY,
    auggie,
    qwen,
    kimi,
    kilo,
    kiro,
    ohMyPi,
    pi,
    copilot,
}) satisfies Partial<Record<CatalogAgentId, AgentCatalogEntry>>;

type BuiltInCatalogEntryId = keyof typeof BUILT_IN_AGENT_CATALOG_ENTRIES;

// Built-in host catalog projection used for CLI/UI surfaces. This shape remains
// internal host vocabulary and is intentionally not a public plugin ABI contract.

function resolveBuiltInBackendRuntimeKind(
    richDefinition: ReturnType<typeof getAllBackendDefinitions>[number],
): string {
    return richDefinition.engine?.defaultRuntimeKind ?? 'native';
}

export function resolveBuiltInContributions(): ResolvedContributionInputs {
    const providers: ResolvedProviderContribution[] = [];
    const providerDefinitionIds = new Set(getAllProviderDefinitionContracts().map((definition) => definition.id));
    const catalogEntries = Object.freeze(
        Object.values(BUILT_IN_AGENT_CATALOG_ENTRIES)
            .filter((entry) => !providerDefinitionIds.has(entry.id)),
    );

    for (const providerDefinition of getAllProviderDefinitionContracts()) {
        const providerId = providerDefinition.id as BuiltInCatalogEntryId;
        const catalogEntry = BUILT_IN_AGENT_CATALOG_ENTRIES[providerId] as AgentCatalogEntry | undefined;
        if (!catalogEntry) {
            throw new Error(`Missing built-in catalog entry for provider '${providerId}'`);
        }
        providers.push({
            id: providerId,
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: providerDefinition,
            richDefinition: {
                provenance: 'first_party',
                definition: getProviderDefinition(providerId) ?? (() => {
                    throw new Error(`Missing built-in provider catalog definition '${providerId}'`);
                })(),
            },
            runtimeSpec: getProviderCliRuntimeSpec(providerId),
            catalogEntry,
        });
    }

    const backendCatalogDefinitionsById = new Map(
        getAllBackendDefinitions().map((definition) => [definition.id, definition] as const),
    );
    const backends = getAllBackendDefinitionContracts().map((backendDefinition) => {
        const richDefinition = backendCatalogDefinitionsById.get(backendDefinition.id as CatalogAgentId);
        if (!richDefinition) {
            throw new Error(`Missing built-in backend catalog definition '${backendDefinition.id}'`);
        }
        const catalogEntry = BUILT_IN_AGENT_CATALOG_ENTRIES[backendDefinition.id as BuiltInCatalogEntryId] as AgentCatalogEntry | undefined;
        const getBindings = catalogEntry?.getBindings;

        return {
            id: backendDefinition.id,
            providerId: backendDefinition.providerId,
            provenance: 'first_party' as const,
            source: { kind: 'bundled' as const },
            definition: backendDefinition,
            richDefinition: {
                provenance: 'first_party' as const,
                definition: richDefinition,
            },
            runtimeKind: resolveBuiltInBackendRuntimeKind(richDefinition),
            getBindings,
        };
    });

    return {
        providers: Object.freeze(providers),
        backends: Object.freeze(backends),
        catalogEntries,
        actions: Object.freeze([]),
        activationTargets: Object.freeze([OPENCODE_BUNDLED_ACTIVATION_TARGET]),
        hookRegistrations: Object.freeze([]),
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}
