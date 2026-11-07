/** @moduleRealm daemon */
export { createSuperserveNativeClient } from './machine/nativeClient.js';
export { SuperserveLaunchSchema, SuperserveResourceSchema, SuperserveOperationSchema } from './machine/schemas.js';
export type { SuperserveLaunch, SuperserveResource, SuperserveOperation } from './machine/schemas.js';
export { PLUGIN, PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest, MACHINE_PROVISIONER, ROLE_SCHEMAS, prepareStoredSchemas } from './manifest.js';
import { PLUGIN } from './manifest.js';
export const activate = PLUGIN.activate;
