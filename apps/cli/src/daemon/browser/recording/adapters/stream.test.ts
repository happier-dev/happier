import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { BrowserRecordingSessionV1, MachineLiveStreamFrameV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

function frame(sequence: number, bytes: Buffer, timestampMs = 1_000): MachineLiveStreamFrameV1 {
  return {
    v: 1,
    streamId: 'recording_1',
    sequence,
    timestampMs,
    payloadKind: sequence === 1 ? 'image_keyframe' : 'image_delta',
    payloadEncoding: 'binary_base64',
    payloadBase64: bytes.toString('base64'),
    payloadSizeBytes: bytes.byteLength,
  };
}

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

describe('browser recording stream-frame adapter', () => {
  it('captures machine-live-stream image frames through an encoder boundary', async () => {
    const [
      { createMachineLiveStreamCaptureRegistry },
      { createBrowserRecordingStreamFrameCaptureAdapter },
    ] = await Promise.all([
      import('../../../peer/mediation/stream/captureRegistry'),
      import('./stream'),
    ]);
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-stream-recording-'));

    try {
      await mkdir(workingDirectory, { recursive: true });
      const outputPath = join(workingDirectory, 'recording.webm');
      const encodedFrames: Buffer[] = [];
      const stopSource = vi.fn(async () => {});
      const registry = createMachineLiveStreamCaptureRegistry();
      registry.register({
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
          start: vi.fn(async (input) => {
            input.offerFrame(frame(1, Buffer.from('first-frame'), 1_000));
            input.offerFrame(frame(2, Buffer.from('second-frame'), 1_500));
            return { ok: true as const, session: { stop: stopSource } };
          }),
        },
      });

      const adapter = createBrowserRecordingStreamFrameCaptureAdapter({
        captureRegistry: registry,
        encoderFactory: async () => ({
          appendFrame: (input) => {
            encodedFrames.push(input.payload);
          },
          finish: async () => {
            const output = Buffer.concat(encodedFrames);
            await writeFile(outputPath, output);
            return {
              source: {
                kind: 'local-file' as const,
                path: outputPath,
                mimeType: 'video/webm',
                fileNameHint: 'recording.webm',
              },
              byteSize: output.byteLength,
            };
          },
          discard: vi.fn(async () => {}),
        }),
        nowMs: () => 3_000,
      });

      const start = await adapter.start({
        recording: createRecording(),
        captureSource: {
          kind: 'machineLiveStream',
          streamFamily: 'simulator.preview',
          sourceId: 'source_1',
        },
      });

      expect(start).toEqual({ status: 'started' });

      const artifact = await adapter.stop({
        recordingId: 'recording_1',
        recording: createRecording(),
      });

      expect(stopSource).toHaveBeenCalledTimes(1);
      expect(artifact).toMatchObject({
        durationMs: 2_000,
        byteSize: 'first-framesecond-frame'.length,
        frameCount: 2,
        fps: 1,
        mimeType: 'video/webm',
        source: {
          kind: 'local-file',
          path: outputPath,
          mimeType: 'video/webm',
        },
      });
      await expect(readFile(outputPath)).resolves.toEqual(Buffer.from('first-framesecond-frame'));
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it('fails closed and discards encoder state when the requested stream source is unavailable', async () => {
    const [
      { createMachineLiveStreamCaptureRegistry },
      { createBrowserRecordingStreamFrameCaptureAdapter },
    ] = await Promise.all([
      import('../../../peer/mediation/stream/captureRegistry'),
      import('./stream'),
    ]);
    const discard = vi.fn(async () => {});
    const adapter = createBrowserRecordingStreamFrameCaptureAdapter({
      captureRegistry: createMachineLiveStreamCaptureRegistry(),
      encoderFactory: async () => ({
        appendFrame: vi.fn(),
        finish: vi.fn(async () => {
          throw new Error('unexpected finish');
        }),
        discard,
      }),
      nowMs: () => 3_000,
    });

    const start = await adapter.start({
      recording: createRecording(),
      captureSource: {
        kind: 'machineLiveStream',
        streamFamily: 'missing',
      },
    });

    expect(start).toMatchObject({
      status: 'unavailable',
      reason: { code: 'browser_recording_capture_unavailable' },
    });
    expect(discard).not.toHaveBeenCalled();
  });

  it('rejects capture sources whose source id belongs to a different stream family', async () => {
    const [
      { createMachineLiveStreamCaptureRegistry },
      { createBrowserRecordingStreamFrameCaptureAdapter },
    ] = await Promise.all([
      import('../../../peer/mediation/stream/captureRegistry'),
      import('./stream'),
    ]);
    const registry = createMachineLiveStreamCaptureRegistry();
    const sourceStart = vi.fn(async () => ({ ok: true as const, session: { stop: vi.fn(async () => {}) } }));
    registry.register({
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
      adapter: { start: sourceStart },
    });
    const adapter = createBrowserRecordingStreamFrameCaptureAdapter({
      captureRegistry: registry,
      encoderFactory: async () => ({
        appendFrame: vi.fn(),
        finish: vi.fn(async () => {
          throw new Error('unexpected finish');
        }),
        discard: vi.fn(async () => {}),
      }),
      nowMs: () => 3_000,
    });

    const start = await adapter.start({
      recording: createRecording(),
      captureSource: {
        kind: 'machineLiveStream',
        streamFamily: 'other.preview',
        sourceId: 'source_1',
      },
    });

    expect(start).toMatchObject({
      status: 'unavailable',
      reason: { code: 'browser_recording_capture_unavailable' },
    });
    expect(sourceStart).not.toHaveBeenCalled();
  });

  it('discards encoder state when the source adapter throws during start', async () => {
    const [
      { createMachineLiveStreamCaptureRegistry },
      { createBrowserRecordingStreamFrameCaptureAdapter },
    ] = await Promise.all([
      import('../../../peer/mediation/stream/captureRegistry'),
      import('./stream'),
    ]);
    const registry = createMachineLiveStreamCaptureRegistry();
    registry.register({
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
        start: vi.fn(async () => {
          throw new Error('source start failed');
        }),
      },
    });
    const encoderDiscard = vi.fn(async () => {});
    const adapter = createBrowserRecordingStreamFrameCaptureAdapter({
      captureRegistry: registry,
      encoderFactory: async () => ({
        appendFrame: vi.fn(),
        finish: vi.fn(async () => {
          throw new Error('unexpected finish');
        }),
        discard: encoderDiscard,
      }),
      nowMs: () => 3_000,
    });

    const start = await adapter.start({
      recording: createRecording(),
      captureSource: {
        kind: 'machineLiveStream',
        streamFamily: 'simulator.preview',
        sourceId: 'source_1',
      },
    });

    expect(start).toMatchObject({
      status: 'unavailable',
      reason: { code: 'browser_recording_capture_failed' },
    });
    expect(encoderDiscard).toHaveBeenCalledWith(expect.objectContaining({
      recording: expect.objectContaining({ recordingId: 'recording_1' }),
      reason: 'capture_failed',
    }));
  });

  it('discards encoder state when active source stop fails', async () => {
    const [
      { createMachineLiveStreamCaptureRegistry },
      { createBrowserRecordingStreamFrameCaptureAdapter },
    ] = await Promise.all([
      import('../../../peer/mediation/stream/captureRegistry'),
      import('./stream'),
    ]);
    const registry = createMachineLiveStreamCaptureRegistry();
    registry.register({
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
        start: vi.fn(async (input) => {
          input.offerFrame(frame(1, Buffer.from('frame'), 1_000));
          return {
            ok: true as const,
            session: {
              stop: vi.fn(async () => {
                throw new Error('source stop failed');
              }),
            },
          };
        }),
      },
    });
    const encoderDiscard = vi.fn(async () => {});
    const adapter = createBrowserRecordingStreamFrameCaptureAdapter({
      captureRegistry: registry,
      encoderFactory: async () => ({
        appendFrame: vi.fn(),
        finish: vi.fn(async () => {
          throw new Error('unexpected finish');
        }),
        discard: encoderDiscard,
      }),
      nowMs: () => 3_000,
    });

    const started = await adapter.start({
      recording: createRecording(),
      captureSource: {
        kind: 'machineLiveStream',
        streamFamily: 'simulator.preview',
      },
    });
    expect(started.status).toBe('started');

    await expect(adapter.stop({
      recordingId: 'recording_1',
      recording: createRecording(),
    })).rejects.toThrow('source stop failed');
    expect(encoderDiscard).toHaveBeenCalledWith(expect.objectContaining({
      recording: expect.objectContaining({ recordingId: 'recording_1' }),
      reason: 'capture_failed',
    }));
  });

  it('discards encoder state when active encoder finish fails after frames were accepted', async () => {
    const [
      { createMachineLiveStreamCaptureRegistry },
      { createBrowserRecordingStreamFrameCaptureAdapter },
    ] = await Promise.all([
      import('../../../peer/mediation/stream/captureRegistry'),
      import('./stream'),
    ]);
    const registry = createMachineLiveStreamCaptureRegistry();
    registry.register({
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
        start: vi.fn(async (input) => {
          input.offerFrame(frame(1, Buffer.from('frame'), 1_000));
          return { ok: true as const, session: { stop: vi.fn(async () => {}) } };
        }),
      },
    });
    const encoderDiscard = vi.fn(async () => {});
    const adapter = createBrowserRecordingStreamFrameCaptureAdapter({
      captureRegistry: registry,
      encoderFactory: async () => ({
        appendFrame: vi.fn(),
        finish: vi.fn(async () => {
          throw new Error('encoder finish failed');
        }),
        discard: encoderDiscard,
      }),
      nowMs: () => 3_000,
    });

    const started = await adapter.start({
      recording: createRecording(),
      captureSource: {
        kind: 'machineLiveStream',
        streamFamily: 'simulator.preview',
      },
    });
    expect(started.status).toBe('started');

    await expect(adapter.stop({
      recordingId: 'recording_1',
      recording: createRecording(),
    })).rejects.toThrow('encoder finish failed');
    expect(encoderDiscard).toHaveBeenCalledWith(expect.objectContaining({
      recording: expect.objectContaining({ recordingId: 'recording_1' }),
      reason: 'capture_failed',
    }));
  });

  it('deletes unfinished output on discard', async () => {
    const [
      { createMachineLiveStreamCaptureRegistry },
      { createBrowserRecordingStreamFrameCaptureAdapter },
    ] = await Promise.all([
      import('../../../peer/mediation/stream/captureRegistry'),
      import('./stream'),
    ]);
    const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-browser-stream-recording-discard-'));

    try {
      const outputPath = join(workingDirectory, 'recording.webm');
      const registry = createMachineLiveStreamCaptureRegistry();
      registry.register({
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
          start: vi.fn(async (input) => {
            input.offerFrame(frame(1, Buffer.from('frame'), 1_000));
            return { ok: true as const, session: { stop: vi.fn(async () => {}) } };
          }),
        },
      });
      const encoderDiscard = vi.fn(async () => {
        await rm(outputPath, { force: true });
      });
      const adapter = createBrowserRecordingStreamFrameCaptureAdapter({
        captureRegistry: registry,
        encoderFactory: async () => ({
          appendFrame: (input) => {
            writeFileSync(outputPath, input.payload);
          },
          finish: vi.fn(async () => {
            throw new Error('unexpected finish');
          }),
          discard: encoderDiscard,
        }),
        nowMs: () => 3_000,
      });

      const started = await adapter.start({
        recording: createRecording(),
        captureSource: {
          kind: 'machineLiveStream',
          streamFamily: 'simulator.preview',
        },
      });

      expect(started.status).toBe('started');
      await expect(stat(outputPath)).resolves.toMatchObject({ size: 5 });

      await adapter.discard({
        recordingId: 'recording_1',
        recording: createRecording(),
        reason: 'user_canceled',
      });

      expect(encoderDiscard).toHaveBeenCalledTimes(1);
      await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });
});
