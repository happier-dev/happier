/** @moduleRealm daemon */
export { createUpstashBoxNativeClient } from './machine/nativeClient.js';
export { UpstashBoxLaunchSchema, UpstashBoxResourceSchema, UpstashBoxOperationSchema } from './machine/schemas.js';
export type { UpstashBoxLaunch, UpstashBoxResource, UpstashBoxOperation } from './machine/schemas.js';
export { PLUGIN, PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest, MACHINE_PROVISIONER, ROLE_SCHEMAS, prepareStoredSchemas } from './manifest.js';
import { PLUGIN } from './manifest.js';
export const activate = PLUGIN.activate;
