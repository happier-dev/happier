import { resolveObservedReversePairingHome } from '@/auth/pairing/resolveReversePairingHome';
import { getServerProfileById, listServerProfiles } from '@/sync/domains/server/serverProfiles';
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
