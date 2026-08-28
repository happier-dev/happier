import {
    resolveAgentCatalogProjection,
    type ResolvedAgentCatalogEntry,
} from '@/agents/backendCatalog/agentCatalogProjection';
import type {
    MergedBackendProjectionEntry,
    MergedProviderProjectionEntry,
} from '@/agents/backendCatalog/mergedProjectionTypes';

/** Canonical Agent-catalog fixture; tests do not reconstruct presentation fields. */
export function createResolvedAgentCatalogEntryFixture(params: Readonly<{
    agentId: string;
    mergedBackendProjectionById?: Readonly<Record<string, MergedBackendProjectionEntry>> | null;
    mergedProviderProjectionById?: Readonly<Record<string, MergedProviderProjectionEntry>> | null;
    overrides?: Partial<ResolvedAgentCatalogEntry>;
}>): ResolvedAgentCatalogEntry {
    return {
        ...resolveAgentCatalogProjection(params.agentId, {
            enabledAgentIds: [params.agentId],
            mergedBackendProjectionById: params.mergedBackendProjectionById,
            mergedProviderProjectionById: params.mergedProviderProjectionById,
        }),
        ...params.overrides,
    };
}
