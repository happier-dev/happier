import { z } from 'zod';

/**
 * The finite placement vocabulary carried in a host-API surface context.
 *
 * This deliberately has no registry dependency. Host request envelopes import
 * it during module initialization, while mounted destinations receive one of
 * these coarse contexts from the direct container/target registry. The two
 * semantic contexts remain owned by their contribution families; no legacy
 * surface-id parser participates in either path.
 */
export const PluginUiSurfacePlacementV1Schema = z.enum([
  'structuredMessage',
  'sessionPane',
  'sessionHeaderAction',
  'projectSurface',
  'appSurface',
  'browserSurface',
  'rightSidebarSurface',
  'servicesSurface',
  'composerSurface',
  'unknown',
]);
export type PluginUiSurfacePlacementV1 = z.infer<typeof PluginUiSurfacePlacementV1Schema>;
