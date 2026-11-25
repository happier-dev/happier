import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { ExternalActionRequestIdV1Schema, ExternalActionMachineRpcSourceExecutionV1Schema } from '../actions/externalActionApi.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';
import { deploymentChildEffectActionIdForRootV1 } from './deploymentActionIdsV1.js';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1 } from '../machines/managed/actionIdsV1.js';
import { readReviewedMachineRpcChildFamilyV1 } from '../machines/peer/mediation/rpc/reviewedChildFamilyV1.js';
import { isDeploymentBackupConfigureNativeAdmissionV1 } from './deploymentCandidatePublicationV1.js';

export const DeploymentArchiveOriginV1Schema = lazyZodSchema(() => z.strictObject({
    environmentId: DeploymentIdentifierV1Schema, deploymentId: DeploymentIdentifierV1Schema,
    holderMachineId: DeploymentIdentifierV1Schema, holderInstallationId: DeploymentIdentifierV1Schema,
}));
export type DeploymentArchiveOriginV1 = z.infer<typeof DeploymentArchiveOriginV1Schema>;

/** A projection of one controller signature, with no recursively delegated proof or new custody. */
export const DeploymentChildExecutionProofV1Schema = lazyZodSchema(() => z.strictObject({
    method: z.string().check(z.minLength(1)), requestId: ExternalActionRequestIdV1Schema,
    paramsPresent: z.boolean(), paramsDigest: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    externalActionExecution: ExternalActionMachineRpcSourceExecutionV1Schema,
    /** Receiver annotation only. Its outer signature and Home lineage admission are mandatory. */
    archiveOrigin: z.optional(DeploymentArchiveOriginV1Schema),
    /** Receiver-observed native source identity; no private filesystem path crosses Home. */
    nativeIncumbentSource: z.optional(z.strictObject({
        environmentId: DeploymentIdentifierV1Schema, sourceDeploymentId: DeploymentIdentifierV1Schema,
        restorationForDeploymentId: z.optional(DeploymentIdentifierV1Schema),
        rootFingerprint: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
    })),
}).check(z.refine(value => {
    const execution = value.externalActionExecution;
    const routing = execution.deploymentChildRouting;
    if (!routing) {
        const { authorization, reviewedChild, effectActionId } = execution;
        const binding = authorization.binding;
        const admission = binding.deploymentNativeAdmission;
        const child = BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply;
        return !value.archiveOrigin && !value.nativeIncumbentSource && !execution.managedAdmission && value.paramsPresent
            && isDeploymentBackupConfigureNativeAdmissionV1(admission)
            && admission.receiverMachineId !== undefined && admission.receiverInstallationId !== undefined
            && reviewedChild?.role === child.role && effectActionId === child.action
            && value.method === `${admission.receiverMachineId}:${child.action}`
            && authorization.requesterAccountContext?.installationId === admission.receiverInstallationId
            && readReviewedMachineRpcChildFamilyV1({ binding, effectActionId, method: child.action,
                target: { machineId: admission.receiverMachineId, installationId: admission.receiverInstallationId },
                reviewedChild }) === 'backup_receiver_setup';
    }
    return value.method === `${routing.machineId}:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`
        && value.externalActionExecution.effectActionId === routing.actionId
        && deploymentChildEffectActionIdForRootV1(value.externalActionExecution.authorization.binding.actionId,
            value.externalActionExecution.authorization.binding.deploymentPreparationAdmission,
            value.externalActionExecution.effectActionId) === routing.actionId
        && (value.archiveOrigin === undefined || routing.kind === 'build'
            || routing.kind === 'member' && routing.phase !== 'cleanup')
        && (value.nativeIncumbentSource === undefined || routing.kind === 'review' && value.archiveOrigin === undefined
            && value.nativeIncumbentSource.environmentId === routing.input.environmentId);
})));
export type DeploymentChildExecutionProofV1 = z.infer<typeof DeploymentChildExecutionProofV1Schema>;
