import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModelPackManifest } from '@happier-dev/protocol';

import type {
    VoiceInferenceRuntimeEngine,
    VoiceInferenceRuntimeSynthesizeInput,
    VoiceInferenceRuntimeTranscribeInput,
} from '../voiceInferenceRuntimeTypes';
import {
    createRuntimeUnavailableError,
    createVoiceInferenceError,
    isVoiceInferenceWavMimeType,
    normalizeVoiceInferenceInputMimeType,
} from '../voiceInferenceWorker.shared';
import { decodeCompressedAudioToWav } from './decodeCompressedAudioToWav';

type SherpaGeneratedAudio = Readonly<{
    samples: Float32Array;
    sampleRate: number;
}>;

type SherpaOnlineStream = Readonly<{
    acceptWaveform: (input: Readonly<{ samples: Float32Array; sampleRate: number }>) => void;
    inputFinished: () => void;
}>;

type SherpaOnlineRecognizer = Readonly<{
    createStream: () => SherpaOnlineStream;
    isReady: (stream: SherpaOnlineStream) => boolean;
    decode: (stream: SherpaOnlineStream) => void;
    getResult: (stream: SherpaOnlineStream) => Readonly<{ text?: string | null }>;
    free?: () => void;
    delete?: () => void;
    dispose?: () => void;
    close?: () => void;
}>;

type SherpaOfflineTts = Readonly<{
    generate: (input: Readonly<{ text: string; sid: number; speed: number }>) => SherpaGeneratedAudio;
    free?: () => void;
    delete?: () => void;
    dispose?: () => void;
    close?: () => void;
}>;

type SherpaOnnxModule = Readonly<{
    OnlineRecognizer: new (config: Record<string, unknown>) => SherpaOnlineRecognizer;
    OfflineTts: new (config: Record<string, unknown>) => SherpaOfflineTts;
}>;

type CachedTtsRuntime = Readonly<{
    key: string;
    runtime: SherpaOfflineTts;
}>;

type CachedSttRuntime = Readonly<{
    key: string;
    runtime: SherpaOnlineRecognizer;
}>;

type DisposableRuntime = Readonly<{
    free?: () => void;
    delete?: () => void;
    dispose?: () => void;
    close?: () => void;
}>;

const DEFAULT_STT_SAMPLE_RATE = 16_000;
const DEFAULT_TTS_SPEED = 1;

const cachedTtsRuntimes = new Map<string, CachedTtsRuntime>();
const cachedSttRuntimes = new Map<string, CachedSttRuntime>();
let sherpaOnnxModulePromise: Promise<SherpaOnnxModule> | null = null;
async function dynamicImportModule(specifier: string): Promise<unknown> {
    return await import(specifier);
}

function throwIfAborted(signal?: AbortSignal | null): void {
    if (signal?.aborted) {
        throw createVoiceInferenceError('cancelled', 'voice_inference_cancelled');
    }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
    return value instanceof Error;
}

async function assertPathExists(path: string, code: string): Promise<string> {
    try {
        await stat(path);
        return path;
    } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            throw createVoiceInferenceError(code);
        }
        throw error;
    }
}

async function resolveOptionalPath(path: string): Promise<string | null> {
    try {
        await stat(path);
        return path;
    } catch {
        return null;
    }
}

async function importSherpaOnnxModule(): Promise<SherpaOnnxModule> {
    if (!sherpaOnnxModulePromise) {
        sherpaOnnxModulePromise = dynamicImportModule('sherpa-onnx-node').then(
            (value: unknown) => value as SherpaOnnxModule,
        ).catch((error: unknown) => {
            sherpaOnnxModulePromise = null;
            throw createRuntimeUnavailableError(error);
        });
    }
    return await sherpaOnnxModulePromise;
}

function resolveVoiceSpeakerId(input: VoiceInferenceRuntimeSynthesizeInput): number {
    if (!Array.isArray((input.manifest as ModelPackManifest).voices)) {
        return 0;
    }

    const voiceCatalog = (input.manifest as ModelPackManifest).voices ?? [];
    const matchedVoice = voiceCatalog.find((voice) => voice.id === input.voiceId) ?? null;
    return typeof matchedVoice?.sid === 'number' ? matchedVoice.sid : 0;
}

