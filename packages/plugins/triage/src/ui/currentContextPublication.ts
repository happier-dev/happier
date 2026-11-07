import * as React from 'react';
import type { PluginUiContextEnrichmentV1, PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

/** Publish only when this mount supplies a host slot; clear that same slot on retirement. */
export function useTriageCurrentUiContextPublication(
  hostApi: Pick<PluginUiHostApi, 'publishCurrentUiContext' | 'version'>,
  currentUiContext: PluginUiContextEnrichmentV1,
  publication?: Readonly<{
    subscribe: (listener: () => void) => () => void;
    read: () => PluginUiContextEnrichmentV1;
  }>,
): void {
  const publish = React.useCallback((enrichment: PluginUiContextEnrichmentV1 | null) => {
    // Ephemeral input hosts can settle a picker without providing a current-UI publisher.
    if (hostApi.version().methods.includes('publishCurrentUiContext')) hostApi.publishCurrentUiContext(enrichment);
  }, [hostApi]);
  React.useLayoutEffect(() => {
    const publishCurrent = () => publish(publication?.read() ?? currentUiContext);
    publishCurrent();
    return publication?.subscribe(publishCurrent);
  }, [currentUiContext, publish, publication]);
  React.useLayoutEffect(() => () => {
    publish(null);
  }, [publish]);
}
