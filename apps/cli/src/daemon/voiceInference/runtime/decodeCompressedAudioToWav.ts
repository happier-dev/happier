import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import { VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT } from '@happier-dev/protocol';

import { resolveFfmpegStaticBinaryPath } from '@/daemon/runtime/ffmpegStatic';

import { createRuntimeUnavailableError, createVoiceInferenceError } from '../voiceInferenceWorker.shared';

/**
 * Build the ffmpeg args that resample/downmix arbitrary compressed audio into the
 * canonical daemon STT PCM format. The sample rate, channel count, and codec come
 * from the centralized protocol constant so this conversion chokepoint cannot drift
 * from what the sherpa runtime expects.
 */
export function buildDaemonSttDecodeFfmpegArgs(params: Readonly<{
    inputFilePath: string;
    outputFilePath: string;
}>): string[] {
    return [
        '-nostdin',
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        params.inputFilePath,
        '-vn',
        '-ac',
        String(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.channelCount),
        '-ar',
        String(VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.sampleRateHz),
        '-c:a',
        VOICE_RUNTIME_DAEMON_STT_PCM_FORMAT.ffmpegCodec,
        params.outputFilePath,
    ];
}

function throwIfAborted(signal?: AbortSignal | null): void {
    if (signal?.aborted) {
        throw createVoiceInferenceError('cancelled', 'voice_inference_cancelled');
    }
}

async function runFfmpegDecode(params: Readonly<{
    ffmpegBinaryPath: string;
    inputFilePath: string;
    outputFilePath: string;
    signal?: AbortSignal | null;
}>): Promise<void> {
    throwIfAborted(params.signal);

    await new Promise<void>((resolve, reject) => {
        const args = buildDaemonSttDecodeFfmpegArgs({
            inputFilePath: params.inputFilePath,
            outputFilePath: params.outputFilePath,
        });
        const child = spawn(params.ffmpegBinaryPath, args, {
            stdio: ['ignore', 'ignore', 'ignore'],
            windowsHide: true,
        });
        let settled = false;
        const finalizeReject = async (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            await rm(params.outputFilePath, { force: true }).catch(() => undefined);
            reject(error);
        };
        const finalizeResolve = () => {
            if (settled) {
                return;
            }
            settled = true;
            resolve();
        };
        const abortListener = () => {
            try {
                child.kill('SIGKILL');
            } catch {
                child.kill();
            }
            void finalizeReject(createVoiceInferenceError('cancelled', 'voice_inference_cancelled'));
        };

        params.signal?.addEventListener('abort', abortListener, { once: true });
        child.once('error', (error) => {
            params.signal?.removeEventListener('abort', abortListener);
            void finalizeReject(createRuntimeUnavailableError(error));
        });
        child.once('close', (code) => {
            params.signal?.removeEventListener('abort', abortListener);
            if (params.signal?.aborted) {
                void finalizeReject(createVoiceInferenceError('cancelled', 'voice_inference_cancelled'));
                return;
            }
            if (code === 0) {
                finalizeResolve();
                return;
            }
            // Avoid leaking stderr (which can include local file paths) into surfaced error messages.
            void finalizeReject(createVoiceInferenceError(
                'unsupported_codec',
                'voice_inference_daemon_decode_failed',
            ));
        });
    });

    throwIfAborted(params.signal);
}

export async function decodeCompressedAudioToWav(params: Readonly<{
    filePath: string;
    signal?: AbortSignal | null;
}>): Promise<Readonly<{ filePath: string; inputMimeType: 'audio/wav' }>> {
    const ffmpegBinaryPath = await resolveFfmpegStaticBinaryPath();
    if (!ffmpegBinaryPath) {
        throw createVoiceInferenceError('unsupported_codec', 'voice_inference_daemon_decoder_unavailable');
    }

    const fileBaseName = basename(params.filePath, extname(params.filePath));
    const outputFilePath = join(dirname(params.filePath), `${fileBaseName}.${randomUUID()}.decoded.wav`);
    await runFfmpegDecode({
        ffmpegBinaryPath,
        inputFilePath: params.filePath,
        outputFilePath,
        signal: params.signal,
    });

    return {
        filePath: outputFilePath,
        inputMimeType: 'audio/wav',
    };
}
