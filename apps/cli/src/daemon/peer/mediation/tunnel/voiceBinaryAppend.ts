import type {
    PeerTcpTunnelBinaryFrameHeaderV2,
    VoiceMediaApplicationAuthorityV1,
} from '@happier-dev/protocol';

const DAEMON_VOICE_INFERENCE_STT_SUBSTREAM_PREFIX = 'daemon.voiceInference.stt.';

export type PeerTcpTunnelVoiceBinaryAppendInput = Readonly<{
    streamId: string;
    generation: number;
    seq: number;
    /** Stream-key ciphertext for an E2EE Account, raw PCM for a plain one; the stream owner decides. */
    payloadBytes: Uint8Array;
    voiceMediaApplicationAuthority: VoiceMediaApplicationAuthorityV1;
}>;

export type PeerTcpTunnelVoiceBinaryAppendConsumer = (
    input: PeerTcpTunnelVoiceBinaryAppendInput,
) => Promise<unknown> | unknown;

type PeerTcpTunnelVoiceBinaryTerminalCommonInput = Readonly<{
    reasonCode: string;
    voiceMediaApplicationAuthority: VoiceMediaApplicationAuthorityV1;
}>;

export type PeerTcpTunnelVoiceBinaryTerminalInput =
    PeerTcpTunnelVoiceBinaryTerminalCommonInput
    & (
        | Readonly<{
            streamId: string;
            generation: number;
            substreamId: string;
        }>
        | Readonly<{
            streamId?: never;
            generation?: never;
            substreamId?: never;
        }>
    );

export type PeerTcpTunnelVoiceBinaryTerminalConsumer = (
    input: PeerTcpTunnelVoiceBinaryTerminalInput,
) => Promise<unknown> | unknown;

export function parseDaemonVoiceInferenceSttSubstreamId(
    substreamId: string,
): Readonly<{ streamId: string; generation: number }> | null {
    if (!substreamId.startsWith(DAEMON_VOICE_INFERENCE_STT_SUBSTREAM_PREFIX)) {
        return null;
    }
    const body = substreamId.slice(DAEMON_VOICE_INFERENCE_STT_SUBSTREAM_PREFIX.length);
    const generationSeparatorIndex = body.lastIndexOf('.');
    if (generationSeparatorIndex <= 0 || generationSeparatorIndex === body.length - 1) {
        return null;
    }
    const streamId = body.slice(0, generationSeparatorIndex);
    const generationText = body.slice(generationSeparatorIndex + 1);
    if (!/^\d+$/u.test(generationText)) {
        return null;
    }
    const generation = Number(generationText);
    if (!Number.isSafeInteger(generation)) {
        return null;
    }
    return { streamId, generation };
}

export async function dispatchDaemonVoiceInferenceSttBinaryAppend(input: Readonly<{
    consumer: PeerTcpTunnelVoiceBinaryAppendConsumer | undefined;
    header: PeerTcpTunnelBinaryFrameHeaderV2;
    payload: Uint8Array;
    voiceMediaApplicationAuthority?: VoiceMediaApplicationAuthorityV1;
    onResponse?: (response: unknown, header: PeerTcpTunnelBinaryFrameHeaderV2) => Promise<void> | void;
}>): Promise<boolean> {
    if (
        !input.consumer
        || !input.header.substreamId
        || input.voiceMediaApplicationAuthority?.applicationKind !== 'speech_transcription'
    ) {
        return false;
    }
    const binding = parseDaemonVoiceInferenceSttSubstreamId(input.header.substreamId);
    if (!binding) {
        return false;
    }
    if (
        input.header.kind !== 'data'
        || input.header.direction !== 'client_to_daemon'
        || input.header.sequence === undefined
    ) {
        return true;
    }
    const response = await input.consumer({
        streamId: binding.streamId,
        generation: binding.generation,
        seq: input.header.sequence,
        payloadBytes: input.payload,
        voiceMediaApplicationAuthority: input.voiceMediaApplicationAuthority,
    });
    await input.onResponse?.(response, input.header);
    return true;
}

export async function dispatchDaemonVoiceInferenceSttTerminal(input: Readonly<{
    consumer: PeerTcpTunnelVoiceBinaryTerminalConsumer | undefined;
    substreamIds: readonly string[];
    reasonCode: string;
    voiceMediaApplicationAuthority?: VoiceMediaApplicationAuthorityV1;
}>): Promise<boolean> {
    if (
        !input.consumer
        || input.voiceMediaApplicationAuthority?.applicationKind !== 'speech_transcription'
    ) {
        return false;
    }
    let handled = false;
    for (const substreamId of new Set(input.substreamIds)) {
        const binding = parseDaemonVoiceInferenceSttSubstreamId(substreamId);
        if (!binding) continue;
        handled = true;
        await input.consumer({
            streamId: binding.streamId,
            generation: binding.generation,
            substreamId,
            reasonCode: input.reasonCode,
            voiceMediaApplicationAuthority: input.voiceMediaApplicationAuthority,
        });
    }
    if (!handled) {
        handled = true;
        await input.consumer({
            reasonCode: input.reasonCode,
            voiceMediaApplicationAuthority: input.voiceMediaApplicationAuthority,
        });
    }
    return handled;
}
