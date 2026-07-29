import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

import { resolveFfmpegStaticBinaryPath } from '@/daemon/runtime/ffmpegStatic';

import type {
  BrowserRecordingStreamFrameEncoder,
  BrowserRecordingStreamFrameEncoderFactory,
  BrowserRecordingStreamFrameEncoderOutput,
} from './stream';

export type BrowserRecordingFfmpegProcess = Readonly<{
  stdin: Writable;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}>;

export type BrowserRecordingFfmpegSpawn = (
  binaryPath: string,
  args: readonly string[],
  options: SpawnOptions,
) => BrowserRecordingFfmpegProcess;

export type FfmpegBrowserRecordingStreamFrameEncoderFactoryOptions = Readonly<{
  workingDirectory: string;
  outputDirectory?: string;
  resolveFfmpegBinaryPath?: () => Promise<string | null>;
  spawnFfmpeg?: BrowserRecordingFfmpegSpawn;
  randomId?: () => string;
}>;

const ENCODER_UNAVAILABLE_MESSAGE = 'Browser recording ffmpeg encoder is unavailable.';
const ENCODER_FAILED_MESSAGE = 'Browser recording ffmpeg encoder failed.';
const ENCODER_BACKPRESSURE_MESSAGE = 'Browser recording ffmpeg encoder backpressure exceeded.';

function defaultSpawnFfmpeg(
  binaryPath: string,
  args: readonly string[],
  options: SpawnOptions,
): BrowserRecordingFfmpegProcess {
  return spawnProcess(binaryPath, [...args], options) as BrowserRecordingFfmpegProcess;
}

function sanitizeRecordingIdSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized.length > 0 ? sanitized.slice(0, 72) : 'recording';
}

function buildOutputPath(input: Readonly<{
  outputDirectory: string;
  recordingId: string;
  randomId: string;
}>): string {
  return join(
    input.outputDirectory,
    `${sanitizeRecordingIdSegment(input.recordingId)}-${sanitizeRecordingIdSegment(input.randomId)}.webm`,
  );
}

function buildFfmpegArgs(input: Readonly<{
  fps: number;
  outputPath: string;
}>): readonly string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'mjpeg',
    '-r',
    String(Math.max(1, Math.floor(input.fps))),
    '-i',
    'pipe:0',
    '-an',
    '-c:v',
    'libvpx',
    '-pix_fmt',
    'yuv420p',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-f',
    'webm',
    input.outputPath,
  ];
}

function killFfmpeg(child: BrowserRecordingFfmpegProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    child.kill();
  }
}

function createGenericFailure(): Error {
  return new Error(ENCODER_FAILED_MESSAGE);
}

type FfmpegEncoderState = {
  failure: Error | null;
  finished: boolean;
  discarded: boolean;
};

class FfmpegBrowserRecordingStreamFrameEncoder implements BrowserRecordingStreamFrameEncoder {
  private readonly state: FfmpegEncoderState = {
    failure: null,
    finished: false,
    discarded: false,
  };
  private readonly closePromise: Promise<void>;

