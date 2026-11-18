import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    type PeerTcpTunnelRelayEnvelope,
} from '@happier-dev/protocol';
import { vi } from 'vitest';
import { createExternalProviderBrokerDispatcher } from './externalProviderBrokerDispatcher';

/** Relay transport boundary; keep the actual carrier and HTTP decoder real. */
export async function dispatchWithUpstreamResponse(response: Uint8Array, options: Readonly<{
    enabled?: boolean; env?: NodeJS.ProcessEnv; relaySocketId?: string; closeOnOpen?: boolean;
    denyOnOpen?: boolean; cancellation?: AbortController;
}> = {}) {
    let receive: ((envelope: PeerTcpTunnelRelayEnvelope) => void) | undefined;
    let responseSent = false;
    const relaySocketId = options.relaySocketId ?? 'relay-socket-1';
    const machineId = 'broker-machine-1';
    const accountId = 'custodian-account-1';
    let transportCloseCount = 0;
    const dispatch = createExternalProviderBrokerDispatcher({
        enabled: () => options.enabled ?? true,
        env: options.env ?? {
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'test-key',
            HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.alloc(32, 7).toString('base64url'),
        },
        createRelayTransport: () => ({
            relaySocketId,
            subscribe(handler) { receive = handler; return () => {}; },
            close() { transportCloseCount += 1; },
            send(_event, envelope) {
                if (options.denyOnOpen && envelope.v === 1 && envelope.frame.kind === 'open') {
                    // The registered Home relay sends its terminal refusal
                    // to the owner with the original envelope participants.
                    receive?.({ ...envelope, frame: { v: 1, kind: 'abort',
                        tunnelId: envelope.frame.open.tunnelId, reasonCode: 'route_unavailable' } });
                    return;
                }
                if (options.denyOnOpen) return;
                if (options.closeOnOpen && envelope.v === 1 && envelope.frame.kind === 'open') {
                    receive?.({ ...envelope, sender: { kind: 'machine', machineId },
                        recipient: { kind: 'user', socketId: relaySocketId },
                        frame: { v: 1, kind: 'close', tunnelId: envelope.frame.open.tunnelId,
                            halfClose: false, reasonCode: 'completed' } });
                    return;
                }
                if (envelope.v !== 2 || responseSent) return;
                const decoded = decodePeerTcpTunnelBinaryFrameV2({
                    frame: envelope.frame,
                    maxHeaderBytes: 64 * 1024,
                    maxPayloadBytes: 64 * 1024,
                });
                if (!decoded.ok || decoded.header.kind !== 'data') return;
                responseSent = true;
                receive?.({
                    v: 2,
                    scopeUserId: accountId,
                    sender: { kind: 'machine', machineId },
                    recipient: { kind: 'user', socketId: relaySocketId },
                    encoding: 'binary_frame_v2',
                    frame: encodePeerTcpTunnelBinaryFrameV2({
                        header: {
                            version: 2,
                            kind: 'data',
                            tunnelId: decoded.header.tunnelId,
                            substreamId: decoded.header.substreamId,
                            direction: 'daemon_to_client',
                            sequence: 0,
                            payloadLength: response.byteLength,
                        },
                        payload: response,
                    }),
                });
                receive?.({
                    v: 2,
                    scopeUserId: accountId,
                    sender: { kind: 'machine', machineId },
                    recipient: { kind: 'user', socketId: relaySocketId },
                    encoding: 'binary_frame_v2',
                    frame: encodePeerTcpTunnelBinaryFrameV2({ header: {
                        version: 2, kind: 'close', tunnelId: decoded.header.tunnelId,
                        substreamId: decoded.header.substreamId, direction: 'daemon_to_client',
                        halfClose: true, reasonCode: 'upstream_eof', payloadLength: 0,
                    } }),
                });
            },
        }),
    });

    const cancellation = options.cancellation ?? new AbortController();
    const removeAbortListener = vi.spyOn(cancellation.signal, 'removeEventListener');
    const result = await dispatch({
        target: { custodianAccountId: accountId, brokerMachineId: machineId, operationId: null, brokerPlacementFingerprint: 'a'.repeat(64) },
        signal: cancellation.signal,
        request: {
            v: 1,
            requestId: 'request-1',
            teamId: 'team-1',
            resourceId: 'resource-1',
            caller: {
                kind: 'external_api_key',
                keyId: '550e8400-e29b-41d4-a716-446655440000',
                assignedAccountId: 'account-1',
                assignedTeamMembershipId: 'membership-1',
            },
            route: 'models',
            method: 'GET',
            pathAndQuery: '/v1/models',
            bodyBase64: null,
        },
    });

    return { result, removeAbortListener, transportCloseCount: () => transportCloseCount };
}
