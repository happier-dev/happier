import { encodePeerTcpTunnelBinaryFrameV2 } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
    decodePeerTcpTunnelBinaryRoutingHeaderV2,
    peerTcpTunnelBinaryDecodeFailureReason,
} from './routingHeader';

describe('decodePeerTcpTunnelBinaryRoutingHeaderV2', () => {
    it('recovers a strict bounded routing header without admitting its payload', () => {
        const valid = encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: 'tun_1',
                substreamId: 'application.stream-1',
                direction: 'client_to_daemon',
                sequence: 0,
                payloadLength: 4,
            },
            payload: Buffer.from('pcm!'),
        });

        expect(decodePeerTcpTunnelBinaryRoutingHeaderV2({ frame: valid, maxHeaderBytes: 1024 })).toMatchObject({
            ok: true,
            header: { tunnelId: 'tun_1', substreamId: 'application.stream-1' },
        });

        const mismatchedPayload = valid.subarray(0, valid.byteLength - 1);
        expect(decodePeerTcpTunnelBinaryRoutingHeaderV2({ frame: mismatchedPayload, maxHeaderBytes: 1024 })).toMatchObject({
            ok: true,
            header: { tunnelId: 'tun_1', substreamId: 'application.stream-1', payloadLength: 4 },
        });
    });

    it('rejects unbounded, truncated, invalid JSON, and schema-invalid headers', () => {
        const createRaw = (header: string) => {
            const bytes = Buffer.from(header, 'utf8');
            const frame = Buffer.alloc(4 + bytes.byteLength);
            frame.writeUInt32BE(bytes.byteLength, 0);
            bytes.copy(frame, 4);
            return frame;
        };

        expect(decodePeerTcpTunnelBinaryRoutingHeaderV2({ frame: createRaw('{}'), maxHeaderBytes: 1024 }).ok).toBe(false);
        expect(decodePeerTcpTunnelBinaryRoutingHeaderV2({ frame: createRaw('{'), maxHeaderBytes: 1024 }).ok).toBe(false);
        expect(decodePeerTcpTunnelBinaryRoutingHeaderV2({ frame: createRaw('{}').subarray(0, 5), maxHeaderBytes: 1024 }).ok).toBe(false);
        expect(decodePeerTcpTunnelBinaryRoutingHeaderV2({ frame: createRaw('{}'), maxHeaderBytes: 1 }).ok).toBe(false);
    });

    it('maps protocol decode failures to stable tunnel admission reasons', () => {
        expect(peerTcpTunnelBinaryDecodeFailureReason('header_too_large')).toBe('encoded_frame_too_large');
        expect(peerTcpTunnelBinaryDecodeFailureReason('payload_too_large')).toBe('decoded_payload_too_large');
        expect(peerTcpTunnelBinaryDecodeFailureReason('payload_length_mismatch')).toBe('frame_invalid');
    });
});
