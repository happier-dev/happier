import { CONNECTED_CLIENT_ROUTES, ConnectedClientsResponseSchema } from '@happier-dev/protocol';

import { serverFetch } from '@/sync/http/client';

/**
 * Reports that this client is connected now. Liveness only on the relay: no settings version or
 * account change. Relays without the endpoint answer 404; the device list then falls back to the
 * last-seen time older builds stored in settings.
 */
export async function apiReportConnectedClientSeen(clientId: string): Promise<void> {
    const response = await serverFetch(CONNECTED_CLIENT_ROUTES.seen, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
    }, {});
    if (!response.ok && response.status !== 404) {
        throw new Error(`Connected-client report failed with HTTP ${response.status}`);
    }
}

/** When each of this account's clients was last seen (client id → epoch ms); empty on older relays. */
export async function apiListConnectedClientsLastSeen(): Promise<Record<string, number>> {
    const response = await serverFetch(CONNECTED_CLIENT_ROUTES.list, { method: 'GET' }, {});
    if (response.status === 404) return {};
    if (!response.ok) throw new Error(`Connected-client list failed with HTTP ${response.status}`);
    const parsed = ConnectedClientsResponseSchema.parse(await response.json());
    return Object.fromEntries(parsed.clients.map((client) => [client.clientId, client.lastSeenAt]));
}
