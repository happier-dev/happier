import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VoiceInferenceRuntimeTranscribeInput } from '../voiceInferenceRuntimeTypes';

const spawnMock = vi.hoisted(() => vi.fn());
const require = createRequire(import.meta.url);

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
            packId: 'sherpa-stt-en-v1',
            packDir: rootDir,
            manifest: {
                packId: 'sherpa-stt-en-v1',
                kind: 'stt_sherpa',
                model: 'sherpa',
                version: '2026-04-17',
                files: [],
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

    it('disposes warmed cached runtimes when releaseModel is invoked', async () => {
        const rootDir = await createTempDir();
        const ttsManifest = {
            packId: 'kokoro-tts-en-v1',
            kind: 'tts_sherpa' as const,
            model: 'kokoro',
            version: '2026-04-17',
            files: [],
        };
        const sttManifest = {
            packId: 'sherpa-stt-en-v1',
            kind: 'stt_sherpa' as const,
            model: 'sherpa',
            version: '2026-04-17',
            files: [],
        };
        await Promise.all([
            writeFile(join(rootDir, 'model.onnx'), 'tts-model', 'utf8'),
            writeFile(join(rootDir, 'voices.bin'), 'tts-voices', 'utf8'),
            writeFile(join(rootDir, 'tokens.txt'), 'shared-tokens', 'utf8'),
            writeFile(join(rootDir, 'encoder.onnx'), 'stt-encoder', 'utf8'),
            writeFile(join(rootDir, 'decoder.onnx'), 'stt-decoder', 'utf8'),
            writeFile(join(rootDir, 'joiner.onnx'), 'stt-joiner', 'utf8'),
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
});
