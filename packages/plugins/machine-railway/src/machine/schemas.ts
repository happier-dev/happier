import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
export const RailwayLaunchSchema = defineProtocolObject({ environmentId: text, checkpoint: text.optional() }, closed);
export const RailwayOptionsSchema = defineProtocolObject({ environmentId: text.optional() }, closed);
export const RailwayResourceSchema = defineProtocolObject({ sandboxId: text, environmentId: text, managedId: text }, closed);
export const RailwayOperationSchema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('acquire'), environmentId: text, managedId: text, sandboxId: text.optional() }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('delete'), resource: RailwayResourceSchema }, closed),
]);
export type RailwayLaunch = ProtocolSchemaOutput<typeof RailwayLaunchSchema>;
export type RailwayResource = ProtocolSchemaOutput<typeof RailwayResourceSchema>;
export type RailwayOperation = ProtocolSchemaOutput<typeof RailwayOperationSchema>;
export const CONTRIBUTION = { pluginId: 'happier.machine.railway', localId: 'railway' } as const;
export const BILLING = { location: 'cloud', stoppedBilling: 'unknown' } as const;
export const ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: RailwayLaunchSchema, resource: RailwayResourceSchema });
export const RECONCILIATION = defineMachineProvisionerReconciliationSchemas({ launch: RailwayLaunchSchema, resource: RailwayResourceSchema, nativeOperation: RailwayOperationSchema });
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas({ launch: RailwayLaunchSchema, resource: RailwayResourceSchema, nativeOperation: RailwayOperationSchema });
export const reference = <T>(value: T) => ({ contributionRef: CONTRIBUTION, schemaVersion: 1, value });
