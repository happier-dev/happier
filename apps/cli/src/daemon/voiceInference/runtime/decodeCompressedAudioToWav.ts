import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join } from 'node:path';

import { createRuntimeUnavailableError, createVoiceInferenceError } from '../voiceInferenceWorker.shared';

const DEFAULT_STT_SAMPLE_RATE = 16_000;
const require = createRequire(import.meta.url);

let ffmpegStaticPathPromise: Promise<string | null> | null = null;

function throwIfAborted(signal?: AbortSignal | null): void {
    if (signal?.aborted) {
        throw createVoiceInferenceError('cancelled', 'voice_inference_cancelled');
    }
}

function isModuleResolutionFailure(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');
    return (
        message.includes('Cannot find module')
        || message.includes('Cannot find package')
        || message.includes('ERR_MODULE_NOT_FOUND')
    );
}

async function resolveFfmpegStaticBinaryPath(): Promise<string | null> {
    if (!ffmpegStaticPathPromise) {
        ffmpegStaticPathPromise = (async () => {
            let resolvedPath: unknown;
            try {
                resolvedPath = require('ffmpeg-static');
            } catch (error) {
                if (isModuleResolutionFailure(error)) {
                    return null;
                }
                throw error;
            }
            const candidate = typeof resolvedPath === 'string'
                ? resolvedPath
                : typeof (resolvedPath as { default?: unknown } | null)?.default === 'string'
                    ? (resolvedPath as { default: string }).default
                    : null;
            if (!candidate) {
                return null;
            }
            try {
                const candidateStat = await stat(candidate);
                return candidateStat.isFile() ? candidate : null;
            } catch {
                return null;
            }
        })();
    }
    return await ffmpegStaticPathPromise;
}

async function runFfmpegDecode(params: Readonly<{
    ffmpegBinaryPath: string;
    inputFilePath: string;
    outputFilePath: string;
    signal?: AbortSignal | null;
}>): Promise<void> {
    throwIfAborted(params.signal);

    await new Promise<void>((resolve, reject) => {
        const args = [
            '-nostdin',
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            params.inputFilePath,
            '-vn',
            '-ac',
            '1',
            '-ar',
            String(DEFAULT_STT_SAMPLE_RATE),
            '-c:a',
            'pcm_s16le',
            params.outputFilePath,
        ];
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
