import { PLUGIN } from './manifest.js';
export { PLUGIN, MACHINE_PROVISIONER, PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest, ROLE_SCHEMAS, prepareStoredSchemas } from './manifest.js';
export const activate = PLUGIN.activate;
export { createMaritimeNativeClient } from './machine/nativeClient.js';
