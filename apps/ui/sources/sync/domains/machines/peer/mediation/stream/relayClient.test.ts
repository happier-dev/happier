import { describe, expect, it } from 'vitest';

import {
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    type MachineLiveStreamRelayEnvelopeV1,
    type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

function startRequest(): MachineLiveStreamStartRequestV1 {
    return {
        v: 1,
        streamId: 'stream_1',
        streamFamily: 'screen',
        routeKind: 'server_relay',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
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

describe('openMachineLiveStreamRelayClient', () => {
    it('emits the generic live-stream socket event with a start envelope', async () => {
        const mod = await import('./relayClient').catch((error: unknown) => ({ importError: error }));

        expect(mod).toHaveProperty('openMachineLiveStreamRelayClient');
        if (!('openMachineLiveStreamRelayClient' in mod)) return;

        const sent: Array<{ event: string; envelope: MachineLiveStreamRelayEnvelopeV1 }> = [];
        await expect(mod.openMachineLiveStreamRelayClient({
            serverId: 'server-a',
            sourceMachineId: 'machine_source',
            targetMachineId: 'machine_target',
            streamId: 'stream_1',
            streamFamily: 'screen',
            caps: {
                maxBitrateBps: 64_000,
                maxFramesPerSecond: 12,
                maxFrameBytes: 32_000,
                maxDurationMs: 60_000,
                maxTotalBytes: 128_000,
            },
            startProduction: async () => ({
                ok: true,
                routeKind: 'server_relay',
                startRequest: startRequest(),
                relayAuthorization: startRequest().authorization!,
            }),
            send: (event, envelope) => sent.push({ event, envelope }),
        })).resolves.toEqual({ ok: true, streamId: 'stream_1' });

        expect(sent).toEqual([{
            event: MACHINE_LIVE_STREAM_SOCKET_EVENT,
            envelope: {
                v: 1,
                sourceMachineId: 'machine_source',
                targetMachineId: 'machine_target',
                message: {
                    kind: 'start',
                    startRequest: startRequest(),
                },
            },
        }]);
    });
});
