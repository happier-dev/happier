export { createFlyNativeClient } from './machine/nativeClient.js';
export type { FlyAcquireResult, FlyCleanup, FlyExecResult, FlyInspection, FlyOptionsInput, FlyOptionsResult } from './machine/nativeClient.js';
export { FlyAcquireOperationV1Schema, FlyAcquireRequestSchema, FlyExecRequestSchema, FlyGuestBootSchema, FlyLaunchV1Schema, FlyPutFileRequestSchema, FlyResourceV1Schema } from './machine/schemas.js';
export type { FlyAcquireOperationV1, FlyAcquireRequest, FlyExecRequest, FlyGuestBoot, FlyLaunchV1, FlyPutFileRequest, FlyResourceV1 } from './machine/schemas.js';
import { PLUGIN } from './manifest.js';
export { PLUGIN, MACHINE_PROVISIONER, PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest, ROLE_SCHEMAS, prepareStoredSchemas } from './manifest.js';
export const activate = PLUGIN.activate;
