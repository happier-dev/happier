import { readFile, stat } from 'node:fs/promises';

import { VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT } from '@happier-dev/protocol';
import type { ModelPackManifest } from '@happier-dev/protocol';

import type {
    VoiceInferenceRuntimeEngine,
    VoiceInferenceRuntimeCreateStreamingTranscriptionSessionInput,
    VoiceInferenceRuntimeSynthesizeInput,
    VoiceInferenceRuntimeTranscribeInput,
    VoiceInferenceStreamingTranscriptionSession,
} from '../voiceInferenceRuntimeTypes';
import {
    createRuntimeUnavailableError,
    createVoiceInferenceError,
    isVoiceInferenceWavMimeType,
    normalizeVoiceInferenceInputMimeType,
} from '../voiceInferenceWorker.shared';
import { decodeCompressedAudioToWav } from './decodeCompressedAudioToWav';
import { resolveDaemonVoiceRuntimePackAdapter } from './runtimeFamilyRegistry';

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
    isEndpoint?: (stream: SherpaOnlineStream) => boolean;
    reset?: (stream: SherpaOnlineStream) => void;
    getResult: (stream: SherpaOnlineStream) => Readonly<{ text?: string | null }>;
    free?: () => void;
    delete?: () => void;
    dispose?: () => void;
    close?: () => void;
}>;

type SherpaOfflineStream = Readonly<{
    acceptWaveform: (input: Readonly<{ samples: Float32Array; sampleRate: number }>) => void;
}>;

type SherpaOfflineRecognizerResult = Readonly<{ text?: string | null }>;

type SherpaOfflineRecognizer = Readonly<{
    createStream: () => SherpaOfflineStream;
    decode: (stream: SherpaOfflineStream) => void;
    decodeAsync?: (stream: SherpaOfflineStream) => Promise<SherpaOfflineRecognizerResult>;
    getResult: (stream: SherpaOfflineStream) => SherpaOfflineRecognizerResult;
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
    OnlineRecognizer?: new (config: Record<string, unknown>) => SherpaOnlineRecognizer;
    OfflineRecognizer?: new (config: Record<string, unknown>) => SherpaOfflineRecognizer;
    OfflineTts?: new (config: Record<string, unknown>) => SherpaOfflineTts;
}>;

type CachedTtsRuntime = Readonly<{
    key: string;
    runtime: SherpaOfflineTts;
}>;

type CachedSttRuntime =
    | Readonly<{
        key: string;
        kind: 'streaming';
        runtime: SherpaOnlineRecognizer;
    }>
    | Readonly<{
        key: string;
        kind: 'offline';
        runtime: SherpaOfflineRecognizer;
    }>;

type DisposableRuntime = Readonly<{
    free?: () => void;
    delete?: () => void;
    dispose?: () => void;
    close?: () => void;
}>;

// Canonical daemon STT sample rate. Shared with the ffmpeg decode chokepoint via the
// protocol constant so the recognizer input rate cannot drift from the decoded WAV rate.
const DEFAULT_STT_SAMPLE_RATE = VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.sampleRateHz;
const DEFAULT_TTS_SPEED = 1;
// Native online decode is synchronous. A bounded macrotask turn lets timers and child IPC
// deliver cancellation without imposing an event-loop hop after every native decode call.
const ONLINE_DECODE_EVENT_LOOP_YIELD_INTERVAL = 4;

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

