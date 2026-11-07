/** @moduleRealm daemon */
export { createBoatNativeClient } from './machine/nativeClient.js';
export type { BoatAcquireResult, BoatNativeClientOptions, BoatOptions, BoatSize } from './machine/nativeClient.js';
export { BoatAcquireOperationV1Schema, BoatDeleteOperationV1Schema, BoatLaunchV1Schema, BoatNativeOperationV1Schema, BoatResourceV1Schema } from './machine/schemas.js';
export type { BoatAcquireOperationV1, BoatDeleteOperationV1, BoatLaunchV1, BoatNativeOperationV1, BoatResourceV1 } from './machine/schemas.js';
import { resolveMachineProvisionerSshBootstrap } from '@happier-dev/plugin-sdk/machine-provisioners/ssh';
import { createBoatPlugin } from './manifest.js';
export { MACHINE_PROVISIONER, PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest, ROLE_SCHEMAS, prepareStoredSchemas } from './manifest.js';
export const PLUGIN = createBoatPlugin(resolveMachineProvisionerSshBootstrap);
export const activate = PLUGIN.activate;
