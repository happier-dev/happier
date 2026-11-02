import { uiSurfaceNetworkAccessWidensV1, type UiSurfaceNetworkRequestV1 } from '../../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { readWidgetDefinitionNetworkOverrideV1 } from '../../widgets/widgetDefinitionV1.js';
import type { WidgetInstanceV1 } from '../../widgets/widgetInstanceV1.js';
import type { ActionExecutorDeps } from './types.js';

/** Consequence facts only; the common Action policy still owns Ask and waivers. */
export async function readWidgetNetworkSafetyV1(args: Readonly<{
  network: UiSurfaceNetworkRequestV1;
  instance: WidgetInstanceV1 | undefined;
  definitions: ActionExecutorDeps['widgetDefinitionArtifacts'];
  signal?: AbortSignal;
}>): Promise<'safe' | 'danger'> {
  const { network, instance } = args;
  if (!instance) return 'danger';
  if (!uiSurfaceNetworkAccessWidensV1(network, { network: 'none' })) return 'safe';
  let previous = instance.networkOverride;
  // No instance override means the renderer consumes its saved definition's
  // policy first. Read that owner only when this change permits network.
  if (previous === undefined && instance.definition.kind === 'inline') {
    previous = readWidgetDefinitionNetworkOverrideV1(instance.definition.definition);
  } else if (previous === undefined && instance.definition.kind === 'artifact') {
    try {
      const definition = await args.definitions?.get(instance.definition.artifactId, args.signal);
      if (!definition) return 'danger';
      previous = readWidgetDefinitionNetworkOverrideV1(definition);
    } catch { return 'danger'; }
  }
  // With neither saved override the renderer's declaration is the ceiling;
  // an explicit restriction only narrows it. An unreadable definition keeps Ask.
  return uiSurfaceNetworkAccessWidensV1(network, previous ?? { network: 'open' }) ? 'danger' : 'safe';
}
