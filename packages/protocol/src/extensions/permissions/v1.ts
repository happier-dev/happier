import { z } from 'zod';

import { OptionalStringSchema } from '../_shared.js';

export const ExtensionPermissionCapabilityV1Schema = z.enum([
  'filesystem.read',
  'filesystem.write',
  'network',
  'process.spawn',
  'provider.request.mutate',
  'actions.register',
  'actions.execute',
  'tools.register',
  'commands.register',
  'resources.register',
  'ui.descriptors',
  'hooks.register',
  'reload',
]);
export type ExtensionPermissionCapabilityV1 = z.infer<typeof ExtensionPermissionCapabilityV1Schema>;

export const ExtensionPermissionDeclarationV1Schema = z.object({
  capability: ExtensionPermissionCapabilityV1Schema,
  reason: OptionalStringSchema,
  scope: OptionalStringSchema,
}).strict();
export type ExtensionPermissionDeclarationV1 = z.infer<typeof ExtensionPermissionDeclarationV1Schema>;
