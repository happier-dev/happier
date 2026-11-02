import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  createBrowserRecordingCdpScreencastCaptureAdapter,
  type BrowserRecordingCdpScreencastFrame,
  type BrowserRecordingCdpScreencastSession,
  type BrowserRecordingCdpScreencastTransport,
} from './cdpScreencast';
import type { BrowserRecordingStreamFrameEncoder } from './stream';

function createRecording(
  overrides: Partial<BrowserRecordingSessionV1> = {},
): BrowserRecordingSessionV1 {
  return {
    v: 1,
    recordingId: 'recording_cdp_1',
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: 'externalUrl',
    adapterKind: 'chromiumSidecar',
    renderEngineKind: 'unavailable',
    captureKind: 'cdpScreencast',
    fidelity: 'streamFrame',
    startedAtMs: 1_000,
    status: 'recording',
    navigationGenerationStart: 1,
    durationMs: 0,
    byteSize: 0,
    frameCount: 0,
    fps: 12,
    mimeType: 'video/webm',
    retentionClass: 'preSend',
    redactionLevel: 'metadataOnly',
    policyState: 'allowed',
    actionChapters: [],
    relatedReferences: [],
    ...overrides,
  };
}

type CapturedEncoder = BrowserRecordingStreamFrameEncoder & {
  readonly frames: BrowserRecordingCdpScreencastFrame['dataBase64'][];
  readonly appended: Buffer[];
  readonly discardSpy: ReturnType<typeof vi.fn>;
};

function createFakeEncoder(
  byteSize = 4_096,
  appendFrame?: BrowserRecordingStreamFrameEncoder['appendFrame'],
): CapturedEncoder {
  const appended: Buffer[] = [];
  const discardSpy = vi.fn(async () => {});
  return {
    frames: [],
    appended,
    discardSpy,
    appendFrame: appendFrame ?? ((input) => {
      appended.push(input.payload);
    }),
    finish: async () => ({
      source: {
        kind: 'local-file' as const,
        path: '/tmp/recording_cdp_1.webm',
        mimeType: 'video/webm',
        fileNameHint: 'recording_cdp_1.webm',
      },
      byteSize,
    }),
    discard: discardSpy,
  };
}

type FakeTransportControls = {
  transport: BrowserRecordingCdpScreencastTransport;
  emit: (frame: BrowserRecordingCdpScreencastFrame) => void;
  stopSpy: ReturnType<typeof vi.fn>;
  startCalls: number;
};

function createFakeTransport(options: { startReturnsNull?: boolean } = {}): FakeTransportControls {
  const stopSpy = vi.fn(async () => {});
  let onFrame: ((frame: BrowserRecordingCdpScreencastFrame) => void) | null = null;
  let startCalls = 0;
  const session: BrowserRecordingCdpScreencastSession = {
    stop: stopSpy,
  };
  return {
    stopSpy,
    get startCalls() {
      return startCalls;
    },
    emit: (frame) => {
      onFrame?.(frame);
    },
    transport: {
      start: async (input) => {
        startCalls += 1;
        if (options.startReturnsNull) return null;
        onFrame = input.onFrame;
        return session;
      },
    },
  };
}

function jpegFrame(sessionId: number, bytes: Buffer, timestampMs = 1_100): BrowserRecordingCdpScreencastFrame {
  return { sessionId, dataBase64: bytes.toString('base64'), timestampMs };
}

