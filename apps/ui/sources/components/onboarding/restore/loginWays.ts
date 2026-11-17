import {
  buildHomeConnectionDescriptorForProfile,
  listServerProfiles,
} from '@/sync/domains/server/serverProfiles';
import { canUseCurrentDeviceQrScanner } from '@/utils/platform/qrScannerSupport';
import { useViewportClass } from '@/utils/platform/useViewportClass';

/**
 * The requester-displayed direction needs one unambiguous saved Home to display a
 * QR for. Resolve it from the saved profiles this device already knows, and only
 * when exactly one of them can produce an established connection descriptor;
 * ambiguity stays on the scanner rather than guessing an enrollment target.
 */
export function resolveReverseQrTargetProfileId(): string | null {
  let resolved: string | null = null;
  for (const profile of listServerProfiles()) {
    const descriptor = buildHomeConnectionDescriptorForProfile(profile);
    if (
      !descriptor ||
      profile.serverIdentityId !== descriptor.homeServerIdentityId
    )
      continue;
    if (resolved) return null;
    resolved = profile.id;
  }
  return resolved;
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
