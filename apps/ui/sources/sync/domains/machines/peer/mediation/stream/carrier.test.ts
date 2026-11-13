import {
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
} from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';
import { describe, expect, it } from 'vitest';
import { MACHINE_RPC_JSON_BASE64_ENCODING } from './carrier';

describe('machine stream carrier contract', () => {
    it('selects the existing binary tunnel frame encoding for direct binary-capable audio', async () => {
        const mod = await import('./carrier');

        expect(mod.resolveMachineStreamCarrierProfile({
            routeKind: 'loopback_direct',
            deliveryMode: 'input_append',
            streamKind: 'audio_pcm',
            binaryCapable: true,
        })).toMatchObject({
            routeKind: 'loopback_direct',
            deliveryMode: 'input_append',
            streamKind: 'audio_pcm',
            binaryCapable: true,
            frameEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            payloadShape: 'bytes',
            orderedInputAppend: {
                sequenceField: 'seq',
                ackField: 'ackSeq',
                finalSequenceField: 'finalSeq',
            },
            flowControl: {
                ack: true,
                creditBytes: true,
                byteOffsets: true,
                replayCursor: true,
                receipts: true,
            },
        });
    });

    it('selects the existing binary tunnel frame encoding for relay adapters that can carry binary frames', async () => {
        const mod = await import('./carrier');

        expect(mod.resolveMachineStreamCarrierProfile({
            routeKind: 'server_relay',
            deliveryMode: 'push_event',
            streamKind: 'audio_pcm',
            binaryCapable: true,
        })).toMatchObject({
            routeKind: 'server_relay',
            deliveryMode: 'push_event',
            streamKind: 'audio_pcm',
            binaryCapable: true,
            frameEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
            payloadShape: 'bytes',
            pushEventSubscription: {
                deliveryTrigger: 'subscription',
                pollIntervalMs: null,
            },
        });
    });

    it('makes JSON base64 an explicit relay fallback instead of a competing binary framing concept', async () => {
        const mod = await import('./carrier');

        expect(mod.resolveMachineStreamCarrierProfile({
            routeKind: 'server_relay',
            deliveryMode: 'push_event',
            streamKind: 'audio_pcm',
            binaryCapable: false,
        })).toMatchObject({
            routeKind: 'server_relay',
            deliveryMode: 'push_event',
            streamKind: 'audio_pcm',
            binaryCapable: false,
            frameEncoding: MACHINE_RPC_JSON_BASE64_ENCODING,
            payloadShape: 'json_base64_envelope',
            pushEventSubscription: {
                deliveryTrigger: 'subscription',
                pollIntervalMs: null,
            },
            flowControl: {
                ack: true,
                creditBytes: true,
                byteOffsets: true,
                replayCursor: true,
                receipts: true,
            },
        });
    });

});