describe('browser recording cdpScreencast adapter', () => {
  it('captures startup frames and refuses a producer that fails before startup settles', async () => {
    for (const fails of [false, true]) {
      const encoder = createFakeEncoder();
      const stop = vi.fn(async () => {});
      const adapter = createBrowserRecordingCdpScreencastCaptureAdapter({
        encoderFactory: async () => encoder,
        transport: { start: async input => {
          input.onFrame(jpegFrame(1, Buffer.from('startup-frame')));
          if (fails) input.onError?.(new Error('CDP connection lost'));
          return { stop };
        } },
      });
      const recording = createRecording();
      const started = await adapter.start({ recording });
      expect(encoder.appended).toEqual([Buffer.from('startup-frame')]);
      if (fails) {
        expect(started).toMatchObject({ status: 'unavailable', reason: { code: 'browser_recording_capture_failed' } });
        expect(stop).toHaveBeenCalledOnce();
        expect(encoder.discardSpy).toHaveBeenCalledOnce();
      } else await adapter.discard({ recordingId: recording.recordingId, recording, reason: 'user_canceled' });
    }
  });

  it('keeps accepting page frames until Stop', async () => {
    const fake = createFakeTransport();
    const encoder = createFakeEncoder();
    const recording = createRecording();
    const adapter = createBrowserRecordingCdpScreencastCaptureAdapter({ transport: fake.transport,
      encoderFactory: async () => encoder, nowMs: () => 168_000 });
    await adapter.start({ recording });
    fake.emit(jpegFrame(1, Buffer.from('within-window'), 1_100));
    fake.emit(jpegFrame(2, Buffer.from('after-window'), 168_000));
    const artifact = await adapter.stop({ recordingId: recording.recordingId, recording });
    expect(encoder.appended).toEqual([Buffer.from('within-window'), Buffer.from('after-window')]);
    expect(artifact).toMatchObject({ durationMs: 167_000, frameCount: 2 });
  });

  it.each(['producer', 'encoder'] as const)('reports a failed %s drain and rejects late frames', async (failure) => {
    const fake = createFakeTransport();
    const encoder = createFakeEncoder();
    if (failure === 'producer') fake.stopSpy.mockRejectedValue(new Error('source shutdown failed'));
    else encoder.discardSpy.mockRejectedValue(new Error('encoder shutdown failed'));
    const adapter = createBrowserRecordingCdpScreencastCaptureAdapter({
      transport: fake.transport,
      encoderFactory: async () => encoder,
    });
    const recording = createRecording();
    await adapter.start({ recording });
    const discarded = await adapter.discard({ recordingId: recording.recordingId, recording, reason: 'policy_revoked' }).then(() => true, () => false);
    fake.emit(jpegFrame(1, Buffer.from('D26-cdp-fixture-secret')));

    expect(discarded).toBe(false);
    expect(encoder.appended).toEqual([]);
  });

  it('feeds the shared producer JPEG frames into the recording encoder', async () => {
    const fake = createFakeTransport();
    const encoder = createFakeEncoder(8_192);
    const adapter = createBrowserRecordingCdpScreencastCaptureAdapter({
      transport: fake.transport,
      encoderFactory: async () => encoder,
      nowMs: () => 5_000,
    });

    const recording = createRecording();
    const start = await adapter.start({ recording });
    expect(start.status).toBe('started');

    fake.emit(jpegFrame(1, Buffer.from('jpeg-frame-one'), 1_100));
    fake.emit(jpegFrame(2, Buffer.from('jpeg-frame-two'), 1_200));

    expect(encoder.appended).toHaveLength(2);
    expect(encoder.appended[0]?.toString()).toBe('jpeg-frame-one');

    const artifact = await adapter.stop({ recordingId: recording.recordingId, recording });
    expect(fake.stopSpy).toHaveBeenCalledOnce();
    expect(artifact.mimeType).toBe('video/webm');
    expect(artifact.frameCount).toBe(2);
    expect(artifact.byteSize).toBe(8_192);
    expect(artifact.source.kind).toBe('local-file');
  });

  it('rejects a second concurrent recording for the same id', async () => {
    const fake = createFakeTransport();
    const adapter = createBrowserRecordingCdpScreencastCaptureAdapter({
      transport: fake.transport,
      encoderFactory: async () => createFakeEncoder(),
    });
    const recording = createRecording();
    expect((await adapter.start({ recording })).status).toBe('started');
    const second = await adapter.start({ recording });
    expect(second.status).toBe('unavailable');
    if (second.status === 'unavailable') {
      expect(second.reason.code).toBe('browser_recording_already_active');
    }
  });

  it('only supports video/webm output', async () => {
    const fake = createFakeTransport();
    const adapter = createBrowserRecordingCdpScreencastCaptureAdapter({
      transport: fake.transport,
      encoderFactory: async () => createFakeEncoder(),
    });
    const result = await adapter.start({ recording: createRecording({ mimeType: 'video/mp4' }) });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason.code).toBe('browser_recording_mime_unavailable');
    }
  });

  it('reports unavailable when the screencast transport cannot start', async () => {
    const fake = createFakeTransport({ startReturnsNull: true });
    const adapter = createBrowserRecordingCdpScreencastCaptureAdapter({
      transport: fake.transport,
      encoderFactory: async () => createFakeEncoder(),
    });
    const result = await adapter.start({ recording: createRecording() });
    expect(result.status).toBe('unavailable');
    if (result.status === 'unavailable') {
      expect(result.reason.code).toBe('browser_recording_capture_unavailable');
    }
  });

  it('lets encoder backpressure bound pending frames', async () => {
    const fake = createFakeTransport();
    const encoder = createFakeEncoder(undefined, () => false);
    const adapter = createBrowserRecordingCdpScreencastCaptureAdapter({
      transport: fake.transport,
      encoderFactory: async () => encoder,
    });
    const recording = createRecording();
    await adapter.start({ recording });

    fake.emit(jpegFrame(1, Buffer.from('12345678')));
    fake.emit(jpegFrame(2, Buffer.from('12345678')));

    expect(encoder.appended).toHaveLength(0);
    expect(await adapter.stop({ recordingId: recording.recordingId, recording })).toMatchObject({ frameCount: 0 });
  });

  it('discards the encoder and stops the session on discard', async () => {
    const fake = createFakeTransport();
    const encoder = createFakeEncoder();
    const adapter = createBrowserRecordingCdpScreencastCaptureAdapter({
      transport: fake.transport,
      encoderFactory: async () => encoder,
    });
    const recording = createRecording();
    await adapter.start({ recording });
    await adapter.discard({ recordingId: recording.recordingId, recording, reason: 'user_canceled' });
    expect(fake.stopSpy).toHaveBeenCalledOnce();
    expect(encoder.discardSpy).toHaveBeenCalledOnce();
  });
});
