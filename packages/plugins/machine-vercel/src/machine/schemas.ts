import {
  defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
  defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput,
} from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';
import { label } from '../ui/translations.js';
const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
const name = defineProtocolString({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' });
const timestamp = defineProtocolNumber({ integer: true, minimum: 0 });
export const VERCEL_REGIONS = ['iad1','sfo1','cle1','cdg1','fra1','arn1','sin1','pdx1','lhr1','icn1','bom1','cpt1','dub1','gru1','hkg1','syd1','yul1','hnd1','kix1'] as const;
const region = defineProtocolUnion([defineProtocolLiteral(VERCEL_REGIONS[0]), defineProtocolLiteral(VERCEL_REGIONS[1]), ...VERCEL_REGIONS.slice(2).map(value => defineProtocolLiteral(value))]);
const vcpus = defineProtocolUnion([defineProtocolLiteral(1), defineProtocolNumber({ integer: true, minimum: 2, maximum: 32, multipleOf: 2 })]);
const image = defineProtocolString({ minLength: 1, maxLength: 255, pattern: '\\S' });
// Vercel REST v4 + pricing limits, verified 2026-10-25. Team limits are checked separately.
const timeoutMs = defineProtocolNumber({ integer: true, minimum: 1000, maximum: 86_400_000 });
const snapshotExpirationMs = defineProtocolNumber({ integer: true, minimum: 0 });
export const VercelLaunchSchema = defineProtocolObject({ image, region, vcpus, timeoutMs, snapshotExpirationMs, snapshotId: text.optional() }, closed);
export const VercelOptionsSchema = defineProtocolObject({ image: image.optional(), region: region.optional(), vcpus: vcpus.optional(), timeoutMs: timeoutMs.optional(), snapshotExpirationMs: snapshotExpirationMs.optional() }, closed);
export const VercelResourceSchema = defineProtocolObject({ name, createdAt: timestamp, managedId: text, teamId: text, projectId: text }, closed);
export const VercelScopeSchema = defineProtocolObject({ teamId: text, projectId: text }, closed);
export const VercelAcquisitionSchema = defineProtocolObject({ kind: defineProtocolLiteral('acquire'), name, managedId: text, teamId: text, projectId: text,
  createdAt: timestamp.optional() }, closed);
export const VercelOperationSchema = defineProtocolUnion([
  VercelAcquisitionSchema,
  defineProtocolObject({ kind: defineProtocolLiteral('delete'), resource: VercelResourceSchema,
    phase: defineProtocolUnion([defineProtocolLiteral('stop'), defineProtocolLiteral('delete')]),
    snapshotIds: defineProtocolArray(text) }, closed),
]);
export type VercelLaunch = ProtocolSchemaOutput<typeof VercelLaunchSchema>;
export type VercelResource = ProtocolSchemaOutput<typeof VercelResourceSchema>;
export type VercelScope = ProtocolSchemaOutput<typeof VercelScopeSchema>;
export type VercelOperation = ProtocolSchemaOutput<typeof VercelOperationSchema>;
export const ROLE_SCHEMAS = defineMachineProvisionerSchemas({ launch: VercelLaunchSchema, resource: VercelResourceSchema });
export const RECONCILIATION = defineMachineProvisionerReconciliationSchemas({ launch: VercelLaunchSchema, resource: VercelResourceSchema, nativeOperation: VercelOperationSchema });
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas({ launch: VercelLaunchSchema, resource: VercelResourceSchema, nativeOperation: VercelOperationSchema });
export const CONTRIBUTION = { pluginId: 'happier.machine.vercel', localId: 'vercel' } as const;
// Published paid-plan rate before included usage; this is not a per-machine quote.
export const BILLING = { location: 'cloud', stoppedBilling: 'not-billed', storageCharges: [{
  label: label('snapshotStorage'), amount: '0.08', currency: 'USD', unit: 'GB-month',
  source: 'https://vercel.com/docs/sandbox/pricing', observedAt: Date.UTC(2026, 9, 27),
}] } as const;
export const reference = <T>(value: T) => ({ contributionRef: CONTRIBUTION, schemaVersion: 1, value });
