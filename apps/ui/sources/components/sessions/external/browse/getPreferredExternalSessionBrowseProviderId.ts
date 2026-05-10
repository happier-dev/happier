import type { ExternalSessionsProviderId } from '@happier-dev/protocol';

export function getPreferredExternalSessionBrowseProviderId(
    providerIds: readonly ExternalSessionsProviderId[],
    selectedProviderId: ExternalSessionsProviderId | null,
): ExternalSessionsProviderId | null {
    if (selectedProviderId && providerIds.includes(selectedProviderId)) return selectedProviderId;
    return providerIds[0] ?? null;
}
