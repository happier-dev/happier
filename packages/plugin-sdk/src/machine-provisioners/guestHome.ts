import { compareMachineHosts } from '@happier-dev/protocol/machines/host/normalizeMachineHost';

import type { MachineProvisionerGuestHomeV1 } from '../machineProvisioners.js';

export function isMachineProvisionerGuestHomeOnControllerHost(guestHome?: MachineProvisionerGuestHomeV1): boolean {
    const identity = guestHome?.hostIdentity;
    return compareMachineHosts(identity?.homeMachineHost, identity?.controllerMachineHost);
}
