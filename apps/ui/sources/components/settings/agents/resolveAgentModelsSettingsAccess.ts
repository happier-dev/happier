import { composeProviderSettingsV1, DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, type ProviderConnectionsCatalogV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { ProviderSettingsV1 } from '@happier-dev/protocol/providers/settings/v1';

export type AgentModelsSettingsAccess = Readonly<{
    writable: boolean;
    settings: ProviderSettingsV1;
}>;

export function resolveAgentModelsSettingsAccess(snapshot: Readonly<{ status: 'loading' | 'ready' | 'partial' | 'unavailable'; data: ProviderConnectionsCatalogV1 | null; stale?: boolean }> | null): AgentModelsSettingsAccess {
    return {
        writable: snapshot?.status === 'ready' && snapshot.data !== null && !snapshot.stale,
        settings: composeProviderSettingsV1(snapshot?.data ?? DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, {}),
    };
}