async function createTtsRuntime(input: VoiceInferenceRuntimeSynthesizeInput): Promise<CachedTtsRuntime> {
    if (String(input.manifest?.kind ?? '') !== 'tts_sherpa') {
        throw createVoiceInferenceError('runtime_unavailable');
    }
    if (String(input.manifest?.model ?? '').trim().toLowerCase() !== 'kokoro') {
        throw createVoiceInferenceError('runtime_unavailable');
    }

    const key = `${input.packDir}:${String(input.manifest?.version ?? '')}`;
    const cachedRuntime = cachedTtsRuntimes.get(input.packId);
    if (cachedRuntime?.key === key) {
        return cachedRuntime;
    }
    if (cachedRuntime) {
        disposeCachedRuntime(cachedRuntime.runtime);
        cachedTtsRuntimes.delete(input.packId);
    }

    const sherpaOnnx = await importSherpaOnnxModule();
    const model = await assertPathExists(join(input.packDir, 'model.onnx'), 'voice_inference_missing_tts_model');
    const voices = await assertPathExists(join(input.packDir, 'voices.bin'), 'voice_inference_missing_tts_voices');
    const tokens = await assertPathExists(join(input.packDir, 'tokens.txt'), 'voice_inference_missing_tts_tokens');
    const dataDir = (await resolveOptionalPath(join(input.packDir, 'espeak-ng-data'))) ?? input.packDir;

    const runtime = new sherpaOnnx.OfflineTts({
        model: {
            numThreads: 2,
            provider: 'cpu',
            kokoro: {
                model,
                voices,
                tokens,
                dataDir,
            },
        },
        maxNumSentences: 1,
        silenceScale: 0.2,
    });
    const nextRuntime = { key, runtime } satisfies CachedTtsRuntime;
    cachedTtsRuntimes.set(input.packId, nextRuntime);
    return nextRuntime;
}

async function createSttRuntime(input: VoiceInferenceRuntimeTranscribeInput): Promise<CachedSttRuntime> {
    if (String(input.manifest?.kind ?? '') !== 'stt_sherpa') {
        throw createVoiceInferenceError('runtime_unavailable');
    }

    const key = `${input.packDir}:${String(input.manifest?.version ?? '')}`;
    const cachedRuntime = cachedSttRuntimes.get(input.packId);
    if (cachedRuntime?.key === key) {
        return cachedRuntime;
    }
    if (cachedRuntime) {
        disposeCachedRuntime(cachedRuntime.runtime);
        cachedSttRuntimes.delete(input.packId);
    }

    const sherpaOnnx = await importSherpaOnnxModule();
    const tokens = await assertPathExists(join(input.packDir, 'tokens.txt'), 'voice_inference_missing_stt_tokens');
    const encoder = await assertPathExists(join(input.packDir, 'encoder.onnx'), 'voice_inference_missing_stt_encoder');
    const decoder = await assertPathExists(join(input.packDir, 'decoder.onnx'), 'voice_inference_missing_stt_decoder');
    const joiner = await assertPathExists(join(input.packDir, 'joiner.onnx'), 'voice_inference_missing_stt_joiner');

    const runtime = new sherpaOnnx.OnlineRecognizer({
        featConfig: {
            sampleRate: DEFAULT_STT_SAMPLE_RATE,
            featureDim: 80,
        },
        modelConfig: {
            tokens,
            numThreads: 2,
            provider: 'cpu',
            modelType: '',
            transducer: {
                encoder,
                decoder,
                joiner,
            },
        },
        decodingMethod: 'greedy_search',
        maxActivePaths: 4,
        enableEndpoint: 1,
        rule1MinTrailingSilence: 1.2,
        rule2MinTrailingSilence: 0.6,
        rule3MinUtteranceLength: 15,
    });
    const nextRuntime = { key, runtime } satisfies CachedSttRuntime;
    cachedSttRuntimes.set(input.packId, nextRuntime);
    return nextRuntime;
}

