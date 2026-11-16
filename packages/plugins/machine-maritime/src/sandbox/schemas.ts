import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
// Maritime SDK 0.12.0 CreateSandboxParams: exact resources override size presets.
export const SandboxLaunchSchema = defineProtocolObject({ from: text,
  vcpu: defineProtocolNumber({ integer: true, minimum: 1, maximum: 16 }),
  memoryMib: defineProtocolNumber({ integer: true, minimum: 1024, maximum: 65536, multipleOf: 1024 }),
  diskGib: defineProtocolNumber({ integer: true, minimum: 5, maximum: 500 }) }, closed);
export const SandboxOptionsSchema = defineProtocolObject({ from: text.optional() }, closed);
export const SandboxResourceSchema = defineProtocolObject({ sandboxId: text, name: text }, closed);
export const SandboxOperationSchema = defineProtocolObject({ kind: defineProtocolLiteral('acquire'), name: text }, closed);
export type SandboxLaunch = ProtocolSchemaOutput<typeof SandboxLaunchSchema>;
export type SandboxResource = ProtocolSchemaOutput<typeof SandboxResourceSchema>;
export type SandboxOperation = ProtocolSchemaOutput<typeof SandboxOperationSchema>;
export const SANDBOX_CONTRIBUTION = { pluginId: 'happier.machine.maritime', localId: 'maritime-sandbox' } as const;
export const sandboxReference = <T>(value: T) => ({ contributionRef: SANDBOX_CONTRIBUTION, schemaVersion: 1, value });
const schemas = { launch: SandboxLaunchSchema, resource: SandboxResourceSchema, nativeOperation: SandboxOperationSchema };
export const SANDBOX_ROLES = defineMachineProvisionerSchemas(schemas);
export const SANDBOX_RECONCILIATION = defineMachineProvisionerReconciliationSchemas(schemas);
export const prepareSandboxStoredSchemas = () => prepareMachineProvisionerStoredSchemas(schemas);
export const SANDBOX_HOME = '/opt/happier';
export const SANDBOX_BILLING = { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [
  { amount: '0.08', currency: 'USD', unit: 'GB-month', label: 'Paused sandbox disk', source: 'https://maritime.sh/docs/billing', observedAt: Date.UTC(2026, 10, 16) },
] } as const;
export const SANDBOX_RETENTION = { supportedIntents: ['suspend', 'resume', 'delete'] } as const;
