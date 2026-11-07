/** @moduleRealm daemon */
export { createDaytonaNativeClient } from './machine/nativeClient.js';
export { DaytonaLaunchSchema, DaytonaResourceSchema, DaytonaOperationSchema } from './machine/schemas.js';
export type { DaytonaLaunch, DaytonaResource, DaytonaOperation } from './machine/schemas.js';
export { PLUGIN, PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest, MACHINE_PROVISIONER, ROLE_SCHEMAS, prepareStoredSchemas } from './manifest.js';
import { PLUGIN } from './manifest.js';
export const activate = PLUGIN.activate;
