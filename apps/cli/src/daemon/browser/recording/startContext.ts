import {
  DEFAULT_BROWSER_RECORDING_CAPABILITIES,
  type BrowserRecordingCapabilities,
  type DaemonBrowserRecordingStartInputV1,
} from '@happier-dev/protocol';

import type { BrowserRecordingStartContext } from './routes';

/**
 * Stream-frame recording surfaces. The PMS `streamFrameCapture` producer proves streamed browser
 * and simulator live-stream recording ONLY — it must never be cited as proof for local-preview
 * iframes/RN WebViews or `desktopWebView` recording (BRW-15 closeout invariant). Desktop WebView
 * recording stays scoped to `nativeViewCapture`; local previews stay unavailable until they have
 * a real live-stream source model.
 */
const STREAM_FRAME_SUPPORTED_ADAPTER_KINDS = [
  'streamedBrowserSurface',
  'simulatorPreview',
] as const;

const STREAM_FRAME_RECORDING_CAPABILITIES: BrowserRecordingCapabilities = {
  ...DEFAULT_BROWSER_RECORDING_CAPABILITIES,
  enabled: true,
  attachmentsEnabled: true,
  available: true,
  supportedCaptureKinds: ['streamFrameCapture'],
  supportedMimeTypes: ['video/webm'],
  supportedAdapterKinds: [...STREAM_FRAME_SUPPORTED_ADAPTER_KINDS],
  supportedRetentionClasses: ['preSend', 'attached', 'clearOnClose', 'clearOnSend'],
  disabledReasons: [],
};

const STREAM_FRAME_DISABLED_RECORDING_CAPABILITIES: BrowserRecordingCapabilities = {
  ...DEFAULT_BROWSER_RECORDING_CAPABILITIES,
  disabledReasons: [
    'Browser recording requires a machine live-stream capture source for this daemon runtime.',
  ],
};

/**
 * Desktop Wry `nativeViewCapture` recording surface (BA-4). The native still-capture producer
 * proves DESKTOP WebView recording ONLY — it is a single PNG frame written reference-only by the
 * native `desktop_browser_capture_recording_frame` command, NEVER a PMS stream mapped onto a
 * desktop view. Capabilities flip ON only where a real native capture producer is bound AND the
 * platform reports capture support; otherwise the cell stays fail-closed.
 */
const NATIVE_VIEW_SUPPORTED_ADAPTER_KINDS = ['externalUrl'] as const;

const NATIVE_VIEW_RECORDING_CAPABILITIES: BrowserRecordingCapabilities = {
  ...DEFAULT_BROWSER_RECORDING_CAPABILITIES,
  enabled: true,
  attachmentsEnabled: true,
  available: true,
  supportedCaptureKinds: ['nativeViewCapture'],
  supportedMimeTypes: ['image/png'],
  supportedAdapterKinds: [...NATIVE_VIEW_SUPPORTED_ADAPTER_KINDS],
  supportedRetentionClasses: ['preSend', 'attached', 'clearOnClose', 'clearOnSend'],
  disabledReasons: [],
};

const CDP_SCREENCAST_SUPPORTED_ADAPTER_KINDS = ['chromiumSidecar'] as const;

const CDP_SCREENCAST_RECORDING_CAPABILITIES: BrowserRecordingCapabilities = {
  ...DEFAULT_BROWSER_RECORDING_CAPABILITIES,
  enabled: true,
  attachmentsEnabled: true,
  available: true,
  supportedCaptureKinds: ['cdpScreencast'],
  supportedMimeTypes: ['video/webm'],
  supportedAdapterKinds: [...CDP_SCREENCAST_SUPPORTED_ADAPTER_KINDS],
  supportedRetentionClasses: ['preSend', 'attached', 'clearOnClose', 'clearOnSend'],
  disabledReasons: [],
};

export type BrowserRecordingStreamFrameStartContextOptions = Readonly<{
  hasLiveStreamCaptureRegistry: boolean;
}>;

