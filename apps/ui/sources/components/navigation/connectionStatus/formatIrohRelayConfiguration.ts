import type { DoctorSnapshotHomeTransportDiagnostics } from '@happier-dev/protocol/diagnostics/doctorSnapshot';

import { t } from '@/text';

type IrohRelayConfiguration = NonNullable<DoctorSnapshotHomeTransportDiagnostics['effectiveConfiguration']>;

/** Formats the one user-facing projection of applied Iroh relay policy. */
export function formatIrohRelayConfiguration(configuration: IrohRelayConfiguration): string {
    if (configuration.policy === 'disabled') {
        return t('connectionStatus.values.relayDisabledWithDirect', {
            direct: configuration.directAddressCount,
        });
    }

    const shownRelayCount = configuration.relayUrls.length;
    const totalRelayCount = configuration.relayUrlCount
        ?? (configuration.relayUrlsTruncated ? null : shownRelayCount);
    const relayList = shownRelayCount > 0
        ? configuration.relayUrls.join(', ')
        : t('connectionStatus.values.relayNone');
    const relayCount = totalRelayCount === null
        ? `${shownRelayCount}/${t('status.unknown')}`
        : `${shownRelayCount}/${totalRelayCount}`;

    return t('connectionStatus.values.relayAutomatic', {
        relays: `${relayList} (${relayCount})`,
        direct: configuration.directAddressCount,
    });
}
