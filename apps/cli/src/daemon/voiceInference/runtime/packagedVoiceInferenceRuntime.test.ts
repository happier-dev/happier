import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VoiceInferenceRuntimeTranscribeInput } from '../voiceInferenceRuntimeTypes';

const spawnMock = vi.hoisted(() => vi.fn());
const require = createRequire(import.meta.url);
const ZIPFORMER_PACK_ID = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
const PUBLIC_ZIPFORMER_PACK_ID = 'dev.happier.fixture.voice.zipformer/zipformer-en-20m';
const ZIPFORMER_SUPPORT_PATHS = [
    'LICENSES/Apache-2.0.txt',
    'LICENSES/GPL-3.0.txt',
    'LICENSES/README.txt',
    'THIRD_PARTY_NOTICES.txt',
] as const;
const PARAKEET_PACK_ID = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8';

function manifestFiles(paths: readonly string[]) {
    return paths.map((path, index) => ({
        path,
        url: `https://models.example.test/${index}`,
        sha256: String(index + 1).repeat(64),
        sizeBytes: 1,
    }));
}

vi.mock('node:child_process', () => ({
    spawn: (...args: unknown[]) => spawnMock(...args),
}));

function createMonoPcm16WavBuffer(sampleCount = 8, sampleRate = 16_000): Buffer {
    const dataSize = sampleCount * 2;
    const buffer = Buffer.alloc(44 + dataSize);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * 2, 28);
    buffer.writeUInt16LE(2, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(dataSize, 40);
    for (let index = 0; index < sampleCount; index += 1) {
        buffer.writeInt16LE(index * 128, 44 + (index * 2));
    }
    return buffer;
}

type MockChildProcess = EventEmitter & Readonly<{
    stderr: EventEmitter;
    stdout: EventEmitter;
    kill: () => boolean;
}>;

function createMockChildProcess(): MockChildProcess {
    const child = new EventEmitter() as MockChildProcess;
    Object.assign(child, {
        stderr: new EventEmitter(),
        stdout: new EventEmitter(),
        kill: () => true,
    });
    return child;
}

