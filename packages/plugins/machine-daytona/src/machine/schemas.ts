import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
export const DaytonaLaunchSchema = defineProtocolObject({ snapshot: text }, closed);
export const DaytonaOptionsSchema = defineProtocolObject({ snapshot: text.optional() }, closed);
export const DaytonaResourceSchema = defineProtocolObject({ sandboxId: text, name: text, managedId: text, organizationId: text, toolboxProxyUrl: text }, closed);
export const DaytonaOperationSchema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('acquire'), name: text, managedId: text }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('delete'), resource: DaytonaResourceSchema }, closed),
]);
export type DaytonaLaunch = ProtocolSchemaOutput<typeof DaytonaLaunchSchema>;
export type DaytonaResource = ProtocolSchemaOutput<typeof DaytonaResourceSchema>;
export type DaytonaOperation = ProtocolSchemaOutput<typeof DaytonaOperationSchema>;
export const CONTRIBUTION = { pluginId: 'happier.machine.daytona', localId: 'daytona' } as const;
export const BILLING = { location: 'cloud', stoppedBilling: 'not-billed' } as const;
export const ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: DaytonaLaunchSchema, resource: DaytonaResourceSchema });
export const RECONCILIATION = defineMachineProvisionerReconciliationSchemas({ launch: DaytonaLaunchSchema, resource: DaytonaResourceSchema, nativeOperation: DaytonaOperationSchema });
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas({ launch: DaytonaLaunchSchema, resource: DaytonaResourceSchema, nativeOperation: DaytonaOperationSchema });
export const reference = <T>(value: T) => ({ contributionRef: CONTRIBUTION, schemaVersion: 1, value });
