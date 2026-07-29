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
    maxDurationMs: 30_000,
    maxBytes: 16_000_000,
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

function createFakeEncoder(byteSize = 4_096): CapturedEncoder {
  const appended: Buffer[] = [];
  const discardSpy = vi.fn(async () => {});
  return {
    frames: [],
    appended,
    discardSpy,
    appendFrame: (input) => {
      appended.push(input.payload);
    },
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
  acked: number[];
  stopSpy: ReturnType<typeof vi.fn>;
  startCalls: number;
};

function createFakeTransport(options: { startReturnsNull?: boolean } = {}): FakeTransportControls {
  const acked: number[] = [];
  const stopSpy = vi.fn(async () => {});
  let onFrame: ((frame: BrowserRecordingCdpScreencastFrame) => void) | null = null;
  let startCalls = 0;
  const session: BrowserRecordingCdpScreencastSession = {
    ackFrame: (sessionId) => {
      acked.push(sessionId);
    },
    stop: stopSpy,
  };
  return {
    acked,
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
  it('feeds CDP screencast JPEG frames into the encoder and acks each frame', async () => {
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

    // Every screencast frame must be acked so Chromium keeps emitting frames.
    expect(fake.acked).toEqual([1, 2]);
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

  it('bounds the aggregate raw byte budget and stops appending past the cap (no unbounded accumulation)', async () => {
    const fake = createFakeTransport();
    const encoder = createFakeEncoder();
    const adapter = createBrowserRecordingCdpScreencastCaptureAdapter({
      transport: fake.transport,
      encoderFactory: async () => encoder,
    });
    // Tiny byte cap forces the second frame to exceed the aggregate budget.
    const recording = createRecording({ maxBytes: 12 });
    await adapter.start({ recording });

    fake.emit(jpegFrame(1, Buffer.from('12345678'))); // 8 bytes -> accepted
    fake.emit(jpegFrame(2, Buffer.from('12345678'))); // would push to 16 > 12 -> rejected

    // The over-budget frame is still acked (to drain Chromium) but NOT appended.
    expect(fake.acked).toEqual([1, 2]);
    expect(encoder.appended).toHaveLength(1);
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