function encodeWavFromFloat32Audio(audio: SherpaGeneratedAudio): Buffer {
    const sampleCount = audio.samples.length;
    const pcmBuffer = Buffer.alloc(sampleCount * 2);
    for (let index = 0; index < sampleCount; index += 1) {
        const clamped = Math.max(-1, Math.min(1, audio.samples[index] ?? 0));
        const int16 = clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * 32_767);
        pcmBuffer.writeInt16LE(int16, index * 2);
    }

    const wavBuffer = Buffer.alloc(44 + pcmBuffer.byteLength);
    wavBuffer.write('RIFF', 0, 'ascii');
    wavBuffer.writeUInt32LE(36 + pcmBuffer.byteLength, 4);
    wavBuffer.write('WAVE', 8, 'ascii');
    wavBuffer.write('fmt ', 12, 'ascii');
    wavBuffer.writeUInt32LE(16, 16);
    wavBuffer.writeUInt16LE(1, 20);
    wavBuffer.writeUInt16LE(1, 22);
    wavBuffer.writeUInt32LE(audio.sampleRate, 24);
    wavBuffer.writeUInt32LE(audio.sampleRate * 2, 28);
    wavBuffer.writeUInt16LE(2, 32);
    wavBuffer.writeUInt16LE(16, 34);
    wavBuffer.write('data', 36, 'ascii');
    wavBuffer.writeUInt32LE(pcmBuffer.byteLength, 40);
    pcmBuffer.copy(wavBuffer, 44);
    return wavBuffer;
}

type ParsedWavAudio = Readonly<{
    samples: Float32Array;
    sampleRate: number;
}>;

function decodePcm16Wav(buffer: Buffer): ParsedWavAudio {
    if (buffer.byteLength < 44 || buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') {
        throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_invalid_wav_header');
    }

    let formatTag = 0;
    let channels = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;
    let dataOffset = -1;
    let dataSize = 0;
    let offset = 12;

    while (offset + 8 <= buffer.byteLength) {
        const chunkId = buffer.subarray(offset, offset + 4).toString('ascii');
        const chunkSize = buffer.readUInt32LE(offset + 4);
        const chunkDataOffset = offset + 8;

        if (chunkId === 'fmt ' && chunkSize >= 16 && chunkDataOffset + chunkSize <= buffer.byteLength) {
            formatTag = buffer.readUInt16LE(chunkDataOffset);
            channels = buffer.readUInt16LE(chunkDataOffset + 2);
            sampleRate = buffer.readUInt32LE(chunkDataOffset + 4);
            bitsPerSample = buffer.readUInt16LE(chunkDataOffset + 14);
        } else if (chunkId === 'data' && chunkDataOffset + chunkSize <= buffer.byteLength) {
            dataOffset = chunkDataOffset;
            dataSize = chunkSize;
            break;
        }

        offset = chunkDataOffset + chunkSize + (chunkSize % 2);
    }

    if (formatTag !== 1 || channels < 1 || sampleRate < 1 || bitsPerSample !== 16 || dataOffset < 0 || dataSize < 2) {
        throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_unsupported_wav_encoding');
    }

    const sampleView = buffer.subarray(dataOffset, dataOffset + dataSize);
    const frameCount = Math.floor(sampleView.byteLength / (channels * 2));
    const monoSamples = new Float32Array(frameCount);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        let total = 0;
        for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
            const sampleIndex = (frameIndex * channels + channelIndex) * 2;
            total += sampleView.readInt16LE(sampleIndex);
        }
        monoSamples[frameIndex] = (total / channels) / 32_768;
    }

    return {
        samples: monoSamples,
        sampleRate,
    };
}

function resampleTo16kHz(audio: ParsedWavAudio): ParsedWavAudio {
    if (audio.sampleRate === DEFAULT_STT_SAMPLE_RATE) {
        return audio;
    }

    const outputLength = Math.max(1, Math.round(audio.samples.length * DEFAULT_STT_SAMPLE_RATE / audio.sampleRate));
    const outputSamples = new Float32Array(outputLength);
    const ratio = audio.sampleRate / DEFAULT_STT_SAMPLE_RATE;
    for (let index = 0; index < outputLength; index += 1) {
        const position = index * ratio;
        const leftIndex = Math.floor(position);
        const rightIndex = Math.min(audio.samples.length - 1, leftIndex + 1);
        const blend = position - leftIndex;
        const left = audio.samples[leftIndex] ?? 0;
        const right = audio.samples[rightIndex] ?? left;
        outputSamples[index] = left + ((right - left) * blend);
    }

    return {
        samples: outputSamples,
        sampleRate: DEFAULT_STT_SAMPLE_RATE,
    };
}

