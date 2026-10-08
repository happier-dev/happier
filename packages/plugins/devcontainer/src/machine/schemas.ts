import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '^[^\\u0000\\r\\n]+$' });
const path = defineProtocolString({ minLength: 1, pattern: '^[^\\u0000]+$' });
const childPath = defineProtocolString({ pattern: '^/[^\\u0000]*$' });
export const DevcontainerReviewQuerySchema = defineProtocolObject({
  workspaceFolder: path, configPath: path,
}, closed);
const reviewedEffectDigest = defineProtocolString({ pattern: '^[a-f0-9]{64}$' });
export const DevcontainerLaunchSchema = defineProtocolObject({
  workspaceFolder: path, configPath: path, reviewedEffectDigest,
}, closed);
export const DevcontainerStorageSchema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('bind'), hostPath: path, childPath }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('child'), childPath }, closed),
]);
export const DevcontainerResourceSchema = defineProtocolObject({
  workspaceFolder: path, configPath: path, reviewedEffectDigest,
  managedMachineId: text,
  containerId: defineProtocolString({ pattern: '^[a-f0-9]{64}$' }),
  user: text, workspaceRoot: childPath, storage: DevcontainerStorageSchema,
  volumes: defineProtocolArray(defineProtocolObject({ name: text, childPath }, closed)),
}, closed);
export const DevcontainerNativeOperationSchema = defineProtocolUnion([
  DevcontainerResourceSchema,
  defineProtocolObject({ managedMachineId: text, launch: DevcontainerLaunchSchema,
    nativeResourceId: defineProtocolString({ pattern: '^[a-f0-9]{64}$' }).optional() }, closed),
]);
export type DevcontainerLaunch = ProtocolSchemaOutput<typeof DevcontainerLaunchSchema>;
export type DevcontainerReviewQuery = ProtocolSchemaOutput<typeof DevcontainerReviewQuerySchema>;
export type DevcontainerResource = ProtocolSchemaOutput<typeof DevcontainerResourceSchema>;
export type DevcontainerNativeOperation = ProtocolSchemaOutput<typeof DevcontainerNativeOperationSchema>;
