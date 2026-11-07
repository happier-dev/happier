import { hasRemoteHomeApplicationCarrier } from '@happier-dev/cli-common/homeEnrollment';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';

/** Bootstrap exec/file protects enrollment material; it does not forward Home traffic. */
export function readManagedGuestHomeWarning(target: ResolvedHomeTarget) {
    // Descriptor admission remains the enrollment owner's responsibility. A
    // controller-local runtime URL cannot replace the guest's declared routes.
    if (!target.descriptor || hasRemoteHomeApplicationCarrier(target.descriptor)) return null;
    return {
        code: 'home_not_guest_reachable',
        status: 'This Home only offers a connection on the controller. Add a Home endpoint the new machine can reach before creating it.',
    } as const;
}
