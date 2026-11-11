// Storage transports are Protocol-owned to preserve its dependency direction.
import { z } from 'zod/mini';
import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { DeploymentBindingsPreparedInputV1Schema, DeploymentEnvironmentUpdateInputV1Schema,
    DeploymentEnvironmentUpdatePatchV1Schema, deploymentEnvironmentPrivateContentPatchFieldsV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentArtifactContentReferenceV1Schema } from '@happier-dev/protocol/deployments/deploymentArtifactContentReferenceV1';
import { DeploymentIdentifierV1Schema, DeploymentRevisionV1Schema } from '@happier-dev/protocol/deployments/deploymentIdentifiersV1';
import { MachineSecretGrantV1Schema } from '../secrets/machineSecretGrantV1.js';
import { DeploymentBindingSavedSecretRevisionsV1Schema } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';

/** Private prepared installation envelopes accompany the single public binding intent. */
export const DeploymentBindingsSetStorageInputV1Schema = z.extend(DeploymentBindingsPreparedInputV1Schema, {
    grants: z.array(MachineSecretGrantV1Schema),
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

export { DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateResultV1Schema, DeploymentEnvironmentControllerSetInputV1Schema, DeploymentTargetLinkInputV1Schema, DeploymentTargetLinkResultV1Schema, DeploymentDeployInputV1Schema, DeploymentRollbackInputV1Schema, DeploymentReceiptResultV1Schema, DeploymentActionFailureV1Schema, DeploymentEnvironmentGetInputV1Schema, DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetInputV1Schema, DeploymentReceiptGetResultV1Schema, DeploymentEnvironmentListInputV1Schema, DeploymentReceiptListInputV1Schema, DeploymentBindingsSetInputV1Schema, DeploymentDeployAdmissionInputV1Schema, DeploymentRollbackAdmissionInputV1Schema, DeploymentTransitionInputV1Schema, DeploymentCancelInputV1Schema, DeploymentCancelTransitionInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
export type {
    DeploymentEnvironmentCreateInputV1, DeploymentTargetLinkInputV1,
    DeploymentEnvironmentControllerSetInputV1,
    DeploymentDeployInputV1, DeploymentRollbackInputV1, DeploymentReceiptResultV1,
    DeploymentEnvironmentGetInputV1, DeploymentReceiptGetInputV1,
    DeploymentEnvironmentListInputV1, DeploymentReceiptListInputV1,
    DeploymentBindingsSetInputV1,
    DeploymentDeployAdmissionInputV1, DeploymentRollbackAdmissionInputV1,
    DeploymentTransitionInputV1,
    DeploymentCancelInputV1, DeploymentCancelTransitionInputV1,
} from '@happier-dev/protocol';
