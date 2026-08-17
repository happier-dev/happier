import { z } from 'zod';

import { PluginOptionalStringSchema } from '../_shared.js';
import { PluginPermissionCapabilityV1Schema } from './capabilityV1.js';

export {
  PLUGIN_ENFORCED_PERMISSION_CAPABILITIES_V1,
  PluginPermissionCapabilityV1Schema,
  type PluginPermissionCapabilityV1,
} from './capabilityV1.js';

export const PLUGIN_DECLARED_CAPABILITIES_V1 = [
  'actions.execute',
  'ui.descriptors',
  'secrets.read',
  'secrets.write',
  'storage.account',
  'reload',
] as const;

export const PLUGIN_EXPERIMENTAL_UNIMPLEMENTED_CAPABILITIES_V1 = [
  'agent.request.mutate',
] as const;

// These ids gated registering a manifest-declared contribution behind a SECOND
// permission grant on top of the manifest's own `contributes` declaration and
// the `uses` runtime-capability family check. The manifest declaration is
// already the authority for a plugin's own contributions; a redundant
// `*.register` permission was pure ceremony (it broke the scaffold golden
// path) and added no security value the `uses` family check doesn't already
// provide. De-scoped in the same wave `resources.register` was de-scoped.
export const PLUGIN_DE_SCOPED_CAPABILITIES_V1 = [
  'actions.register',
  'tools.register',
  'commands.register',
  'notifications.register',
  'hooks.register',
  'resources.register',
] as const;

export const PluginDeclaredCapabilityV1Schema = z.enum(PLUGIN_DECLARED_CAPABILITIES_V1);
export type PluginDeclaredCapabilityV1 = z.infer<typeof PluginDeclaredCapabilityV1Schema>;

export const PluginPermissionDeclarationV1Schema = z.object({
  capability: PluginPermissionCapabilityV1Schema,
  reason: PluginOptionalStringSchema,
  scope: PluginOptionalStringSchema,
}).strict();
export type PluginPermissionDeclarationV1 = z.infer<typeof PluginPermissionDeclarationV1Schema>;

export const PluginCapabilityDeclarationV1Schema = z.object({
  capability: PluginDeclaredCapabilityV1Schema,
  reason: PluginOptionalStringSchema,
  scope: PluginOptionalStringSchema,
}).strict();
export type PluginCapabilityDeclarationV1 = z.infer<typeof PluginCapabilityDeclarationV1Schema>;

export * from './grants.js';
export * from './actions.js';
