import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import type { DaemonVoiceInferenceAudioOutput, DaemonVoiceInferenceNormalizationDecision } from '@happier-dev/protocol';
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

    afterEach(async () => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        vi.resetModules();
        vi.doUnmock('@/runtime/assets/resolveCliRuntimeAssetPath');
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
        const ttsPackId = 'kokoro-tts-en-v1';
        const sttPackId = 'sherpa-stt-en-v1';
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
        const packId = 'kokoro-tts-en-v1';
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
                        output:
                            | { codec: 'wav'; mimeType: 'audio/wav' }
                            | { codec: 'mp3'; mimeType: 'audio/mpeg' }
                            | { codec: 'opus'; mimeType: 'audio/opus' };
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
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
        });

        await runtimeSynthesisStarted;
        await worker.cancelTts('tts-cancel');

        await expect(pendingSynthesis).rejects.toMatchObject({
            code: 'cancelled',
        });
        await worker.stop();
    });

    it('surfaces unavailable runtime status and runtime_unavailable errors without crashing the worker', async () => {
        const packId = 'kokoro-tts-en-v1';
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
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
        })).rejects.toMatchObject({
            code: 'runtime_unavailable',
        });

        await expect(worker.getStatus()).resolves.toMatchObject({
            serviceState: 'unavailable',
        });

        await worker.stop();
    });

    it('maps raw runtime loader failures to runtime_unavailable and keeps the worker unavailable', async () => {
        const packId = 'kokoro-tts-en-v1';
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
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
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
        const packId = 'kokoro-tts-en-v1';
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

    it('waits for in-flight synthesis before timed idle eviction releases the warm runtime', async () => {
        vi.useFakeTimers();
        const packId = 'kokoro-tts-en-v1';
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

        await vi.advanceTimersByTimeAsync(1_100);
        expect(releaseCalls).toEqual([]);

        releaseSecondSynthesis();
        await secondSynthesis;
        await Promise.resolve();

        expect(releaseCalls).toEqual([packId]);
        await worker.stop();
        vi.useRealTimers();
    });

    it('releases an already-warm runtime after reinstall so the next request reloads the updated pack state', async () => {
        const packId = 'kokoro-tts-en-v1';
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
        const packId = 'kokoro-tts-en-v1';
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
                        output: { codec: 'mp3', mimeType: 'audio/mpeg' },
                        name: `${requestId}.mp3`,
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
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
        });
        const secondSynthesis = worker.synthesizeTts({
            requestId: 'tts-second',
            text: 'hello again',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
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
        const packId = 'kokoro-tts-en-v1';
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
        const packId = 'sherpa-stt-en-v1';
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
                    output: { codec: 'mp3', mimeType: 'audio/mpeg' },
                    name: 'unused.mp3',
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
        const packId = 'sherpa-stt-en-v1';
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
                    output: { codec: 'mp3', mimeType: 'audio/mpeg' },
                    name: 'unused.mp3',
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
        const packId = 'sherpa-stt-en-v1';
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
                    output: { codec: 'mp3', mimeType: 'audio/mpeg' },
                    name: 'unused.mp3',
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
        const packId = 'kokoro-tts-en-v1';
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

    it('derives the temp-file extension from the synthesized output codec', async () => {
        const packId = 'kokoro-tts-en-v1';
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
                    bytes: Buffer.from('opus-audio'),
                    output: { codec: 'opus', mimeType: 'audio/opus' },
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
            requestId: 'tts-opus',
            text: 'hello daemon',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'opus', mimeType: 'audio/opus' },
        });

        expect(synthesized.name).toBe('voice-inference-tts-opus.opus');
        expect(synthesized.filePath).toContain('.opus');
        await worker.stop();
    });

    it('rejects TTS requests when the runtime returns a different output codec than requested', async () => {
        const packId = 'kokoro-tts-en-v1';
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
            requestId: 'tts-mismatch',
            text: 'hello daemon',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
        })).rejects.toMatchObject({
            code: 'unsupported_codec',
        });

        await worker.stop();
    });

    it('rejects TTS requests when the runtime returns a mismatched output MIME type', async () => {
        const packId = 'kokoro-tts-en-v1';
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
                    // Intentionally violate the codec<->mime contract to prove the worker fails closed.
                    output: ({ codec: 'mp3', mimeType: 'audio/wav' } as unknown) as DaemonVoiceInferenceAudioOutput,
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
            requestId: 'tts-mismatch-mime',
            text: 'hello daemon',
            packId,
            voiceId: null,
            speed: null,
            output: { codec: 'mp3', mimeType: 'audio/mpeg' },
        })).rejects.toMatchObject({
            code: 'unsupported_codec',
        });

        await worker.stop();
    });

    it('sanitizes synthesized output names to avoid path traversal', async () => {
        const packId = 'kokoro-tts-en-v1';
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
        const packId = 'kokoro-tts-en-v1';
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
        const packId = 'sherpa-stt-en-v1';
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
                "    synthesizeTts: async () => ({ bytes: Buffer.from('unused'), output: { codec: 'mp3', mimeType: 'audio/mpeg' }, name: 'unused.mp3' }),",
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
        vi.doMock('@/runtime/assets/resolveCliRuntimeAssetPath', () => ({
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
