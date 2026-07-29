import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserRecordingCdpScreencastTransport } from './cdpScreencastTransport';

type CdpNotification = Readonly<{
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}>;

function createRecording(
  overrides: Partial<BrowserRecordingSessionV1> = {},
): BrowserRecordingSessionV1 {
  return {
    v: 1,
    recordingId: 'recording_cdp_transport',
    browserSessionId: 'browser_session_cdp',
    viewId: 'view_cdp',
    profileId: 'profile_cdp',
    targetKind: 'externalUrl',
    adapterKind: 'chromiumSidecar',
    renderEngineKind: 'unavailable',
    captureKind: 'cdpScreencast',
    fidelity: 'cdp',
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

function createHarness(options: { handle?: null; sessionId?: string; canSubscribe?: boolean } = {}) {
  const commands: Array<Record<string, unknown>> = [];
  const listeners: Array<(notification: CdpNotification) => void> = [];
  const unsubscribe = vi.fn();
  const handle = options.handle === null
    ? null
    : { targetId: 'target_cdp', sessionId: options.sessionId ?? 'session_cdp' };
  return {
    commands,
    listeners,
    unsubscribe,
    contextCapture: {
      transport: {
        dispatchPageCommand: vi.fn(async (command: Record<string, unknown>) => {
          commands.push(command);
          return {};
        }),
      },
      resolvePageHandle: vi.fn(() => handle),
      ...(options.canSubscribe === false
        ? {}
        : {
          subscribeCdpEvents: (listener: (notification: CdpNotification) => void) => {
            listeners.push(listener);
            return unsubscribe;
          },
        }),
    },
  };
}

describe('managed-Chromium CDP screencast recording transport', () => {
  it('starts Page.screencast, forwards matching frames, acks frames, and stops through the existing context-capture surface', async () => {
    const harness = createHarness();
    const frames: unknown[] = [];
    const transport = createBrowserRecordingCdpScreencastTransport({
      contextCapture: harness.contextCapture,
    });

    const session = await transport.start({
      recording: createRecording(),
      onFrame: (frame) => frames.push(frame),
    });

    expect(session).not.toBe(null);
    expect(harness.commands[0]).toMatchObject({
      targetId: 'target_cdp',
      sessionId: 'session_cdp',
      method: 'Page.startScreencast',
      params: { format: 'jpeg' },
    });

    harness.listeners[0]?.({
      method: 'Page.screencastFrame',
      sessionId: 'session_cdp',
      params: {
        sessionId: 7,
        data: Buffer.from('jpeg-frame').toString('base64'),
      },
    });

    expect(frames).toEqual([
      expect.objectContaining({
        sessionId: 7,
        dataBase64: Buffer.from('jpeg-frame').toString('base64'),
      }),
    ]);

    session?.ackFrame(7);
    expect(harness.commands.at(-1)).toMatchObject({
      targetId: 'target_cdp',
      sessionId: 'session_cdp',
      method: 'Page.screencastFrameAck',
      params: { sessionId: 7 },
    });

    await session?.stop();
    expect(harness.commands.at(-1)).toMatchObject({
      targetId: 'target_cdp',
      sessionId: 'session_cdp',
      method: 'Page.stopScreencast',
    });
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
  });

  it('fails closed when the recording view has no sidecar page handle or event stream', async () => {
    const noHandle = createBrowserRecordingCdpScreencastTransport({
      contextCapture: createHarness({ handle: null }).contextCapture,
    });
    await expect(noHandle.start({ recording: createRecording(), onFrame: vi.fn() })).resolves.toBe(null);

    const noEvents = createBrowserRecordingCdpScreencastTransport({
      contextCapture: createHarness({ canSubscribe: false }).contextCapture,
    });
    await expect(noEvents.start({ recording: createRecording(), onFrame: vi.fn() })).resolves.toBe(null);
  });
});
