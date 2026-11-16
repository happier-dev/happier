import { resolveServerHttpBaseUrl } from './serverHttpBaseUrl';
import { readStoredCredentials } from '@/persistence';
import { createSessionSocketTransport } from '@/api/session/connection/createSessionSocketTransport';
import { createUserScopedSocket } from '@/api/session/sockets';
import { openAccountUpdatesSocket } from '@/api/session/sharedAccountUpdatesSocket';
import type { SessionClientTransport } from '@/api/session/client/transport/sessionClientTransport';
import { configuration } from '@/configuration';
import { bindToHostedSessionScope } from '@/agent/runtime/lifecycle/hostedSessionScope';

/** Ordinary Account clients retain AccessKey provisioning and Account updates. */
export function createAccountSessionClientTransport(token: string): SessionClientTransport {
    const serverId = configuration.activeServerId;
    const serverUrl = resolveServerHttpBaseUrl();
    return Object.freeze({
        serverId,
        serverUrl,
        createSessionSocketTransport: bindToHostedSessionScope((binding: Parameters<SessionClientTransport['createSessionSocketTransport']>[0]) =>
            createSessionSocketTransport({ token, serverUrl, ...binding })),
        // One Account update connection per process and credential (a session host holds many Sessions).
        createAccountUpdatesSocket: bindToHostedSessionScope(() => openAccountUpdatesSocket(`${serverUrl}\n${token}`,
            () => createUserScopedSocket({ token, serverUrl }))),
        resolveToken: async () => (await readStoredCredentials())?.token ?? null,
    });
}
