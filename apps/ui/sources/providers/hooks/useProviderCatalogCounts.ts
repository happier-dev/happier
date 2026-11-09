import * as React from 'react';
import type { ProviderDeclarationContext } from '@/providers/catalog/accountProviderDeclarations';
import { projectAccountProviderCatalogCountsV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';

import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { useProviderCatalogForServer } from '@/sync/store/useProviderCatalog';

/** Counts follow Account rows; admitted declarations supply their portable model facts. */
export function useProviderCatalogCounts(serverId: string | null, declarationContext: ProviderDeclarationContext,
    options?: Readonly<{ enabled?: boolean }>) {
    const catalog = useProviderCatalogForServer(serverId, undefined, options);
    return React.useMemo(() => catalog?.data
        ? projectAccountProviderCatalogCountsV1({ catalog: catalog.data, definitions: readAccountProviderDeclarations(declarationContext) })
        : null, [catalog?.data, declarationContext]);
}
