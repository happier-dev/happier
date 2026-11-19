import { resolveObservedReversePairingHome } from '@/auth/pairing/resolveReversePairingHome';
import { getServerProfileById, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { useViewportClass } from '@/utils/platform/useViewportClass';

/**
 * The requester-displayed direction needs one unambiguous saved Home to display a
 * QR for. A focused Welcome supplies its exact profile; targetless restore
 * offers this direction only when one profile has a usable observed address.
 */
export function resolveReverseQrTargetProfileId(selectedProfileId?: string): string | null {
    if (selectedProfileId) {
        const profile = getServerProfileById(selectedProfileId);
        return profile && resolveObservedReversePairingHome(profile) ? profile.id : null;
    }
    const eligible = listServerProfiles().filter(resolveObservedReversePairingHome);
    return eligible.length === 1 ? eligible[0].id : null;
}

/**
 * Which way Login leads with on this device: a phone with the pairing link and its camera, a computer
 * with the recovery key it can paste. The Login screen orders its ways by this and the Welcome door that
 * opens it promises the same order, so the two never disagree.
 */
export function useLoginLeadsWithLink(): boolean {
    return useViewportClass() === 'compact';
}

/** Whether Login can involve a QR code here: this device scans one, or shows one for its single saved Home. */
export function loginOffersQr(): boolean {
  return (
    canUseCurrentDeviceQrScanner() || resolveReverseQrTargetProfileId() !== null
  );
}

/**
 * Whether Login starts on this device's camera: a phone (Login leads with the link) that can scan. The Welcome's
 * scan door, the wizard's scan step and Login's first view all read this one decision; a computer opens Login's
 * one screen, where the camera stays one press away.
 */
export function useLoginScansFirst(): boolean {
    return useLoginLeadsWithLink() && canUseCurrentDeviceQrScanner();
}
