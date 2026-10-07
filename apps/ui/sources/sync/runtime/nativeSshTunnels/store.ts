import { buildSshTarget, parseSshTarget } from '@happier-dev/protocol/ssh/sshTarget';

import type { NativeSshTunnelRequest } from './types';

/** Normalized SSH lease identity: host/user/port/destination facts, never credentials. */
export function buildNativeSshTunnelKey(request: NativeSshTunnelRequest): string {
    const parsedTarget = parseSshTarget(request.sshTarget);
    return JSON.stringify({
        remoteHostId: request.remoteHostId.trim(),
        sshTarget: buildSshTarget({
            username: parsedTarget.username.trim(),
            host: parsedTarget.host.trim().toLowerCase(),
        }),
        sshPort: request.sshPort ?? 22,
        destinationHost: request.destinationHost.trim().toLowerCase(),
        destinationPort: request.destinationPort,
        purpose: request.purpose,
    });
}
