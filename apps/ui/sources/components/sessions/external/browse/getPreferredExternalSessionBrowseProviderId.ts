import type { ExternalSessionsAgentId } from '@happier-dev/protocol';

export function getPreferredExternalSessionBrowseProviderId(
    providerIds: readonly ExternalSessionsAgentId[],
    selectedProviderId: ExternalSessionsAgentId | null,
): ExternalSessionsAgentId | null {
    if (selectedProviderId && providerIds.includes(selectedProviderId)) return selectedProviderId;
    return providerIds[0] ?? null;
}