async function readNormalizedWavAudio(filePath: string): Promise<ParsedWavAudio> {
    return resampleTo16kHz(decodePcm16Wav(await readFile(filePath)));
}

function disposeCachedRuntime(runtime: DisposableRuntime | null | undefined): void {
    if (!runtime) {
        return;
    }
    for (const methodName of ['free', 'delete', 'dispose', 'close'] as const) {
        const method = runtime[methodName];
        if (typeof method !== 'function') {
            continue;
        }
        try {
            method.call(runtime);
        } catch {
            // best-effort runtime cleanup
        }
        return;
    }
}

export const voiceInferenceRuntimeEngine: VoiceInferenceRuntimeEngine = {
    warmModel: async (input) => {
        throwIfAborted(input.signal);
        if (String(input.manifest?.kind ?? '') === 'tts_sherpa') {
            await createTtsRuntime({
                requestId: 'warm-model',
                text: '',
                voiceId: null,
                speed: null,
                output: { codec: 'wav', mimeType: 'audio/wav' },
                ...input,
            });
            return;
        }
        if (String(input.manifest?.kind ?? '') === 'stt_sherpa') {
            await createSttRuntime({
                requestId: 'warm-model',
                filePath: join(input.packDir, 'tokens.txt'),
                inputMimeType: 'audio/wav',
                language: null,
                normalization: {
                    inputTransport: 'upload_transfer',
                    strategy: 'ui_pretranscoded_pcm16_fallback',
                    systemFfmpegAllowed: false,
                },
                ...input,
            });
            return;
        }
        throw createVoiceInferenceError('runtime_unavailable');
    },
    releaseModel: async (input) => {
        if (String(input.manifest?.kind ?? '') === 'tts_sherpa') {
            const cachedRuntime = cachedTtsRuntimes.get(input.packId);
            if (cachedRuntime) {
                cachedTtsRuntimes.delete(input.packId);
                disposeCachedRuntime(cachedRuntime.runtime);
            }
            return;
        }
        if (String(input.manifest?.kind ?? '') === 'stt_sherpa') {
            const cachedRuntime = cachedSttRuntimes.get(input.packId);
            if (cachedRuntime) {
                cachedSttRuntimes.delete(input.packId);
                disposeCachedRuntime(cachedRuntime.runtime);
            }
            return;
        }
        cachedTtsRuntimes.delete(input.packId);
        cachedSttRuntimes.delete(input.packId);
    },
    synthesizeTts: async (input) => {
        throwIfAborted(input.signal);
        const { runtime } = await createTtsRuntime(input);
        const synthesized = runtime.generate({
            text: input.text,
            sid: resolveVoiceSpeakerId(input),
            speed: input.speed ?? DEFAULT_TTS_SPEED,
        });
        throwIfAborted(input.signal);
        return {
            bytes: encodeWavFromFloat32Audio(synthesized),
            output: {
                codec: 'wav',
                mimeType: 'audio/wav',
            },
            name: 'daemon-tts.wav',
        };
    },
    decodeAudioInput: async (input) => {
        throwIfAborted(input.signal);
        const normalizedInputMimeType = normalizeVoiceInferenceInputMimeType(input.inputMimeType);
        if (isVoiceInferenceWavMimeType(normalizedInputMimeType)) {
            return {
                filePath: input.filePath,
                inputMimeType: 'audio/wav',
            };
        }
        return await decodeCompressedAudioToWav({
            filePath: input.filePath,
            signal: input.signal,
        });
    },
    transcribeAudio: async (input) => {
        throwIfAborted(input.signal);
        const { runtime } = await createSttRuntime(input);
        const audio = await readNormalizedWavAudio(input.filePath);
        const stream = runtime.createStream();
        stream.acceptWaveform({
            samples: audio.samples,
            sampleRate: audio.sampleRate,
        });
        stream.inputFinished();
        while (runtime.isReady(stream)) {
            throwIfAborted(input.signal);
            runtime.decode(stream);
        }
        const result = runtime.getResult(stream);
        throwIfAborted(input.signal);
        return {
            text: String(result.text ?? '').trim(),
            language: input.language,
        };
    },
};
