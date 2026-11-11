import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '^[^\\u0000\\r\\n]+$' });
const path = defineProtocolString({ minLength: 1, pattern: '^[^\\u0000]+$' });
const inactiveOperand = defineProtocolString({ pattern: '^[^\\u0000]*$' });
const childPath = defineProtocolString({ pattern: '^/[^\\u0000]*$' });
export const DevcontainerRuntimeSchema = defineProtocolUnion([defineProtocolLiteral('docker'), defineProtocolLiteral('podman')]);
const setupScript = defineProtocolString({ pattern: '^[^\\u0000]*$' });
const imageConfiguration = defineProtocolObject({ kind: defineProtocolLiteral('image'), image: text, setupScript: setupScript.optional() }, closed);
const advancedConfiguration = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('file') }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('inline'), config: path }, closed),
]);
// Editors retain hidden operands when switching source kinds. Only the active
// operand is required; materialization retains the selected source alone.
export const DevcontainerReviewQuerySchema = defineProtocolUnion([
  defineProtocolObject({ runtime: DevcontainerRuntimeSchema.optional(), workspaceFolder: path, configPath: path,
    configuration: defineProtocolObject({ kind: defineProtocolLiteral('file'), image: inactiveOperand.optional(), config: inactiveOperand.optional(), setupScript: setupScript.optional() }, closed).optional() }, closed),
  defineProtocolObject({ runtime: DevcontainerRuntimeSchema.optional(), workspaceFolder: inactiveOperand.optional(), configPath: inactiveOperand.optional(),
    configuration: defineProtocolObject({ kind: defineProtocolLiteral('image'), image: text, setupScript: setupScript.optional(), config: inactiveOperand.optional() }, closed) }, closed),
  defineProtocolObject({ runtime: DevcontainerRuntimeSchema.optional(), workspaceFolder: path, configPath: inactiveOperand.optional(),
    configuration: defineProtocolObject({ kind: defineProtocolLiteral('inline'), config: path, image: inactiveOperand.optional(), setupScript: setupScript.optional() }, closed) }, closed),
]);
const reviewedEffectDigest = defineProtocolString({ pattern: '^[a-f0-9]{64}$' });
const launchFields = { runtime: DevcontainerRuntimeSchema.optional(), reviewedEffectDigest };
const advancedFields = { ...launchFields, workspaceFolder: path, configPath: path, configuration: advancedConfiguration.optional() };
const imageFields = { ...launchFields, workspaceFolder: path.optional(), configPath: path.optional(), configuration: imageConfiguration };
// Native executable facts belong to retained resources and reconciliation.
// Presets and acquire launch operands use DevcontainerReviewQuerySchema.
export const DevcontainerLaunchSchema = defineProtocolUnion([
  defineProtocolObject(advancedFields, closed), defineProtocolObject(imageFields, closed),
]);
export const DevcontainerStorageSchema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('bind'), hostPath: path, childPath }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('child'), childPath }, closed),
]);
const resourceFields = {
  managedMachineId: text,
  containerId: defineProtocolString({ pattern: '^[a-f0-9]{64}$' }),
  user: text, workspaceRoot: childPath, storage: DevcontainerStorageSchema,
  volumes: defineProtocolArray(defineProtocolObject({ name: text, childPath }, closed)),
};
export const DevcontainerResourceSchema = defineProtocolUnion([
  defineProtocolObject({ ...advancedFields, ...resourceFields }, closed),
  defineProtocolObject({ ...imageFields, ...resourceFields }, closed),
]);
export const DevcontainerNativeOperationSchema = defineProtocolUnion([
  DevcontainerResourceSchema,
  defineProtocolObject({ managedMachineId: text, launch: DevcontainerLaunchSchema,
    nativeResourceId: defineProtocolString({ pattern: '^[a-f0-9]{64}$' }).optional() }, closed),
]);
export type DevcontainerLaunch = ProtocolSchemaOutput<typeof DevcontainerLaunchSchema>;
export type DevcontainerReviewQuery = ProtocolSchemaOutput<typeof DevcontainerReviewQuerySchema>;
export type DevcontainerResource = ProtocolSchemaOutput<typeof DevcontainerResourceSchema>;
export type DevcontainerNativeOperation = ProtocolSchemaOutput<typeof DevcontainerNativeOperationSchema>;
