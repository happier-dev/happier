export { createDigitalOceanNativeClient, type DigitalOceanNativeClient } from './machine/nativeClient.js';
export { createDigitalOceanProvider } from './machine/provider.js';
export {
  bootstrapSshPublicKeySchema, dropletAcquireInputSchema, dropletLaunchSchema,
  dropletPowerIntentSchema, dropletResourceSchema,
  type DropletAcquireInputV1, type DropletLaunchV1, type DropletResourceV1,
} from './machine/schemas.js';
import { PLUGIN } from './manifest.js';
export { PLUGIN, MACHINE_PROVISIONER, PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest, ROLE_SCHEMAS, prepareStoredSchemas } from './manifest.js';
export const activate = PLUGIN.activate;