async function decodeOnlineRecognizerWhileReady(
    runtime: SherpaOnlineRecognizer,
    stream: SherpaOnlineStream,
    assertNotCancelled: () => void,
): Promise<boolean> {
    let decoded = false;
    let decodeCountSinceYield = 0;
    while (runtime.isReady(stream)) {
        assertNotCancelled();
        runtime.decode(stream);
        decoded = true;
        decodeCountSinceYield += 1;
        if (decodeCountSinceYield >= ONLINE_DECODE_EVENT_LOOP_YIELD_INTERVAL) {
            decodeCountSinceYield = 0;
            await new Promise<void>((resolve) => setImmediate(resolve));
            assertNotCancelled();
        }
    }
    assertNotCancelled();
    return decoded;
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

function readModuleRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object'
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function resolveSherpaOnnxConstructor<K extends keyof SherpaOnnxModule>(
    namespace: Readonly<Record<string, unknown>>,
    key: K,
): NonNullable<SherpaOnnxModule[K]> | null {
    const namedExport = Reflect.has(namespace, key)
        ? Reflect.get(namespace, key)
        : undefined;
    const defaultExport = readModuleRecord(
        Reflect.has(namespace, 'default')
            ? Reflect.get(namespace, 'default')
            : undefined,
    );
    const candidate = typeof namedExport === 'function'
        ? namedExport
        : defaultExport?.[key];
    if (typeof candidate !== 'function') {
        return null;
    }
    return candidate as NonNullable<SherpaOnnxModule[K]>;
}

function normalizeSherpaOnnxModule(value: unknown): SherpaOnnxModule {
    const namespace = readModuleRecord(value);
    if (!namespace) {
        throw new Error('voice_inference_sherpa_module_invalid');
    }
    const OnlineRecognizer = resolveSherpaOnnxConstructor(namespace, 'OnlineRecognizer');
    const OfflineRecognizer = resolveSherpaOnnxConstructor(namespace, 'OfflineRecognizer');
    const OfflineTts = resolveSherpaOnnxConstructor(namespace, 'OfflineTts');
    return {
        ...(OnlineRecognizer ? { OnlineRecognizer } : {}),
        ...(OfflineRecognizer ? { OfflineRecognizer } : {}),
        ...(OfflineTts ? { OfflineTts } : {}),
    };
}

async function importSherpaOnnxModule(): Promise<SherpaOnnxModule> {
    if (!sherpaOnnxModulePromise) {
        sherpaOnnxModulePromise = dynamicImportModule('sherpa-onnx-node').then(
            normalizeSherpaOnnxModule,
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
    const adapter = resolveDaemonVoiceRuntimePackAdapter(
        input.packId,
        input.packDir,
        input.manifest,
        input.runtimeDescriptor,
        input.supportArtifacts,
    );
    if (!adapter || adapter.runtimeFamily !== 'sherpa_kokoro_offline') {
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
    const OfflineTts = sherpaOnnx.OfflineTts;
    if (!OfflineTts) {
        throw createRuntimeUnavailableError(new Error('voice_inference_sherpa_export_missing:OfflineTts'));
    }
    const model = await assertPathExists(adapter.files.model, 'voice_inference_missing_tts_model');
    const voices = await assertPathExists(adapter.files.voices, 'voice_inference_missing_tts_voices');
    const tokens = await assertPathExists(adapter.files.tokens, 'voice_inference_missing_tts_tokens');
    const dataDir = await assertPathExists(adapter.files.dataDir, 'voice_inference_missing_tts_data');

    const runtime = new OfflineTts({
        model: {
            numThreads: 2,
            provider: 'cpu',
            kokoro: {
                model,
                voices,
                tokens,
                dataDir,
                lang: 'en',
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

    const adapter = resolveDaemonVoiceRuntimePackAdapter(
        input.packId,
        input.packDir,
        input.manifest,
        input.runtimeDescriptor,
        input.supportArtifacts,
    );
    if (
        !adapter
        || (
            adapter.runtimeFamily !== 'sherpa_zipformer_streaming'
            && adapter.runtimeFamily !== 'sherpa_parakeet_offline'
        )
    ) {
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
    const tokens = await assertPathExists(adapter.files.tokens, 'voice_inference_missing_stt_tokens');
    const encoder = await assertPathExists(adapter.files.encoder, 'voice_inference_missing_stt_encoder');
    const decoder = await assertPathExists(adapter.files.decoder, 'voice_inference_missing_stt_decoder');
    const joiner = await assertPathExists(adapter.files.joiner, 'voice_inference_missing_stt_joiner');

    const commonModelConfig = {
        tokens,
        numThreads: 2,
        provider: 'cpu',
        transducer: {
            encoder,
            decoder,
            joiner,
        },
    };
    let nextRuntime: CachedSttRuntime;
    if (adapter.runtimeFamily === 'sherpa_parakeet_offline') {
        const OfflineRecognizer = sherpaOnnx.OfflineRecognizer;
        if (!OfflineRecognizer) {
            throw createRuntimeUnavailableError(new Error('voice_inference_sherpa_export_missing:OfflineRecognizer'));
        }
        nextRuntime = {
            key,
            kind: 'offline',
            runtime: new OfflineRecognizer({
                featConfig: {
                    sampleRate: DEFAULT_STT_SAMPLE_RATE,
                    featureDim: 80,
                },
                modelConfig: {
                    ...commonModelConfig,
                    modelType: 'nemo_transducer',
                },
            }),
        };
    } else {
        const OnlineRecognizer = sherpaOnnx.OnlineRecognizer;
        if (!OnlineRecognizer) {
            throw createRuntimeUnavailableError(new Error('voice_inference_sherpa_export_missing:OnlineRecognizer'));
        }
        nextRuntime = {
            key,
            kind: 'streaming',
            runtime: new OnlineRecognizer({
                featConfig: {
                    sampleRate: DEFAULT_STT_SAMPLE_RATE,
                    featureDim: 80,
                },
                modelConfig: {
                    ...commonModelConfig,
                    modelType: '',
                },
                decodingMethod: 'greedy_search',
                maxActivePaths: 4,
                enableEndpoint: 1,
                rule1MinTrailingSilence: 1.2,
                rule2MinTrailingSilence: 0.6,
                rule3MinUtteranceLength: 15,
            }),
        };
    }
    cachedSttRuntimes.set(input.packId, nextRuntime);
    return nextRuntime;
}

async function decodeOfflineRecognizer(
    runtime: SherpaOfflineRecognizer,
    stream: SherpaOfflineStream,
    signal?: AbortSignal | null,
): Promise<SherpaOfflineRecognizerResult> {
    throwIfAborted(signal);
    const result = typeof runtime.decodeAsync === 'function'
        ? await runtime.decodeAsync(stream)
        : (() => {
            runtime.decode(stream);
            return runtime.getResult(stream);
        })();
    // sherpa-onnx has no per-decode abort primitive. Cancellation is terminal at
    // this boundary: native work may finish, but its result can never escape.
    throwIfAborted(signal);
    return result;
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

function decodePcm16Bytes(bytes: Uint8Array): Float32Array {
    if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
        throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_invalid_pcm16_chunk');
    }
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = new Float32Array(buffer.byteLength / 2);
    for (let index = 0; index < samples.length; index += 1) {
        samples[index] = buffer.readInt16LE(index * 2) / 32_768;
    }
    return samples;
}

function normalizeTranscriptText(value: unknown): string {
    return String(value ?? '').trim();
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

export const voiceInferenceRuntimeEngine = {
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
                filePath: input.packDir,
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
    primeModel: async (input) => {
        // Run one tiny dummy inference pass on the warmed runtime so the first real
        // utterance does not pay native cold-start latency. Reuses the cached runtime
        // (warmModel already loaded it), so this is cheap and idempotent.
        throwIfAborted(input.signal);
        if (String(input.manifest?.kind ?? '') === 'tts_sherpa') {
            const { runtime } = await createTtsRuntime({
                requestId: 'prime-model',
                text: 'a',
                voiceId: null,
                speed: null,
                output: { codec: 'wav', mimeType: 'audio/wav' },
                ...input,
            });
            runtime.generate({ text: 'a', sid: 0, speed: DEFAULT_TTS_SPEED });
            return;
        }
        if (String(input.manifest?.kind ?? '') === 'stt_sherpa') {
            const sttRuntime = await createSttRuntime({
                requestId: 'prime-model',
                filePath: input.packDir,
                inputMimeType: 'audio/wav',
                language: null,
                normalization: {
                    inputTransport: 'upload_transfer',
                    strategy: 'ui_pretranscoded_pcm16_fallback',
                    systemFfmpegAllowed: false,
                },
                ...input,
            });
            // A short slice of silence at the canonical sample rate is enough to drive one
            // decode pass through the native graph without depending on a model fixture file.
            if (sttRuntime.kind === 'offline') {
                const stream = sttRuntime.runtime.createStream();
                stream.acceptWaveform({
                    samples: new Float32Array(DEFAULT_STT_SAMPLE_RATE / 100),
                    sampleRate: DEFAULT_STT_SAMPLE_RATE,
                });
                await decodeOfflineRecognizer(sttRuntime.runtime, stream, input.signal);
                return;
            }
            const stream = sttRuntime.runtime.createStream();
            stream.acceptWaveform({
                samples: new Float32Array(DEFAULT_STT_SAMPLE_RATE / 100),
                sampleRate: DEFAULT_STT_SAMPLE_RATE,
            });
            stream.inputFinished();
            await decodeOnlineRecognizerWhileReady(
                sttRuntime.runtime,
                stream,
                () => throwIfAborted(input.signal),
            );
            sttRuntime.runtime.getResult(stream);
            return;
        }
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
    createStreamingTranscriptionSession: async (
        input: VoiceInferenceRuntimeCreateStreamingTranscriptionSessionInput,
    ): Promise<VoiceInferenceStreamingTranscriptionSession> => {
        throwIfAborted(input.signal);
        if (
            input.format.sampleRateHz !== DEFAULT_STT_SAMPLE_RATE
            || input.format.channelCount !== 1
            || input.format.bitsPerSample !== 16
        ) {
            throw createVoiceInferenceError('invalid_audio_input', 'voice_inference_streaming_stt_invalid_format');
        }
        const sttRuntime = await createSttRuntime({
            requestId: input.requestId,
            filePath: input.packDir,
            inputMimeType: 'audio/wav',
            packId: input.packId,
            packDir: input.packDir,
            manifest: input.manifest,
            runtimeDescriptor: input.runtimeDescriptor,
            supportArtifacts: input.supportArtifacts,
            language: input.language,
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'ui_pretranscoded_pcm16_fallback',
                systemFfmpegAllowed: false,
            },
            signal: input.signal,
        });
        if (sttRuntime.kind !== 'streaming') {
            throw createVoiceInferenceError('runtime_unavailable', 'voice_inference_streaming_stt_unavailable');
        }
        const runtime = sttRuntime.runtime;
        if (typeof runtime.isEndpoint !== 'function' || typeof runtime.reset !== 'function') {
            throw createVoiceInferenceError('runtime_unavailable', 'voice_inference_streaming_stt_unavailable');
        }
        const stream = runtime.createStream();
        const committedSegments: string[] = [];
        let closed = false;
        let openPartialText = '';

        const assertOpen = () => {
            throwIfAborted(input.signal);
            if (closed) {
                throw createVoiceInferenceError('cancelled', 'voice_inference_stream_closed');
            }
        };

        const drain = async (seq: number, signal?: AbortSignal | null) => {
            const events = [];
            const decodedInDrain = await decodeOnlineRecognizerWhileReady(runtime, stream, () => {
                assertOpen();
                throwIfAborted(signal);
            });
            const currentText = normalizeTranscriptText(runtime.getResult(stream).text);
            const isEndpoint = runtime.isEndpoint?.(stream) === true;
            if (
                currentText
                && currentText !== openPartialText
                && (decodedInDrain || committedSegments.length === 0 || openPartialText.length > 0)
            ) {
                openPartialText = currentText;
                events.push({
                    type: 'partial' as const,
                    seq,
                    text: currentText,
                    isEndpoint,
                    confidence: null,
                });
            }
            if (isEndpoint) {
                if (currentText) {
                    committedSegments.push(currentText);
                }
                events.push({
                    type: 'endpoint' as const,
                    seq,
                    transcript: currentText,
                    reason: 'vad' as const,
                });
                runtime.reset?.(stream);
                openPartialText = '';
            }
            return events;
        };

        return {
            appendPcm16: async ({ seq, pcm16Bytes, signal }) => {
                assertOpen();
                throwIfAborted(signal);
                const samples = decodePcm16Bytes(pcm16Bytes);
                stream.acceptWaveform({
                    samples,
                    sampleRate: DEFAULT_STT_SAMPLE_RATE,
                });
                return { events: await drain(seq, signal) };
            },
            finish: async ({ finalSeq, signal }) => {
                assertOpen();
                throwIfAborted(signal);
                stream.inputFinished();
                const finishEvents = await drain(finalSeq, signal);
                const finalText = [...committedSegments, openPartialText]
                    .map((segment) => segment.trim())
                    .filter((segment) => segment.length > 0)
                    .join(' ')
                    .trim();
                closed = true;
                return {
                    text: finalText,
                    language: input.language,
                    events: [
                        ...finishEvents,
                        {
                            type: 'final' as const,
                            seq: finalSeq,
                            text: finalText,
                            language: input.language,
                            modelPackId: input.packId,
                        },
                    ],
                };
            },
            cancel: async () => {
                closed = true;
            },
            close: async () => {
                closed = true;
            },
        };
    },
    transcribeAudio: async (input) => {
        throwIfAborted(input.signal);
        const sttRuntime = await createSttRuntime(input);
        const audio = await readNormalizedWavAudio(input.filePath);
        if (sttRuntime.kind === 'offline') {
            const stream = sttRuntime.runtime.createStream();
            stream.acceptWaveform({
                samples: audio.samples,
                sampleRate: audio.sampleRate,
            });
            const result = await decodeOfflineRecognizer(sttRuntime.runtime, stream, input.signal);
            return {
                text: normalizeTranscriptText(result.text),
                language: input.language,
            };
        }

        const stream = sttRuntime.runtime.createStream();
        stream.acceptWaveform({
            samples: audio.samples,
            sampleRate: audio.sampleRate,
        });
        stream.inputFinished();
        await decodeOnlineRecognizerWhileReady(
            sttRuntime.runtime,
            stream,
            () => throwIfAborted(input.signal),
        );
        const result = sttRuntime.runtime.getResult(stream);
        throwIfAborted(input.signal);
        return {
            text: String(result.text ?? '').trim(),
            language: input.language,
        };
    },
} satisfies VoiceInferenceRuntimeEngine;