  constructor(
    private readonly child: BrowserRecordingFfmpegProcess,
    private readonly outputPath: string,
    private readonly fileNameHint: string,
  ) {
    this.closePromise = new Promise<void>((resolve, reject) => {
      child.once('error', () => {
        const failure = this.fail(createGenericFailure());
        reject(failure);
      });
      child.once('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        const failure = this.fail(createGenericFailure());
        reject(failure);
      });
    });
    void this.closePromise.catch(() => undefined);
  }

  appendFrame(input: Parameters<BrowserRecordingStreamFrameEncoder['appendFrame']>[0]): void {
    if (this.state.discarded) {
      throw new Error('Browser recording ffmpeg encoder has been discarded.');
    }
    if (this.state.finished) {
      throw new Error('Browser recording ffmpeg encoder has already finished.');
    }
    if (this.state.failure) {
      throw this.state.failure;
    }

    let accepted = false;
    try {
      accepted = this.child.stdin.write(input.payload);
    } catch {
      const failure = this.fail(createGenericFailure());
      killFfmpeg(this.child);
      throw failure;
    }
    if (!accepted) {
      const failure = this.fail(new Error(ENCODER_BACKPRESSURE_MESSAGE));
      killFfmpeg(this.child);
      throw failure;
    }
  }

  async finish(input: Parameters<BrowserRecordingStreamFrameEncoder['finish']>[0]): Promise<BrowserRecordingStreamFrameEncoderOutput> {
    if (this.state.discarded) {
      throw new Error('Browser recording ffmpeg encoder has been discarded.');
    }
    if (this.state.finished) {
      throw new Error('Browser recording ffmpeg encoder has already finished.');
    }
    this.state.finished = true;
    if (input.frameCount <= 0) {
      const failure = this.fail(createGenericFailure());
      killFfmpeg(this.child);
      await this.removeOutput();
      throw failure;
    }

    try {
      this.child.stdin.end();
      await this.closePromise;
      if (this.state.failure) {
        throw this.state.failure;
      }
      const outputStat = await stat(this.outputPath);
      if (!outputStat.isFile() || outputStat.size <= 0) {
        throw createGenericFailure();
      }
      return {
        source: {
          kind: 'local-file',
          path: this.outputPath,
          mimeType: 'video/webm',
          fileNameHint: this.fileNameHint,
        },
        byteSize: outputStat.size,
        cleanup: async () => {
          await this.removeOutput();
        },
      };
    } catch (error) {
      const failure = this.fail(error instanceof Error ? error : createGenericFailure());
      await this.removeOutput();
      throw failure;
    }
  }

  async discard(_input: Parameters<BrowserRecordingStreamFrameEncoder['discard']>[0]): Promise<void> {
    if (this.state.discarded) return;
    this.state.discarded = true;
    killFfmpeg(this.child);
    this.child.stdin.destroy();
    await this.removeOutput();
  }

  private fail(error: Error): Error {
    if (!this.state.failure) {
      this.state.failure = error.message === ENCODER_BACKPRESSURE_MESSAGE
        ? error
        : createGenericFailure();
    }
    return this.state.failure;
  }

  private async removeOutput(): Promise<void> {
    await rm(this.outputPath, { force: true });
  }
}

export function createFfmpegBrowserRecordingStreamFrameEncoderFactory(
  options: FfmpegBrowserRecordingStreamFrameEncoderFactoryOptions,
): BrowserRecordingStreamFrameEncoderFactory {
  const resolveFfmpegBinaryPath = options.resolveFfmpegBinaryPath ?? resolveFfmpegStaticBinaryPath;
  const spawnFfmpeg = options.spawnFfmpeg ?? defaultSpawnFfmpeg;
  const randomId = options.randomId ?? randomUUID;
  const outputDirectory = options.outputDirectory
    ?? join(options.workingDirectory, '.happier', 'tmp', 'browser-recordings');

  return async ({ recording, outputMimeType }) => {
    if (outputMimeType !== 'video/webm') {
      throw new Error('Browser recording ffmpeg encoder only supports video/webm output.');
    }
    const ffmpegBinaryPath = await resolveFfmpegBinaryPath();
    if (!ffmpegBinaryPath) {
      throw new Error(ENCODER_UNAVAILABLE_MESSAGE);
    }
    await mkdir(outputDirectory, { recursive: true });
    const outputPath = buildOutputPath({
      outputDirectory,
      recordingId: recording.recordingId,
      randomId: randomId(),
    });
    const args = buildFfmpegArgs({
      fps: recording.fps,
      outputPath,
    });
    const child = spawnFfmpeg(ffmpegBinaryPath, args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    return new FfmpegBrowserRecordingStreamFrameEncoder(
      child,
      outputPath,
      `browser-recording-${sanitizeRecordingIdSegment(recording.recordingId)}.webm`,
    );
  };
}
