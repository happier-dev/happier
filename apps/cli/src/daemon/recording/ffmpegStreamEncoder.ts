import { execFile, spawn as spawnProcess, type SpawnOptions } from 'node:child_process';
import { observeProcessLaunch } from '@/processes/launchNotification';
import { withProcessOwnerEnvironment } from '@/processes/ownerTag';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { logger } from '@/ui/logger';
import { projectActionFailureCauseV1, readActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { resolveFfmpegStaticBinaryPath } from '@/daemon/runtime/ffmpegStatic';
import { RecordingEncoderUnavailableError } from './encoderFailure';

import type {
  BrowserRecordingStreamFrameEncoder,
  BrowserRecordingStreamFrameEncoderFactory,
  BrowserRecordingStreamFrameEncoderOutput,
} from './stream';

export type BrowserRecordingFfmpegProcess = Readonly<{
  stdin: Writable;
  stderr?: Readable | null;
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

export type RecordingOutputFormat = Readonly<{
  encoder: string;
  mimeType: 'video/mp4' | 'video/webm';
  container: 'mp4' | 'webm';
}>;

// yuv420p needs even dimensions. Pad rather than crop or rescale captured pixels.
const RECORDING_FRAME_FILTER = 'pad=ceil(iw/2)*2:ceil(ih/2)*2';

const WEBM_FORMAT: RecordingOutputFormat = { encoder: 'libvpx', mimeType: 'video/webm', container: 'webm' };
// These encoders accept software yuv420p frames without a separate device/filter graph.
// Hardware availability is established by the executable, never by the host OS name.
const H264_ENCODERS = ['libx264', 'libopenh264', 'h264_videotoolbox', 'h264_mf', 'h264_nvenc', 'h264_amf'] as const;
const formatsByExecutable = new Map<string, { identity: string; format: Promise<RecordingOutputFormat> }>();

/** The resolver revalidates the managed path; replacement changes its filesystem identity. */
export async function resolveRecordingOutputFormat(binaryPath: string): Promise<RecordingOutputFormat> {
  let identity: string;
  try {
    const info = await stat(binaryPath, { bigint: true });
    identity = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  } catch {
    // The real managed resolver rejects a missing executable. This also preserves
    // WebM for external process adapters that do not expose a filesystem binary.
    return WEBM_FORMAT;
  }
  const cached = formatsByExecutable.get(binaryPath);
  if (cached?.identity === identity) return cached.format;
  const format = (async (): Promise<RecordingOutputFormat> => {
    const listing = await new Promise<string>(resolve => {
      execFile(binaryPath, ['-hide_banner', '-encoders'], { windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout));
    });
    const encoders = new Set([...listing.matchAll(/^\s*V[.A-Z]{5}\s+(\S+)\s/gmu)].map(match => match[1]));
    for (const encoder of [...H264_ENCODERS, WEBM_FORMAT.encoder]) {
      if (!encoders.has(encoder)) continue;
      const candidate: RecordingOutputFormat = encoder === WEBM_FORMAT.encoder
        ? WEBM_FORMAT : { encoder, mimeType: 'video/mp4', container: 'mp4' };
      // Listing proves compilation, not runtime usability (including software
      // libraries). Exercise odd-sized RGB frames through the same padding filter
      // and actual muxer once per identity, including the WebM fallback.
      const usable = await new Promise<boolean>(resolve => {
        execFile(binaryPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=1281x721,format=rgb24',
          '-frames:v', '1', ...buildFfmpegOutputArgs(candidate), 'pipe:1'],
        { windowsHide: true }, error => resolve(!error));
      });
      if (usable) return candidate;
    }
    throw new RecordingEncoderUnavailableError();
  })();
  formatsByExecutable.set(binaryPath, { identity, format });
  return format;
}

function buildFfmpegOutputArgs(format: RecordingOutputFormat): readonly string[] {
  return [
    '-an',
    '-vf',
    RECORDING_FRAME_FILTER,
    '-c:v',
    format.encoder,
    '-pix_fmt',
    'yuv420p',
    ...(format.container === 'mp4'
      // Fragmented MP4 writes initialization metadata before media, rather than
      // depending on a final moov. Nonzero/signaled exits still fail and unlink.
      ? ['-movflags', 'frag_keyframe+empty_moov+default_base_moof']
      : ['-deadline', 'realtime', '-cpu-used', '8']),
    '-f',
    format.container,
  ];
}

function buildFfmpegArgs(input: Readonly<{
  fps: number;
  outputPath: string;
  inputFormat: 'mjpeg' | 'image2pipe';
  format: RecordingOutputFormat;
}>): readonly string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-f', input.inputFormat,
    '-r', String(input.fps), '-i', 'pipe:0', ...buildFfmpegOutputArgs(input.format), input.outputPath];
}

