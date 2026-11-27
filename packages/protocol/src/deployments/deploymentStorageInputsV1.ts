// Storage transports are Protocol-owned to preserve its dependency direction.
import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentBindingsPreparedInputV1Schema, DeploymentEnvironmentUpdateInputV1Schema,
    DeploymentEnvironmentUpdatePatchV1Schema, deploymentEnvironmentPrivateContentPatchFieldsV1 } from './deploymentActionsV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from './deploymentIdentifiersV1.js';
import { MachineSecretGrantV1Schema } from './machineSecretGrantV1.js';
import { DeploymentBindingSavedSecretRevisionsV1Schema } from './deploymentBindingPatchV1.js';
import { DeploymentTelemetryTokenHashV1Schema } from './deploymentTelemetryV1.js';

/** Private prepared installation envelopes accompany the single public binding intent. */
export const DeploymentBindingsSetStorageInputV1Schema = z.extend(DeploymentBindingsPreparedInputV1Schema, {
    grants: z.array(MachineSecretGrantV1Schema),
    retainGrantsForOwnServerDataRoleRemoval: z.optional(z.literal(true)),
    /** The grants are this one recipient's copy seal of the unchanged content's backup credential. */
    copyRestoreSeal: z.optional(z.strictObject({ machineId: DeploymentIdentifierV1Schema, installationId: DeploymentIdentifierV1Schema })),
    telemetrySyncAcknowledgement: z.optional(z.strictObject({
        telemetryMachineId: DeploymentIdentifierV1Schema,
        telemetryTokenHash: DeploymentTelemetryTokenHashV1Schema,
    })),
    targetLinkContent: z.optional(z.strictObject({
        targetLinkId: DeploymentIdentifierV1Schema, expectedTargetLinkRevision: DeploymentRevisionV1Schema,
        ...DeploymentArtifactContentReferenceV1Schema.shape,
    })),
});
export type DeploymentBindingsSetStorageInputV1 = z.infer<typeof DeploymentBindingsSetStorageInputV1Schema>;

/** Update remains the sole placement front door; binding custody commits in that same CAS. */
export const DeploymentEnvironmentUpdateStorageInputV1Schema = lazyZodSchema(() => z.safeExtend(DeploymentEnvironmentUpdateInputV1Schema, {
    referencedSavedSecretRevisions: z.optional(DeploymentBindingSavedSecretRevisionsV1Schema.check(z.minLength(1))),
    patch: z.optional(z.omit(DeploymentEnvironmentUpdatePatchV1Schema, deploymentEnvironmentPrivateContentPatchFieldsV1)),
    authoredInputDigest: z.optional(z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u))),
    preparedBindings: z.optional(z.strictObject({
        grants: z.array(MachineSecretGrantV1Schema),
        referencedSavedSecretRevisions: DeploymentBindingsPreparedInputV1Schema.shape.referencedSavedSecretRevisions,
    })),
}));
export type DeploymentEnvironmentUpdateStorageInputV1 = z.infer<typeof DeploymentEnvironmentUpdateStorageInputV1Schema>;
