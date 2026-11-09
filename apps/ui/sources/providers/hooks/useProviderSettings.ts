import * as React from 'react';
import { composeProviderSettingsV1, DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { useSetting } from '@/sync/domains/state/storage';
import { useProviderCatalogSelection } from '@/sync/store/useProviderCatalog';
import type { ProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

const emptyDefaults = Object.freeze({});
const readData = (snapshot: ProviderCatalogSnapshot | null) => snapshot?.data ?? DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1;

/** Transient display view only: effect owners must demand the complete row snapshot. */
export function useProviderSettings(scope?: ServerAccountScope | null) {
    const active = useAccountSettingsScope();
    const data = useProviderCatalogSelection(readData, scope);
    const defaults = useSetting('providerDefaultModelSelectionsByAgentTargetKeyV1');
    const captured = scope === undefined ? active : scope;
    const scopedDefaults = captured && areServerAccountScopesEqual(captured, active) ? defaults : emptyDefaults;
    return React.useMemo(() => composeProviderSettingsV1(data, scopedDefaults), [data, scopedDefaults]);
}
export function useProviderSettingsForServer(serverId?: string | null) {
    const active = useAccountSettingsScope();
    return useProviderSettings(serverId === undefined ? active : serverId && active
        && areServerProfileIdentifiersEquivalent(serverId, active.serverId) ? active : null);
}