function killFfmpeg(child: BrowserRecordingFfmpegProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    child.kill();
  }
}

type EncoderProcessOutcome = {
  format: RecordingOutputFormat;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrClass: 'unclassified' | 'encoder_unavailable' | 'encoder_initialization_failed' | 'invalid_input' | 'output_write_failed' | 'no_frames_captured';
};

class RecordingEncoderError extends Error {
  constructor(readonly outcome: EncoderProcessOutcome, cause?: unknown) {
    super(ENCODER_FAILED_MESSAGE, { cause });
  }

  get failureCause() {
    return readActionFailureCauseV1({ ...projectActionFailureCauseV1(this.cause, 'recording.encoder'),
      nativeErrorCode: this.outcome.signal ? `signal_${this.outcome.signal.toLowerCase()}`
        : this.outcome.exitCode !== null ? `exit_${this.outcome.exitCode}` : 'process_error',
      nativeErrorReason: this.outcome.stderrClass });
  }
}

function createGenericFailure(cause?: unknown): Error {
  return new Error(ENCODER_FAILED_MESSAGE, { cause });
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
  private childPhase: 'running' | 'stopping' | 'closed' = 'running';
  private discardPromise: Promise<void> | null = null;
  private writtenFrames = 0;
  private lastFrame: Buffer | null = null;
  private pendingFrame: Readonly<{ index: number; payload: Buffer }> | null = null;
  readonly ready: Promise<void>;
  private readonly outcome: EncoderProcessOutcome;

  constructor(
    private readonly child: BrowserRecordingFfmpegProcess,
    private readonly outputPath: string,
    private readonly fileNameHint: string,
    private readonly startedAtMs: number,
    private readonly fps: number,
    private readonly format: RecordingOutputFormat,
  ) {
    this.outcome = { format, exitCode: null, signal: null, stderrClass: 'unclassified' };
    if (child.stderr) {
      const lines = createInterface({ input: child.stderr });
      lines.on('line', line => {
        // Empty-input teardown diagnostics must not replace the known capture cause.
        if (this.outcome.stderrClass === 'no_frames_captured') return;
        // Match known ffmpeg diagnostics, retaining only the closed class, never the line.
        if (/Unknown encoder/i.test(line)) this.outcome.stderrClass = 'encoder_unavailable';
        else if (/Error (?:while opening encoder|initializing output stream)|Cannot load lib|No capable devices found/i.test(line)) this.outcome.stderrClass = 'encoder_initialization_failed';
        else if (/Invalid data found when processing input|Could not find codec parameters|Error while decoding/i.test(line)) this.outcome.stderrClass = 'invalid_input';
        else if (/No space left on device|Error writing trailer|Error submitting a packet to the muxer/i.test(line)) this.outcome.stderrClass = 'output_write_failed';
      });
      child.once('close', () => lines.close());
    }
    this.ready = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', error => reject(this.fail(error)));
    });
    this.closePromise = new Promise<void>(resolve => {
      child.once('close', (code, signal) => {
        this.outcome.exitCode = code;
        this.outcome.signal = signal;
        this.childPhase = 'closed';
        if ((code !== 0 || signal) && !this.state.discarded) this.fail();
        if (this.state.failure) logger.warn('[recording] encoder failed', this.outcome);
        resolve();
      });
    });
    child.once('error', error => { this.fail(error); this.stopChild(); });
    child.stdin.on('error', error => { this.fail(error); this.stopChild(); });
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
    } catch (error) {
      const failure = this.fail(error);
      this.stopChild();
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
    try {
      if (input.frameCount <= 0) {
        if (!this.state.failure) this.outcome.stderrClass = 'no_frames_captured';
        throw this.fail();
      }
      const targetFrames = Math.max(1, Math.ceil(input.durationMs * this.fps / 1_000));
      while (this.pendingFrame || this.writtenFrames < targetFrames) {
        if (this.state.failure || this.child.stdin.destroyed) throw this.fail();
        if (this.child.stdin.writableNeedDrain) {
          await Promise.race([
            once(this.child.stdin, 'drain'),
            this.closePromise.then(() => { throw this.fail(); }),
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
          mimeType: this.format.mimeType,
          fileNameHint: this.fileNameHint,
        },
        byteSize: outputStat.size,
        cleanup: async () => {
          await this.removeOutput();
        },
      };
    } catch (error) {
      const failure = this.fail(error);
      // Cleanup failure must not replace the encoder's original failure.
      await this.discard({ recording: input.recording, reason: 'capture_failed' }).catch(() => undefined);
      throw failure;
    } finally {
      this.lastFrame = null;
      this.pendingFrame = null;
    }
  }

  discard(_input: Parameters<BrowserRecordingStreamFrameEncoder['discard']>[0]): Promise<void> {
    if (this.discardPromise) return this.discardPromise;
    this.state.discarded = true;
    this.lastFrame = null;
    this.pendingFrame = null;
    this.discardPromise = (async () => {
      this.stopChild();
      await this.closePromise;
      await this.removeOutput();
    })();
    return this.discardPromise;
  }

  private stopChild(): void {
    if (this.childPhase !== 'running') return;
    this.childPhase = 'stopping';
    killFfmpeg(this.child);
    this.child.stdin.destroy();
  }

  private fail(cause?: unknown): Error {
    if (!this.state.failure) {
      this.state.failure = new RecordingEncoderError(this.outcome, cause);
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

  const factory: BrowserRecordingStreamFrameEncoderFactory = async ({ recording, outputMimeType, registeredSource }) => {
    if (outputMimeType !== 'video/webm' && outputMimeType !== 'video/mp4') {
      throw new Error('Browser recording ffmpeg encoder requires a video output type.');
    }
    const ffmpegBinaryPath = await resolveFfmpegBinaryPath();
    if (!ffmpegBinaryPath) {
      throw new RecordingEncoderUnavailableError();
    }
    const format = await resolveRecordingOutputFormat(ffmpegBinaryPath);
    await mkdir(outputDirectory, { recursive: true });
    // The existing opaque UUID is a portable filename; recording IDs need no filename cutoff.
    const fileNameHint = `browser-recording-${randomId()}.${format.container}`;
    const outputPath = join(outputDirectory, fileNameHint);
    const fps = Math.max(1, Math.floor(recording.fps));
    const args = buildFfmpegArgs({
      inputFormat: registeredSource?.capabilities.supportedCodecs.includes('image.frame.v1') ? 'image2pipe' : 'mjpeg',
      fps,
      format,
      outputPath,
    });
    const child = spawnFfmpeg(ffmpegBinaryPath, args, {
      env: withProcessOwnerEnvironment(process.env, { kind: 'happier', component: 'recording_encoder' }),
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
    const encoder = new FfmpegBrowserRecordingStreamFrameEncoder(
      child,
      outputPath,
      fileNameHint,
      recording.startedAtMs,
      fps,
      format,
    );
    try {
      await encoder.ready;
    } catch (error) {
      await encoder.discard({ recording, reason: 'capture_failed' }).catch(() => undefined);
      throw error;
    }
    return encoder;
  };
  return Object.assign(factory, {
    async resolveOutputMimeType() {
      const binary = await resolveFfmpegBinaryPath();
      if (!binary) return null;
      try {
        return (await resolveRecordingOutputFormat(binary)).mimeType;
      } catch (error) {
        if (error instanceof RecordingEncoderUnavailableError) return null;
        throw error;
      }
    },
  });
}
