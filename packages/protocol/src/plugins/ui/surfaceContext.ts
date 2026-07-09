import { z } from 'zod';

import { PLUGIN_SURFACE_REGISTRY } from '../contributions/ui/surfaceRegistry.js';
import { PluginUiChannelV1Schema, PluginUiPlatformV1Schema } from '../contributions/ui/compatibility.js';
import { PluginSessionResourceTargetV1Schema } from '../contributions/ui/resources.js';

export const PluginUiSurfacePlacementV1Schema = z.enum([
  'structuredMessage',
  'sessionPane',
  'sessionHeaderAction',
  'workspaceSurface',
  'projectSurface',
  'appSurface',
  'browserSurface',
  'rightSidebarSurface',
  'servicesSurface',
  'unknown',
]);
export type PluginUiSurfacePlacementV1 = z.infer<typeof PluginUiSurfacePlacementV1Schema>;

export const PluginUiSurfaceContextV1Schema = z.object({
  pluginId: z.string().trim().min(1),
  contributionId: z.string().trim().min(1),
  surfaceId: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).optional(),
  placement: PluginUiSurfacePlacementV1Schema.default('unknown'),
  platform: PluginUiPlatformV1Schema,
  channel: PluginUiChannelV1Schema,
  resourceScope: z.array(PluginSessionResourceTargetV1Schema).default([]),
  diagnostics: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type PluginUiSurfaceContextV1 = z.infer<typeof PluginUiSurfaceContextV1Schema>;

export function resolvePluginUiSurfaceContextPlacement(
  surfaceId: string,
): PluginUiSurfacePlacementV1 {
  const descriptor = PLUGIN_SURFACE_REGISTRY.get(surfaceId.trim());
  if (!descriptor) return 'unknown';

  if (descriptor.category === 'message') return 'structuredMessage';
  if (descriptor.category === 'action') return 'sessionHeaderAction';
  if (descriptor.anchor.container === 'rightSidebar') return 'rightSidebarSurface';

  switch (descriptor.scope) {
    case 'session':
      return 'sessionPane';
    case 'workspace':
      return 'workspaceSurface';
    case 'project':
      return 'projectSurface';
    case 'app':
      return 'appSurface';
    case 'browser':
      return 'browserSurface';
    case 'services':
      return 'servicesSurface';
    default:
      return 'unknown';
  }
}
