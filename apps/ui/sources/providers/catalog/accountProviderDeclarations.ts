import type { AgentProviderRequirementsV1 } from '@happier-dev/protocol/providers/binding-compatibility';
import type { AccountProviderDeclarationV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';
import { parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import {
    BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS,
    BUNDLED_CANONICAL_AGENT_DECLARATIONS,
} from '@/agents/registry/generatedBundledPluginEntries';

const providerDeclarations: readonly AccountProviderDeclarationV1[] = Object.freeze(Object.values(BUNDLED_ACCOUNT_PROVIDER_DECLARATIONS));

/** Admitted portable source facts only. Dynamic plugins need their current declaration authority. */
export function readAccountProviderDeclarations(): readonly AccountProviderDeclarationV1[] {
    return providerDeclarations;
}

export function readAccountAgentProviderRequirements(agentTargetKey: string): AgentProviderRequirementsV1 | null {
    let target: ReturnType<typeof parseBackendTargetKeyV2>;
    try { target = parseBackendTargetKeyV2(agentTargetKey); } catch { return null; }
    if (target.kind === 'agent') {
        if (target.definitionId !== undefined) return null;
        return Object.values(BUNDLED_CANONICAL_AGENT_DECLARATIONS).find(declaration =>
            declaration.identity.pluginId === target.identity.pluginId
            && declaration.identity.localId === target.identity.localId)?.providerRequirements ?? null;
    }
    if (target.configuredBackendId !== undefined || target.sourceKind === 'configured') return null;
    return Object.entries(BUNDLED_CANONICAL_AGENT_DECLARATIONS).find(([routingId]) => routingId === target.backendId)
        ?.[1]?.providerRequirements ?? null;
}
