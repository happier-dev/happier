import type { BrowserRecordingSessionV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createBrowserRecordingCdpScreencastTransport } from './cdpScreencastTransport';
import { createBrowserCdpScreencastProducer } from '../../capture/cdpScreencast';
import { createSurfaceInputControl } from '../../../surfaces/inputControl';

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
  const lifecycleListeners: Array<(event: { type: 'bound' | 'unbound'; browserSessionId: string; viewId: string }) => void> = [];
  const unsubscribe = vi.fn();
  const handle = options.handle === null
    ? null
    : { targetId: 'target_cdp', sessionId: options.sessionId ?? 'session_cdp' };
  return {
    commands,
    listeners,
    lifecycleListeners,
    unsubscribe,
    contextCapture: {
      transport: {
        dispatchPageCommand: vi.fn(async (command: Record<string, unknown>) => {
          commands.push(command);
          return {};
        }),
      },
      resolvePageHandle: vi.fn(() => handle),
      subscribeViewLifecycle: (listener: (typeof lifecycleListeners)[number]) => {
        lifecycleListeners.push(listener);
        return () => { lifecycleListeners.splice(lifecycleListeners.indexOf(listener), 1); };
      },
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
  it('keeps human live viewing while confidential frames are excluded from observation subscribers', async () => {
    const harness = createHarness();
    const control = createSurfaceInputControl();
    const producer = createBrowserCdpScreencastProducer({ contextCapture: harness.contextCapture, resolveInputControl: () => control });
    const observations: unknown[] = [];
    const humanFrames: unknown[] = [];
    await producer.start({ view: createRecording(), onFrame: frame => observations.push(frame) });
    await producer.start({ view: createRecording(), purpose: 'humanViewer', onFrame: frame => humanFrames.push(frame) });
    await control.beginConfidentialityHold();
    harness.listeners.forEach(listener => listener({ method: 'Page.screencastFrame', sessionId: 'session_cdp',
      params: { sessionId: 1, data: 'fixture-secret' } }));
    expect(observations).toEqual([]);
    expect(humanFrames).toHaveLength(1);
    expect(harness.commands.filter(command => command.method === 'Page.screencastFrameAck')).toHaveLength(1);
    expect(await producer.start({ view: createRecording(), onFrame: frame => observations.push(frame) })).toBeNull();
    await producer.dispose();
  });

  it('retires all consumers when their exact view closes and never forwards late page frames', async () => {
    const harness = createHarness();
    const producer = createBrowserCdpScreencastProducer({ contextCapture: harness.contextCapture });
    const frames: unknown[] = [];
    const errors: unknown[] = [];
    await producer.start({ view: createRecording(), onFrame: (frame) => frames.push(frame), onError: (error) => errors.push(error) });
    harness.lifecycleListeners.forEach((listener) => listener({ type: 'unbound', browserSessionId: 'browser_session_cdp', viewId: 'view_cdp' }));
    harness.listeners.forEach((listener) => listener({ method: 'Page.screencastFrame', sessionId: 'session_cdp', params: { sessionId: 1, data: 'anBlZw==' } }));
    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(1);
    await producer.dispose();
    expect(harness.commands.filter((command) => command.method === 'Page.stopScreencast')).toHaveLength(1);
  });
  it.each(['viewer', 'recording'] as const)('shares one per-view producer when %s closes first', async (first) => {
    const harness = createHarness();
    const transport = createBrowserRecordingCdpScreencastTransport({ producer: createBrowserCdpScreencastProducer({ contextCapture: harness.contextCapture }) });
    const recordingFrames: unknown[] = [];
    const viewerFrames: unknown[] = [];
    const [recording, viewer] = await Promise.all([
      transport.start({ recording: createRecording(), onFrame: (frame) => recordingFrames.push(frame) }),
      transport.start({ recording: createRecording({ recordingId: 'viewer' }), onFrame: (frame) => viewerFrames.push(frame) }),
    ]);
    expect(harness.commands.filter((command) => command.method === 'Page.startScreencast')).toHaveLength(1);
    const emit = (sessionId: number) => harness.listeners.forEach((listener) => listener({
      method: 'Page.screencastFrame', sessionId: 'session_cdp',
      params: { sessionId, data: Buffer.from('jpeg-frame').toString('base64') },
    }));
    emit(1);
    expect(recordingFrames).toHaveLength(1);
    expect(viewerFrames).toHaveLength(1);
    expect(harness.commands.filter((command) => command.method === 'Page.screencastFrameAck')).toHaveLength(1);
    await (first === 'viewer' ? viewer : recording)?.stop();
    expect(harness.commands.filter((command) => command.method === 'Page.stopScreencast')).toHaveLength(0);
    emit(2);
    expect(recordingFrames).toHaveLength(first === 'viewer' ? 2 : 1);
    expect(viewerFrames).toHaveLength(first === 'recording' ? 2 : 1);
    await (first === 'viewer' ? recording : viewer)?.stop();
    expect(harness.commands.filter((command) => command.method === 'Page.stopScreencast')).toHaveLength(1);
  });
  it('starts Page.screencast, forwards matching frames, acks frames, and stops through the existing context-capture surface', async () => {
    const harness = createHarness();
    const frames: unknown[] = [];
    const transport = createBrowserRecordingCdpScreencastTransport({
      producer: createBrowserCdpScreencastProducer({ contextCapture: harness.contextCapture }),
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
      producer: createBrowserCdpScreencastProducer({ contextCapture: createHarness({ handle: null }).contextCapture }),
    });
    await expect(noHandle.start({ recording: createRecording(), onFrame: vi.fn() })).resolves.toBe(null);

    const noEvents = createBrowserRecordingCdpScreencastTransport({
      producer: createBrowserCdpScreencastProducer({ contextCapture: createHarness({ canSubscribe: false }).contextCapture }),
    });
    await expect(noEvents.start({ recording: createRecording(), onFrame: vi.fn() })).resolves.toBe(null);
  });
});
