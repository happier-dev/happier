/** @moduleRealm daemon */
export { createFreestyleNativeClient } from './machine/nativeClient.js';
export { FreestyleLaunchSchema, FreestyleResourceSchema, FreestyleOperationSchema } from './machine/schemas.js';
export type { FreestyleLaunch, FreestyleResource, FreestyleOperation } from './machine/schemas.js';
export { PLUGIN, PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest, MACHINE_PROVISIONER, ROLE_SCHEMAS, prepareStoredSchemas } from './manifest.js';
import { PLUGIN } from './manifest.js';
export const activate = PLUGIN.activate;
