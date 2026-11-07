import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
const kind = defineProtocolUnion([defineProtocolLiteral('agent-box'), defineProtocolLiteral('linux-computer')]);
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
// Vendor bounds: https://maritime.sh/docs/configuration (2026-11-05).
const memory = defineProtocolNumber({ integer: true, minimum: 512, maximum: 8192 });
const disk = defineProtocolNumber({ integer: true, minimum: 1, maximum: 100 });
export const MaritimeLaunchSchema = defineProtocolObject({ kind, memMb: memory, diskGb: disk,
  alwaysOn: boolean, templateId: text }, closed);
export const MaritimeOptionsSchema = defineProtocolObject({ memMb: memory.optional(), diskGb: disk.optional(),
  alwaysOn: boolean.optional(), templateId: text.optional() }, closed);
export const MaritimeResourceSchema = defineProtocolObject({ machineId: text, managedId: text, kind,
  alwaysOn: boolean.optional() }, closed);
export const MaritimeOperationSchema = defineProtocolObject({ kind: defineProtocolLiteral('acquire'), managedId: text, launch: MaritimeLaunchSchema }, closed);
export type MaritimeLaunch = ProtocolSchemaOutput<typeof MaritimeLaunchSchema>;
export type MaritimeResource = ProtocolSchemaOutput<typeof MaritimeResourceSchema>;
export type MaritimeOperation = ProtocolSchemaOutput<typeof MaritimeOperationSchema>;
const schemas = { launch: MaritimeLaunchSchema, resource: MaritimeResourceSchema, nativeOperation: MaritimeOperationSchema };
export const ROLE_SCHEMAS = defineMachineProvisionerSchemas(schemas);
export const RECONCILIATION = defineMachineProvisionerReconciliationSchemas(schemas);
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas(schemas);
export const CONTRIBUTION = { pluginId: 'happier.machine.maritime', localId: 'maritime' } as const;
export const reference = <T>(value: T) => ({ contributionRef: CONTRIBUTION, schemaVersion: 1, value });
export const BILLING = { location: 'cloud', stoppedBilling: 'unknown' } as const;
// Inspected 2026-11-05: boxes reserve monthly compute asleep; computers release compute asleep.
export const BILLING_BY_KIND = {
  'agent-box': { location: 'cloud', stoppedBilling: 'billed', storageCharges: [
    { amount: '0.08', currency: 'USD', unit: 'GB-month', label: 'Disk beyond the included 5 GB, awake or asleep',
      source: 'https://maritime.sh/docs/persistent-sandboxes', observedAt: Date.UTC(2026, 10, 5) },
  ] },
  'linux-computer': { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [
    { amount: '0.08', currency: 'USD', unit: 'GB-month', label: 'Disk while asleep',
      source: 'https://maritime.sh/docs/computers', observedAt: Date.UTC(2026, 10, 5) },
  ] },
} as const;
export const RETENTION = { supportedIntents: ['suspend', 'resume', 'delete'] } as const;
export const BOX_RETENTION = { supportedIntents: ['start', 'stop', 'suspend', 'resume', 'delete'] } as const;
