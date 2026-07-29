import type { BrowserSidecarContextCaptureSurface } from '../../sidecar/controlAdapter';

import type {
  BrowserRecordingCdpScreencastSession,
  BrowserRecordingCdpScreencastTransport,
} from './cdpScreencast';

export type BrowserRecordingCdpScreencastTransportOptions = Readonly<{
  contextCapture: BrowserSidecarContextCaptureSurface;
  nowMs?: () => number;
}>;

function readScreencastFrame(input: unknown): Readonly<{
  sessionId: number;
  dataBase64: string;
}> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const params = input as Record<string, unknown>;
  const sessionId = params.sessionId;
  const data = params.data;
  if (typeof sessionId !== 'number' || !Number.isInteger(sessionId)) return null;
  if (typeof data !== 'string' || data.length === 0) return null;
  return { sessionId, dataBase64: data };
}

/**
 * Bridges the managed-Chromium sidecar context-capture surface into the recording producer seam.
 * This keeps `cdpScreencast` on the same route/service/adapter path as stream-frame and native
 * recording; the only sidecar-specific work here is view-handle resolution plus CDP commands.
 */
export function createBrowserRecordingCdpScreencastTransport(
  options: BrowserRecordingCdpScreencastTransportOptions,
): BrowserRecordingCdpScreencastTransport {
  const nowMs = options.nowMs ?? (() => Date.now());

  return {
    async start(input) {
      const handle = options.contextCapture.resolvePageHandle({
        browserSessionId: input.recording.browserSessionId,
        viewId: input.recording.viewId,
      });
      const subscribeCdpEvents = options.contextCapture.subscribeCdpEvents;
      if (!handle || !subscribeCdpEvents) return null;

      let closed = false;
      const unsubscribe = subscribeCdpEvents((notification) => {
        if (closed) return;
        if (notification.method !== 'Page.screencastFrame') return;
        if (handle.sessionId && notification.sessionId !== handle.sessionId) return;

        const frame = readScreencastFrame(notification.params);
        if (!frame) return;

        input.onFrame({
          sessionId: frame.sessionId,
          dataBase64: frame.dataBase64,
          timestampMs: nowMs(),
        });
      });

      const dispatchPageCommand = options.contextCapture.transport.dispatchPageCommand;

      try {
        await dispatchPageCommand({
          ...handle,
          method: 'Page.startScreencast',
          params: { format: 'jpeg' },
        });
      } catch (error) {
        closed = true;
        unsubscribe();
        input.onError?.(error);
        return null;
      }

      const session: BrowserRecordingCdpScreencastSession = {
        ackFrame(sessionId) {
          dispatchPageCommand({
            ...handle,
            method: 'Page.screencastFrameAck',
            params: { sessionId },
          }).catch((error: unknown) => {
            input.onError?.(error);
          });
        },
        async stop() {
          if (closed) return;
          closed = true;
          try {
            await dispatchPageCommand({
              ...handle,
              method: 'Page.stopScreencast',
            });
          } finally {
            unsubscribe();
          }
        },
      };

      return session;
    },
  };
}
