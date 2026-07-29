import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { MachineLiveStreamStartRequestV1 } from '@happier-dev/protocol';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';

import { registerDaemonLiveStreamRelayHandlers } from './daemonLiveStreamRelay';

function createRegistrar(): { handlers: Map<string, (payload: unknown) => Promise<unknown>>; registrar: RpcHandlerRegistrar } {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    return {
        handlers,
        registrar: {
            registerHandler(method, handler) {
                handlers.set(method, handler as (payload: unknown) => Promise<unknown>);
            },
        },
    };
}

function createSignedStartRequest(overrides?: Partial<MachineLiveStreamStartRequestV1>): MachineLiveStreamStartRequestV1 {
    return {
        v: 1,
        streamId: 'stream_1',
        streamFamily: 'screen',
        routeKind: 'server_relay',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_source',
        viewerSocketId: 'socket_tab_1',
        maxBitrateBps: 64_000,
        maxFramesPerSecond: 12,
        maxFrameBytes: 32_000,
        maxDurationMs: 60_000,
        maxTotalBytes: 128_000,
        authorization: {
            payload: {
                v: 1,
                grantId: 'grant_1',
                accountId: 'account_1',
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_source',
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
                keyId: 'key_1',
                alg: 'Ed25519',
                valueBase64Url: 'c2ln',
            },
        },
        ...overrides,
    } as MachineLiveStreamStartRequestV1;
}

describe('daemon live-stream relay rpc handlers', () => {
    it('starts the relay terminator from a signed startRequest delivered over machine rpc (SIM-P0-1)', async () => {
        const started: MachineLiveStreamStartRequestV1[] = [];
        const { handlers, registrar } = createRegistrar();
        registerDaemonLiveStreamRelayHandlers(registrar, {
            relay: {
                start: async (startRequest) => {
                    started.push(startRequest);
                    return { ok: true, streamId: startRequest.streamId };
                },
            },
        });

        expect((RPC_METHODS as Record<string, string>).DAEMON_LIVE_STREAM_RELAY_START)
            .toBe('daemon.machines.liveStream.relay.start');

        const startRequest = createSignedStartRequest();
        await expect(handlers.get(RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START)?.({
            protocolVersion: 1,
            machineId: 'machine_source',
            startRequest,
        })).resolves.toEqual({
            protocolVersion: 1,
            result: { ok: true, streamId: 'stream_1' },
        });
        expect(started).toHaveLength(1);
        expect(started[0]?.streamId).toBe('stream_1');
    });

    it('fails closed when the relay terminator is unavailable', async () => {
        const { handlers, registrar } = createRegistrar();
        registerDaemonLiveStreamRelayHandlers(registrar, { relay: null });

        await expect(handlers.get(RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START)?.({
            protocolVersion: 1,
            machineId: 'machine_source',
            startRequest: createSignedStartRequest(),
        })).resolves.toEqual({
            protocolVersion: 1,
            result: { ok: false, reasonCode: 'live_stream_relay_unavailable' },
        });
    });

    it('propagates terminator denials as typed reason codes', async () => {
        const { handlers, registrar } = createRegistrar();
        registerDaemonLiveStreamRelayHandlers(registrar, {
            relay: {
                start: async () => ({ ok: false, reasonCode: 'capture_source_unavailable' }),
            },
        });

        await expect(handlers.get(RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START)?.({
            protocolVersion: 1,
            machineId: 'machine_source',
            startRequest: createSignedStartRequest(),
        })).resolves.toEqual({
            protocolVersion: 1,
            result: { ok: false, reasonCode: 'capture_source_unavailable' },
        });
    });

    it('rejects unsigned server-relay start requests at the schema boundary', async () => {
        const { handlers, registrar } = createRegistrar();
        registerDaemonLiveStreamRelayHandlers(registrar, {
            relay: {
                start: async (startRequest) => ({ ok: true, streamId: startRequest.streamId }),
            },
        });

        const unsigned = createSignedStartRequest();
        const { authorization: _authorization, ...withoutAuthorization } = unsigned;
        await expect(handlers.get(RPC_METHODS.DAEMON_LIVE_STREAM_RELAY_START)?.({
            protocolVersion: 1,
            machineId: 'machine_source',
            startRequest: withoutAuthorization,
        })).rejects.toThrow();
    });
});
