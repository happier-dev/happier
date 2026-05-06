import { z } from 'zod';

import { PluginOptionalStringSchema } from '../_shared.js';

export const PluginPermissionCapabilityV1Schema = z.enum([
  'filesystem.read',
  'filesystem.write',
  'env',
  'network',
  'process.spawn',
  'agent.request.mutate',
  'actions.register',
  'actions.execute',
  'tools.register',
  'commands.register',
  'resources.register',
  'ui.descriptors',
  'notifications.register',
  'hooks.register',
  'events.subscribe',
  'runtime.subscribe',
  'lifecycle.subscribe',
  'session.subscribe',
  'reload',
]);
export type PluginPermissionCapabilityV1 = z.infer<typeof PluginPermissionCapabilityV1Schema>;

export const PluginPermissionDeclarationV1Schema = z.object({
  capability: PluginPermissionCapabilityV1Schema,
  reason: PluginOptionalStringSchema,
  scope: PluginOptionalStringSchema,
}).strict();
export type PluginPermissionDeclarationV1 = z.infer<typeof PluginPermissionDeclarationV1Schema>;
