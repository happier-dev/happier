/**
 * Frame primitives shared by more than one tunnel frame responsibility: payload base64
 * codec, substream abort framing, and schedulable-timeout clamping. Extracted from `frames.ts`
 * (lane D3, 2026-08-23) because each of these is used by two or three of the split modules;
 * anything used by exactly one module stayed with that module.
 */
import {
    encodePeerTcpTunnelBinaryFrameV2,
} from '@happier-dev/protocol';

export const MAX_SCHEDULABLE_TIMEOUT_MS = 2_147_483_647;

export function decodePayloadBase64(payloadBase64: string): Uint8Array {
    return new Uint8Array(Buffer.from(payloadBase64, 'base64'));
}

export function encodePayloadBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

export function substreamAbortFrame(input: Readonly<{
    tunnelId: string;
    substreamId: string;
    reasonCode: string;
}>): Uint8Array {
    return encodePeerTcpTunnelBinaryFrameV2({
        header: {
            version: 2,
            kind: 'abort',
            tunnelId: input.tunnelId,
            substreamId: input.substreamId,
            reasonCode: input.reasonCode,
            payloadLength: 0,
        },
    });
}


export function isSchedulableTimeoutMs(value: number | undefined): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value >= 1
        && value <= MAX_SCHEDULABLE_TIMEOUT_MS;
}
