import type { MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol';
import type { MachineContentCodec } from './machineStoredContent';

/** The Machine content owner supplies the payload allowance within the wire cap. */
export function resolveMachineLiveStreamFramePayloadByteLimit(input: Readonly<{
    envelope: MachineLiveStreamRelayEnvelopeV1;
    maxFrameBytes: number;
    codec: MachineContentCodec;
}>): number {
    if (input.codec.mode === 'plain' || input.envelope.message.kind !== 'frame') return input.maxFrameBytes;
    // Both supported Machine ciphers add a fixed envelope to their serialized
    // plaintext. Measure it through the actual codec, including authenticated
    // routing/frame headers. The cap's digit width also fits the smaller payload.
    const empty = { ...input.envelope, message: { kind: 'frame', frame: {
        ...input.envelope.message.frame, payloadBase64: '', payloadSizeBytes: input.maxFrameBytes,
    } } };
    const overhead = Buffer.from(input.codec.encodeRpc({ purpose: 'machine_live_stream_v1', envelope: empty }), 'base64').byteLength;
    // Metadata itself is base64 in the authenticated plaintext.
    return Math.max(0, Math.floor((input.maxFrameBytes - overhead) / 4) * 3);
}
