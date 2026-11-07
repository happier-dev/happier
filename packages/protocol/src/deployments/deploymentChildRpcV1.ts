import { z } from 'zod/mini';
import type { ExternalActionExecutionAuthorizationBindingV1, ReviewedActionChildHttpProofV1 } from '../actions/externalActionApi.js';
import { computeActionInputApprovalDigestV1 } from '../actions/decisionAuthority.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
import { DeploymentDeployInputV1Schema, DeploymentDeployIntentInputV1Schema, DeploymentRollbackInputV1Schema, DeploymentRollbackIntentInputV1Schema, DeploymentPromoteInputV1Schema, DeploymentEnvironmentCreateIntentInputV1Schema } from './deploymentActionsV1.js';
import { deploymentChildEffectActionIdForRootV1, isDeploymentDomainRemoveActionIdV1, isDeploymentDomainAddActionIdV1,
    DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from './deploymentActionIdsV1.js';
import { DeploymentDomainAddInputV1Schema, DeploymentDomainAddPreparedInputV1Schema, DeploymentDomainRemoveInputV1Schema, DeploymentDomainVerifyInputV1Schema,
    DeploymentDomainPlacementV1Schema, DeploymentDomainTopologyV1Schema } from './deploymentDomainV1.js';
import type { DeploymentPreparationAdmissionV1 } from './deploymentPreparationAdmissionV1.js';
import { DeploymentTemplateInstantiateInputV1Schema } from './deploymentTemplateInstantiationV1.js';
import { DeploymentPromoteIntentInputV1Schema } from './deploymentPromoteIntentV1.js';
import { DeploymentTeardownInputV1Schema, DeploymentTeardownActionInputV1Schema, DeploymentTeardownStepV1Schema } from './deploymentActionsV1.js';
import { matchesDeploymentDomainPreparedInputV1,
    isDeploymentDomainNativeAdmissionV1, projectDeploymentNativeAdmissionV1 } from './deploymentCandidatePublicationV1.js';
export { isDeploymentChildRootActionIdV1, isDeploymentChildEffectActionIdV1, deploymentOperationForRootActionV1, deploymentChildEffectActionIdForRootV1,
    isDeploymentDomainChildActionIdV1, isDeploymentDomainAddActionIdV1, isDeploymentDomainRemoveActionIdV1,
    type DeploymentRootOperationV1, type DeploymentDomainChildActionIdV1 } from './deploymentActionIdsV1.js';

const placement = { v: z.literal(1), machineId: id, installationId: id };
export const DeploymentDomainChildRoutingV1Schema = lazyZodSchema(() => z.strictObject({
    ...placement, kind: z.literal('domain'), actionId: z.enum(['deployments.domains.add', 'deployments.domains.remove', 'deployments.domains.verify']),
    input: z.strictObject({ serverId: id, environmentId: id, domainId: id }), expectedDomainRevision: revision,
    capture: DeploymentDomainPlacementV1Schema, actionOperationId: z.optional(id),
}).check(z.refine(value => (value.actionId === 'deployments.domains.verify' || value.actionOperationId !== undefined)
    && value.input.serverId === value.capture.placement.serverId && value.input.environmentId === value.capture.placement.environmentId
    && value.input.domainId === value.capture.placement.domainId && value.machineId === value.capture.placement.machineId
    && value.installationId === value.capture.placement.installationId
    && (value.actionOperationId === undefined || value.actionOperationId === value.capture.placement.actionOperationId))));
export const DeploymentDomainChildRpcV1Schema = lazyZodSchema(() => z.safeExtend(DeploymentDomainChildRoutingV1Schema, {
    topology: z.optional(DeploymentDomainTopologyV1Schema),
    /** Private admitted Account result; removal includes it only after the
     * Domain parent's existing last-consumer decision. */
    cloudflareConnector: z.optional(z.strictObject({ tunnelId: id,
        connector: z.strictObject({ imageRef: id, version: id }), networkName: id, grantRef: id })),
}));
export type DeploymentDomainChildRpcV1 = z.infer<typeof DeploymentDomainChildRpcV1Schema>;
export const DeploymentDomainRemoveDiscoverInputV1Schema = lazyZodSchema(() => z.strictObject({
    ...DeploymentDomainRemoveInputV1Schema.shape, ...DeploymentArtifactContentReferenceV1Schema.shape,
    targetLinkId: id, expectedTargetLinkRevision: revision,
}));
export type DeploymentDomainRemoveDiscoverInputV1 = z.infer<typeof DeploymentDomainRemoveDiscoverInputV1Schema>;
export const DeploymentDomainDiscoverChildRpcV1Schema = lazyZodSchema(() => z.discriminatedUnion('actionId', [
    z.strictObject({ ...placement, kind: z.literal('domainDiscover'), actionId: z.literal('deployments.domains.add'), input: DeploymentDomainAddPreparedInputV1Schema }),
    z.strictObject({ ...placement, kind: z.literal('domainDiscover'), actionId: z.literal('deployments.domains.remove'), input: DeploymentDomainRemoveDiscoverInputV1Schema }),
]));
export type DeploymentDomainDiscoverChildRpcV1 = z.infer<typeof DeploymentDomainDiscoverChildRpcV1Schema>;
const job = lazyZodSchema(() => z.union([
    z.strictObject({ ...placement, kind: z.literal('review') }),
    z.strictObject({ ...placement, kind: z.literal('build'), deploymentId: id, actionOperationId: id }),
    z.strictObject({ ...placement, kind: z.literal('retention'), deploymentId: id, actionOperationId: id,
        settledTargetLinkRevision: revision, settledDeploymentRevision: revision, activeDeploymentId: id }),
    z.strictObject({ ...placement, kind: z.literal('member'), deploymentId: id, actionOperationId: id,
        phase: z.enum(['activate', 'restore', 'observe', 'cleanup']), selectedDeploymentId: id }),
]));
const root = lazyZodSchema(() => z.discriminatedUnion('actionId', [
    z.strictObject({ actionId: z.literal('deployments.deploy'), input: DeploymentDeployInputV1Schema }),
    z.strictObject({ actionId: z.literal('deployments.rollback'), input: DeploymentRollbackInputV1Schema }),
    z.strictObject({ actionId: z.literal('deployments.promote'), input: DeploymentPromoteInputV1Schema }),
]));

/** Private finite child work. Content, authority and acceptance remain with their canonical owners. */
export const DeploymentChildRpcV1Schema = lazyZodSchema(() => z.union([
    DeploymentDomainChildRpcV1Schema, DeploymentDomainDiscoverChildRpcV1Schema,
    z.strictObject({ ...placement, kind: z.literal('teardown'), actionId: z.literal('deployments.teardown'),
        input: DeploymentTeardownInputV1Schema, deploymentId: id, actionOperationId: id,
        step: DeploymentTeardownStepV1Schema, mode: z.enum(['observe', 'execute']) }),
    z.strictObject({ ...placement, kind: z.literal('prepare'), actionId: z.literal('deployments.deploy'),
        input: z.safeExtend(DeploymentDeployIntentInputV1Schema, { targetLinkId: id }), expectedRevision: revision, expectedTargetLinkRevision: revision }),
    ...job._zod.def.options.map(shape => z.union(root._zod.def.options.map(action => z.strictObject({ ...shape.shape, ...action.shape })))),
]).check(z.refine(value => value.kind !== 'member' || value.phase !== 'cleanup' || value.selectedDeploymentId === value.deploymentId)));
export type DeploymentChildRpcV1 = z.infer<typeof DeploymentChildRpcV1Schema>;

/** Input derivation is separate from admission: Home and the receiver must still
 * prove the current parent receipt, operation, candidate and installed role. */
export function doesDeploymentChildInputMatchRootV1(input: Readonly<{
    rootInput: unknown; child: DeploymentChildRpcV1; rootActionId?: string; rootRequestId?: string;
    rootBinding?: ExternalActionExecutionAuthorizationBindingV1;
    rootPreparationAdmission?: DeploymentPreparationAdmissionV1; reviewedChild?: ReviewedActionChildHttpProofV1;
}>): boolean {
    const child = input.child;
    if (child.kind === 'teardown') {
        if (input.rootActionId !== child.actionId) return false;
        const exact = DeploymentTeardownInputV1Schema.safeParse(input.rootInput);
        if (exact.success) return sameStrictJsonValue(exact.data, child.input);
        const intent = DeploymentTeardownActionInputV1Schema.safeParse(input.rootInput);
        return intent.success && !('detachKeepRunning' in intent.data) && !('dataCreation' in intent.data)
            && intent.data.serverId === child.input.serverId
            && intent.data.environmentId === child.input.environmentId && intent.data.reason === child.input.reason
            && (intent.data.targetLinkId === undefined || intent.data.targetLinkId === child.input.targetLinkId)
            && (intent.data.requestKey === undefined || intent.data.requestKey === child.input.requestKey)
            && (!('expectedRevision' in intent.data) || intent.data.expectedRevision === child.input.expectedRevision)
            && (!('expectedTargetLinkRevision' in intent.data) || intent.data.expectedTargetLinkRevision === child.input.expectedTargetLinkRevision)
            && (!('machines' in intent.data) || sameStrictJsonValue(intent.data.machines, child.input.machines));
    }
    if (input.rootActionId === 'deployments.teardown' && (child.kind === 'domainDiscover' || child.kind === 'domain')) {
        if (!isDeploymentDomainRemoveActionIdV1(child.actionId)) return false;
        const binding = input.rootBinding;
        // The existing signed teardown admission names the Environment. Home's
        // Domain preparation owner proves each current Domain and target capture.
        if (input.rootInput === undefined && binding) return binding.actionId === input.rootActionId
            && binding.serverIdentityId === child.input.serverId && binding.environmentId === child.input.environmentId;
        const original = DeploymentTeardownActionInputV1Schema.safeParse(input.rootInput);
        if (!original.success || 'detachKeepRunning' in original.data) return false;
        return original.data.serverId === child.input.serverId && original.data.environmentId === child.input.environmentId;
    }
    if (input.rootActionId === 'deployments.environments.create'
        || input.rootActionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 && isDeploymentDomainAddActionIdV1(child.actionId)) {
        if (deploymentChildEffectActionIdForRootV1(input.rootActionId, input.rootPreparationAdmission, child.actionId) !== child.actionId) return false;
        if (child.actionId === 'deployments.deploy') {
            if (input.reviewedChild) return input.reviewedChild.actionId === child.actionId
                && input.reviewedChild.role === 'template.deploy'
                && input.reviewedChild.inputDigest === computeActionInputApprovalDigestV1(child.actionId, child.input);
            // Read-only preparation precedes the final candidate revision. Home
            // binds its allocated Environment; the original request names this attempt.
            const original = DeploymentEnvironmentCreateIntentInputV1Schema.safeParse(input.rootInput);
            return (child.kind === 'prepare' || child.kind === 'review') && original.success
                && original.data.serverId === child.input.serverId && input.rootRequestId !== undefined
                && child.input.requestKey === input.rootRequestId;
        }
        if (input.reviewedChild?.actionId !== 'deployments.domains.add' || child.actionId !== 'deployments.domains.add') return false;
        if (!input.reviewedChild.role.startsWith('template.domain:')) return false;
        const native = input.reviewedChild.deploymentNativeAdmission;
        if (native && (native.actionId !== child.actionId || native.environmentId !== child.input.environmentId
            || native.domainId !== child.input.domainId)) return false;
        if (child.kind === 'domainDiscover') return native && input.rootBinding
            ? matchesDeploymentDomainPreparedInputV1(child.input, { ...input.rootBinding,
                deploymentNativeAdmission: native, reviewedChild: input.reviewedChild })
            : input.reviewedChild.inputDigest === computeActionInputApprovalDigestV1('deployments.domains.add', child.input);
        // Native continuation consumes Home's accepted Domain capture. Its
        // original exact operand was admitted by the signed HTTP child proof.
        return child.kind === 'domain';
    }
    if (child.kind === 'domainDiscover') {
        // Removal discovers current retained content and target references at
        // Home. Those derived observation inputs are not part of its root intent.
        const { contentArtifactId: _contentId, contentHeaderVersion: _header, contentBodyVersion: _body,
            targetLinkId: _targetId, expectedTargetLinkRevision: _targetRevision, ...removeRoot } = child.input;
        const rootOperand = isDeploymentDomainRemoveActionIdV1(child.actionId) ? removeRoot : child.input;
        const binding = input.rootBinding;
        const native = binding?.deploymentNativeAdmission;
        if (binding && isDeploymentDomainNativeAdmissionV1(native)) {
            if (input.rootActionId !== child.actionId || binding.actionId !== child.actionId || native.actionId !== child.actionId
                || child.input.serverId !== binding.serverIdentityId || child.input.environmentId !== native.environmentId
                || child.input.domainId !== native.domainId) return false;
            if (native.authoredMetadataDigest !== undefined) {
                return matchesDeploymentDomainPreparedInputV1(child.input, { ...binding, deploymentNativeAdmission: native });
            }
            const projected = projectDeploymentNativeAdmissionV1(child.actionId, rootOperand);
            return isDeploymentDomainNativeAdmissionV1(projected) && projected.inputDigest === native.inputDigest;
        }
        const original = (isDeploymentDomainRemoveActionIdV1(child.actionId)
            ? DeploymentDomainRemoveInputV1Schema : DeploymentDomainAddInputV1Schema).safeParse(input.rootInput);
        return input.rootActionId === child.actionId && original.success && sameStrictJsonValue(original.data, rootOperand);
    }
    if (child.kind === 'domain') {
        const schema = child.actionId === 'deployments.domains.add' ? DeploymentDomainAddInputV1Schema
            : child.actionId === 'deployments.domains.remove' ? DeploymentDomainRemoveInputV1Schema : DeploymentDomainVerifyInputV1Schema;
        const original = schema.safeParse(input.rootInput);
        return input.rootActionId === child.actionId && original.success && original.data.serverId === child.input.serverId
            && original.data.environmentId === child.input.environmentId && original.data.domainId === child.input.domainId
            && child.expectedDomainRevision === (child.actionId === 'deployments.domains.verify'
                ? original.data.expectedDomainRevision : (original.data.expectedDomainRevision ?? 0) + 1);
    }
    if (input.rootActionId === 'deployments.templates.instantiate') {
        const original = DeploymentTemplateInstantiateInputV1Schema.safeParse(input.rootInput);
        if (!original.success || original.data.mode !== 'apply' || !original.data.deploy || child.actionId !== 'deployments.deploy') return false;
        const template = original.data;
        const requestKey = original.data.deploy.requestKey;
        return template.serverId === child.input.serverId
            && (template.environment.kind !== 'existing' || template.environment.environmentId === child.input.environmentId)
            && (template.target.kind !== 'existing' || template.target.targetLinkId === child.input.targetLinkId)
            && child.input.requestKey === requestKey;
    }
    if (child.actionId === 'deployments.deploy') {
        const semantic = DeploymentDeployIntentInputV1Schema.safeParse(input.rootInput);
        if (semantic.success) {
            // Preparation retains every private semantic operand. The receiver
            // proves an omitted runtime link against the current Environment.
            if (child.kind === 'prepare') return sameStrictJsonValue({ ...semantic.data,
                targetLinkId: semantic.data.targetLinkId ?? child.input.targetLinkId }, child.input);
            // This admits transport only. The receiver binds source content
            // from the candidate/current receipt before any native work.
            return semantic.data.serverId === child.input.serverId
                && semantic.data.environmentId === child.input.environmentId
                && (semantic.data.targetLinkId === undefined || semantic.data.targetLinkId === child.input.targetLinkId)
                && (semantic.data.requestKey === undefined || semantic.data.requestKey === child.input.requestKey)
                && (semantic.data.whenBusy ?? 'refuse') === (child.input.whenBusy ?? 'refuse');
        }
        const original = DeploymentDeployInputV1Schema.safeParse(input.rootInput);
        if (!original.success) return false;
        return child.kind === 'prepare' ? sameStrictJsonValue(child.input, {
            serverId: original.data.serverId, environmentId: original.data.environmentId, targetLinkId: original.data.targetLinkId,
        }) : sameStrictJsonValue(original.data, child.input);
    }
    if (child.actionId === 'deployments.rollback') {
        const semantic = DeploymentRollbackIntentInputV1Schema.safeParse(input.rootInput);
        if (semantic.success) return semantic.data.serverId === child.input.serverId
            && semantic.data.environmentId === child.input.environmentId
            && semantic.data.deploymentId === child.input.deploymentId
            && semantic.data.restoreBackupId === child.input.restoreBackupId
            && (semantic.data.requestKey === undefined || semantic.data.requestKey === child.input.requestKey);
        const original = DeploymentRollbackInputV1Schema.safeParse(input.rootInput);
        return original.success && sameStrictJsonValue(original.data, child.input);
    }
    const semantic = DeploymentPromoteIntentInputV1Schema.safeParse(input.rootInput);
    // Transport preserves the original selection. The receiver proves the
    // prepared candidate and current destination/link through its existing owner.
    if (semantic.success) return semantic.data.serverId === child.input.serverId
        && semantic.data.environmentId === child.input.environmentId
        && semantic.data.sourceEnvironmentId === child.input.sourceEnvironmentId
        && semantic.data.sourceDeploymentId === child.input.sourceDeploymentId
        && semantic.data.artifact === child.input.artifact
        && (semantic.data.requestKey === undefined || semantic.data.requestKey === child.input.requestKey);
    const original = DeploymentPromoteInputV1Schema.safeParse(input.rootInput);
    if (!original.success) return false;
    // Promotion preparation alone derives these immutable references. The
    // receiver proves their contents with the canonical promotion derivation.
    const stable = ({ contentArtifactId: _artifact, contentHeaderVersion: _header,
        contentBodyVersion: _body, destinationContent: _destination, ...value }:
        z.infer<typeof DeploymentPromoteInputV1Schema>) => value;
    return sameStrictJsonValue(stable(original.data), stable(child.input));
}

/** Closed transport grammar only; Home and the installed receiver still prove current custody. */
export function readDeploymentChildRpcV1(input: Readonly<{
    rootActionId: string; effectActionId: string; method: string; params: unknown;
    deploymentChildRoot?: true;
    rootPreparationAdmission?: DeploymentPreparationAdmissionV1; reviewedChild?: ReviewedActionChildHttpProofV1;
}>): DeploymentChildRpcV1 | null {
    const effect = deploymentChildEffectActionIdForRootV1(input.rootActionId, input.rootPreparationAdmission, input.effectActionId);
    if (input.deploymentChildRoot !== true || input.effectActionId !== effect
        || input.method !== RPC_METHODS.DAEMON_DEPLOYMENT_CHILD) return null;
    const parsed = DeploymentChildRpcV1Schema.safeParse(input.params);
    return parsed.success && parsed.data.actionId === input.effectActionId ? parsed.data : null;
}
