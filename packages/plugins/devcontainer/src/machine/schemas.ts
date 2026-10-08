import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import type { ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '^[^\\u0000\\r\\n]+$' });
const path = defineProtocolString({ minLength: 1, pattern: '^[^\\u0000]+$' });
const childPath = defineProtocolString({ pattern: '^/[^\\u0000]*$' });
export const DevcontainerLaunchSchema = defineProtocolObject({
  workspaceFolder: path, configPath: path,
}, closed);
export const DevcontainerStorageSchema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('bind'), hostPath: path, childPath }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('child'), childPath }, closed),
]);
export const DevcontainerResourceSchema = defineProtocolObject({
  workspaceFolder: path, configPath: path,
  containerId: defineProtocolString({ pattern: '^[a-f0-9]{64}$' }),
  user: text, workspaceRoot: childPath, storage: DevcontainerStorageSchema,
  volumes: defineProtocolArray(defineProtocolObject({ name: text, childPath }, closed)),
}, closed);
export type DevcontainerLaunch = ProtocolSchemaOutput<typeof DevcontainerLaunchSchema>;
export type DevcontainerResource = ProtocolSchemaOutput<typeof DevcontainerResourceSchema>;
