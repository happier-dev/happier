import {
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

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
            frameEncoding: PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
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

    it('maps the current terminal carrier as demand-pull machine-rpc-base64 without requiring migration', async () => {
        const mod = await import('./carrier');

        expect(mod.describeTerminalStreamCarrierMapping()).toEqual({
            currentCarrierKind: 'machine-rpc-base64',
            routeKinds: ['loopback_direct', 'server_relay'],
            deliveryMode: 'demand_pull',
            binaryCapable: false,
            frameEncoding: PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
            payloadShape: 'json_base64_envelope',
            migrationRequiredForB0: false,
            terminalCapabilities: {
                ack: 'renderer byte offsets',
                credit: 'creditBytes',
                replay: 'byte-offset cursor',
                input: 'ordered sendInput queue',
            },
        });
    });
});
