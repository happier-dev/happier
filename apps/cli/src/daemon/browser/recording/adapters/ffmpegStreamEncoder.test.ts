import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';

import type {
  BrowserRecordingMachineLiveStreamCaptureSourceV1,
  BrowserRecordingSessionV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { MachineLiveStreamRegisteredCaptureSource } from '../../../peer/mediation/stream/captureRegistry';

function createRecording(): BrowserRecordingSessionV1 {
  return {
    v: 1,
    recordingId: 'recording_1',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: 'localServicePreview',
    adapterKind: 'localPreview',
    renderEngineKind: 'streamedSurface',
    captureKind: 'streamFrameCapture',
    fidelity: 'streamFrame',
    startedAtMs: 1_000,
    status: 'recording',
    navigationGenerationStart: 3,
    durationMs: 0,
    byteSize: 0,
    frameCount: 0,
    fps: 12,
    mimeType: 'video/webm',
    retentionClass: 'preSend',
    redactionLevel: 'metadataOnly',
    policyState: 'allowed',
    maxDurationMs: 30_000,
    maxBytes: 16_000_000,
    actionChapters: [],
    relatedReferences: [],
  };
}

const captureSource: BrowserRecordingMachineLiveStreamCaptureSourceV1 = {
  kind: 'machineLiveStream',
  streamFamily: 'simulator.preview',
  sourceId: 'source_1',
};

const registeredSource: MachineLiveStreamRegisteredCaptureSource = {
  sourceId: 'source_1',
  streamFamily: 'simulator.preview',
  capabilities: {
    v: 1,
    sourceId: 'source_1',
    sourceKind: 'simulator',
    supportedCodecs: ['image.mjpeg'],
    maxFramesPerSecond: 30,
    inputMode: 'none',
    sidebands: [],
    health: { status: 'available' },
  },
  adapter: {
    start: vi.fn(),
  },
};

class FakeFfmpegProcess extends EventEmitter {
  readonly chunks: Buffer[] = [];
  readonly kill = vi.fn(() => true);
  readonly stdin: Writable;

  constructor(
    private readonly outputPath: string,
    private readonly closeCode: number,
    private readonly writeReturns: boolean = true,
  ) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.chunks.push(Buffer.from(chunk));
        callback();
      },
      final: (callback) => {
        void (async () => {
          await mkdir(dirname(this.outputPath), { recursive: true });
          await writeFile(this.outputPath, Buffer.concat(this.chunks));
          callback();
          queueMicrotask(() => {
            this.emit('close', this.closeCode, null);
          });
        })().catch((error) => {
          callback(error instanceof Error ? error : new Error(String(error)));
        });
      },
    });
    const originalWrite = this.stdin.write.bind(this.stdin);
    this.stdin.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      originalWrite(chunk, encodingOrCallback as BufferEncoding, callback);
      return this.writeReturns;
    }) as Writable['write'];
  }
}

function outputPathFromArgs(args: readonly string[]): string {
  return args[args.length - 1] ?? '';
}

