import { selectConnectedServiceQuotaMetersForLimitSelection } from '@happier-dev/protocol/connect/connectedServiceQuotaLimitSelection';
import type { ConnectedServiceQuotaLimitSelectionV1, ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol/connect/connected-service-schemas';

type QuotaSnapshot = Pick<ConnectedServiceQuotaSnapshotV1, 'meters'>;

/**
 * Projects quota meters through a Pool policy while preserving subscription,
 * account, reset-credit, freshness, and identity facts from the source snapshot.
 */
export function projectConnectedServiceQuotaSnapshotForLimitSelection<T extends QuotaSnapshot>(
    snapshot: T | null,
    selection?: ConnectedServiceQuotaLimitSelectionV1,
): T | null {
    if (!snapshot || !selection || selection.mode === 'all') return snapshot;
    return {
        ...snapshot,
        meters: [...selectConnectedServiceQuotaMetersForLimitSelection(snapshot.meters, selection)],
    };
}
