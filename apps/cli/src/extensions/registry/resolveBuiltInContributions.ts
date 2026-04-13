import {
  getAllBackendDefinitionContracts,
  getProviderDefinitionContract,
  getProviderCliRuntimeSpec,
} from '@happier-dev/agents';

import { BUILT_IN_CATALOG_DEFINED_ACP_AGENTS } from '@/agent/acp/catalog';
import { agent as auggie } from '@/backends/auggie';
import { agent as claude } from '@/backends/claude';
import { agent as codex } from '@/backends/codex';
import { agent as copilot } from '@/backends/copilot';
import { agent as gemini } from '@/backends/gemini';
import { agent as kimi } from '@/backends/kimi';
import { agent as kilo } from '@/backends/kilo';
import { agent as opencode } from '@/backends/opencode';
import { agent as pi } from '@/backends/pi';
import { agent as qwen } from '@/backends/qwen';
import type { AgentCatalogEntry, CatalogAgentId } from '@/backends/types';

import type { ResolvedContributionInputs, ResolvedProviderContribution } from './types';

const BUILT_IN_AGENT_CATALOG_ENTRIES = Object.freeze({
    claude,
    codex,
    gemini,
    opencode,
    auggie,
    qwen,
    kimi,
    kilo,
    ...BUILT_IN_CATALOG_DEFINED_ACP_AGENTS,
    pi,
    copilot,
}) satisfies Record<CatalogAgentId, AgentCatalogEntry>;

export function resolveBuiltInContributions(): ResolvedContributionInputs {
    const providers: ResolvedProviderContribution[] = [];

    for (const [providerId, catalogEntry] of Object.entries(BUILT_IN_AGENT_CATALOG_ENTRIES)) {
        const providerDefinition = getProviderDefinitionContract(providerId as CatalogAgentId);
        if (!providerDefinition) {
            throw new Error(`Missing provider definition for built-in provider '${providerId}'`);
        }

        providers.push({
            id: providerId,
            source: 'built_in',
            definition: providerDefinition,
            runtimeSpec: getProviderCliRuntimeSpec(providerId as CatalogAgentId),
            catalogEntry,
        });
    }

    const backends = getAllBackendDefinitionContracts().map((backendDefinition) => ({
        id: backendDefinition.id,
        providerId: backendDefinition.providerId,
        source: 'built_in' as const,
        definition: backendDefinition,
    }));

    return {
        providers: Object.freeze(providers),
        backends: Object.freeze(backends),
        hookRegistrations: Object.freeze([]),
        pluginDiagnosticsByPluginId: Object.freeze({}),
    };
}
