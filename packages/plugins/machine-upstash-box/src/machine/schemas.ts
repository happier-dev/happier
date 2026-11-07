import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
export const UpstashBoxLaunchSchema = defineProtocolObject({ runtime: defineProtocolLiteral('node'), size: defineProtocolUnion([defineProtocolLiteral('small'), defineProtocolLiteral('medium'), defineProtocolLiteral('large')]) }, closed);
export const UpstashBoxOptionsSchema = defineProtocolObject({}, closed);
export const UpstashBoxResourceSchema = defineProtocolObject({ boxId: text, name: text, managedId: text }, closed);
export const UpstashBoxOperationSchema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('acquire'), name: text, managedId: text }, closed),
  defineProtocolObject({ kind: defineProtocolLiteral('delete'), resource: UpstashBoxResourceSchema }, closed),
]);
export type UpstashBoxLaunch = ProtocolSchemaOutput<typeof UpstashBoxLaunchSchema>;
export type UpstashBoxResource = ProtocolSchemaOutput<typeof UpstashBoxResourceSchema>;
export type UpstashBoxOperation = ProtocolSchemaOutput<typeof UpstashBoxOperationSchema>;
export const CONTRIBUTION = { pluginId: 'happier.machine.upstash-box', localId: 'upstash-box' } as const;
export const BILLING = { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [{
  label: 'Retained storage, including snapshots', amount: '0.10', currency: 'USD', unit: 'GB-month',
  source: 'https://upstash.com/pricing/box', observedAt: Date.UTC(2026, 10, 5),
}] } as const;
export const ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: UpstashBoxLaunchSchema, resource: UpstashBoxResourceSchema });
export const RECONCILIATION = defineMachineProvisionerReconciliationSchemas({ launch: UpstashBoxLaunchSchema, resource: UpstashBoxResourceSchema, nativeOperation: UpstashBoxOperationSchema });
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas({ launch: UpstashBoxLaunchSchema, resource: UpstashBoxResourceSchema, nativeOperation: UpstashBoxOperationSchema });
export const reference = <T>(value: T) => ({ contributionRef: CONTRIBUTION, schemaVersion: 1, value });
