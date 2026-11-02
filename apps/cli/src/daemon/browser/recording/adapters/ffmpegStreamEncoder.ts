import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process';
import { observeProcessLaunch } from '@/processes/launchNotification';
import { withProcessOwnerEnvironment } from '@/processes/ownerTag';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
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
  once(event: 'spawn', listener: () => void): unknown;
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

function defaultSpawnFfmpeg(
  binaryPath: string,
  args: readonly string[],
  options: SpawnOptions,
): BrowserRecordingFfmpegProcess {
  const child = spawnProcess(binaryPath, [...args], options);
  observeProcessLaunch(child);
  return child as BrowserRecordingFfmpegProcess;
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
    String(input.fps),
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
  private writtenFrames = 0;
  private lastFrame: Buffer | null = null;
  private pendingFrame: Readonly<{ index: number; payload: Buffer }> | null = null;
  readonly ready: Promise<void>;

  constructor(
    private readonly child: BrowserRecordingFfmpegProcess,
    private readonly outputPath: string,
    private readonly fileNameHint: string,
    private readonly startedAtMs: number,
    private readonly fps: number,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => reject(createGenericFailure()));
    });
    this.closePromise = new Promise<void>((resolve, reject) => {
      child.once('error', () => {
        const failure = this.fail();
        reject(failure);
      });
      child.once('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        const failure = this.fail();
        reject(failure);
      });
    });
    void this.closePromise.catch(() => undefined);
    child.stdin.on('error', () => { this.fail(); });
  }

  appendFrame(input: Parameters<BrowserRecordingStreamFrameEncoder['appendFrame']>[0]): false | void {
    if (this.state.discarded) {
      throw new Error('Browser recording ffmpeg encoder has been discarded.');
    }
    if (this.state.finished) {
      throw new Error('Browser recording ffmpeg encoder has already finished.');
    }
    if (this.state.failure) {
      throw this.state.failure;
    }

    // MJPEG has no timestamps. Sample its fixed-rate slots on the capture clock,
    // keeping the last picture across gaps rather than stretching every arrival
    // into a frame interval. Retain at most the held picture and one admitted one.
    if (this.child.stdin.writableNeedDrain) return false;
    try {
      this.flushPendingFrame();
      if (this.pendingFrame || this.child.stdin.writableNeedDrain) return false;
      const index = Math.max(0, Math.floor((input.timestampMs - this.startedAtMs) * this.fps / 1_000));
      if (index < this.writtenFrames) return false;
      this.pendingFrame = { index, payload: input.payload };
      this.flushPendingFrame();
    } catch {
      const failure = this.fail();
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
      const failure = this.fail();
      killFfmpeg(this.child);
      await this.removeOutput();
      throw failure;
    }

    try {
      const targetFrames = Math.max(1, Math.ceil(input.durationMs * this.fps / 1_000));
      while (this.pendingFrame || this.writtenFrames < targetFrames) {
        if (this.state.failure || this.child.stdin.destroyed) throw createGenericFailure();
        if (this.child.stdin.writableNeedDrain) {
          await Promise.race([
            once(this.child.stdin, 'drain'),
            this.closePromise.then(() => { throw createGenericFailure(); }),
          ]);
        }
        this.flushPendingFrame();
        if (!this.pendingFrame && this.writtenFrames < targetFrames) {
          if (!this.lastFrame) throw createGenericFailure();
          if (!this.child.stdin.writableNeedDrain) this.writeFrame(this.lastFrame);
        }
      }
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
    } catch {
      const failure = this.fail();
      await this.removeOutput();
      throw failure;
    } finally {
      this.lastFrame = null;
      this.pendingFrame = null;
    }
  }

  async discard(_input: Parameters<BrowserRecordingStreamFrameEncoder['discard']>[0]): Promise<void> {
    if (this.state.discarded) return;
    this.state.discarded = true;
    this.lastFrame = null;
    this.pendingFrame = null;
    killFfmpeg(this.child);
    this.child.stdin.destroy();
    await this.removeOutput();
  }

  private fail(): Error {
    if (!this.state.failure) {
      this.state.failure = createGenericFailure();
    }
    return this.state.failure;
  }

  private writeFrame(payload: Buffer): void {
    // write(false) still accepted this slot. The next slot waits for drain.
    this.child.stdin.write(payload);
    this.writtenFrames += 1;
  }

  private flushPendingFrame(): void {
    const frame = this.pendingFrame;
    if (!frame) return;
    this.lastFrame ??= frame.payload;
    while (this.writtenFrames <= frame.index) {
      if (this.child.stdin.writableNeedDrain) return;
      this.writeFrame(this.writtenFrames === frame.index ? frame.payload : this.lastFrame);
    }
    this.lastFrame = frame.payload;
    this.pendingFrame = null;
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
    const fps = Math.max(1, Math.floor(recording.fps));
    const args = buildFfmpegArgs({
      fps,
      outputPath,
    });
    const child = spawnFfmpeg(ffmpegBinaryPath, args, {
      env: withProcessOwnerEnvironment(process.env, { kind: 'happier', component: 'recording_encoder' }),
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    const encoder = new FfmpegBrowserRecordingStreamFrameEncoder(
      child,
      outputPath,
      `browser-recording-${sanitizeRecordingIdSegment(recording.recordingId)}.webm`,
      recording.startedAtMs,
      fps,
    );
    await encoder.ready;
    return encoder;
  };
}
