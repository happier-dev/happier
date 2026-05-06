import type { RemoteHost } from '@/sync/domains/remoteHosts/remoteHostModel';

import type { AccessEndpointRemediationAction } from '../accessEndpointModel';
import {
    createAccessEndpointRemediationAction,
    createScopedAccessEndpointRemediationAction,
} from '../accessEndpointRemediation';

export type RemoteHostAccessEndpointInput = Pick<RemoteHost, 'id' | 'name' | 'ssh'>;

export function buildRemoteHostAccessEndpointRemediations(
    remoteHosts: readonly RemoteHostAccessEndpointInput[],
): readonly AccessEndpointRemediationAction[] {
    return [
        createAccessEndpointRemediationAction('remoteHost.add'),
        ...remoteHosts.map((host) => createScopedAccessEndpointRemediationAction({
            id: `remote-host:${host.id}:setup`,
            ownerSurface: 'remoteHost.setup',
            payload: {
                remoteHostId: host.id,
            },
        })),
    ];
}
