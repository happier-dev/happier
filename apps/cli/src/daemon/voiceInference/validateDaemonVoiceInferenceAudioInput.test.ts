import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

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

describe('validateDaemonVoiceInferenceAudioInput', () => {
    const envKeys = ['HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES'] as const;
    let envScope = createEnvKeyScope(envKeys);
    const tempDirs: string[] = [];

    afterEach(async () => {
        envScope.restore();
        envScope = createEnvKeyScope(envKeys);
        await Promise.all(tempDirs.splice(0).map(async (dir) => await rm(dir, { recursive: true, force: true }).catch(() => undefined)));
    });

    it('rejects oversized pretranscoded wav uploads with the daemon upload limit', async () => {
        envScope.patch({
            HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES: '32',
        });

        const { validateDaemonVoiceInferenceAudioInput } = await import('./validateDaemonVoiceInferenceAudioInput');
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-voice-input-'));
        tempDirs.push(tempDir);
        const filePath = join(tempDir, 'input.wav');
        await writeFile(filePath, createMonoPcm16WavBuffer());

        await expect(
            validateDaemonVoiceInferenceAudioInput({
                filePath,
                inputMimeType: 'audio/wav',
                normalization: {
                    inputTransport: 'upload_transfer',
                    strategy: 'ui_pretranscoded_pcm16_fallback',
                    systemFfmpegAllowed: false,
                },
            }),
        ).rejects.toMatchObject({
            code: 'invalid_audio_input',
            message: 'voice_inference_audio_input_too_large',
        });
    });

    it('rejects unsupported daemon-decode mime types', async () => {
        envScope.patch({
            HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES: '1024',
        });

        const { validateDaemonVoiceInferenceAudioInput } = await import('./validateDaemonVoiceInferenceAudioInput');
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-voice-input-'));
        tempDirs.push(tempDir);
        const filePath = join(tempDir, 'input.bin');
        await writeFile(filePath, Buffer.from('not-audio'));

        await expect(
            validateDaemonVoiceInferenceAudioInput({
                filePath,
                inputMimeType: 'text/plain',
                normalization: {
                    inputTransport: 'upload_transfer',
                    strategy: 'daemon_decode',
                    systemFfmpegAllowed: false,
                },
            }),
        ).rejects.toMatchObject({
            code: 'invalid_audio_input',
            message: 'voice_inference_unsupported_daemon_audio_input',
        });
    });

    it('normalizes mime parameters (e.g. codecs) before validating daemon-decode inputs', async () => {
        envScope.patch({
            HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES: '1024',
        });

        const { validateDaemonVoiceInferenceAudioInput } = await import('./validateDaemonVoiceInferenceAudioInput');
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-voice-input-'));
        tempDirs.push(tempDir);
        const filePath = join(tempDir, 'input.webm');
        await writeFile(filePath, Buffer.from('not-really-webm'));

        await expect(
            validateDaemonVoiceInferenceAudioInput({
                filePath,
                inputMimeType: 'audio/webm;codecs=opus',
                normalization: {
                    inputTransport: 'upload_transfer',
                    strategy: 'daemon_decode',
                    systemFfmpegAllowed: false,
                },
            }),
        ).resolves.toEqual({
            filePath,
            inputMimeType: 'audio/webm',
            normalization: {
                inputTransport: 'upload_transfer',
                strategy: 'daemon_decode',
                systemFfmpegAllowed: false,
            },
        });
    });

    it('requires pretranscoded-fallback uploads to advertise a wav input mime type', async () => {
        envScope.patch({
            HAPPIER_VOICE_INFERENCE_STT_MAX_UPLOAD_BYTES: '1024',
        });

        const { validateDaemonVoiceInferenceAudioInput } = await import('./validateDaemonVoiceInferenceAudioInput');
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-voice-input-'));
        tempDirs.push(tempDir);
        const filePath = join(tempDir, 'input.webm');
        await writeFile(filePath, Buffer.from('not-audio'));

        await expect(
            validateDaemonVoiceInferenceAudioInput({
                filePath,
                inputMimeType: 'audio/webm',
                normalization: {
                    inputTransport: 'upload_transfer',
                    strategy: 'ui_pretranscoded_pcm16_fallback',
                    systemFfmpegAllowed: false,
                },
            }),
        ).rejects.toMatchObject({
            code: 'invalid_audio_input',
            message: 'voice_inference_expected_pretranscoded_wav_input',
        });
    });
});
