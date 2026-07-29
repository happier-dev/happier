import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import {
    getModelPackCatalogEntry,
    type DaemonVoiceInferenceAudioOutput,
    type DaemonVoiceInferenceNormalizationDecision,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

function sha256Hex(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
}

function createMonoPcm16WavBuffer(sampleCount = 4, sampleRate = 16_000): Buffer {
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

describe('voiceInferenceWorker', () => {
    const envKeys = [
        'HAPPIER_HOME_DIR',
        'HAPPIER_MODEL_PACK_MANIFESTS',
        'HAPPIER_VOICE_INFERENCE_RUNTIME_MODULE',
        'HAPPIER_VOICE_INFERENCE_PER_MODEL_CONCURRENCY',
        'HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES',
    ] as const;
    let envScope = createEnvKeyScope(envKeys);
    const tempDirs: string[] = [];
    const servers: Server[] = [];

    async function createHomeDir(): Promise<string> {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-voice-inference-worker-'));
        tempDirs.push(homeDir);
        return homeDir;
    }

    async function importWorkerModuleForHome(homeDir: string) {
        process.env.HAPPIER_HOME_DIR = homeDir;
        vi.resetModules();
        const configurationModule = await import('@/configuration');
        configurationModule.reloadConfiguration();
        return await import('./voiceInferenceWorker');
    }

    async function serveSinglePack(params: Readonly<{
        packId: string;
        kind: 'tts_sherpa' | 'stt_sherpa';
        model: string;
        modelBytes: Buffer;
    }>): Promise<void> {
        const { packId, kind, model, modelBytes } = params;
        const server = createServer();
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind,
                        model,
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });
    }

    afterEach(async () => {
        // Restore real timers unconditionally so a fake-timer test that throws before its own
        // `vi.useRealTimers()` cannot leak a frozen clock into later real-timer tests.
        vi.useRealTimers();
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        vi.resetModules();
        vi.doUnmock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath');
        while (servers.length > 0) {
            const server = servers.pop();
            if (!server) {
                continue;
            }
            await new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            }).catch(() => undefined);
        }
        await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    });

    it('installs packs, synthesizes TTS, and transcribes uploaded audio through the worker runtime', async () => {
        const ttsPackId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const sttPackId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
        const ttsModelBytes = Buffer.from('tts-model');
        const sttModelBytes = Buffer.from('stt-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === `/${ttsPackId}/manifest.json`) {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId: ttsPackId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        voices: [{ id: 'af_bella', title: 'Bella' }],
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${ttsPackId}/model.onnx`,
                                sha256: sha256Hex(ttsModelBytes),
                                sizeBytes: ttsModelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === `/${sttPackId}/manifest.json`) {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId: sttPackId,
                        kind: 'stt_sherpa',
                        model: 'sherpa',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${sttPackId}/model.onnx`,
                                sha256: sha256Hex(sttModelBytes),
                                sizeBytes: sttModelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === `/${ttsPackId}/model.onnx`) {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(ttsModelBytes.byteLength));
                    response.end(ttsModelBytes);
                    return;
                }
                if (url === `/${sttPackId}/model.onnx`) {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(sttModelBytes.byteLength));
                    response.end(sttModelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [ttsPackId]: `http://127.0.0.1:${address.port}/${ttsPackId}/manifest.json`,
            [sttPackId]: `http://127.0.0.1:${address.port}/${sttPackId}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const warmCalls: string[] = [];
        const synthCalls: string[] = [];
        const transcribeCalls: string[] = [];
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async ({ packId }) => {
                    warmCalls.push(packId);
                },
                synthesizeTts: async ({ packId, text, voiceId, speed, signal }) => {
                    expect(signal?.aborted).toBe(false);
                    synthCalls.push(`${packId}:${text}:${voiceId ?? 'none'}:${speed ?? 'none'}`);
                    return {
                        bytes: Buffer.from('tts-audio'),
                        output: { codec: 'wav', mimeType: 'audio/wav' },
                        name: 'daemon-tts.wav',
                    };
                },
                transcribeAudio: async ({ packId, filePath, language, normalization, signal }) => {
                    expect(signal?.aborted).toBe(false);
                    transcribeCalls.push(`${packId}:${language ?? 'none'}`);
                    expect(normalization).toEqual<DaemonVoiceInferenceNormalizationDecision>({
                        inputTransport: 'upload_transfer',
                        strategy: 'daemon_decode',
                        systemFfmpegAllowed: false,
                    });
                    const bytes = await readFile(filePath);
                    return {
                        text: `decoded:${bytes.toString('base64')}`,
                        language,
                    };
                },
            }),
        });

        await expect(worker.installModel({ packId: ttsPackId })).resolves.toMatchObject({
            packId: ttsPackId,
            installState: 'installed',
        });
        await expect(worker.installModel({ packId: sttPackId })).resolves.toMatchObject({
            packId: sttPackId,
            installState: 'installed',
        });

        const synthesized = await worker.synthesizeTts({
            requestId: 'tts-1',
            text: 'Hello daemon',
            packId: ttsPackId,
            voiceId: 'af_bella',
            speed: 1,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        await expect(readFile(synthesized.filePath)).resolves.toEqual(Buffer.from('tts-audio'));

        const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
        const { tempDir } = resolveVoiceInferencePaths();
        const uploadedFilePath = join(tempDir, 'upload.wav');
        const uploadedFile = createMonoPcm16WavBuffer();
        await writeFile(uploadedFilePath, uploadedFile);
        const transcription = await worker.transcribeAudio({
            requestId: 'stt-1',
            uploadId: 'upload-1',
            filePath: uploadedFilePath,
            inputMimeType: 'audio/wav',
            packId: sttPackId,
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        });

        await expect(worker.getStatus()).resolves.toMatchObject({
            serviceState: 'ready',
            models: [
                expect.objectContaining({ packId: ttsPackId, installState: 'installed' }),
                expect.objectContaining({ packId: sttPackId, installState: 'installed' }),
            ],
        });
        expect(warmCalls).toEqual([ttsPackId, sttPackId]);
        expect(synthCalls).toEqual([`${ttsPackId}:Hello daemon:af_bella:1`]);
        expect(transcribeCalls).toEqual([`${sttPackId}:en`]);
        expect(transcription).toEqual({
            requestId: 'stt-1',
            text: `decoded:${uploadedFile.toString('base64')}`,
            language: 'en',
            modelPackId: sttPackId,
        });
        await expect(access(uploadedFilePath)).rejects.toThrow();

        await worker.removeModel(ttsPackId);
        await worker.removeModel(sttPackId);
        await worker.stop();
    });

  it('propagates TTS cancellation to the runtime boundary', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        let runtimeSynthesisStartedResolve: (() => void) | null = null;
        const runtimeSynthesisStarted = new Promise<void>((resolve) => {
            runtimeSynthesisStartedResolve = resolve;
        });
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: ({ signal }) => {
                    runtimeSynthesisStartedResolve?.();
                    return new Promise<Readonly<{
                        bytes: Uint8Array;
                        output: { codec: 'wav'; mimeType: 'audio/wav' };
                        name?: string | null;
                    }>>((_, reject) => {
                        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                    });
                },
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });
        const pendingSynthesis = worker.synthesizeTts({
            requestId: 'tts-cancel',
            text: 'cancel me',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });

        await runtimeSynthesisStarted;
        await worker.cancelTts('tts-cancel');

        await expect(pendingSynthesis).rejects.toMatchObject({
            code: 'cancelled',
        });
        await worker.stop();
    });

    it('remembers a TTS cancellation that arrives before request registration', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const homeDir = await createHomeDir();
        await serveSinglePack({ packId, kind: 'tts_sherpa', model: 'kokoro', modelBytes: Buffer.from('tts-model') });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const synthCalls: string[] = [];
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async ({ requestId }) => {
                    synthCalls.push(requestId);
                    return {
                        bytes: Buffer.from('tts-audio'),
                        output: { codec: 'wav', mimeType: 'audio/wav' },
                        name: 'daemon-tts.wav',
                    };
                },
                transcribeAudio: async () => ({ text: 'unused', language: null }),
            }),
        });

        await worker.installModel({ packId });
        await worker.cancelTts('tts-pre-cancelled');

        await expect(worker.synthesizeTts({
            requestId: 'tts-pre-cancelled',
            text: 'cancelled before registration',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        })).rejects.toMatchObject({ code: 'cancelled' });
        expect(synthCalls).toEqual([]);
        await worker.stop();
    });

    it('rejects a queued TTS request promptly when it is cancelled before reaching the runtime', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const homeDir = await createHomeDir();
        await serveSinglePack({ packId, kind: 'tts_sherpa', model: 'kokoro', modelBytes: Buffer.from('tts-model') });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        let releaseFirst!: () => void;
        const firstGate = new Promise<Readonly<{
            bytes: Uint8Array;
            output: DaemonVoiceInferenceAudioOutput;
            name?: string | null;
        }>>((resolve) => {
            releaseFirst = () => resolve({
                bytes: Buffer.from('first-audio'),
                output: { codec: 'wav', mimeType: 'audio/wav' },
                name: 'first.wav',
            });
        });
        let firstStarted!: () => void;
        const firstStartedPromise = new Promise<void>((resolve) => {
            firstStarted = resolve;
        });
        const synthCalls: string[] = [];

        const worker = await startVoiceInferenceWorker({
            perModelConcurrency: 1,
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async ({ requestId }) => {
                    synthCalls.push(requestId);
                    if (requestId === 'tts-first') {
                        firstStarted();
                        return await firstGate;
                    }
                    return {
                        bytes: Buffer.from('unexpected-second-audio'),
                        output: { codec: 'wav', mimeType: 'audio/wav' },
                        name: 'second.wav',
                    };
                },
                transcribeAudio: async () => ({ text: 'unused', language: null }),
            }),
        });

        await worker.installModel({ packId });
        const first = worker.synthesizeTts({
            requestId: 'tts-first',
            text: 'first',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        await firstStartedPromise;

        const second = worker.synthesizeTts({
            requestId: 'tts-queued',
            text: 'queued',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        }).catch((error) => error);

        await new Promise((resolve) => setTimeout(resolve, 10));
        await worker.cancelTts('tts-queued');

        const queuedResult = await Promise.race([
            second,
            new Promise((resolve) => setTimeout(() => resolve('still-pending'), 25)),
        ]);

        releaseFirst();
        await expect(first).resolves.toMatchObject({ requestId: 'tts-first' });
        await expect(second).resolves.toMatchObject({ code: 'cancelled' });
        expect(queuedResult).toMatchObject({ code: 'cancelled' });
        expect(synthCalls).toEqual(['tts-first']);
        await worker.stop();
    });

    it('surfaces unavailable runtime status and runtime_unavailable errors without crashing the worker', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => null,
        });

        await worker.installModel({ packId });

        await expect(worker.getStatus()).resolves.toMatchObject({
            serviceState: 'unavailable',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
            models: [
                expect.objectContaining({
                    packId,
                    installState: 'installed',
                }),
            ],
        });

        await expect(worker.synthesizeTts({
            requestId: 'tts-unavailable',
            text: 'hello daemon',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        })).rejects.toMatchObject({
            code: 'runtime_unavailable',
        });

        await expect(worker.getStatus()).resolves.toMatchObject({
            serviceState: 'unavailable',
        });

        await worker.stop();
    });

    it('maps raw runtime loader failures to runtime_unavailable and keeps the worker unavailable', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => {
                throw new Error('missing native runtime payload');
            },
        });

        await worker.installModel({ packId });

        await expect(worker.synthesizeTts({
            requestId: 'tts-unavailable-throw',
            text: 'hello daemon',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        })).rejects.toMatchObject({
            code: 'runtime_unavailable',
        });

        await expect(worker.getStatus()).resolves.toMatchObject({
            serviceState: 'unavailable',
        });

        await worker.stop();
    });

    it('evicts warm models after the configured idle residency window and warms them again on the next request', async () => {
        vi.useFakeTimers();
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const warmCalls: string[] = [];
        const releaseCalls: string[] = [];
        const worker = await startVoiceInferenceWorker({
            residencyMs: 1_000,
            runtimeLoader: async () => ({
                warmModel: async ({ packId: nextPackId }) => {
                    warmCalls.push(nextPackId);
                },
                releaseModel: async ({ packId: nextPackId }) => {
                    releaseCalls.push(nextPackId);
                },
                synthesizeTts: async () => ({
                    bytes: Buffer.from('tts-audio'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: 'daemon-tts.wav',
                }),
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });
        await worker.synthesizeTts({
            requestId: 'tts-first',
            text: 'hello',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        expect(warmCalls).toEqual([packId]);

        await vi.advanceTimersByTimeAsync(1_100);
        expect(releaseCalls).toEqual([packId]);

        await worker.synthesizeTts({
            requestId: 'tts-second',
            text: 'hello again',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });

        expect(warmCalls).toEqual([packId, packId]);
        await worker.stop();
        vi.useRealTimers();
    });

    it('primes the loaded engine once on warm so the first utterance avoids cold-start latency', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const homeDir = await createHomeDir();
        await serveSinglePack({ packId, kind: 'tts_sherpa', model: 'kokoro', modelBytes: Buffer.from('tts-model') });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const primeCalls: string[] = [];
        const orderedCalls: string[] = [];
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async ({ packId: nextPackId }) => {
                    orderedCalls.push(`warm:${nextPackId}`);
                },
                primeModel: async ({ packId: nextPackId }) => {
                    primeCalls.push(nextPackId);
                    orderedCalls.push(`prime:${nextPackId}`);
                },
                synthesizeTts: async () => {
                    orderedCalls.push('synth');
                    return {
                        bytes: Buffer.from('tts-audio'),
                        output: { codec: 'wav', mimeType: 'audio/wav' },
                        name: 'daemon-tts.wav',
                    };
                },
                transcribeAudio: async () => ({ text: 'unused', language: null }),
            }),
        });

        await worker.installModel({ packId });
        // Explicit warm primes the model before any utterance.
        await worker.warmModelPack(packId);
        expect(primeCalls).toEqual([packId]);

        await worker.synthesizeTts({
            requestId: 'tts-1',
            text: 'hello',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });

        // Priming happens once (warm is singleflighted) and strictly before the first synth.
        expect(primeCalls).toEqual([packId]);
        expect(orderedCalls).toEqual([`warm:${packId}`, `prime:${packId}`, 'synth']);
        await worker.stop();
    });

    it('keeps the model ready when priming fails so a best-effort prime never blocks readiness', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const homeDir = await createHomeDir();
        await serveSinglePack({ packId, kind: 'tts_sherpa', model: 'kokoro', modelBytes: Buffer.from('tts-model') });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                primeModel: async () => {
                    throw new Error('prime_boom');
                },
                synthesizeTts: async () => ({
                    bytes: Buffer.from('tts-audio'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: 'daemon-tts.wav',
                }),
                transcribeAudio: async () => ({ text: 'unused', language: null }),
            }),
        });

        await worker.installModel({ packId });
        // A priming failure must not surface as a warm/synthesize failure.
        await expect(worker.synthesizeTts({
            requestId: 'tts-1',
            text: 'hello',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        })).resolves.toMatchObject({ requestId: 'tts-1' });

        const status = await worker.getStatus();
        expect(status.models[0]).toMatchObject({ packId, runtimeState: 'ready' });
        await worker.stop();
    });

    it('exposes a daemon readiness snapshot with per-model runtimeState and resident memory', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model-bytes');
        const homeDir = await createHomeDir();
        await serveSinglePack({ packId, kind: 'tts_sherpa', model: 'kokoro', modelBytes });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async () => ({
                    bytes: Buffer.from('tts-audio'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: 'daemon-tts.wav',
                }),
                transcribeAudio: async () => ({ text: 'unused', language: null }),
            }),
        });

        await worker.installModel({ packId });

        // Installed but not yet loaded: cold, no resident memory reported.
        const coldStatus = await worker.getStatus();
        expect(coldStatus.models[0]).toMatchObject({ packId, runtimeState: 'cold' });
        expect('residentMemoryBytes' in coldStatus.models[0]!).toBe(false);

        await worker.warmModelPack(packId);

        const readyStatus = await worker.getStatus();
        expect(readyStatus.models[0]).toMatchObject({
            packId,
            runtimeState: 'ready',
            residentMemoryBytes: modelBytes.byteLength,
        });
        await worker.stop();
    });

    it('evicts the least-recently-used loaded model when the resident memory budget is exceeded', async () => {
        const ttsPackId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const sttPackId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
        const ttsModelBytes = Buffer.from('tts-model-payload');
        const sttModelBytes = Buffer.from('stt-model-payload');
        const homeDir = await createHomeDir();

        const server = createServer();
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                const port = (server.address() as AddressInfo).port;
                if (url === `/${ttsPackId}/manifest.json` || url === `/${sttPackId}/manifest.json`) {
                    const isTts = url.startsWith(`/${ttsPackId}`);
                    const bytes = isTts ? ttsModelBytes : sttModelBytes;
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId: isTts ? ttsPackId : sttPackId,
                        kind: isTts ? 'tts_sherpa' : 'stt_sherpa',
                        model: isTts ? 'kokoro' : 'sherpa',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${port}/${isTts ? ttsPackId : sttPackId}/model.onnx`,
                                sha256: sha256Hex(bytes),
                                sizeBytes: bytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === `/${ttsPackId}/model.onnx` || url === `/${sttPackId}/model.onnx`) {
                    const bytes = url.startsWith(`/${ttsPackId}`) ? ttsModelBytes : sttModelBytes;
                    response.statusCode = 200;
                    response.setHeader('content-length', String(bytes.byteLength));
                    response.end(bytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [ttsPackId]: `http://127.0.0.1:${address.port}/${ttsPackId}/manifest.json`,
            [sttPackId]: `http://127.0.0.1:${address.port}/${sttPackId}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const releaseCalls: string[] = [];
        // Budget only fits one model at a time, forcing LRU eviction of the first.
        const worker = await startVoiceInferenceWorker({
            maxResidentBytes: Math.max(ttsModelBytes.byteLength, sttModelBytes.byteLength) + 1,
            runtimeLoader: async () => ({
                warmModel: async () => {},
                releaseModel: async ({ packId }) => {
                    releaseCalls.push(packId);
                },
                synthesizeTts: async () => ({
                    bytes: Buffer.from('tts-audio'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: 'daemon-tts.wav',
                }),
                transcribeAudio: async () => ({ text: 'unused', language: null }),
            }),
        });

        await worker.installModel({ packId: ttsPackId });
        await worker.installModel({ packId: sttPackId });
        await worker.warmModelPack(ttsPackId);
        await worker.warmModelPack(sttPackId);

        // Loading the second model pushed the resident footprint over budget, evicting the first.
        expect(releaseCalls).toEqual([ttsPackId]);
        const status = await worker.getStatus();
        const ttsStatus = status.models.find((entry) => entry.packId === ttsPackId);
        const sttStatus = status.models.find((entry) => entry.packId === sttPackId);
        expect(ttsStatus).toMatchObject({ runtimeState: 'evicted' });
        expect(sttStatus).toMatchObject({ runtimeState: 'ready' });
        await worker.stop();
    });

    it('waits for in-flight synthesis before timed idle eviction releases the warm runtime', async () => {
        vi.useFakeTimers();
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        let releaseSecondSynthesis!: () => void;
        const secondSynthesisGate = new Promise<void>((resolve) => {
            releaseSecondSynthesis = resolve;
        });
        let secondSynthesisStartedResolve: (() => void) | null = null;
        const secondSynthesisStarted = new Promise<void>((resolve) => {
            secondSynthesisStartedResolve = resolve;
        });
        const releaseCalls: string[] = [];

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            residencyMs: 1_000,
            runtimeLoader: async () => ({
                warmModel: async () => {},
                releaseModel: async ({ packId: nextPackId }) => {
                    releaseCalls.push(nextPackId);
                },
                synthesizeTts: async ({ requestId }) => {
                    if (requestId === 'tts-second') {
                        secondSynthesisStartedResolve?.();
                        await secondSynthesisGate;
                    }
                    return {
                        bytes: Buffer.from('tts-audio'),
                        output: { codec: 'wav', mimeType: 'audio/wav' },
                        name: `${requestId}.wav`,
                    };
                },
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });
        await worker.synthesizeTts({
            requestId: 'tts-first',
            text: 'hello',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });

        await vi.advanceTimersByTimeAsync(900);
        const secondSynthesis = worker.synthesizeTts({
            requestId: 'tts-second',
            text: 'hello again',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        await secondSynthesisStarted;

        // The idle timer fires mid-synthesis but the active lease re-arms it for another
        // residency window instead of evicting the in-use runtime.
        await vi.advanceTimersByTimeAsync(1_100);
        expect(releaseCalls).toEqual([]);

        // Draining the lease must not release the runtime synchronously: the model only
        // leaves residency once it has been genuinely idle for a full residency window.
        releaseSecondSynthesis();
        await secondSynthesis;
        await Promise.resolve();
        expect(releaseCalls).toEqual([]);

        // Once idle, the re-armed window elapses and the warm runtime is finally released.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(releaseCalls).toEqual([packId]);
        await worker.stop();
        vi.useRealTimers();
    });

    it('releases an already-warm runtime after reinstall so the next request reloads the updated pack state', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        let modelBytes = Buffer.from('tts-model-v1');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        let warmedPackState = 'unset';
        const warmStates: string[] = [];
        const releaseCalls: string[] = [];
        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async ({ packDir }) => {
                    warmedPackState = await readFile(join(packDir, 'model.onnx'), 'utf8');
                    warmStates.push(warmedPackState);
                },
                releaseModel: async ({ packId: nextPackId }) => {
                    releaseCalls.push(nextPackId);
                },
                synthesizeTts: async () => ({
                    bytes: Buffer.from(warmedPackState, 'utf8'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: 'daemon-tts.wav',
                }),
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });
        const firstSynthesis = await worker.synthesizeTts({
            requestId: 'tts-v1',
            text: 'hello',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        await expect(readFile(firstSynthesis.filePath, 'utf8')).resolves.toBe('tts-model-v1');

        modelBytes = Buffer.from('tts-model-v2');
        await worker.installModel({ packId });

        const secondSynthesis = await worker.synthesizeTts({
            requestId: 'tts-v2',
            text: 'hello again',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        await expect(readFile(secondSynthesis.filePath, 'utf8')).resolves.toBe('tts-model-v2');

        expect(warmStates).toEqual(['tts-model-v1', 'tts-model-v2']);
        expect(releaseCalls).toEqual([packId]);
        await worker.stop();
    });

    it('uses stored manifest metadata for model status when a manifest can no longer be resolved', async () => {
        const homeDir = await createHomeDir();
        process.env.HAPPIER_HOME_DIR = homeDir;
        vi.resetModules();
        const configurationModule = await import('@/configuration');
        configurationModule.reloadConfiguration();
        const pathsModule = await import('./voiceInferencePaths');
        const paths = pathsModule.resolveVoiceInferencePaths();
        await writeFile(
            paths.installsStateFilePath,
            JSON.stringify({
                modelsById: {
                    'custom-pack-v1': {
                        modelId: 'custom-pack-v1',
                        state: 'error',
                        version: '2026-04-17',
                        manifestHash: 'manifest-hash',
                        updatedAtMs: 1,
                        progress: {
                            phase: 'error',
                            progress: 1,
                            message: 'install failed',
                        },
                        lastError: 'install failed',
                        kind: 'stt_sherpa',
                        model: 'sherpa',
                    },
                },
            }, null, 2),
            'utf8',
        );

        const { startVoiceInferenceWorker } = await import('./voiceInferenceWorker');
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => null,
        });

        await expect(worker.getStatus()).resolves.toMatchObject({
            serviceState: 'unavailable',
            models: [
                expect.objectContaining({
                    packId: 'custom-pack-v1',
                    installState: 'error',
                    kind: 'stt_sherpa',
                    model: 'sherpa',
                }),
            ],
        });

        await worker.stop();
    });

    it('allows parallel same-pack synthesis when per-model concurrency is explicitly raised', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });
        process.env.HAPPIER_VOICE_INFERENCE_PER_MODEL_CONCURRENCY = '2';

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        let activeCount = 0;
        let maxActiveCount = 0;
        let resolveRelease!: () => void;
        const releaseGate = new Promise<void>((resolve) => {
            resolveRelease = resolve;
        });
        const startedRequestIds = new Set<string>();

        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async ({ requestId }) => {
                    startedRequestIds.add(requestId);
                    activeCount += 1;
                    maxActiveCount = Math.max(maxActiveCount, activeCount);
                    await releaseGate;
                    activeCount -= 1;
                    return {
                        bytes: Buffer.from(`tts-audio:${requestId}`),
                        output: { codec: 'wav', mimeType: 'audio/wav' },
                        name: `${requestId}.wav`,
                    };
                },
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });

        const firstSynthesis = worker.synthesizeTts({
            requestId: 'tts-first',
            text: 'hello',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        const secondSynthesis = worker.synthesizeTts({
            requestId: 'tts-second',
            text: 'hello again',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });

        const startedBothRequests = await Promise.race([
            (async () => {
                while (startedRequestIds.size < 2) {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                }
                return true;
            })(),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 75)),
        ]);

        resolveRelease();
        await Promise.all([firstSynthesis, secondSynthesis]);

        expect(startedBothRequests).toBe(true);
        expect(maxActiveCount).toBe(2);
        await worker.stop();
    });

    it('waits for in-flight synthesis before removing the same model pack', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        let releaseSynthesis!: () => void;
        const synthesisGate = new Promise<void>((resolve) => {
            releaseSynthesis = resolve;
        });
        let synthesisStartedResolve: (() => void) | null = null;
        const synthesisStarted = new Promise<void>((resolve) => {
            synthesisStartedResolve = resolve;
        });
        const releaseCalls: string[] = [];

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                releaseModel: async ({ packId: nextPackId }) => {
                    releaseCalls.push(nextPackId);
                },
                synthesizeTts: async () => {
                    synthesisStartedResolve?.();
                    await synthesisGate;
                    return {
                        bytes: Buffer.from('tts-audio'),
                        output: { codec: 'wav', mimeType: 'audio/wav' },
                        name: 'daemon-tts.wav',
                    };
                },
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });

        const synthesis = worker.synthesizeTts({
            requestId: 'tts-remove-race',
            text: 'hello daemon',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        await synthesisStarted;

        const removeModel = worker.removeModel(packId);
        const removeState = await Promise.race([
            removeModel.then(() => 'removed' as const),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 25)),
        ]);

        expect(removeState).toBe('pending');
        expect(releaseCalls).toEqual([]);

        releaseSynthesis();
        await synthesis;
        await removeModel;

        expect(releaseCalls).toEqual([packId]);
        await worker.stop();
    });

    it('keeps daemon health ready after request-level invalid audio input errors', async () => {
        const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
        const sttModelBytes = Buffer.from('stt-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'stt_sherpa',
                        model: 'sherpa',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(sttModelBytes),
                                sizeBytes: sttModelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(sttModelBytes.byteLength));
                    response.end(sttModelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async () => ({
                    bytes: Buffer.from('unused'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: 'unused.wav',
                }),
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: 'en',
                }),
            }),
        });

        await worker.installModel({ packId });

        const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
        const { tempDir } = resolveVoiceInferencePaths();
        const unsupportedInputPath = join(tempDir, 'input.flac');
        await writeFile(unsupportedInputPath, 'flac-bytes', 'utf8');
        await expect(worker.transcribeAudio({
            requestId: 'stt-invalid-audio',
            uploadId: 'upload-invalid-audio',
            filePath: unsupportedInputPath,
            inputMimeType: 'audio/flac',
            packId,
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        })).rejects.toMatchObject({
            code: 'invalid_audio_input',
        });

        await expect(worker.getStatus()).resolves.toMatchObject({
            serviceState: 'ready',
        });

        await worker.stop();
    });

    it('rejects STT file paths outside the voice inference temp directory', async () => {
        const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
        const sttModelBytes = Buffer.from('stt-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'stt_sherpa',
                        model: 'sherpa',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(sttModelBytes),
                                sizeBytes: sttModelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(sttModelBytes.byteLength));
                    response.end(sttModelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async () => ({
                    bytes: Buffer.from('unused'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: 'unused.wav',
                }),
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: 'en',
                }),
            }),
        });

        await worker.installModel({ packId });

        const outsideTempPath = join(homeDir, 'outside.wav');
        await writeFile(outsideTempPath, createMonoPcm16WavBuffer());

        await expect(worker.transcribeAudio({
            requestId: 'stt-outside-temp',
            uploadId: 'upload-outside-temp',
            filePath: outsideTempPath,
            inputMimeType: 'audio/wav',
            packId,
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        })).rejects.toMatchObject({
            code: 'invalid_audio_input',
        });

        await expect(access(outsideTempPath)).resolves.toBeUndefined();
        const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
        const { tempDir } = resolveVoiceInferencePaths();
        const symlinkPath = join(tempDir, 'outside-symlink.wav');
        await symlink(outsideTempPath, symlinkPath);

        await expect(worker.transcribeAudio({
            requestId: 'stt-symlink-escape',
            uploadId: 'upload-symlink-escape',
            filePath: symlinkPath,
            inputMimeType: 'audio/wav',
            packId,
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        })).rejects.toMatchObject({
            code: 'invalid_audio_input',
        });

        await expect(access(outsideTempPath)).resolves.toBeUndefined();
        await worker.stop();
    });

    it('rejects STT uploads that exceed the configured max upload bytes', async () => {
        const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
        const sttModelBytes = Buffer.from('stt-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'stt_sherpa',
                        model: 'sherpa',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(sttModelBytes),
                                sizeBytes: sttModelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(sttModelBytes.byteLength));
                    response.end(sttModelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });
        process.env.HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES = '16';

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async () => ({
                    bytes: Buffer.from('unused'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: 'unused.wav',
                }),
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: 'en',
                }),
            }),
        });

        await worker.installModel({ packId });

        const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
        const { tempDir } = resolveVoiceInferencePaths();
        const oversizedWavPath = join(tempDir, 'oversized.wav');
        await writeFile(oversizedWavPath, createMonoPcm16WavBuffer());
        await expect(worker.transcribeAudio({
            requestId: 'stt-too-large',
            uploadId: 'upload-too-large',
            filePath: oversizedWavPath,
            inputMimeType: 'audio/wav',
            packId,
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        })).rejects.toMatchObject({
            code: 'invalid_audio_input',
        });

        await worker.stop();
    });

    it('rejects duplicate in-flight TTS request ids so cancellation and cleanup remain request-scoped', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        let releaseFirstRequest!: () => void;
        const firstRequestFinished = new Promise<void>((resolve) => {
            releaseFirstRequest = resolve;
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async () => {
                    await firstRequestFinished;
                    return {
                        bytes: Buffer.from('tts-audio'),
                        output: { codec: 'wav', mimeType: 'audio/wav' },
                        name: 'daemon-tts.wav',
                    };
                },
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });

        const firstRequestPromise = worker.synthesizeTts({
            requestId: 'tts-duplicate',
            text: 'first request',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });
        await Promise.resolve();

        await expect(worker.synthesizeTts({
            requestId: 'tts-duplicate',
            text: 'second request',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        })).rejects.toMatchObject({
            code: 'internal_error',
        });

        releaseFirstRequest();
        await expect(firstRequestPromise).resolves.toMatchObject({
            requestId: 'tts-duplicate',
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });

        await worker.stop();
    });

    it('uses the canonical WAV extension when synthesized output omits a name', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async () => ({
                    bytes: Buffer.from('wav-audio'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: null,
                }),
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });

        const synthesized = await worker.synthesizeTts({
            requestId: 'tts-wav',
            text: 'hello daemon',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });

        expect(synthesized.name).toBe('voice-inference-tts-wav.wav');
        expect(synthesized.filePath).toContain('.wav');
        await worker.stop();
    });

    it('rejects TTS requests when the runtime returns a different output codec than requested', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async () => ({
                    bytes: Buffer.from('mp3-audio'),
                    output: ({ codec: 'mp3', mimeType: 'audio/mpeg' } as unknown) as DaemonVoiceInferenceAudioOutput,
                    name: 'daemon-tts.mp3',
                }),
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });

        await expect(worker.synthesizeTts({
            requestId: 'tts-mismatch',
            text: 'hello daemon',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        })).rejects.toMatchObject({
            code: 'unsupported_codec',
        });

        await worker.stop();
    });

    it('rejects TTS requests when the runtime returns a mismatched output MIME type', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async () => ({
                    bytes: Buffer.from('invalid-audio'),
                    // Intentionally violate the codec<->mime contract to prove the worker fails closed.
                    output: ({ codec: 'wav', mimeType: 'audio/mpeg' } as unknown) as DaemonVoiceInferenceAudioOutput,
                    name: 'daemon-tts.wav',
                }),
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });

        await expect(worker.synthesizeTts({
            requestId: 'tts-mismatch-mime',
            text: 'hello daemon',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        })).rejects.toMatchObject({
            code: 'unsupported_codec',
        });

        await worker.stop();
    });

    it('sanitizes synthesized output names to avoid path traversal', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async () => ({
                    bytes: Buffer.from('wav-audio'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: '../../evil.wav',
                }),
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });

        const synthesized = await worker.synthesizeTts({
            requestId: 'tts-traversal',
            text: 'hello daemon',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });

        expect(synthesized.name).toBe('evil.wav');
        expect(synthesized.filePath).not.toContain('..');
        expect(synthesized.filePath).toContain('evil.wav');
        await worker.stop();
    });

    it('sanitizes requestId when staging synthesized temp files so traversal cannot escape the temp directory', async () => {
        const packId = 'kokoro-82m-v1.0-onnx-q8-wasm';
        const modelBytes = Buffer.from('tts-model');
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolveServer, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: 'tts_sherpa',
                        model: 'kokoro',
                        version: '2026-04-17',
                        files: [
                            {
                                path: 'model.onnx',
                                url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/model.onnx`,
                                sha256: sha256Hex(modelBytes),
                                sizeBytes: modelBytes.byteLength,
                            },
                        ],
                    }));
                    return;
                }
                if (url === '/model.onnx') {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(modelBytes.byteLength));
                    response.end(modelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolveServer());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker({
            runtimeLoader: async () => ({
                warmModel: async () => {},
                synthesizeTts: async () => ({
                    bytes: Buffer.from('wav-audio'),
                    output: { codec: 'wav', mimeType: 'audio/wav' },
                    name: 'daemon-tts.wav',
                }),
                transcribeAudio: async () => ({
                    text: 'unused',
                    language: null,
                }),
            }),
        });

        await worker.installModel({ packId });

        const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
        const { tempDir } = resolveVoiceInferencePaths();
        const resolvedTempDirPrefix = resolve(tempDir) + sep;

        const synthesized = await worker.synthesizeTts({
            requestId: '../../evil',
            text: 'hello daemon',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'wav', mimeType: 'audio/wav' },
        });

        expect(resolve(synthesized.filePath).startsWith(resolvedTempDirPrefix)).toBe(true);
        await worker.stop();
    });

    it('loads the first-party daemon runtime facade, accepts MIME codec parameters, decodes compressed inputs through the runtime seam, and still validates WAV fallback uploads', async () => {
        const packId = 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17';
        const catalogEntry = getModelPackCatalogEntry(packId);
        if (!catalogEntry) {
            throw new Error('voice_inference_test_catalog_entry_missing');
        }
        if (catalogEntry.runtimeFamily !== 'sherpa_zipformer_streaming') {
            throw new Error('voice_inference_test_catalog_family_mismatch');
        }
        const sttModelBytes = Buffer.from('stt-model');
        const requiredFilePaths = [
            ...Object.values(catalogEntry.runtimeArtifacts).map((artifact) => artifact.path),
            ...(catalogEntry.supportArtifacts ?? []).map((artifact) => artifact.path),
        ];
        const requiredFiles = new Set(requiredFilePaths);
        const server = createServer();
        servers.push(server);
        const homeDir = await createHomeDir();

        await new Promise<void>((resolve, reject) => {
            server.on('request', (request, response) => {
                const url = request.url ?? '/';
                if (url === '/manifest.json') {
                    response.statusCode = 200;
                    response.setHeader('content-type', 'application/json');
                    response.end(JSON.stringify({
                        packId,
                        kind: catalogEntry.kind,
                        model: catalogEntry.model,
                        version: '2026-04-17',
                        files: requiredFilePaths.map((path) => ({
                            path,
                            url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${path}`,
                            sha256: sha256Hex(sttModelBytes),
                            sizeBytes: sttModelBytes.byteLength,
                        })),
                    }));
                    return;
                }
                if (requiredFiles.has(url.slice(1))) {
                    response.statusCode = 200;
                    response.setHeader('content-length', String(sttModelBytes.byteLength));
                    response.end(sttModelBytes);
                    return;
                }
                response.statusCode = 404;
                response.end('not found');
            });
            server.listen(0, '127.0.0.1', () => resolve());
            server.once('error', reject);
        });

        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('voice_inference_test_server_address_missing');
        }
        process.env.HAPPIER_MODEL_PACK_MANIFESTS = JSON.stringify({
            [packId]: `http://127.0.0.1:${address.port}/manifest.json`,
        });

        const runtimeRoot = join(homeDir, 'runtime-root');
        const runtimeModulePath = join(runtimeRoot, 'scripts', 'runtime', 'loadVoiceInferenceRuntime.mjs');
        const decodedCompressedBytes = createMonoPcm16WavBuffer(8, 16_000);
        await mkdir(join(runtimeRoot, 'scripts', 'runtime'), { recursive: true });
        await writeFile(
            runtimeModulePath,
            [
                "import { readFile, writeFile } from 'node:fs/promises';",
                `const decodedCompressedBase64 = '${decodedCompressedBytes.toString('base64')}';`,
                'export const voiceInferenceRuntimeEngine = {',
                '    warmModel: async () => {},',
                "    synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'wav', mimeType: 'audio/wav' }, name: 'unused.wav' }),",
                '    decodeAudioInput: async ({ filePath, inputMimeType }) => {',
                "        if (inputMimeType !== 'audio/wav') {",
                "            const decodedFilePath = `${filePath}.decoded.wav`;",
                "            await writeFile(decodedFilePath, Buffer.from(decodedCompressedBase64, 'base64'));",
                "            return { filePath: decodedFilePath, inputMimeType: 'audio/wav' };",
                '        }',
                '        return { filePath, inputMimeType };',
                '    },',
                "    transcribeAudio: async ({ filePath, inputMimeType }) => ({ text: `decoded:${inputMimeType}:${await readFile(filePath, 'base64')}`, language: 'en' }),",
                '};',
                '',
            ].join('\n'),
            'utf8',
        );
        vi.doMock('@/packagedRuntime/assets/resolveCliRuntimeAssetPath', () => ({
            resolveCliRuntimeAssetPath: (...segments: string[]) => join(runtimeRoot, ...segments),
        }));

        const { startVoiceInferenceWorker } = await importWorkerModuleForHome(homeDir);
        const worker = await startVoiceInferenceWorker();

        await worker.installModel({ packId });

        const { resolveVoiceInferencePaths } = await import('./voiceInferencePaths');
        const { tempDir } = resolveVoiceInferencePaths();
        const compressedInputPath = join(tempDir, 'input.m4a');
        await writeFile(compressedInputPath, 'm4a-bytes', 'utf8');
        await expect(worker.transcribeAudio({
            requestId: 'stt-compressed',
            uploadId: 'upload-compressed',
            filePath: compressedInputPath,
            inputMimeType: 'audio/webm;codecs=opus',
            packId,
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        })).resolves.toMatchObject({
            requestId: 'stt-compressed',
            language: 'en',
            modelPackId: packId,
            text: `decoded:audio/wav:${decodedCompressedBytes.toString('base64')}`,
        });

        const wavInputPath = join(tempDir, 'input.wav');
        const wavInputBytes = createMonoPcm16WavBuffer();
        await writeFile(wavInputPath, wavInputBytes);
        await expect(worker.transcribeAudio({
            requestId: 'stt-wav',
            uploadId: 'upload-wav',
            filePath: wavInputPath,
            inputMimeType: 'audio/wav',
            packId,
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'ui_pretranscoded_pcm16_fallback',
                systemFfmpegAllowed: false,
            },
        })).resolves.toMatchObject({
            requestId: 'stt-wav',
            language: 'en',
            modelPackId: packId,
            text: `decoded:audio/wav:${wavInputBytes.toString('base64')}`,
        });

        const unsupportedInputPath = join(tempDir, 'input.flac');
        await writeFile(unsupportedInputPath, 'flac-bytes', 'utf8');
        await expect(worker.transcribeAudio({
            requestId: 'stt-unsupported',
            uploadId: 'upload-unsupported',
            filePath: unsupportedInputPath,
            inputMimeType: 'audio/flac',
            packId,
            language: 'en',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        })).rejects.toMatchObject({
            code: 'invalid_audio_input',
        });

        await worker.stop();
    });
});
