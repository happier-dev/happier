import { lazyZodSchema } from '../lazyZodSchema.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { z } from '../zodRuntimePolicy.js';
import { DeploymentAcceptedExecutionV1Schema } from './deploymentAcceptedExecutionV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { DatabaseAgentLevelV1Schema, DeploymentEnvironmentDataEditorModeV1Schema,
  DeploymentEnvironmentPeopleModeV1Schema, DeploymentEnvironmentPrincipalsV1Schema } from './deploymentEnvironmentDeployerV1.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema, DeploymentTimestampV1Schema } from './deploymentIdentifiersV1.js';
import { DeploymentPreviewPullRequestIdV1Schema } from './deploymentPreviewReferenceV1.js';
import { DeploymentReceiptOperationV1Schema, DeploymentStateV1Schema } from './deploymentStateV1.js';
import { DeploymentIngressV1Schema } from './storedAppInputV1.js';

export const DeploymentEnvironmentOwnerV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('account'), accountId: DeploymentIdentifierV1Schema }),
  z.strictObject({ kind: z.literal('team'), teamId: DeploymentIdentifierV1Schema }),
]));
export const DeploymentEnvironmentCapabilitiesV1Schema = lazyZodSchema(() => z.strictObject({
  role: z.enum(['reader', 'deployer', 'manager']), read: z.boolean(), deploy: z.boolean(), editData: z.boolean(), manage: z.boolean(),
  manageBindings: z.boolean(), manageTargets: z.boolean(), delete: z.boolean(),
}));
/** Preview relation validation is shared by transport headers and opened Environment records. */
export function hasCompleteDeploymentPreviewRelationV1(environment: Readonly<{
  purpose: 'standard' | 'preview'; previewTemplateEnvironmentId?: string | undefined; previewRepositoryId?: string | undefined;
  previewPullRequestId?: string | undefined; previewTargetLinkId?: string | undefined;
  previewCompanionOfEnvironmentId?: string | undefined;
}>): boolean {
  const relations = [environment.previewTemplateEnvironmentId, environment.previewRepositoryId,
    environment.previewPullRequestId, environment.previewTargetLinkId];
  if (environment.purpose === 'preview') return environment.previewCompanionOfEnvironmentId === undefined
    && relations.every(value => value !== undefined);
  return environment.previewCompanionOfEnvironmentId === undefined ? relations.every(value => value === undefined)
    : environment.previewTemplateEnvironmentId !== undefined && relations.slice(1).every(value => value === undefined);
}
export const DeploymentEnvironmentHeaderV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), id: DeploymentIdentifierV1Schema, serverId: DeploymentIdentifierV1Schema,
  projectSourceId: DeploymentIdentifierV1Schema, revision: DeploymentRevisionV1Schema,
  owner: DeploymentEnvironmentOwnerV1Schema, protection: z.enum(['production', 'nonProduction']),
  purpose: z.enum(['standard', 'preview']), deployerMode: DeploymentEnvironmentPeopleModeV1Schema,
  deployerPrincipals: z.optional(DeploymentEnvironmentPrincipalsV1Schema),
  /** Database access (P3): server-readable decision facts, ids only (docs/encryption.md). */
  dataEditorMode: DeploymentEnvironmentDataEditorModeV1Schema, dataEditors: z.optional(DeploymentEnvironmentPrincipalsV1Schema),
  dataAgentAccess: DatabaseAgentLevelV1Schema,
  telemetryMachineId: z.optional(z.nullable(DeploymentIdentifierV1Schema)),
  controllerMachineId: DeploymentIdentifierV1Schema, buildMachineId: z.optional(DeploymentIdentifierV1Schema),
  ingress: z.optional(DeploymentIngressV1Schema),
  runtimeTargetLinkId: z.optional(DeploymentIdentifierV1Schema),
  previewTemplateEnvironmentId: z.optional(DeploymentIdentifierV1Schema),
  previewRepositoryId: z.optional(DeploymentIdentifierV1Schema),
  previewPullRequestId: z.optional(DeploymentPreviewPullRequestIdV1Schema),
  previewTargetLinkId: z.optional(DeploymentIdentifierV1Schema),
  previewCompanionOfEnvironmentId: z.optional(DeploymentIdentifierV1Schema),
  ...DeploymentArtifactContentReferenceV1Schema.shape, capabilities: DeploymentEnvironmentCapabilitiesV1Schema,
  createdByAccountId: DeploymentIdentifierV1Schema,
  createdAtMs: DeploymentTimestampV1Schema, updatedAtMs: DeploymentTimestampV1Schema,
  deletedAtMs: z.optional(DeploymentTimestampV1Schema),
}).check(z.refine(hasCompleteDeploymentPreviewRelationV1,
  { message: 'Preview relationships identify a preview or its named standard companion.' })));
