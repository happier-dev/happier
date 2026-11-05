import { z } from 'zod/mini';
import { DEPLOYMENT_TEARDOWN_STEPS_V1, DeploymentTeardownStepV1Schema, DeploymentTeardownReasonV1Schema, DeploymentTargetLinkMachineV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './ids.js';

export { DEPLOYMENT_TEARDOWN_STEPS_V1 };
export type DeploymentTeardownStepV1 = z.infer<typeof DeploymentTeardownStepV1Schema>;
export const DeploymentTeardownResourceV1Schema = z.strictObject({
    id, kind: z.enum(['workload', 'network', 'data', 'domain', 'release', 'binding', 'providerResource']),
    machineId: z.optional(id), ownership: z.enum(['owned', 'shared', 'external']),
    disposition: z.enum(['remove', 'retain']),
}).check(z.refine(resource => resource.disposition !== 'remove' || resource.ownership === 'owned',
    { message: 'Only exact owned resources can be removed.' }),
    z.refine(resource => resource.kind !== 'workload' || resource.disposition === 'remove',
        { message: 'Retaining a running workload requires explicit detach.' }));
export type DeploymentTeardownResourceV1 = z.infer<typeof DeploymentTeardownResourceV1Schema>;
export const DeploymentTeardownStepProofV1Schema = z.strictObject({
    step: DeploymentTeardownStepV1Schema, ...DeploymentTargetLinkMachineV1Schema.shape,
    state: z.enum(['running', 'succeeded', 'failed', 'outcome_unknown']), reason: z.optional(id),
    resources: z.array(z.strictObject({ resourceId: id, disposition: z.enum(['absent', 'retained']) })),
});
export type DeploymentTeardownStepProofV1 = z.infer<typeof DeploymentTeardownStepProofV1Schema>;
export const DeploymentTeardownContentV1Schema = z.strictObject({
    reason: DeploymentTeardownReasonV1Schema, targetLinkRevision: revision,
    machines: z.array(DeploymentTargetLinkMachineV1Schema).check(z.minLength(1)),
    resources: z.array(DeploymentTeardownResourceV1Schema), proofs: z.array(DeploymentTeardownStepProofV1Schema),
}).check(z.refine(content => new Set(content.machines.map(member => member.machineId)).size === content.machines.length
    && new Set(content.resources.map(resource => resource.id)).size === content.resources.length
    && new Set(content.proofs.map(proof => JSON.stringify([proof.machineId, proof.step]))).size === content.proofs.length
    && content.resources.every(resource => resource.machineId === undefined || content.machines.some(member => member.machineId === resource.machineId))
    && content.proofs.every(proof => content.machines.some(member => member.machineId === proof.machineId
        && member.installationId === proof.installationId)),
{ message: 'Teardown custody and proofs require one exact resource and installation scope.' }));
export type DeploymentTeardownContentV1 = z.infer<typeof DeploymentTeardownContentV1Schema>;
