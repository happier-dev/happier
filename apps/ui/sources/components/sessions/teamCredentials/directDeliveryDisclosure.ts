import { presentMachineAuthorityV1, type MachineAuthorityPresentationV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { t } from '@/text';

export type DirectDeliveryVisibility = MachineAuthorityPresentationV1['deliveredMaterial'];
export type DirectDeliveryDisclosureTranslationKey =
    | 'teams.credentials.directUse.ownerVisibility'
    | 'teams.credentials.directUse.sharedUserVisibility';

/** Unknown target/setup keeps both warnings through the existing authority presenter. */
export function readDirectDeliveryVisibility(): DirectDeliveryVisibility {
    return presentMachineAuthorityV1({}).deliveredMaterial;
}

/** One copy projection for the existing choice rows and first-use review. */
export function describeDirectDeliveryVisibility(
    visibility: DirectDeliveryVisibility,
    translate: (key: DirectDeliveryDisclosureTranslationKey) => string = t,
): string {
    return [
        visibility.ownerVisible ? translate('teams.credentials.directUse.ownerVisibility') : null,
        visibility.sharedUserPeerVisible ? translate('teams.credentials.directUse.sharedUserVisibility') : null,
    ].filter((value): value is string => value !== null).join('\n\n');
}
