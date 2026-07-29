import { describe, expect, it } from 'vitest';

import { PEER_MEDIATION_RECEIPTS, type MachineLiveStreamStartRequestV1 } from '@happier-dev/protocol';

import { openMachineLiveStreamRelayClient } from './relayClient';

function startRequest(): MachineLiveStreamStartRequestV1 {
    return {
        v: 1,
        streamId: 'stream_1',
        streamFamily: 'screen',
        routeKind: 'server_relay',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        viewerSocketId: 'socket_tab_1',
        maxBitrateBps: 64_000,
        maxFramesPerSecond: 12,
        maxFrameBytes: 32_000,
        maxDurationMs: 60_000,
        maxTotalBytes: 128_000,
        authorization: {
            payload: {
                v: 1,
                grantId: 'relay_grant_1',
                accountId: 'account_1',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                flowKind: 'live_stream',
                routeKind: 'server_relay',
                streamId: 'stream_1',
                streamFamily: 'screen',
                viewerSocketId: 'socket_tab_1',
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                maxDurationMs: 60_000,
                maxTotalBytes: 128_000,
                iat: 1_000,
                exp: 61_000,
                aud: 'happier-live-stream-relay-authorization',
            },
            signature: {
                keyId: 'relay_key_1',
                alg: 'Ed25519',
                valueBase64Url: 'AbCdEf012_-',
            },
        },
    };
}

function openInput(overrides?: Partial<Parameters<typeof openMachineLiveStreamRelayClient>[0]>) {
    return {
        serverId: 'server-a',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        streamId: 'stream_1',
        streamFamily: 'screen',
        viewerSocketId: 'socket_tab_1',
        caps: {
            maxBitrateBps: 64_000,
            maxFramesPerSecond: 12,
            maxFrameBytes: 32_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
        },
        startProduction: async (input) => input.routeKind === 'loopback_direct'
            ? { ok: false as const, reasonCode: 'topology_unavailable' }
            : {
                ok: true as const,
                routeKind: 'server_relay' as const,
                startRequest: startRequest(),
                relayAuthorization: startRequest().authorization!,
            },
        ...overrides,
    } satisfies Parameters<typeof openMachineLiveStreamRelayClient>[0];
}

describe('openMachineLiveStreamRelayClient', () => {
    it('tries loopback direct first and does not start the daemon relay when direct capture succeeds (SIM-P1-4)', async () => {
        const routeKinds: string[] = [];
        let daemonCalled = false;

        await expect(openMachineLiveStreamRelayClient(openInput({
            startProduction: async (input) => {
                routeKinds.push(input.routeKind);
                return {
                    ok: true as const,
                    routeKind: 'loopback_direct' as const,
                    response: {
                        v: 1,
                        ok: true,
                        receipt: PEER_MEDIATION_RECEIPTS.streamStarted,
                        streamId: input.streamId,
                        routeKind: 'loopback_direct',
                        expiresAtMs: 61_000,
                    },
                };
            },
            startDaemonRelay: async () => {
                daemonCalled = true;
                return { ok: true, streamId: 'stream_1' };
            },
        }))).resolves.toEqual({ ok: true, streamId: 'stream_1' });

        expect(routeKinds).toEqual(['loopback_direct']);
        expect(daemonCalled).toBe(false);
    });

    it('falls back to server relay and delivers the signed startRequest over machine RPC when loopback is unavailable', async () => {
        const routeKinds: string[] = [];
        const rpcStarts: Array<{ machineId: string; serverId?: string | null; startRequest: MachineLiveStreamStartRequestV1 }> = [];

        await expect(openMachineLiveStreamRelayClient(openInput({
            startProduction: async (input) => {
                routeKinds.push(input.routeKind);
                if (input.routeKind === 'loopback_direct') {
                    return { ok: false as const, reasonCode: 'topology_unavailable' };
                }
                return {
                    ok: true as const,
                    routeKind: 'server_relay' as const,
                    startRequest: startRequest(),
                    relayAuthorization: startRequest().authorization!,
                };
            },
            startDaemonRelay: async (input) => {
                rpcStarts.push(input);
                return { ok: true, streamId: input.startRequest.streamId };
            },
        }))).resolves.toEqual({ ok: true, streamId: 'stream_1' });

        expect(routeKinds).toEqual(['loopback_direct', 'server_relay']);
        expect(rpcStarts).toHaveLength(1);
        expect(rpcStarts[0]?.startRequest).toEqual(startRequest());
    });

    it('delivers the signed startRequest to the capture daemon over machine RPC (SIM-P0-1)', async () => {
        const rpcStarts: Array<{ machineId: string; serverId?: string | null; startRequest: MachineLiveStreamStartRequestV1 }> = [];
        await expect(openMachineLiveStreamRelayClient(openInput({
            startDaemonRelay: async (input) => {
                rpcStarts.push(input);
                return { ok: true, streamId: input.startRequest.streamId };
            },
        }))).resolves.toEqual({ ok: true, streamId: 'stream_1' });

        expect(rpcStarts).toHaveLength(1);
        expect(rpcStarts[0]?.machineId).toBe('machine_source');
        expect(rpcStarts[0]?.serverId).toBe('server-a');
        expect(rpcStarts[0]?.startRequest).toEqual(startRequest());
    });

    it('fails closed when the daemon relay start is denied', async () => {
        await expect(openMachineLiveStreamRelayClient(openInput({
            startDaemonRelay: async () => ({ ok: false, reasonCode: 'capture_source_unavailable' }),
        }))).resolves.toEqual({ ok: false, reasonCode: 'capture_source_unavailable' });
    });

    it('does not invoke the daemon when the relay mint fails', async () => {
        let daemonCalled = false;
        await expect(openMachineLiveStreamRelayClient(openInput({
            startProduction: async () => ({ ok: false as const, reasonCode: 'grant_missing' }),
            startDaemonRelay: async () => {
                daemonCalled = true;
                return { ok: true, streamId: 'stream_1' };
            },
        }))).resolves.toEqual({ ok: false, reasonCode: 'grant_missing' });
        expect(daemonCalled).toBe(false);
    });

    it('preserves the direct signing reason and capability when the independent relay is unavailable', async () => {
        await expect(openMachineLiveStreamRelayClient(openInput({
            startProduction: async (input) => input.routeKind === 'loopback_direct'
                ? {
                    ok: false as const,
                    reasonCode: 'peer_route_signing_identity_unavailable',
                    requiredCapability: 'peer_route_signing_identity_v1',
                }
                : { ok: false as const, reasonCode: 'server_relay_disabled' },
        }))).resolves.toEqual({
            ok: false,
            reasonCode: 'peer_route_signing_identity_unavailable',
            requiredCapability: 'peer_route_signing_identity_v1',
        });
    });
});
