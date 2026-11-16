import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from './deploymentIdentifiersV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { DeploymentBindingSavedSecretRevisionsV1Schema } from './deploymentBindingPatchV1.js';
import { DeploymentNewProjectV1Schema, hasOneDeploymentProjectV1, DeploymentTargetManagedRetentionV1Schema } from './storedAppInputV1.js';
import { DeploymentEnvironmentPeopleModeV1Schema, DeploymentEnvironmentPrincipalsV1Schema } from './deploymentEnvironmentDeployerV1.js';
import { DeploymentPreviewReferenceV1Schema } from './deploymentPreviewReferenceV1.js';
import { DeploymentEnvironmentCopySourceV1Schema, DeploymentEnvironmentCopyFromV1Schema, DeploymentEnvironmentCopyPlanV1Schema } from './deploymentEnvironmentCopyV1.js';

/** Prepared child-owned content for one exact template DATA link; no private provider operands reach storage. */
export const DeploymentPreviewDataTargetLinkCreateV1Schema = lazyZodSchema(() => z.strictObject({
  templateDataTargetLinkId: DeploymentIdentifierV1Schema, expectedTemplateTargetLinkRevision: DeploymentRevisionV1Schema,
  ...DeploymentArtifactContentReferenceV1Schema.shape,
}));

/** P40 authored and prepared creation share these leaves without loading an Action catalog. */
export const DeploymentEnvironmentCreateBaseInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: DeploymentIdentifierV1Schema, requestKey: DeploymentIdentifierV1Schema, ...DeploymentArtifactContentReferenceV1Schema.shape,
  projectSourceId: z.optional(DeploymentIdentifierV1Schema), newProject: z.optional(DeploymentNewProjectV1Schema),
  protection: z.enum(['production', 'nonProduction']), purpose: z.enum(['standard', 'preview']),
  deployerMode: DeploymentEnvironmentPeopleModeV1Schema,
  deployerPrincipals: z.optional(DeploymentEnvironmentPrincipalsV1Schema),
  controllerMachineId: DeploymentIdentifierV1Schema,
  buildMachineId: z.optional(DeploymentIdentifierV1Schema),
  /** Omission offers until-delete in the target review; keep declines the allocation change. */
  managedRetention: z.optional(DeploymentTargetManagedRetentionV1Schema),
  /** Prepared storage relation only; copying and SCM admission remain host-owned. */
  preview: z.optional(DeploymentPreviewReferenceV1Schema),
  /** One ordinary data Environment belongs to the actual preview child. */
  previewCompanionOfEnvironmentId: z.optional(DeploymentIdentifierV1Schema),
  previewDataTargetLinks: z.optional(z.array(DeploymentPreviewDataTargetLinkCreateV1Schema).check(z.refine(links =>
    new Set(links.map(link => link.templateDataTargetLinkId)).size === links.length
      && new Set(links.map(link => link.contentArtifactId)).size === links.length,
  { message: 'Preview DATA clones name each template link and child content once.' }))),
  /** The first own-server runtime link shares this create intent and approval. */
  firstTargetLink: z.optional(z.strictObject({
    ...DeploymentArtifactContentReferenceV1Schema.shape,
    machines: DeploymentOwnServerTargetMachinesV1Schema,
  })),
}));
function hasPreparedPreviewReference(input: Pick<z.infer<typeof DeploymentEnvironmentCreateBaseInputV1Schema>,
  'purpose' | 'preview' | 'previewCompanionOfEnvironmentId' | 'previewDataTargetLinks'>): boolean {
  if (input.purpose === 'preview') return input.preview !== undefined && input.previewCompanionOfEnvironmentId === undefined;
  return input.previewDataTargetLinks === undefined && (input.previewCompanionOfEnvironmentId === undefined
    ? input.preview === undefined : input.preview !== undefined);
}
// A 32-byte commitment, never the selected private copy operands.
const deploymentEnvironmentCopyIntentCommitmentV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/)));
export const DeploymentEnvironmentCreateStorageInputV1Schema = lazyZodSchema(() => z.extend(DeploymentEnvironmentCreateBaseInputV1Schema, {
  // Pending template captures retain identities; the binding writer completes their routing.
  referencedSavedSecretRevisions: z.optional(DeploymentBindingSavedSecretRevisionsV1Schema.check(z.minLength(1))),
  copyFrom: z.optional(DeploymentEnvironmentCopySourceV1Schema),
  copyIntentCommitment: z.optional(deploymentEnvironmentCopyIntentCommitmentV1Schema),
}).check(
  z.refine(input => hasOneDeploymentProjectV1(input.projectSourceId, input.newProject), { message: 'Select an existing or reviewed new Project.' }),
  z.refine(input => (input.copyFrom === undefined) === (input.copyIntentCommitment === undefined),
    { message: 'Stored copies retain their reviewed retry identity.' }),
  z.refine(hasPreparedPreviewReference,
  { message: 'A prepared template relationship belongs to a preview or its named standard companion.' })));
export type DeploymentEnvironmentCreateStorageInputV1 = z.infer<typeof DeploymentEnvironmentCreateStorageInputV1Schema>;
export const DeploymentEnvironmentCreateInputV1Schema = lazyZodSchema(() => z.extend(DeploymentEnvironmentCreateBaseInputV1Schema, {
  copyFrom: z.optional(DeploymentEnvironmentCopyFromV1Schema), copyPlan: z.optional(DeploymentEnvironmentCopyPlanV1Schema),
  copyIntentCommitment: z.optional(deploymentEnvironmentCopyIntentCommitmentV1Schema),
}).check(
  z.refine(input => hasOneDeploymentProjectV1(input.projectSourceId, input.newProject), { message: 'Select an existing or reviewed new Project.' }),
  z.refine(hasPreparedPreviewReference,
    { message: 'A prepared template relationship belongs to a preview or its named standard companion.' }),
  z.refine(input => (input.copyFrom === undefined) === (input.copyPlan === undefined)
    && (input.copyFrom === undefined) === (input.copyIntentCommitment === undefined),
    { message: 'Prepared copies retain their exact selected binding plan and retry identity.' })));
export const DeploymentTargetLinkMachineV1Schema = lazyZodSchema(() => z.strictObject({
  machineId: DeploymentIdentifierV1Schema, installationId: DeploymentIdentifierV1Schema,
}));
export const DeploymentTargetMachinesV1Schema = lazyZodSchema(() => z.array(DeploymentTargetLinkMachineV1Schema).check(
  z.refine(machines => new Set(machines.map(machine => machine.machineId)).size === machines.length,
    { message: 'Runtime Machines must be unique.' })));
/** Own-server callers retain their nonempty membership contract when other target arms have no members. */
export const DeploymentOwnServerTargetMachinesV1Schema = lazyZodSchema(() => DeploymentTargetMachinesV1Schema.check(z.minLength(1)));
export type DeploymentEnvironmentCreateInputV1 = z.infer<typeof DeploymentEnvironmentCreateInputV1Schema>;
