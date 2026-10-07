import { IrohMachineHandshakeV1Schema } from '@happier-dev/protocol/connectivity/iroh/machineHandshakeV1';
import { PeerTcpTunnelOpenV2Schema, PEER_TCP_TUNNEL_OPEN_PATH_V2, type PeerTcpTunnelOpenV2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/openAuthorizationV2';
import { PeerTcpTunnelOpenResponseV1Schema, PEER_TCP_TUNNEL_STREAM_PATH, type PeerTcpTunnelOpenV1, type PeerTcpTunnelOpenResponseV1 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/v1';
import { parseIrohEndpointDescriptorV1, type IrohEndpointDescriptorV1 } from '@happier-dev/protocol/connectivity/iroh/endpointDescriptorV1';

import { getIrohApplicationEndpoint, startIrohMachineHttpTunnel } from '@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { openPeerTcpTunnelLoopbackStream, type PeerTcpTunnelWebSocketCtor } from './loopbackStream';
import type { PeerTcpTunnelClientStream } from './client';

/** The access/grant owner supplies a fresh signed route, never a mutated loopback grant. */
export type PeerTcpTunnelIrohRoute =
    | Readonly<{ kind: 'selected'; open: PeerTcpTunnelOpenV2; endpoint: IrohEndpointDescriptorV1 }>
    | Readonly<{ kind: 'unavailable'; reasonCode: string }>;

function assertNotAborted(signal: AbortSignal | null | undefined): void {
    if (signal?.aborted) throw Object.assign(new Error('Peer TCP tunnel open aborted'), { name: 'AbortError' });
}

export async function openPeerTcpTunnelIrohStream(input: Readonly<{
    selected: Extract<PeerTcpTunnelIrohRoute, { kind: 'selected' }>;
    requestedOpen: PeerTcpTunnelOpenV1 | PeerTcpTunnelOpenV2;
    signal?: AbortSignal | null;
    WebSocketCtor?: PeerTcpTunnelWebSocketCtor;
    openTimeoutMs?: number;
}>): Promise<Readonly<{ response: PeerTcpTunnelOpenResponseV1; stream: PeerTcpTunnelClientStream }>> {
    assertNotAborted(input.signal);
    const open = PeerTcpTunnelOpenV2Schema.parse(input.selected.open);
    const endpoint = parseIrohEndpointDescriptorV1(input.selected.endpoint);
    const binding = open.grant.payload.iroh;
    if (
        open.routeKind !== 'iroh_peer'
        || !binding
        || binding.operationKind !== 'tcp_tunnel'
        || binding.initiator.kind !== 'account_client'
        || binding.target.endpointId !== endpoint.endpointId
        || open.targetMachineId !== input.requestedOpen.targetMachineId
        || open.tunnelId !== input.requestedOpen.tunnelId
        || open.destination.host !== input.requestedOpen.destination?.host
        || open.destination.port !== input.requestedOpen.destination?.port
    ) throw new Error('Peer TCP tunnel native route scope mismatch');
    const applicationEndpoint = await getIrohApplicationEndpoint();
    if (applicationEndpoint.endpointId !== binding.initiator.endpointId) {
        throw new Error('Peer TCP tunnel native initiator mismatch');
    }
    assertNotAborted(input.signal);
    const handshake = IrohMachineHandshakeV1Schema.parse({
        v: 1, accountId: open.grant.payload.accountId, flow: 'tcp_tunnel',
        initiator: binding.initiator, target: binding.target,
        grant: open.grant, proof: open.proof,
    });
    const lease = await startIrohMachineHttpTunnel({
        endpointId: endpoint.endpointId,
        directAddresses: endpoint.directAddresses,
        relayUrls: endpoint.relayUrls,
        handshakeJson: JSON.stringify(handshake),
    });
    try {
        assertNotAborted(input.signal);
        const control = await runtimeFetch(new URL(PEER_TCP_TUNNEL_OPEN_PATH_V2, lease.localOrigin), {
            method: 'POST',
            headers: { ...lease.requestHeaders, 'content-type': 'application/json' },
            body: JSON.stringify(open),
            signal: input.signal,
        });
        if (!control.ok) throw new Error(`Peer TCP tunnel native open rejected (${control.status})`);
        const response = PeerTcpTunnelOpenResponseV1Schema.parse(await control.json());
        // Authentication is local-only: never follow an application-selected
        // WebSocket origin/path with the native listener capability.
        if (response.tunnelId !== open.tunnelId || response.streamPath !== PEER_TCP_TUNNEL_STREAM_PATH) {
            throw new Error('Peer TCP tunnel native open response mismatch');
        }
        const stream = await openPeerTcpTunnelLoopbackStream({
            endpointUrl: lease.localOrigin, open, response,
            WebSocketCtor: input.WebSocketCtor,
            webSocketProtocols: lease.webSocketProtocols,
            openTimeoutMs: input.openTimeoutMs,
            signal: input.signal,
            onRetired: () => { void lease.release().catch(() => undefined); },
        });
        return { response, stream: {
            ...stream,
            close: async () => {
                await stream.close();
                await lease.release();
            },
        } };
    } catch (error) {
        await lease.release().catch(() => undefined);
        throw error;
    }
}
