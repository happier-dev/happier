import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
// E2B API 0.1.0: seconds, minimum 1; the selected team's service limit is authoritative.
export const E2bLaunchSchema = defineProtocolObject({ templateId: text, timeoutSeconds: defineProtocolNumber({ integer: true, minimum: 1 }) }, closed);
export const E2bOptionsSchema = defineProtocolObject({ templateId: text.optional(), timeoutSeconds: defineProtocolNumber({ integer: true, minimum: 1 }).optional() }, closed);
export const E2bResourceSchema = defineProtocolObject({ sandboxId: text, managedId: text, timeoutSeconds: defineProtocolNumber({ integer: true, minimum: 1 }) }, closed);
export const E2bOperationSchema = defineProtocolObject({ kind: defineProtocolLiteral('acquire'), managedId: text, launch: E2bLaunchSchema }, closed);
export type E2bLaunch = ProtocolSchemaOutput<typeof E2bLaunchSchema>;
export type E2bResource = ProtocolSchemaOutput<typeof E2bResourceSchema>;
export type E2bOperation = ProtocolSchemaOutput<typeof E2bOperationSchema>;
const schemas = { launch: E2bLaunchSchema, resource: E2bResourceSchema, nativeOperation: E2bOperationSchema };
export const ROLE_SCHEMAS = defineMachineProvisionerSchemas(schemas);
export const RECONCILIATION = defineMachineProvisionerReconciliationSchemas(schemas);
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas(schemas);
export const CONTRIBUTION = { pluginId: 'happier.machine.e2b', localId: 'e2b' } as const;
export const reference = <T>(value: T) => ({ contributionRef: CONTRIBUTION, schemaVersion: 1, value });
export const BILLING = { location: 'cloud', stoppedBilling: 'not-billed' } as const;
export const RETENTION = { supportedIntents: ['suspend', 'resume', 'delete'] } as const;
