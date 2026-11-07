import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
export const SuperserveLaunchSchema = defineProtocolObject({ template: text }, closed);
export const SuperserveOptionsSchema = defineProtocolObject({ template: text.optional() }, closed);
export const SuperserveResourceSchema = defineProtocolObject({ sandboxId: text, name: text, managedId: text }, closed);
export const SuperserveOperationSchema = defineProtocolObject({ kind: defineProtocolLiteral('acquire'), name: text, managedId: text }, closed);
export type SuperserveLaunch = ProtocolSchemaOutput<typeof SuperserveLaunchSchema>;
export type SuperserveResource = ProtocolSchemaOutput<typeof SuperserveResourceSchema>;
export type SuperserveOperation = ProtocolSchemaOutput<typeof SuperserveOperationSchema>;
export const CONTRIBUTION = { pluginId: 'happier.machine.superserve', localId: 'superserve' } as const;
export const BILLING = { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [{
  label: 'Retained shared template and sandbox changes', amount: '0.000108', currency: 'USD', unit: 'GiB-hour',
  source: 'https://www.superserve.ai/pricing/', observedAt: Date.UTC(2026, 10, 5),
}] } as const;
export const ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: SuperserveLaunchSchema, resource: SuperserveResourceSchema });
export const RECONCILIATION = defineMachineProvisionerReconciliationSchemas({ launch: SuperserveLaunchSchema, resource: SuperserveResourceSchema, nativeOperation: SuperserveOperationSchema });
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas({ launch: SuperserveLaunchSchema, resource: SuperserveResourceSchema, nativeOperation: SuperserveOperationSchema });
export const reference = <T>(value: T) => ({ contributionRef: CONTRIBUTION, schemaVersion: 1, value });
