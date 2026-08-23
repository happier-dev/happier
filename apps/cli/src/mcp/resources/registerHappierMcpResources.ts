import type { ActionId, ActionSurfaces } from '@happier-dev/protocol';
import { listActionSpecsForCatalogSurface, serializeActionSpec } from '@happier-dev/protocol';

export const HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI = 'happier://action-specs/catalog';

type ResourceRegistrar = Readonly<{
  registerResource: (
    name: string,
    uri: string,
    config: Readonly<{
      title: string;
      description: string;
      mimeType: string;
    }>,
    readCallback: () => Promise<{
      contents: Array<{
        uri: string;
        mimeType: string;
        text: string;
      }>;
    }>,
  ) => void;
}>;

export function registerHappierMcpResources(
  server: ResourceRegistrar,
  opts?: Readonly<{
    surface?: keyof ActionSurfaces;
    isActionEnabled?: (id: ActionId) => boolean;
  }>,
): void {
  // B8 closure note:
  // Resource publication is derived from first-party action specs.
  // Plugin-contributed MCP resource catalogs remain intentionally deferred for this wave.
  const isActionEnabled = opts?.isActionEnabled ?? ((_id: ActionId) => true);
  const surface = opts?.surface ?? 'agent';

  server.registerResource(
    'happier_action_specs',
    HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI,
    {
      title: 'Happier Action Specs',
      description: 'JSON catalog of enabled Happier action specs available through the Happier MCP surface.',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        {
          uri: HAPPIER_MCP_ACTION_SPECS_RESOURCE_URI,
          mimeType: 'application/json',
          text: JSON.stringify({
            actionSpecs: listActionSpecsForCatalogSurface({
              surface,
              isActionEnabled,
            })
              .map((spec) => serializeActionSpec(spec)),
          }),
        },
      ],
    }),
  );
}