export type BrowserRecordingStartContextOptions = Readonly<{
  /** A live-stream capture registry is wired → the `streamFrameCapture` producer exists. */
  hasLiveStreamCaptureRegistry: boolean;
  /** A native desktop capture producer is bound + platform-supported → `nativeViewCapture` exists. */
  hasNativeViewCapture: boolean;
  /** A managed-Chromium CDP screencast transport is bound → `cdpScreencast` exists. */
  hasCdpScreencast?: boolean;
}>;

function mergeUnique<T>(...lists: readonly (readonly T[])[]): T[] {
  return [...new Set<T>(lists.flat())];
}

/**
 * Production recording start-context resolver for the `streamFrameCapture` producer.
 * Capabilities flip ON only where the producer actually exists (a live-stream capture
 * registry is wired). Without it, the resolver stays fail-closed so the runtime keeps
 * returning a disabled capability (producer-absent guard).
 */
export function resolveBrowserRecordingStreamFrameStartContext(
  options: BrowserRecordingStreamFrameStartContextOptions,
): (startInput: DaemonBrowserRecordingStartInputV1) => BrowserRecordingStartContext {
  return () => {
    if (!options.hasLiveStreamCaptureRegistry) {
      return {
        browserRecordingEnabled: false,
        recordingCapabilities: STREAM_FRAME_DISABLED_RECORDING_CAPABILITIES,
      };
    }
    return {
      browserRecordingEnabled: true,
      recordingCapabilities: STREAM_FRAME_RECORDING_CAPABILITIES,
    };
  };
}

/**
 * Production recording start-context resolver spanning EVERY daemon-wired capture producer (BA-4).
 * The advertised capabilities are the honest union of only the producers that actually exist on
 * this host: the PMS `streamFrameCapture` producer (live-stream registry), desktop Wry
 * `nativeViewCapture` producer (native capture command), and/or managed-Chromium `cdpScreencast`
 * producer (sidecar CDP transport). With no producer wired, recording stays fail-closed. The union
 * keeps each producer's promise scoped to its own capture kind + adapter + mime (BRW-15: a stream
 * producer never stands in as proof for a desktop view, and vice-versa).
 */
export function resolveBrowserRecordingStartContext(
  options: BrowserRecordingStartContextOptions,
): (startInput: DaemonBrowserRecordingStartInputV1) => BrowserRecordingStartContext {
  return (startInput) => {
    if (!options.hasLiveStreamCaptureRegistry && !options.hasNativeViewCapture && !options.hasCdpScreencast) {
      return {
        browserRecordingEnabled: false,
        recordingCapabilities: STREAM_FRAME_DISABLED_RECORDING_CAPABILITIES,
      };
    }

    const streamFrame = options.hasLiveStreamCaptureRegistry
      ? STREAM_FRAME_RECORDING_CAPABILITIES
      : null;
    const nativeView = options.hasNativeViewCapture
      ? NATIVE_VIEW_RECORDING_CAPABILITIES
      : null;
    const cdpScreencast = options.hasCdpScreencast
      ? CDP_SCREENCAST_RECORDING_CAPABILITIES
      : null;
    const sources = [streamFrame, nativeView, cdpScreencast].filter(
      (entry): entry is BrowserRecordingCapabilities => entry !== null,
    );

    return {
      browserRecordingEnabled: true,
      recordingCapabilities: {
        ...DEFAULT_BROWSER_RECORDING_CAPABILITIES,
        enabled: true,
        attachmentsEnabled: true,
        available: true,
        supportedCaptureKinds: sources.flatMap((entry) => entry.supportedCaptureKinds),
        supportedMimeTypes: mergeUnique(...sources.map((entry) => entry.supportedMimeTypes)),
        supportedAdapterKinds: mergeUnique(...sources.map((entry) => entry.supportedAdapterKinds)),
        supportedRetentionClasses: mergeUnique(
          ...sources.map((entry) => entry.supportedRetentionClasses),
        ),
        disabledReasons: [],
      },
      ...(startInput.captureKind === 'nativeViewCapture' && options.hasNativeViewCapture
        ? { captureSourceAvailable: true }
        : {}),
    };
  };
}
