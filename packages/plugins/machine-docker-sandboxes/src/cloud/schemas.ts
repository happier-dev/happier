import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerSchemas, defineMachineProvisionerReconciliationSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1, pattern: '\\S' });
// Docker Sandboxes REST v1: native resource quantities and duration, no local ceiling.
export const ColdLaunchSchema = defineProtocolObject({ imageRef: text,
  cpus: defineProtocolNumber({ integer: true, minimum: 1 }).optional(),
  memoryMib: defineProtocolNumber({ integer: true, minimum: 1 }).optional(),
  timeoutSeconds: defineProtocolNumber({ integer: true, minimum: 1 }).optional(),
}, closed);
export const ArtifactSchema = defineProtocolObject({ snapshotName: defineProtocolString({ pattern: '^snapshots/[^/]+$' }) }, closed);
export const LaunchSchema = defineProtocolUnion([ColdLaunchSchema, ArtifactSchema]);
export const ResourceSchema = defineProtocolObject({ sandboxName: defineProtocolString({ pattern: '^sandboxes/[^/]+$' }) }, closed);
export const OperationSchema = defineProtocolObject({ managedId: text, launch: LaunchSchema,
  sandboxName: defineProtocolString({ pattern: '^sandboxes/[^/]+$' }).optional(),
}, closed);
export type Launch = ProtocolSchemaOutput<typeof LaunchSchema>;
export type Resource = ProtocolSchemaOutput<typeof ResourceSchema>;
export type Operation = ProtocolSchemaOutput<typeof OperationSchema>;
export const PreparationInputSchema = defineProtocolObject({ launch: ColdLaunchSchema, setupScript: text }, closed);
export const PreparationOperationSchema = defineProtocolObject({ operationId: text, input: PreparationInputSchema.optional(),
  sandboxName: defineProtocolString({ pattern: '^sandboxes/[^/]+$' }).optional(),
  snapshotName: defineProtocolString({ pattern: '^snapshots/[^/]+$' }).optional(),
  phase: defineProtocolUnion([defineProtocolLiteral('creating'), defineProtocolLiteral('setup-unknown'),
    defineProtocolLiteral('capturing'), defineProtocolLiteral('cleanup'), defineProtocolLiteral('destroying')]),
}, closed);
export type PreparationInput = ProtocolSchemaOutput<typeof PreparationInputSchema>;
export type PreparationOperation = ProtocolSchemaOutput<typeof PreparationOperationSchema>;
export const ROLE = defineMachineProvisionerSchemas({ launch: LaunchSchema, resource: ResourceSchema });
export const RECONCILIATION = defineMachineProvisionerReconciliationSchemas({ launch: LaunchSchema, resource: ResourceSchema, nativeOperation: OperationSchema });
export const CONTRIBUTION = { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-cloud' } as const;
export const reference = <T>(value: T) => ({ contributionRef: CONTRIBUTION, schemaVersion: 1, value });
export const BILLING = { location: 'cloud', stoppedBilling: 'unknown' } as const;
export const RETENTION = { supportedIntents: ['start', 'stop', 'delete'] } as const;
