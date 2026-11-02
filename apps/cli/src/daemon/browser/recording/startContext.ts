import { DEFAULT_BROWSER_RECORDING_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import type { BrowserRecordingCapabilities, DaemonBrowserRecordingStartInputV1 } from '@happier-dev/protocol';
import { BROWSER_RECORDING_CAPTURE_PROFILES } from '@happier-dev/protocol/browser/recording/captureProfiles';

import type { BrowserRecordingStartContext } from './routes';

const STREAM_FRAME_DISABLED_RECORDING_CAPABILITIES: BrowserRecordingCapabilities = {
  ...DEFAULT_BROWSER_RECORDING_CAPABILITIES,
  disabledReasons: [
    'Browser recording requires a machine live-stream capture source for this daemon runtime.',
  ],
};

export type BrowserRecordingStreamFrameStartContextOptions = Readonly<{
  hasLiveStreamCaptureRegistry: boolean;
  hasFrameEncoder: boolean;
}>;

export type BrowserRecordingStartContextOptions = Readonly<{
  /** A live-stream capture registry is wired → the `streamFrameCapture` producer exists. */
  hasLiveStreamCaptureRegistry: boolean;
  /** A native capture command is bound and not known unsupported; the producer settles actual support. */
  hasNativeViewCapture: boolean;
  /** A managed-Chromium CDP screencast transport is bound → `cdpScreencast` exists. */
  hasCdpScreencast?: boolean;
  /** The shared runtime resolver found the executable WebM encoder; native PNG does not need it. */
  hasFrameEncoder: boolean;
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
  return resolveBrowserRecordingStartContext({ ...options, hasNativeViewCapture: false });
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

    const sources = BROWSER_RECORDING_CAPTURE_PROFILES.filter(profile => {
      switch (profile.captureKind) {
        case 'streamFrameCapture': return options.hasLiveStreamCaptureRegistry && options.hasFrameEncoder;
        case 'nativeViewCapture': return options.hasNativeViewCapture;
        case 'cdpScreencast': return options.hasCdpScreencast === true && options.hasFrameEncoder;
      }
    });

    return {
      browserRecordingEnabled: true,
      recordingCapabilities: {
        ...DEFAULT_BROWSER_RECORDING_CAPABILITIES,
        enabled: true,
        attachmentsEnabled: true,
        available: sources.length > 0,
        cursorOverlaySupported: startInput.captureKind === 'cdpScreencast' && sources.some(source => source.captureKind === 'cdpScreencast'),
        supportedCaptureKinds: sources.map((entry) => entry.captureKind),
        supportedMimeTypes: mergeUnique(...sources.map((entry) => entry.mimeTypes)),
        supportedAdapterKinds: mergeUnique(...sources.map((entry) => entry.adapterKinds)),
        supportedRetentionClasses: sources.length > 0 ? ['preSend', 'attached', 'clearOnClose', 'clearOnSend'] : [],
        disabledReasons: sources.length > 0 ? [] : ['Browser recording WebM encoder is unavailable.'],
      },
      ...(startInput.captureKind === 'nativeViewCapture' && options.hasNativeViewCapture
        ? { captureSourceAvailable: true }
        : {}),
    };
  };
}
