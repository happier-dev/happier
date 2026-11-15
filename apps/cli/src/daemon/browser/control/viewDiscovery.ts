import type { BrowserDaemonViewV1 } from '@happier-dev/protocol/browser/control/v1';
import type { BrowserCommandScope, BrowserDaemonControlBroker, BrowserDaemonViewWatch } from './types';
import type { MachineLiveStreamCaptureRegistry } from '../../peer/mediation/stream/captureRegistry';

/** Both one-shot and parked discovery use the capture owner's current readiness. */
export function projectBrowserDaemonViews(views: readonly BrowserDaemonViewV1[], captureRegistry?: Pick<MachineLiveStreamCaptureRegistry, 'resolve'>) {
  return views.map(view => {
    const source = captureRegistry?.resolve({ sourceId: view.sourceId, streamFamily: 'browser.streamed' });
    return { ...view, ...(source?.ok ? { captureSource: source.source.capabilities } : {}) };
  });
}

/** Read projections stay with the broker; observing an empty browser never starts Chromium. */
export function createBrowserDaemonViewDiscovery(input: Readonly<{
  broker: Pick<BrowserDaemonControlBroker, 'listViews' | 'watchViews'>;
  captureRegistry?: Pick<MachineLiveStreamCaptureRegistry, 'resolve'>;
}>) {
  const listViews = (browserSessionId: string, scope?: BrowserCommandScope) => projectBrowserDaemonViews(input.broker.listViews(browserSessionId, scope), input.captureRegistry);
  return {
    listViews,
    async watchViews(request: BrowserDaemonViewWatch) {
      await input.broker.watchViews(request);
      request.signal?.throwIfAborted();
      return listViews(request.browserSessionId, request.scope);
    },
  };
}

export type BrowserDaemonViewDiscovery = ReturnType<typeof createBrowserDaemonViewDiscovery>;
