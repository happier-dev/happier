/** @moduleRealm daemon */
export { createRailwayNativeClient } from './machine/nativeClient.js';
export { RailwayLaunchSchema, RailwayResourceSchema, RailwayOperationSchema } from './machine/schemas.js';
export type { RailwayLaunch, RailwayResource, RailwayOperation } from './machine/schemas.js';
export { PLUGIN, PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest, MACHINE_PROVISIONER, ROLE_SCHEMAS, prepareStoredSchemas } from './manifest.js';
import { PLUGIN } from './manifest.js';
export const activate = PLUGIN.activate;
