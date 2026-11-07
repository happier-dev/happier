import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
export const FreestyleLaunchSchema = defineProtocolObject({ snapshotId: text }, closed);
export const FreestyleOptionsSchema = defineProtocolObject({ snapshotId: text.optional() }, closed);
export const FreestyleResourceSchema = defineProtocolObject({ vmId: text, name: text, managedId: text }, closed);
export const FreestyleOperationSchema = defineProtocolObject({ kind: defineProtocolLiteral('acquire'), name: text, managedId: text }, closed);
export type FreestyleLaunch = ProtocolSchemaOutput<typeof FreestyleLaunchSchema>;
export type FreestyleResource = ProtocolSchemaOutput<typeof FreestyleResourceSchema>;
export type FreestyleOperation = ProtocolSchemaOutput<typeof FreestyleOperationSchema>;
export const CONTRIBUTION = { pluginId: 'happier.machine.freestyle', localId: 'freestyle' } as const;
export const BILLING = { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [{
  label: 'Retained storage while paused', amount: '0.000086', currency: 'USD', unit: 'GiB-hour',
  source: 'https://www.freestyle.sh/docs/vms/pricing-and-limits', observedAt: Date.UTC(2026, 10, 5),
}] } as const;
export const ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: FreestyleLaunchSchema, resource: FreestyleResourceSchema });
export const RECONCILIATION = defineMachineProvisionerReconciliationSchemas({ launch: FreestyleLaunchSchema, resource: FreestyleResourceSchema, nativeOperation: FreestyleOperationSchema });
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas({ launch: FreestyleLaunchSchema, resource: FreestyleResourceSchema, nativeOperation: FreestyleOperationSchema });
export const reference = <T>(value: T) => ({ contributionRef: CONTRIBUTION, schemaVersion: 1, value });
