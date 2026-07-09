import type { DaemonVoiceInferenceNormalizationDecision } from '@happier-dev/protocol';
import { Platform } from 'react-native';

import type { LocalUploadSource } from '@/sync/runtime/files/localUploadSourceReader';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { guessAudioMimeType } from '@/voice/input/guessAudioMimeType';
import { encodeWavPcm16 } from '@/voice/kokoro/audio/encodeWavPcm16';

function createFallbackNormalizationDecision(): DaemonVoiceInferenceNormalizationDecision {
    return {
        inputTransport: 'upload_transfer',
        strategy: 'ui_pretranscoded_pcm16_fallback',
        systemFfmpegAllowed: false,
    };
}

function createDaemonDecodeNormalizationDecision(): DaemonVoiceInferenceNormalizationDecision {
    return {
        inputTransport: 'upload_transfer',
        strategy: 'daemon_decode',
        systemFfmpegAllowed: false,
    };
}

function getWebAudioContextCtor(): null | (new () => {
    decodeAudioData: (audioData: ArrayBuffer) => Promise<{
        numberOfChannels: number;
        sampleRate: number;
        getChannelData: (channel: number) => Float32Array;
    }>;
    close?: () => Promise<void> | void;
}) {
    return ((globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext ?? null) as any;
}

function mixAudioBufferToMono(audioBuffer: {
    numberOfChannels: number;
    getChannelData: (channel: number) => Float32Array;
}): Float32Array {
    const channelCount = Math.max(1, audioBuffer.numberOfChannels);
    const reference = audioBuffer.getChannelData(0);
    const mixed = new Float32Array(reference.length);
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const channelData = audioBuffer.getChannelData(channelIndex);
        for (let sampleIndex = 0; sampleIndex < mixed.length; sampleIndex += 1) {
            mixed[sampleIndex] += (channelData[sampleIndex] ?? 0) / channelCount;
        }
    }
    return mixed;
}

async function maybePretranscodeWebBlobToWav(blob: Blob): Promise<File | null> {
    const AudioContextCtor = getWebAudioContextCtor();
    if (!AudioContextCtor) {
        return null;
    }

    const audioContext = new AudioContextCtor();
    try {
        const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer());
        const monoSamples = mixAudioBufferToMono(decoded);
        const wavBytes = encodeWavPcm16({
            samples: monoSamples,
            sampleRate: decoded.sampleRate,
        });
        return new File([wavBytes], 'recording.wav', { type: 'audio/wav' });
    } catch {
        return null;
    } finally {
        await audioContext.close?.();
    }
}

export async function prepareDaemonVoiceInferenceSttSource(params: Readonly<{
    uri: string;
}>): Promise<Readonly<{
    source: LocalUploadSource;
    inputMimeType: string;
    normalization: DaemonVoiceInferenceNormalizationDecision;
}>> {
    if (Platform.OS === 'web' && params.uri.startsWith('blob:')) {
        const blob = await (await runtimeFetch(params.uri)).blob();
        const transcodedWav = await maybePretranscodeWebBlobToWav(blob);
        if (transcodedWav) {
            return {
                source: {
                    kind: 'web',
                    file: transcodedWav,
                },
                inputMimeType: transcodedWav.type,
                normalization: createFallbackNormalizationDecision(),
            };
        }

        return {
            source: {
                kind: 'web',
                file: new File([blob], 'recording.webm', { type: blob.type || 'audio/webm' }),
            },
            inputMimeType: blob.type || 'audio/webm',
            normalization: createDaemonDecodeNormalizationDecision(),
        };
    }

    const inputMimeType = guessAudioMimeType(params.uri);
    return {
        source: {
            kind: 'native',
            uri: params.uri,
        },
        inputMimeType,
        // Native wav inputs are not guaranteed to be PCM16 (and the UI does not pretranscode them),
        // so always let the daemon decode unless we explicitly produced a PCM16 wav ourselves on web.
        normalization: createDaemonDecodeNormalizationDecision(),
    };
}