/** Portable projection of the receipt owner's exact operation vocabulary. */
export const DeploymentReceiptOperationV1ProtocolSchema = projectZodProtocolSchema(DeploymentReceiptOperationV1Schema);
export const DeploymentReceiptMetadataV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), id: DeploymentIdentifierV1Schema, environmentId: DeploymentIdentifierV1Schema,
  targetLinkId: DeploymentIdentifierV1Schema, revision: DeploymentRevisionV1Schema,
  operation: DeploymentReceiptOperationV1Schema, state: DeploymentStateV1Schema,
  requestKey: DeploymentIdentifierV1Schema, requestedByAccountId: z.nullable(DeploymentIdentifierV1Schema),
  actionOperationId: DeploymentIdentifierV1Schema,
  /** Immutable admitted Workflow cause; never supplied by the receipt request body. */
  originRunId: z.optional(DeploymentIdentifierV1Schema),
  acceptedExecution: z.optional(DeploymentAcceptedExecutionV1Schema),
  predecessorDeploymentId: z.optional(DeploymentIdentifierV1Schema), rollbackOfDeploymentId: z.optional(DeploymentIdentifierV1Schema),
  restoreBackupId: z.optional(DeploymentIdentifierV1Schema),
  promotedFromDeploymentId: z.optional(DeploymentIdentifierV1Schema),
  cancelRequestedAtMs: z.optional(DeploymentTimestampV1Schema),
  requestedAtMs: DeploymentTimestampV1Schema, startedAtMs: z.optional(DeploymentTimestampV1Schema), settledAtMs: z.optional(DeploymentTimestampV1Schema),
}).check(z.refine(receipt => (receipt.startedAtMs === undefined || receipt.startedAtMs >= receipt.requestedAtMs)
    && (receipt.settledAtMs === undefined || receipt.settledAtMs >= (receipt.startedAtMs ?? receipt.requestedAtMs))
    && [receipt.predecessorDeploymentId, receipt.rollbackOfDeploymentId, receipt.promotedFromDeploymentId]
      .every(parentId => parentId !== receipt.id),
  { message: 'Receipt chronology and lineage must refer to earlier work.' })));
export const DeploymentReceiptHeaderV1Schema = lazyZodSchema(() => z.extend(DeploymentReceiptMetadataV1Schema,
  { ...DeploymentArtifactContentReferenceV1Schema.shape, contentArtifactId: z.nullable(DeploymentIdentifierV1Schema) }));
export type DeploymentEnvironmentHeaderV1 = z.infer<typeof DeploymentEnvironmentHeaderV1Schema>;
export type DeploymentReceiptHeaderV1 = z.infer<typeof DeploymentReceiptHeaderV1Schema>;
/** Retained history can outlive the Account that owned the private Receipt Artifact. */
export function hasDeploymentReceiptContentV1<T extends { contentArtifactId: string | null }>(
  receipt: T,
): receipt is T & { contentArtifactId: string } {
  return receipt.contentArtifactId !== null;
}
