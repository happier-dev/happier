import { useMemo } from 'react';
import { listConnectedConfigurationCatalogSavedSecretRefsV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';

/** Connected services retain their incumbent references when a resource changes storage. */
export function useSavedSecretExportReferences(scope: ServerAccountScope | null, active: boolean) {
    const catalog = useConnectedAccountCatalog('configurations', scope, { enabled: active });
    const references = useMemo(() => catalog.value ? listConnectedConfigurationCatalogSavedSecretRefsV1(catalog.value) : [], [catalog.value]);
    return { status: catalog.status, stale: catalog.stale, reason: catalog.reason, references };
}
