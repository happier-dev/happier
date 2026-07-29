import {
  BrowserRecordingCaptureKindV1Schema,
  type BrowserRecordingCaptureKindV1,
  type BrowserRecordingCapabilities,
  type BrowserRenderEngineKindV1,
  type BrowserSemanticAdapterKindV1,
  type BrowserViewTargetKindV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createMachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';

import { createBrowserRecordingDaemonRuntime, type BrowserRecordingDaemonRuntimeOptions } from './runtime';

/**
 * ENGINE × CAPTURE-KIND CLOSURE (BA-7) — a BUILD-FAILING matrix over EVERY
 * {@link BrowserRecordingCaptureKindV1}. The matrix is keyed by the capture-kind enum, so a NEW
 * capture kind fails to compile until it is classified here with a PROMISE-LEDGER disposition.
 *
 * PROMISE-LEDGER pass condition (Completion rule #2 — a `disabledReason` is NOT a free pass):
 *   - a `build-now` cell MUST map to a LIVE daemon producer — when its dependency is bound the
 *     runtime reaches the producer (never `browser_recording_capture_adapter_missing`), and when the
 *     dependency is absent it stays honestly fail-closed (never silently dark);
 *   - an `unsurface` cell has NO daemon producer by design (structurally unsupported in this
 *     product — e.g. `webContentsCapture` needs an Electron `webContents` host the Tauri/Wry desktop
 *     does not provide) and therefore always reports `browser_recording_capture_unavailable`.
 *
 * This is the daemon half of the §13 engine×capability matrix; the UI navigation half lives in
 * `apps/ui/.../browserEngineNavigationClosure.test.ts`. The documented matrix is in
 * `docs/browser-recording-capture-matrix.md`.
 */

const WORKING_DIRECTORY = '/tmp/happier-browser-recording-engine-capture-matrix';

function capabilitiesForKind(
  captureKind: BrowserRecordingCaptureKindV1,
  adapterKind: BrowserSemanticAdapterKindV1,
  mimeType: string,
): BrowserRecordingCapabilities {
  return {
    enabled: true,
    attachmentsEnabled: true,
    available: true,
    supportedCaptureKinds: [captureKind],
    supportedMimeTypes: [mimeType],
    supportedAdapterKinds: [adapterKind],
    maxDurationMs: 30_000,
    maxBytes: 16_000_000,
    maxFps: 12,
    audioSupported: false,
    cursorOverlaySupported: false,
    actionTimelineChaptersSupported: false,
    supportedRetentionClasses: ['preSend'],
    disabledReasons: [],
    policyDeniedReasons: [],
  };
}

type RecordingCaptureKindContract = Readonly<{
  disposition: 'build-now' | 'unsurface';
  targetKind: BrowserViewTargetKindV1;
  adapterKind: BrowserSemanticAdapterKindV1;
  renderEngineKind: BrowserRenderEngineKindV1;
  mimeType: string;
  /** Returns the runtime options that bind this kind's live producer (`build-now` only). */
  bindProducer?: () => Partial<BrowserRecordingDaemonRuntimeOptions>;
}>;

const ENGINE_CAPTURE_MATRIX: Record<BrowserRecordingCaptureKindV1, RecordingCaptureKindContract> = {
  // Streamed/simulator previews — PMS live-stream capture registry producer.
  streamFrameCapture: {
    disposition: 'build-now',
    targetKind: 'simulatorPreview',
    adapterKind: 'simulatorPreview',
    renderEngineKind: 'streamedSurface',
    mimeType: 'video/webm',
    bindProducer: () => {
      const liveStreamCaptureRegistry = createMachineLiveStreamCaptureRegistry();
      liveStreamCaptureRegistry.register({
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
        adapter: { start: vi.fn(async () => ({ ok: true as const, session: { stop: vi.fn(async () => {}) } })) },
      });
      return {
        liveStreamCaptureRegistry,
        streamFrameEncoderFactory: async () => ({
          appendFrame: vi.fn(),
          finish: vi.fn(async () => {
            throw new Error('unexpected finish');
          }),
          discard: vi.fn(async () => {}),
        }),
      };
    },
  },
  // Managed-Chromium agent sidecar — CDP screencast producer.
  cdpScreencast: {
    disposition: 'build-now',
    targetKind: 'externalUrl',
    adapterKind: 'chromiumSidecar',
    renderEngineKind: 'unavailable',
    mimeType: 'video/webm',
    bindProducer: () => ({
      cdpScreencast: { transport: { start: vi.fn(async () => ({ ackFrame: vi.fn(), stop: vi.fn(async () => {}) })) } },
      streamFrameEncoderFactory: async () => ({
        appendFrame: vi.fn(),
        finish: vi.fn(async () => {
          throw new Error('unexpected finish');
        }),
        discard: vi.fn(async () => {}),
      }),
    }),
  },
  // Desktop Wry WebView — native still-capture producer (BA-4).
  nativeViewCapture: {
    disposition: 'build-now',
    targetKind: 'externalUrl',
    adapterKind: 'externalUrl',
    renderEngineKind: 'desktopWebView',
    mimeType: 'image/png',
    bindProducer: () => ({
      nativeViewCapture: {
        isPlatformCaptureSupported: () => true,
        captureCommand: vi.fn(async () => ({
          ok: true as const,
          source: {
            kind: 'local-file' as const,
            path: '/tmp/native-view.png',
            mimeType: 'image/png',
            fileNameHint: 'native-view.png',
          },
          byteSize: 1_024,
        })),
      },
    }),
  },
  // Electron `webContents` capture — structurally unsupported in the Tauri/Wry desktop (no Electron
  // host). Makes no product promise: it has no daemon producer and always fails closed.
  webContentsCapture: {
    disposition: 'unsurface',
    targetKind: 'externalUrl',
    adapterKind: 'chromiumSidecar',
    renderEngineKind: 'unavailable',
    mimeType: 'video/webm',
  },
  // `MediaRecorder` is a CLIENT-side (in-page) capture path, not a daemon producer; the daemon half
  // of the matrix surfaces no producer for it (the client owns that producer if/when surfaced).
  mediaRecorder: {
    disposition: 'unsurface',
    targetKind: 'localServicePreview',
    adapterKind: 'localPreview',
    renderEngineKind: 'webIframe',
    mimeType: 'video/webm',
  },
  // The no-capture sentinel — never a product producer.
  unavailable: {
    disposition: 'unsurface',
    targetKind: 'localServicePreview',
    adapterKind: 'localPreview',
    renderEngineKind: 'unavailable',
    mimeType: 'video/webm',
  },
};

function startInputForKind(
  captureKind: BrowserRecordingCaptureKindV1,
  contract: RecordingCaptureKindContract,
) {
  return {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    profileId: 'profile_1',
    targetKind: contract.targetKind,
    adapterKind: contract.adapterKind,
    renderEngineKind: contract.renderEngineKind,
    captureKind,
    fidelity: 'streamFrame' as const,
    navigationGeneration: 1,
    mimeType: contract.mimeType,
    retentionClass: 'preSend' as const,
    mediaTarget: { sessionId: 'session_matrix', messageLocalId: 'message_matrix' },
    ...(captureKind === 'streamFrameCapture'
      ? {
        captureSource: {
          kind: 'machineLiveStream' as const,
          streamFamily: 'simulator.preview',
          sourceId: 'source_1',
        },
      }
      : {}),
  };
}

function buildRuntime(producerOptions: Partial<BrowserRecordingDaemonRuntimeOptions>, captureKind: BrowserRecordingCaptureKindV1, contract: RecordingCaptureKindContract) {
  return createBrowserRecordingDaemonRuntime({
    workingDirectory: WORKING_DIRECTORY,
    resolveSessionMediaTarget: () => ({ sessionId: 'session_matrix', messageLocalId: 'message_matrix' }),
    resolveStartContext: vi.fn(async () => ({
      browserRecordingEnabled: true,
      recordingCapabilities: capabilitiesForKind(captureKind, contract.adapterKind, contract.mimeType),
      ...(captureKind === 'nativeViewCapture' && producerOptions.nativeViewCapture
        ? { captureSourceAvailable: true }
        : {}),
    })),
    ...producerOptions,
  });
}

describe('engine × capture-kind closure (BA-7 producer matrix)', () => {
  it('classifies every recording capture kind (build-fails until a new kind is added to the matrix)', () => {
    for (const captureKind of BrowserRecordingCaptureKindV1Schema.options) {
      expect(ENGINE_CAPTURE_MATRIX[captureKind], `capture kind ${captureKind} must be classified`).toBeDefined();
    }
  });

  for (const captureKind of BrowserRecordingCaptureKindV1Schema.options) {
    const contract = ENGINE_CAPTURE_MATRIX[captureKind];

    if (contract.disposition === 'build-now') {
      it(`BUILD-NOW '${captureKind}' maps to a live producer when its dependency is bound`, async () => {
        const producerOptions = contract.bindProducer?.() ?? {};
        const runtime = buildRuntime(producerOptions, captureKind, contract);
        try {
          const result = await runtime.routes.startRecording(startInputForKind(captureKind, contract));
          // The producer was reached — never a dark cell.
          expect(result.status).toBe('started');
        } finally {
          runtime.stop();
        }
      });

      it(`BUILD-NOW '${captureKind}' stays honestly fail-closed when no producer is bound`, async () => {
        const runtime = buildRuntime({}, captureKind, contract);
        try {
          await expect(runtime.routes.startRecording(startInputForKind(captureKind, contract))).resolves.toMatchObject({
            status: 'unavailable',
            reason: {
              code: captureKind === 'nativeViewCapture'
                ? 'browser_recording_capture_unavailable'
                : 'browser_recording_capture_adapter_missing',
            },
          });
        } finally {
          runtime.stop();
        }
      });
    } else {
      it(`UNSURFACE '${captureKind}' has no daemon producer and reports capture_unavailable`, async () => {
        const runtime = buildRuntime({}, captureKind, contract);
        try {
          await expect(runtime.routes.startRecording(startInputForKind(captureKind, contract))).resolves.toMatchObject({
            status: 'unavailable',
            reason: { code: 'browser_recording_capture_unavailable' },
          });
        } finally {
          runtime.stop();
        }
      });
    }
  }
});