describe('packagedVoiceInferenceRuntime', () => {
    const tempDirs: string[] = [];

    async function createTempDir(): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), 'happier-packaged-voice-runtime-'));
        tempDirs.push(dir);
        return dir;
    }

    async function createInputFixture(rootDir: string, overrides?: Partial<VoiceInferenceRuntimeTranscribeInput>): Promise<VoiceInferenceRuntimeTranscribeInput> {
        const filePath = join(rootDir, 'input.webm');
        await writeFile(filePath, Buffer.from('compressed-audio'));
        return {
            requestId: 'stt-1',
            filePath,
            inputMimeType: 'audio/webm;codecs=opus',
            packId: ZIPFORMER_PACK_ID,
            packDir: rootDir,
            manifest: {
                packId: ZIPFORMER_PACK_ID,
                kind: 'stt_sherpa',
                model: 'sherpa',
                version: '2026-04-17',
                files: manifestFiles([
                    'encoder.onnx',
                    'decoder.onnx',
                    'joiner.onnx',
                    'tokens.txt',
                ]),
            },
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
            ...overrides,
        };
    }

    async function ensureFfmpegBinaryFixture(): Promise<void> {
        const ffmpegBinaryPath = require('ffmpeg-static');
        await writeFile(ffmpegBinaryPath, '#!/bin/sh\nexit 0\n');
    }

    async function createParakeetFixture(rootDir: string, options?: Readonly<{ omitEncoder?: boolean }>): Promise<VoiceInferenceRuntimeTranscribeInput> {
        const filePath = join(rootDir, 'parakeet-input.wav');
        await Promise.all([
            writeFile(filePath, createMonoPcm16WavBuffer(32, 16_000)),
            options?.omitEncoder ? Promise.resolve() : writeFile(join(rootDir, 'encoder.int8.onnx'), 'encoder', 'utf8'),
            writeFile(join(rootDir, 'decoder.int8.onnx'), 'decoder', 'utf8'),
            writeFile(join(rootDir, 'joiner.int8.onnx'), 'joiner', 'utf8'),
            writeFile(join(rootDir, 'tokens.txt'), 'tokens', 'utf8'),
        ]);
        return {
            requestId: 'parakeet-stt-1',
            filePath,
            inputMimeType: 'audio/wav',
            packId: PARAKEET_PACK_ID,
            packDir: rootDir,
            manifest: {
                packId: PARAKEET_PACK_ID,
                kind: 'stt_sherpa',
                model: PARAKEET_PACK_ID,
                version: '1ab9323565ddb038682214b292f588070a538ce2',
                files: manifestFiles([
                    'encoder.int8.onnx',
                    'decoder.int8.onnx',
                    'joiner.int8.onnx',
                    'tokens.txt',
                ]),
            },
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'ui_pretranscoded_pcm16_fallback',
                systemFfmpegAllowed: false,
            },
        };
    }

    afterEach(async () => {
        vi.resetModules();
        spawnMock.mockReset();
        await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    });

    it('transcodes supported compressed audio into a wav path for daemon_decode inputs', async () => {
        const rootDir = await createTempDir();
        const input = await createInputFixture(rootDir);
        await ensureFfmpegBinaryFixture();

        spawnMock.mockImplementation((_command: unknown, args: unknown[]) => {
            const child = createMockChildProcess();
            const spawnArgs = args as string[];
            const outputPath = spawnArgs.at(-1);
            if (!outputPath) {
                throw new Error('expected ffmpeg output path');
            }
            void writeFile(outputPath, createMonoPcm16WavBuffer()).then(() => {
                child.emit('close', 0);
            });
            return child;
        });

        const { voiceInferenceRuntimeEngine } = await import('./packagedVoiceInferenceRuntime');
        const decoded = await voiceInferenceRuntimeEngine.decodeAudioInput?.(input);

        expect(decoded).toMatchObject({
            inputMimeType: 'audio/wav',
        });
        expect(decoded?.filePath).not.toBe(input.filePath);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([
            '-i',
            input.filePath,
            '-ac',
            '1',
            '-ar',
            '16000',
            '-c:a',
            'pcm_s16le',
        ]));
        const decodedBuffer = await readFile(String(decoded?.filePath));
        expect(decodedBuffer.subarray(0, 4).toString('ascii')).toBe('RIFF');
        expect(decodedBuffer.subarray(8, 12).toString('ascii')).toBe('WAVE');
    });

    it('keeps the unsupported_codec error shape when the packaged decoder cannot decode the input', async () => {
        const rootDir = await createTempDir();
        const input = await createInputFixture(rootDir, {
            inputMimeType: 'audio/mp4',
        });
        await ensureFfmpegBinaryFixture();

        spawnMock.mockImplementation(() => {
            const child = createMockChildProcess();
            queueMicrotask(() => {
                child.stderr.emit('data', Buffer.from('unsupported container'));
                child.emit('close', 1);
            });
            return child;
        });

        const { voiceInferenceRuntimeEngine } = await import('./packagedVoiceInferenceRuntime');

        try {
            await voiceInferenceRuntimeEngine.decodeAudioInput?.(input);
            throw new Error('expected_decodeAudioInput_to_throw');
        } catch (error) {
            expect(error).toMatchObject({ code: 'unsupported_codec' });
            // Decoder stderr can include file paths and other local details; do not leak it via error messages.
            if (error instanceof Error) {
                expect(error.message).not.toContain('unsupported container');
            }
        }
    });

    it('redacts spawn failures from packaged decoder errors', async () => {
        const rootDir = await createTempDir();
        const input = await createInputFixture(rootDir);
        await ensureFfmpegBinaryFixture();

        spawnMock.mockImplementation(() => {
            const child = createMockChildProcess();
            queueMicrotask(() => {
                child.emit('error', new Error('spawn /Users/leeroy/private/input.webm failed'));
            });
            return child;
        });

        const { voiceInferenceRuntimeEngine } = await import('./packagedVoiceInferenceRuntime');

        try {
            await voiceInferenceRuntimeEngine.decodeAudioInput?.(input);
            throw new Error('expected_decodeAudioInput_to_throw');
        } catch (error) {
            expect(error).toMatchObject({ code: 'runtime_unavailable' });
            if (error instanceof Error) {
                expect(error.message).toBe('voice_inference_runtime_unavailable');
                expect(error.message).not.toContain('/Users/leeroy/private');
            }
        }
    });

    it('loads constructors from the actual CommonJS ESM namespace default export', async () => {
        const rootDir = await createTempDir();
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const manifest = {
            packId,
            kind: 'tts_sherpa' as const,
            model: 'kokoro',
            version: '2026-04-17',
            files: manifestFiles([
                ...ZIPFORMER_SUPPORT_PATHS,
                'model.onnx',
                'voices.bin',
                'tokens.txt',
                'espeak-ng-data/en_dict',
            ]),
        };
        await mkdir(join(rootDir, 'LICENSES'));
        await Promise.all([
            mkdir(join(rootDir, 'espeak-ng-data')),
            writeFile(join(rootDir, 'model.onnx'), 'tts-model', 'utf8'),
            writeFile(join(rootDir, 'voices.bin'), 'tts-voices', 'utf8'),
            writeFile(join(rootDir, 'tokens.txt'), 'shared-tokens', 'utf8'),
            writeFile(join(rootDir, 'espeak-ng-data/en_dict'), 'dictionary', 'utf8'),
            ...ZIPFORMER_SUPPORT_PATHS.map((path) => writeFile(join(rootDir, path), 'support', 'utf8')),
        ]);

        const constructedConfigs: Record<string, unknown>[] = [];
        class MockOfflineTts {
            constructor(config: Record<string, unknown>) {
                constructedConfigs.push(config);
            }

            generate() {
                return {
                    samples: new Float32Array([0.1, 0.2]),
                    sampleRate: 16_000,
                };
            }
        }
        vi.doMock('sherpa-onnx-node', () => ({
            // `sherpa-onnx-node@1.12.38` is CommonJS. Node's ESM namespace exposes
            // OnlineRecognizer as a synthetic named export, while OfflineTts and
            // OfflineRecognizer are available only through `default`.
            OnlineRecognizer: class MockOnlineRecognizer {},
            default: {
                OnlineRecognizer: class MockDefaultOnlineRecognizer {},
                OfflineRecognizer: class MockOfflineRecognizer {},
                OfflineTts: MockOfflineTts,
            },
        }));

        const { voiceInferenceRuntimeEngine } = await import('./packagedVoiceInferenceRuntime');
        await voiceInferenceRuntimeEngine.warmModel?.({
            packId,
            packDir: rootDir,
            manifest,
        });

        expect(constructedConfigs).toEqual([
            expect.objectContaining({
                model: expect.objectContaining({
                    kokoro: expect.objectContaining({
                        lang: 'en',
                    }),
                }),
            }),
        ]);
    });

    it('disposes warmed cached runtimes when releaseModel is invoked', async () => {
        const rootDir = await createTempDir();
        const ttsManifest = {
            packId: 'kokoro-82m-v1.0-onnx-q8-wasm',
            kind: 'tts_sherpa' as const,
            model: 'kokoro',
            version: '2026-04-17',
            files: manifestFiles([
                ...ZIPFORMER_SUPPORT_PATHS,
                'model.onnx',
                'voices.bin',
                'tokens.txt',
                'espeak-ng-data/en_dict',
            ]),
        };
        const sttManifest = {
            packId: ZIPFORMER_PACK_ID,
            kind: 'stt_sherpa' as const,
            model: 'sherpa',
            version: '2026-04-17',
            files: manifestFiles([...ZIPFORMER_SUPPORT_PATHS, 'encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']),
        };
        await mkdir(join(rootDir, 'LICENSES'));
        await Promise.all([
            mkdir(join(rootDir, 'espeak-ng-data')),
            writeFile(join(rootDir, 'model.onnx'), 'tts-model', 'utf8'),
            writeFile(join(rootDir, 'voices.bin'), 'tts-voices', 'utf8'),
            writeFile(join(rootDir, 'tokens.txt'), 'shared-tokens', 'utf8'),
            writeFile(join(rootDir, 'encoder.onnx'), 'stt-encoder', 'utf8'),
            writeFile(join(rootDir, 'decoder.onnx'), 'stt-decoder', 'utf8'),
            writeFile(join(rootDir, 'joiner.onnx'), 'stt-joiner', 'utf8'),
            ...ZIPFORMER_SUPPORT_PATHS.map((path) => writeFile(join(rootDir, path), 'support', 'utf8')),
        ]);

        const disposedKinds: string[] = [];
        vi.doMock('sherpa-onnx-node', () => ({
            OfflineTts: class MockOfflineTts {
                generate() {
                    return {
                        samples: new Float32Array([0.1, 0.2]),
                        sampleRate: 16_000,
                    };
                }

                dispose() {
                    disposedKinds.push('tts');
                }
            },
            OnlineRecognizer: class MockOnlineRecognizer {
                createStream() {
                    return {
                        acceptWaveform() {},
                        inputFinished() {},
                    };
                }

                isReady() {
                    return false;
                }

                decode() {}

                getResult() {
                    return { text: 'decoded' };
                }

                close() {
                    disposedKinds.push('stt');
                }
            },
        }));

        const { voiceInferenceRuntimeEngine } = await import('./packagedVoiceInferenceRuntime');

        await voiceInferenceRuntimeEngine.warmModel?.({
            packId: ttsManifest.packId,
            packDir: rootDir,
            manifest: ttsManifest,
        });
        await voiceInferenceRuntimeEngine.warmModel?.({
            packId: sttManifest.packId,
            packDir: rootDir,
            manifest: sttManifest,
        });

        await voiceInferenceRuntimeEngine.releaseModel?.({
            packId: ttsManifest.packId,
            packDir: rootDir,
            manifest: ttsManifest,
        });
        await voiceInferenceRuntimeEngine.releaseModel?.({
            packId: sttManifest.packId,
            packDir: rootDir,
            manifest: sttManifest,
        });

        expect(disposedKinds).toEqual(['tts', 'stt']);
    });

    it('creates true streaming STT sessions with partial, endpoint, and final events', async () => {
        const rootDir = await createTempDir();
        const sttManifest = {
            packId: 'vp-public-zipformer',
            kind: 'stt_sherpa' as const,
            model: 'sherpa',
            version: '2026-04-17',
            files: manifestFiles([...ZIPFORMER_SUPPORT_PATHS, 'encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']),
        };
        await mkdir(join(rootDir, 'LICENSES'));
        await Promise.all([
            writeFile(join(rootDir, 'tokens.txt'), 'shared-tokens', 'utf8'),
            writeFile(join(rootDir, 'encoder.onnx'), 'stt-encoder', 'utf8'),
            writeFile(join(rootDir, 'decoder.onnx'), 'stt-decoder', 'utf8'),
            writeFile(join(rootDir, 'joiner.onnx'), 'stt-joiner', 'utf8'),
            ...ZIPFORMER_SUPPORT_PATHS.map((path) => writeFile(join(rootDir, path), 'support', 'utf8')),
        ]);

        const acceptedSamples: number[] = [];
        const decoded: string[] = [];
        const resetCalls: string[] = [];
        vi.doMock('sherpa-onnx-node', () => ({
            OfflineTts: class MockOfflineTts {
                generate() {
                    return {
                        samples: new Float32Array([0.1, 0.2]),
                        sampleRate: 16_000,
                    };
                }
            },
            OnlineRecognizer: class MockOnlineRecognizer {
                private decodeCount = 0;

                createStream() {
                    return {
                        acceptWaveform: ({ samples }: { samples: Float32Array }) => {
                            acceptedSamples.push(samples.length);
                        },
                        inputFinished: () => {
                            decoded.push('inputFinished');
                        },
                    };
                }

                isReady() {
                    return this.decodeCount < 1;
                }

                decode() {
                    this.decodeCount += 1;
                    decoded.push(`decode:${this.decodeCount}`);
                }

                getResult() {
                    return this.decodeCount === 1 ? { text: 'hel' } : { text: 'hello' };
                }

                isEndpoint() {
                    return this.decodeCount === 1;
                }

                reset() {
                    resetCalls.push('reset');
                    this.decodeCount = 2;
                }
            },
        }));

        const { voiceInferenceRuntimeEngine } = await import('./packagedVoiceInferenceRuntime');
        const session = await voiceInferenceRuntimeEngine.createStreamingTranscriptionSession?.({
            requestId: 'stt-stream-runtime',
            packId: PUBLIC_ZIPFORMER_PACK_ID,
            packDir: rootDir,
            manifest: sttManifest,
            runtimeDescriptor: {
                family: 'sherpa_zipformer_streaming',
                artifacts: {
                    encoder: { type: 'file', path: 'encoder.onnx' },
                    decoder: { type: 'file', path: 'decoder.onnx' },
                    joiner: { type: 'file', path: 'joiner.onnx' },
                    tokens: { type: 'file', path: 'tokens.txt' },
                },
                abiVersion: 1,
                minHostVersion: '0.2.10',
                platforms: ['darwin', 'linux', 'win32'],
                architectures: ['arm64', 'x64'],
            },
            supportArtifacts: [
                { type: 'file', kind: 'license', path: 'LICENSES/Apache-2.0.txt' },
                { type: 'file', kind: 'license', path: 'LICENSES/GPL-3.0.txt' },
                { type: 'file', kind: 'provenance', path: 'LICENSES/README.txt' },
                { type: 'file', kind: 'notice', path: 'THIRD_PARTY_NOTICES.txt' },
            ],
            language: 'en',
            format: {
                sampleRateHz: 16_000,
                channelCount: 1,
                bitsPerSample: 16,
                ffmpegCodec: 'pcm_s16le',
            },
        });

        await expect(session?.appendPcm16({ seq: 0, pcm16Bytes: new Uint8Array([0, 0, 1, 0]) })).resolves.toEqual({
            events: [
                { type: 'partial', seq: 0, text: 'hel', isEndpoint: true, confidence: null },
                { type: 'endpoint', seq: 0, transcript: 'hel', reason: 'vad' },
            ],
        });
        await expect(session?.finish({ finalSeq: 0 })).resolves.toEqual({
            text: 'hel',
            language: 'en',
            events: [{ type: 'final', seq: 0, text: 'hel', language: 'en', modelPackId: PUBLIC_ZIPFORMER_PACK_ID }],
        });
        expect(acceptedSamples).toEqual([2]);
        expect(decoded).toEqual(['decode:1', 'inputFinished']);
        expect(resetCalls).toEqual(['reset']);
    });

    it('observes timer-driven cancellation before an online Zipformer append drains all ready decode work', async () => {
        const rootDir = await createTempDir();
        const sttManifest = {
            packId: 'vp-public-zipformer-cancellation',
            kind: 'stt_sherpa' as const,
            model: 'sherpa',
            version: '2026-04-17',
            files: manifestFiles([...ZIPFORMER_SUPPORT_PATHS, 'encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']),
        };
        await mkdir(join(rootDir, 'LICENSES'));
        await Promise.all([
            writeFile(join(rootDir, 'tokens.txt'), 'shared-tokens', 'utf8'),
            writeFile(join(rootDir, 'encoder.onnx'), 'stt-encoder', 'utf8'),
            writeFile(join(rootDir, 'decoder.onnx'), 'stt-decoder', 'utf8'),
            writeFile(join(rootDir, 'joiner.onnx'), 'stt-joiner', 'utf8'),
            ...ZIPFORMER_SUPPORT_PATHS.map((path) => writeFile(join(rootDir, path), 'support', 'utf8')),
        ]);

        const abortController = new AbortController();
        const totalDecodeIterations = 64;
        let decodeCount = 0;
        vi.doMock('sherpa-onnx-node', () => ({
            OfflineTts: class MockOfflineTts {},
            OnlineRecognizer: class MockOnlineRecognizer {
                createStream() {
                    return {
                        acceptWaveform() {},
                        inputFinished() {},
                    };
                }

                isReady() {
                    return decodeCount < totalDecodeIterations;
                }

                decode() {
                    decodeCount += 1;
                    if (decodeCount === 1) {
                        setImmediate(() => abortController.abort());
                    }
                }

                getResult() {
                    return { text: 'must not escape' };
                }

                isEndpoint() {
                    return false;
                }

                reset() {}
            },
        }));

        const { voiceInferenceRuntimeEngine } = await import('./packagedVoiceInferenceRuntime');
        const session = await voiceInferenceRuntimeEngine.createStreamingTranscriptionSession?.({
            requestId: 'stt-stream-cancel-during-decode',
            packId: PUBLIC_ZIPFORMER_PACK_ID,
            packDir: rootDir,
            manifest: sttManifest,
            runtimeDescriptor: {
                family: 'sherpa_zipformer_streaming',
                artifacts: {
                    encoder: { type: 'file', path: 'encoder.onnx' },
                    decoder: { type: 'file', path: 'decoder.onnx' },
                    joiner: { type: 'file', path: 'joiner.onnx' },
                    tokens: { type: 'file', path: 'tokens.txt' },
                },
                abiVersion: 1,
                minHostVersion: '0.2.10',
                platforms: ['darwin', 'linux', 'win32'],
                architectures: ['arm64', 'x64'],
            },
            supportArtifacts: [
                { type: 'file', kind: 'license', path: 'LICENSES/Apache-2.0.txt' },
                { type: 'file', kind: 'license', path: 'LICENSES/GPL-3.0.txt' },
                { type: 'file', kind: 'provenance', path: 'LICENSES/README.txt' },
                { type: 'file', kind: 'notice', path: 'THIRD_PARTY_NOTICES.txt' },
            ],
            language: 'en',
            format: {
                sampleRateHz: 16_000,
                channelCount: 1,
                bitsPerSample: 16,
                ffmpegCodec: 'pcm_s16le',
            },
        });

        await expect(session?.appendPcm16({
            seq: 0,
            pcm16Bytes: new Uint8Array([0, 0]),
            signal: abortController.signal,
        })).rejects.toMatchObject({ code: 'cancelled' });
        expect(decodeCount).toBeGreaterThan(0);
        expect(decodeCount).toBeLessThan(totalDecodeIterations);
    });

    it('loads Parakeet through the offline NeMo transducer ABI and transcribes canonical wav input', async () => {
        const rootDir = await createTempDir();
        const input = await createParakeetFixture(rootDir);
        const configs: Record<string, unknown>[] = [];
        const accepted: Array<{ sampleRate: number; sampleCount: number }> = [];

        vi.doMock('sherpa-onnx-node', () => ({
            OfflineTts: class MockOfflineTts {},
            OnlineRecognizer: class UnexpectedOnlineRecognizer {
                constructor() {
                    throw new Error('parakeet_must_not_use_online_recognizer');
                }
            },
            OfflineRecognizer: class MockOfflineRecognizer {
                constructor(config: Record<string, unknown>) {
                    configs.push(config);
                }

                createStream() {
                    return {
                        acceptWaveform: ({ samples, sampleRate }: { samples: Float32Array; sampleRate: number }) => {
                            accepted.push({ sampleRate, sampleCount: samples.length });
                        },
                    };
                }

                async decodeAsync() {
                    return { text: 'Hello from Parakeet.' };
                }

                getResult() {
                    throw new Error('decodeAsync_result_should_be_canonical');
                }
            },
        }));

        const { voiceInferenceRuntimeEngine } = await import('./packagedVoiceInferenceRuntime');

        await expect(voiceInferenceRuntimeEngine.transcribeAudio(input)).resolves.toEqual({
            text: 'Hello from Parakeet.',
            language: 'en',
        });
        expect(configs).toEqual([{
            featConfig: {
                sampleRate: 16_000,
                featureDim: 80,
            },
            modelConfig: {
                transducer: {
                    encoder: join(rootDir, 'encoder.int8.onnx'),
                    decoder: join(rootDir, 'decoder.int8.onnx'),
                    joiner: join(rootDir, 'joiner.int8.onnx'),
                },
                tokens: join(rootDir, 'tokens.txt'),
                numThreads: 2,
                provider: 'cpu',
                modelType: 'nemo_transducer',
            },
        }]);
        expect(accepted).toEqual([{ sampleRate: 16_000, sampleCount: 32 }]);
    });

    it('drops an offline Parakeet result when cancellation wins during native decode', async () => {
        const rootDir = await createTempDir();
        const abortController = new AbortController();
        const input = await createParakeetFixture(rootDir);
        let resolveDecode: (value: { text: string }) => void = () => {
            throw new Error('decode_gate_not_initialized');
        };
        const decodePromise = new Promise<{ text: string }>((resolve) => {
            resolveDecode = resolve;
        });
        const decodeStarted = new Promise<void>((resolve) => {
            vi.doMock('sherpa-onnx-node', () => ({
                OfflineTts: class MockOfflineTts {},
                OnlineRecognizer: class UnexpectedOnlineRecognizer {},
                OfflineRecognizer: class MockOfflineRecognizer {
                    createStream() {
                        return { acceptWaveform() {} };
                    }

                    decodeAsync() {
                        resolve();
                        return decodePromise;
                    }
                },
            }));
        });

        const { voiceInferenceRuntimeEngine } = await import('./packagedVoiceInferenceRuntime');
        const pending = voiceInferenceRuntimeEngine.transcribeAudio({ ...input, signal: abortController.signal });
        await decodeStarted;
        abortController.abort();
        resolveDecode({ text: 'must not escape' });

        await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    });

    it('warms, primes, reuses, and unloads a Parakeet offline runtime deterministically', async () => {
        const rootDir = await createTempDir();
        const input = await createParakeetFixture(rootDir);
        let constructed = 0;
        let decoded = 0;
        let closed = 0;
        vi.doMock('sherpa-onnx-node', () => ({
            OfflineTts: class MockOfflineTts {},
            OnlineRecognizer: class UnexpectedOnlineRecognizer {},
            OfflineRecognizer: class MockOfflineRecognizer {
                constructor() {
                    constructed += 1;
                }

                createStream() {
                    return { acceptWaveform() {} };
                }

                async decodeAsync() {
                    decoded += 1;
                    return { text: '' };
                }

                getResult() {
                    return { text: '' };
                }

                close() {
                    closed += 1;
                }
            },
        }));

        const { voiceInferenceRuntimeEngine } = await import('./packagedVoiceInferenceRuntime');
        const modelInput = {
            packId: input.packId,
            packDir: input.packDir,
            manifest: input.manifest,
        };
        await voiceInferenceRuntimeEngine.warmModel?.(modelInput);
        await voiceInferenceRuntimeEngine.warmModel?.(modelInput);
        await voiceInferenceRuntimeEngine.primeModel?.(modelInput);
        await voiceInferenceRuntimeEngine.releaseModel?.(modelInput);
        await voiceInferenceRuntimeEngine.warmModel?.(modelInput);

        expect({ constructed, decoded, closed }).toEqual({ constructed: 2, decoded: 1, closed: 1 });
    });

    it('keeps Parakeet unavailable to the true-streaming STT operation', async () => {
        const rootDir = await createTempDir();
        const input = await createParakeetFixture(rootDir);
        vi.doMock('sherpa-onnx-node', () => ({
            OfflineTts: class MockOfflineTts {},
            OnlineRecognizer: class UnexpectedOnlineRecognizer {},
            OfflineRecognizer: class MockOfflineRecognizer {
                createStream() {
                    return { acceptWaveform() {} };
                }

                decode() {}

                getResult() {
                    return { text: '' };
                }
            },
        }));

        const { voiceInferenceRuntimeEngine } = await import('./packagedVoiceInferenceRuntime');

        await expect(voiceInferenceRuntimeEngine.createStreamingTranscriptionSession?.({
            requestId: 'parakeet-stream-rejected',
            packId: input.packId,
            packDir: input.packDir,
            manifest: input.manifest,
            language: 'en',
            format: {
                sampleRateHz: 16_000,
                channelCount: 1,
                bitsPerSample: 16,
                ffmpegCodec: 'pcm_s16le',
            },
        })).rejects.toMatchObject({
            code: 'runtime_unavailable',
            message: 'voice_inference_streaming_stt_unavailable',
        });
    });

    it('fails Parakeet loading with a typed error when a manifest-declared role is absent', async () => {
        const rootDir = await createTempDir();
        const input = await createParakeetFixture(rootDir, { omitEncoder: true });
        vi.doMock('sherpa-onnx-node', () => ({
            OfflineTts: class MockOfflineTts {},
            OnlineRecognizer: class MockOnlineRecognizer {},
            OfflineRecognizer: class MockOfflineRecognizer {},
        }));

        const { voiceInferenceRuntimeEngine } = await import('./packagedVoiceInferenceRuntime');

        await expect(voiceInferenceRuntimeEngine.transcribeAudio(input)).rejects.toMatchObject({
            code: 'voice_inference_missing_stt_encoder',
        });
    });
});
