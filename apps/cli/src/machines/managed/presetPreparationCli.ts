import type { MachineProvisionerContributionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

/** Prepare and acquire select the same supplier identity for the provider's delivery mode. */
export function selectManagedPresetPreparationCliDelivery(
    provisioner: Pick<MachineProvisionerContributionV1, 'preparation'>, homeId: string,
): Readonly<{ guestDownload?: Readonly<{ homeId: string }> }> {
    return provisioner.preparation?.cliPayloadDelivery === 'guest-download' ? { guestDownload: { homeId } } : {};
}
