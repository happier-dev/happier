import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { FavoriteModelBackendIdentity } from './favoriteModelSelections';

export function buildFavoriteBackendIdentity(entry: Pick<
    ResolvedBackendCatalogEntry,
    'backendTargetKey' | 'catalogAgentId' | 'builtInAgentId' | 'backendId' | 'kind'
>): FavoriteModelBackendIdentity {
    return {
        backendTargetKey: entry.backendTargetKey,
        catalogAgentId: entry.catalogAgentId,
        builtInAgentId: entry.builtInAgentId,
        configuredBackendId: entry.kind === 'configuredBackend' ? entry.backendId : null,
    };
}