describe('browser recording ffmpeg stream encoder', () => {
  it('writes machine-live-stream MJPEG frames to a local video/webm artifact through bundled ffmpeg', async () => {
    const { createFfmpegBrowserRecordingStreamFrameEncoderFactory } = await import('./ffmpegStreamEncoder');
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-ffmpeg-encoder-'));
    const spawned: FakeFfmpegProcess[] = [];
    const spawnFfmpeg = vi.fn((binaryPath: string, args: readonly string[]) => {
      const child = new FakeFfmpegProcess(outputPathFromArgs(args), 0);
      spawned.push(child);
      return child;
    });

    try {
      const factory = createFfmpegBrowserRecordingStreamFrameEncoderFactory({
        workingDirectory,
        resolveFfmpegBinaryPath: async () => '/bundled/ffmpeg',
        spawnFfmpeg,
        randomId: () => 'uuid_1',
      });

      const encoder = await factory({
        recording: createRecording(),
        captureSource,
        registeredSource,
        outputMimeType: 'video/webm',
      });
      encoder.appendFrame({
        sequence: 1,
        timestampMs: 1_000,
        payloadKind: 'image_keyframe',
        payload: Buffer.from('first-frame'),
      });
      encoder.appendFrame({
        sequence: 2,
        timestampMs: 1_500,
        payloadKind: 'image_delta',
        payload: Buffer.from('second-frame'),
      });

      const output = await encoder.finish({
        recording: createRecording(),
        frameCount: 2,
        durationMs: 2_000,
      });

      expect(spawnFfmpeg).toHaveBeenCalledWith(
        '/bundled/ffmpeg',
        expect.arrayContaining(['-f', 'mjpeg', '-i', 'pipe:0', '-f', 'webm']),
        expect.objectContaining({ stdio: ['pipe', 'ignore', 'ignore'] }),
      );
      expect(output).toMatchObject({
        byteSize: 'first-framesecond-frame'.length,
        source: {
          kind: 'local-file',
          mimeType: 'video/webm',
          fileNameHint: 'browser-recording-recording_1.webm',
        },
      });
      expect(output.source.kind).toBe('local-file');
      if (output.source.kind !== 'local-file') return;
      expect(output.source.path).toContain(join(workingDirectory, '.happier', 'tmp', 'browser-recordings'));
      expect(JSON.stringify(output)).not.toContain(Buffer.from('first-frame').toString('base64'));
      await expect(readFile(output.source.path)).resolves.toEqual(Buffer.from('first-framesecond-frame'));
      await output.cleanup?.();
      await expect(stat(output.source.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(spawned).toHaveLength(1);
      expect(spawned[0]?.kill).not.toHaveBeenCalled();
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('fails closed when bundled ffmpeg is unavailable', async () => {
    const { createFfmpegBrowserRecordingStreamFrameEncoderFactory } = await import('./ffmpegStreamEncoder');
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-ffmpeg-encoder-missing-'));

    try {
      const factory = createFfmpegBrowserRecordingStreamFrameEncoderFactory({
        workingDirectory,
        resolveFfmpegBinaryPath: async () => null,
        spawnFfmpeg: vi.fn(),
      });

      await expect(factory({
        recording: createRecording(),
        captureSource,
        registeredSource,
        outputMimeType: 'video/webm',
      })).rejects.toThrow('Browser recording ffmpeg encoder is unavailable.');
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('removes partial output and surfaces a generic error when ffmpeg fails', async () => {
    const { createFfmpegBrowserRecordingStreamFrameEncoderFactory } = await import('./ffmpegStreamEncoder');
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-ffmpeg-encoder-fail-'));
    const spawnFfmpeg = vi.fn((_binaryPath: string, args: readonly string[]) => new FakeFfmpegProcess(outputPathFromArgs(args), 1));

    try {
      const factory = createFfmpegBrowserRecordingStreamFrameEncoderFactory({
        workingDirectory,
        resolveFfmpegBinaryPath: async () => '/private/path/to/ffmpeg',
        spawnFfmpeg,
        randomId: () => 'uuid_2',
      });
      const encoder = await factory({
        recording: createRecording(),
        captureSource,
        registeredSource,
        outputMimeType: 'video/webm',
      });
      encoder.appendFrame({
        sequence: 1,
        timestampMs: 1_000,
        payloadKind: 'image_keyframe',
        payload: Buffer.from('frame'),
      });

      await expect(encoder.finish({
        recording: createRecording(),
        frameCount: 1,
        durationMs: 1_000,
      })).rejects.toThrow('Browser recording ffmpeg encoder failed.');
      const outputPath = outputPathFromArgs(spawnFfmpeg.mock.calls[0]?.[1] ?? []);
      expect(outputPath).not.toBe('');
      await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('kills ffmpeg and throws when stdin backpressure is exceeded', async () => {
    const { createFfmpegBrowserRecordingStreamFrameEncoderFactory } = await import('./ffmpegStreamEncoder');
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-ffmpeg-encoder-backpressure-'));
    const spawned: FakeFfmpegProcess[] = [];
    const spawnFfmpeg = vi.fn((_binaryPath: string, args: readonly string[]) => {
      const child = new FakeFfmpegProcess(outputPathFromArgs(args), 0, false);
      spawned.push(child);
      return child;
    });

    try {
      const factory = createFfmpegBrowserRecordingStreamFrameEncoderFactory({
        workingDirectory,
        resolveFfmpegBinaryPath: async () => '/bundled/ffmpeg',
        spawnFfmpeg,
      });
      const encoder = await factory({
        recording: createRecording(),
        captureSource,
        registeredSource,
        outputMimeType: 'video/webm',
      });

      expect(() => encoder.appendFrame({
        sequence: 1,
        timestampMs: 1_000,
        payloadKind: 'image_keyframe',
        payload: Buffer.from('frame'),
      })).toThrow('Browser recording ffmpeg encoder backpressure exceeded.');
      expect(spawned[0]?.kill).toHaveBeenCalledWith('SIGKILL');
      await encoder.discard({ recording: createRecording(), reason: 'capture_failed' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
