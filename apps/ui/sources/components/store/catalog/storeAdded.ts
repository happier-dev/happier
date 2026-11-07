import * as React from 'react';
import { findHeldSkillV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { areProviderContributionKeysEqualV1 } from '@happier-dev/protocol/providers/contribution-identity';
import type { ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';

import { findAddedMcpServer } from '@/components/settings/mcpServers/add/mcpAddModalConfig';
import { findAddedAgentDefinition } from '@/components/settings/agents/add/agentAddRows';
import { useMcpServerCatalogForServer } from '@/components/settings/mcpServers/useMcpServersSettings';
import type { RegistryCatalogItemSummary } from '@/registries/registryBrandMark';
import { useSkillsLibrary } from '@/sync/domains/skills/useSkillsLibrary';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useAcpCatalogData } from '@/sync/store/useAcpCatalog';
import { useProviderCatalogSelection } from '@/sync/store/useProviderCatalog';
import type { ProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';

const EMPTY_SERVERS = Object.freeze([]);
const EMPTY_DEFINITIONS = Object.freeze([]);
const EMPTY_CONNECTIONS: ProviderConnectionsCatalogV1['connections'] = [];
const readConnections = (snapshot: ProviderCatalogSnapshot | null) => snapshot?.data?.connections ?? EMPTY_CONNECTIONS;

// Added is Account membership. Machine placement, reach and attention belong to
// Installed; acquiring them here wakes every catalog row for unrelated Machine arrivals.
export function useMcpAdded(presented: boolean): (item: RegistryCatalogItemSummary) => boolean {
    const scope = useActiveServerAccountScopeLifetime()?.scope ?? null;
    const native = useMcpServerCatalogForServer(scope?.serverId, presented, scope);
    const servers = native.value?.servers ?? EMPTY_SERVERS;
    return React.useCallback(item => findAddedMcpServer(servers, item) !== null, [servers]);
}

export function useSkillAdded(presented: boolean): (item: RegistryCatalogItemSummary) => boolean {
    const scope = useActiveServerAccountScopeLifetime()?.scope ?? null;
    const library = useSkillsLibrary(scope, { enabled: presented });
    return React.useCallback(item => findHeldSkillV1(library.items, { registry: item }) !== null, [library.items]);
}

export function useAgentAdded(presented: boolean): (item: RegistryCatalogItemSummary) => boolean {
    const scope = useActiveServerAccountScopeLifetime()?.scope ?? null;
    const catalog = useAcpCatalogData(scope, { enabled: presented });
    const definitions = catalog?.definitions ?? EMPTY_DEFINITIONS;
    return React.useCallback(item => findAddedAgentDefinition(definitions, item) !== null, [definitions]);
}

export function useProviderAdded(presented: boolean): (contributionKey: string) => boolean {
    const scope = useActiveServerAccountScopeLifetime()?.scope ?? null;
    const connections = useProviderCatalogSelection(readConnections, scope, { enabled: presented });
    const keys = React.useMemo(() => connections.flatMap(connection => connection.source.kind === 'contribution'
        ? [connection.source.contributionKey] : []), [connections]);
    return React.useCallback(key => keys.some(held => areProviderContributionKeysEqualV1(held, key)), [keys]);
}
