import { hasRemoteHomeApplicationCarrier, resolveDescriptorApplicationOrigin } from '@happier-dev/cli-common/homeEnrollment';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { MachineProvisionerGuestHomeV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

/** Resolve the already-selected application carrier on the creating controller. */
export async function resolveManagedGuestHome(target: ResolvedHomeTarget, hostIdentity?: MachineProvisionerGuestHomeV1['hostIdentity']): Promise<MachineProvisionerGuestHomeV1 | null> {
    const origin = target.descriptor ? resolveDescriptorApplicationOrigin(target.descriptor) : target.applicationUrl;
    if (!origin) return null;
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/gu, '');
    const identity = hostIdentity ? { hostIdentity } : {};
    if (isIP(hostname)) return { origin, addresses: [], ...identity };
    try {
        return { origin, addresses: (await lookup(hostname, { all: true })).map(result => result.address), ...identity };
    } catch {
        // A descriptor can also offer Iroh. Actual guest enrollment owns carrier
        // availability; unresolved HTTPS must not become a new admission refusal.
        return { origin, addresses: [], ...identity };
    }
}

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
