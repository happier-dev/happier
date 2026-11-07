import * as React from 'react';
import type { PluginUiContextEnrichmentV1, PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

/** Replace the mounted surface's host slot on commit; clear that same slot on retirement. */
export function useTriageCurrentUiContextPublication(
  hostApi: Pick<PluginUiHostApi, 'publishCurrentUiContext'>,
  currentUiContext: PluginUiContextEnrichmentV1,
  publication?: Readonly<{
    subscribe: (listener: () => void) => () => void;
    read: () => PluginUiContextEnrichmentV1;
  }>,
): void {
  React.useLayoutEffect(() => {
    const publish = () => hostApi.publishCurrentUiContext(publication?.read() ?? currentUiContext);
    publish();
    return publication?.subscribe(publish);
  }, [currentUiContext, hostApi, publication]);
  React.useLayoutEffect(() => () => {
    hostApi.publishCurrentUiContext(null);
  }, [hostApi]);
}
