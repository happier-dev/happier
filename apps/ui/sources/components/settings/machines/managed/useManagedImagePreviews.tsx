import * as React from 'react';
import { Image } from 'react-native';
import {
  materializeHappierRenderableImage,
  type HappierRenderableImageSource,
} from '@happier-dev/plugin-ui/advanced';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contributionIdentity';

import { createPluginContextualResourceReadClient } from '@/components/plugins/surfaces/pluginSurfaceResourceRead';

export type ManagedImagePreviewRequest = Readonly<{
  imageId: string;
  /** The provisioner's packaged image/png Resource (plan 51 §7 safe declarative preview). */
  resource: PluginContributionIdentityV1;
}>;

/**
 * The packaged previews a provisioner declares for its images, read once from the controller that
 * returned them through the existing plugin Resource transport and admitted by the shared renderable
 * image owner. A preview that cannot be read or admitted is simply absent: the tile keeps its name and
 * description, and nothing is drawn in its place.
 */
export function useManagedImagePreviews(
  input: Readonly<{
    serverId: string;
    controllerMachineId: string | null;
    pluginId: string;
    occurrenceId: string;
    requests: readonly ManagedImagePreviewRequest[];
  }>,
): ReadonlyMap<string, HappierRenderableImageSource> {
  const [sources, setSources] =
    React.useState<ReadonlyMap<string, HappierRenderableImageSource>>(EMPTY);
  const key = JSON.stringify([
    input.serverId,
    input.controllerMachineId,
    input.pluginId,
    input.occurrenceId,
    input.requests.map((request) => [
      request.imageId,
      request.resource.pluginId,
      request.resource.localId,
    ]),
  ]);
  const requestsRef = React.useRef(input.requests);
  requestsRef.current = input.requests;
  React.useEffect(() => {
    setSources(EMPTY);
    const machineId = input.controllerMachineId;
    const requests = requestsRef.current;
    if (!machineId || requests.length === 0) return;
    const abort = new AbortController();
    const client = createPluginContextualResourceReadClient({
      pluginId: input.pluginId,
      resource: {
        machineId,
        serverId: input.serverId,
        expectedCallerOccurrenceId: input.occurrenceId,
      },
      isCurrent: () => !abort.signal.aborted,
    });
    for (const request of requests) {
      void client
        .readResource(request.resource, { signal: abort.signal })
        .then((read) => {
          if (abort.signal.aborted || read.contentType !== 'image/png') return;
          const admission = materializeHappierRenderableImage(read.bytes);
          if (!admission.admitted) return;
          setSources((current) =>
            new Map(current).set(request.imageId, admission.source),
          );
        })
        .catch(() => {
          /* An unreadable preview leaves the tile's name and description. */
        });
    }
    return () => abort.abort();
  }, [key]);
  return sources;
}

const EMPTY: ReadonlyMap<string, HappierRenderableImageSource> = new Map();

/** The admitted preview filling a visual tile's frame. */
export function ManagedImagePreview(
  props: Readonly<{
    source: HappierRenderableImageSource;
    accessibilityLabel?: string;
  }>,
) {
  return (
    <Image
      source={props.source}
      resizeMode="cover"
      accessible={Boolean(props.accessibilityLabel)}
      accessibilityLabel={props.accessibilityLabel}
      style={PREVIEW_FILL}
    />
  );
}

const PREVIEW_FILL = { width: '100%', height: '100%' } as const;
