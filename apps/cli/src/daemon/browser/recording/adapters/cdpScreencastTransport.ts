import type { BrowserCdpScreencastProducer } from '../../capture/cdpScreencast';
import type { BrowserSidecarContextCaptureSurface } from '../../sidecar/controlAdapter';
import type { BrowserRecordingInputControlResolver } from '../service';
import type { BrowserRecordingCdpScreencastSession, BrowserRecordingCdpScreencastTransport } from './cdpScreencast';
import { startBrowserRecordingOverlay } from './overlay';

/** Owns recording-only rendering and overlay lifetime on the shared JPEG source. */
export function createBrowserRecordingCdpScreencastTransport(
  options: Readonly<{
    producer: BrowserCdpScreencastProducer;
    contextCapture: BrowserSidecarContextCaptureSurface;
    resolveInputControl?: BrowserRecordingInputControlResolver;
  }>,
): BrowserRecordingCdpScreencastTransport {
  return {
    async start(input) {
      const control = options.resolveInputControl?.(input.recording);
      const handle = options.contextCapture.resolvePageHandle(input.recording);
      if (!handle || !options.contextCapture.subscribeCdpEvents || control?.isObservationHeld()) return null;
      const overlay = await startBrowserRecordingOverlay({ contextCapture: options.contextCapture, handle,
        recordingId: input.recording.recordingId });
      let capture: BrowserRecordingCdpScreencastSession | null = null;
      let stopped: Promise<void> | undefined;
      const stop = () => stopped ??= (async () => {
        try {
          await capture?.stop();
        } finally {
          try {
            await options.contextCapture.transport.dispatchPageCommand({ ...handle,
              method: 'Emulation.setFocusEmulationEnabled', params: { enabled: false } });
          } finally {
            try {
              // Failed capture cleanup must still remove key listeners and navigation hooks.
              await overlay.stop();
            } finally {
              unregisterDrain?.();
            }
          }
        }
      })();
      const unregisterDrain = control?.registerConfidentialityDrain(stop);
      try {
        // Hidden Chromium tabs suspend animation. Keep this recording's target rendering
        // without activating it or taking the foreground from a popup or another tab.
        await options.contextCapture.transport.dispatchPageCommand({ ...handle,
          method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } });
        capture = await options.producer.start({
          view: input.recording, onFrame: input.onFrame,
          onError: error => { void stop().catch(input.onError ?? (() => {})); input.onError?.(error); },
        });
        if (!capture || control?.isObservationHeld()) { await stop(); return null; }
        return { stop };
      } catch (error) {
        await stop();
        throw error;
      }
    },
  };
}
