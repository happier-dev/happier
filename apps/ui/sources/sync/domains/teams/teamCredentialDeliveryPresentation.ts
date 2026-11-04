import type { TeamCredentialDeliveryModeV1, TeamCredentialRouteV1 } from '@happier-dev/protocol/teams';
import { t } from '@/text';

/** Presentation only: route allowance and resolution remain their owners' facts. */
export function deliveryModeLabel(mode: TeamCredentialDeliveryModeV1 | TeamCredentialRouteV1 | readonly TeamCredentialRouteV1[]): string {
    if (typeof mode !== 'string') {
        return mode.length === 2 && mode.includes('brokered') && mode.includes('direct')
            ? t('teams.credentials.delivery.both')
            : mode.map(route => deliveryModeLabel(route)).join(' · ');
    }
    switch (mode) {
        case 'brokered': return t('teams.credentials.delivery.brokered');
        case 'direct': return t('teams.credentials.delivery.direct');
        case 'both': return t('teams.credentials.delivery.both');
        case 'vendor-native': return t('teams.credentials.delivery.vendorNative');
    }
}
