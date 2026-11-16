import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';
import { defineMachineProvisionerReconciliationSchemas, defineMachineProvisionerSchemas, prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';

const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1 });
// Coder CLI's workspace.agent selector uses dots and slashes as delimiters.
const agentName = defineProtocolString({ minLength: 1, pattern: '^[A-Za-z0-9_-]+$' });
export const ParameterValuesSchema = defineProtocolArray(defineProtocolObject({ name: text, value: defineProtocolString() }, closed));
// Deliberate configuration of the selected template's workspace host. The
// Coder deployment origin is independent of where Terraform creates compute.
const workspaceHost = defineProtocolUnion([defineProtocolLiteral('controller-local'), defineProtocolLiteral('remote'), defineProtocolLiteral('unknown')]);
export const CoderLaunchSchema = defineProtocolObject({
  organizationId: text, templateId: text, templateVersionId: text, agentName,
  parameterValues: ParameterValuesSchema, presetId: text.optional(), workspaceHost: workspaceHost.optional(),
}, closed);
export const CoderOptionsSchema = defineProtocolObject({
  organizationId: text.optional(), templateId: text.optional(), templateVersionId: text.optional(),
  agentName: agentName.optional(), parameterValues: ParameterValuesSchema.optional(), presetId: text.optional(), workspaceHost: workspaceHost.optional(),
}, closed);
export const CoderResourceSchema = defineProtocolObject({
  workspaceId: text, ownerId: text, ownerName: text, workspaceName: text,
  organizationId: text, templateId: text, agentName, managedId: text,
}, closed);
export const CoderAcquireOperationSchema = defineProtocolObject({
  kind: defineProtocolLiteral('acquire'), managedId: text, launch: CoderLaunchSchema,
  ownerId: text, ownerName: text, workspaceName: text, workspaceId: text.optional(), buildId: text.optional(),
}, closed);
export const CoderDeleteOperationSchema = defineProtocolObject({
  kind: defineProtocolLiteral('delete'), resource: CoderResourceSchema, buildId: text.optional(),
}, closed);
export const CoderOperationSchema = defineProtocolUnion([CoderAcquireOperationSchema, CoderDeleteOperationSchema]);
export type CoderLaunch = ProtocolSchemaOutput<typeof CoderLaunchSchema>;
export type CoderOptions = ProtocolSchemaOutput<typeof CoderOptionsSchema>;
export type CoderResource = ProtocolSchemaOutput<typeof CoderResourceSchema>;
export type CoderAcquireOperation = ProtocolSchemaOutput<typeof CoderAcquireOperationSchema>;
export type CoderDeleteOperation = ProtocolSchemaOutput<typeof CoderDeleteOperationSchema>;
export type CoderOperation = ProtocolSchemaOutput<typeof CoderOperationSchema>;
const schemas = { launch: CoderLaunchSchema, resource: CoderResourceSchema, nativeOperation: CoderOperationSchema };
export const ROLE_SCHEMAS = defineMachineProvisionerSchemas(schemas);
export const RECONCILIATION = defineMachineProvisionerReconciliationSchemas(schemas);
export const prepareStoredSchemas = () => prepareMachineProvisionerStoredSchemas(schemas);
export const CONTRIBUTION = { pluginId: 'happier.machine.coder', localId: 'coder' } as const;
export const ACCOUNT_SERVICE = { pluginId: CONTRIBUTION.pluginId, localId: 'coder-account' } as const;
export const ACCOUNT_PURPOSE = 'coder-account';
export const DEPENDENCY_ID = 'coder-cli';
export const reference = <T>(value: T) => ({ contributionRef: CONTRIBUTION, schemaVersion: 1, value });
export const BILLING = { location: 'cloud', stoppedBilling: 'unknown' } as const;
export const RETENTION = { supportedIntents: ['start', 'stop', 'delete'] } as const;
