import { KINDS } from './kinds.js';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
// Current sizing/create references cap every type at four cores, including VMs.
export const SIZES = [
  { id: '2-4', cpu: 2, memory: 4, containerCompute: 4.40 },
  { id: '4-8', cpu: 4, memory: 8, containerCompute: 8.80 },
  { id: '4-16', cpu: 4, memory: 16, containerCompute: 14.40 },
  { id: '4-32', cpu: 4, memory: 32, containerCompute: 25.60 },
] as const;
export const DISK_GB = 12;
// The public union constructor requires two branches; a one-region type is a literal.
function choices<T extends string>(values: readonly [T, ...T[]]) {
  const [first, ...rest] = values;
  return rest.length === 0 ? defineProtocolLiteral(first)
    : defineProtocolUnion([defineProtocolLiteral(first), defineProtocolLiteral(rest[0]!), ...rest.slice(1).map(value => defineProtocolLiteral(value))]);
}
const size = choices([SIZES[0].id, ...SIZES.slice(1).map(size => size.id)]);
const regions = [...new Set(KINDS.flatMap(kind => [...kind.regions]))];
const region = choices([regions[0]!, ...regions.slice(1)]);
const launchKind = (kind: typeof KINDS[number]) => defineProtocolObject({ kind: defineProtocolLiteral(kind.id), size, region: choices(kind.regions) }, closed);
export const Agent37LaunchSchema = defineProtocolUnion([launchKind(KINDS[0]), launchKind(KINDS[1]), ...KINDS.slice(2).map(launchKind)]);
export const Agent37OptionsSchema = defineProtocolObject({}, closed);
export const Agent37ResourceSchema = defineProtocolObject({
  instanceId: defineProtocolString({ pattern: '^[a-z0-9]{10}$' }), managedId: text,
  kind: choices([KINDS[0].id, ...KINDS.slice(1).map(kind => kind.id)]), size, region,
}, closed);
export const Agent37OperationSchema = defineProtocolObject({ kind: defineProtocolLiteral('acquire'), managedId: text, launch: Agent37LaunchSchema }, closed);
export type Agent37Launch = ProtocolSchemaOutput<typeof Agent37LaunchSchema>;
export type Agent37Resource = ProtocolSchemaOutput<typeof Agent37ResourceSchema>;
export type Agent37Operation = ProtocolSchemaOutput<typeof Agent37OperationSchema>;
const schemas = { launch: Agent37LaunchSchema, resource: Agent37ResourceSchema, nativeOperation: Agent37OperationSchema };
export const ROLE_SCHEMAS = defineMachineProvisionerSchemas(schemas);
export const RECONCILIATION = defineMachineProvisionerReconciliationSchemas(schemas);
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas(schemas);
export const CONTRIBUTION = { pluginId: 'happier.machine.agent37', localId: 'agent37' } as const;
export const reference = <T>(value: T) => ({ contributionRef: CONTRIBUTION, schemaVersion: 1, value });
export const DOCS_OBSERVED_AT = Date.UTC(2026, 10, 5);
export const BILLING = { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [{
  label: 'Retained disk, including while stopped', amount: '0.09', currency: 'USD', unit: 'GB-month',
  source: 'https://www.agent37.com/docs/agents-api/instance-sizing', observedAt: DOCS_OBSERVED_AT,
}] } as const;
export const RETENTION = { supportedIntents: ['start', 'stop', 'delete'] } as const;
