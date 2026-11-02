import { z } from 'zod/mini';
import type { ReviewedActionChildHttpProofV1 } from '../actions/externalActionApi.js';
import { computeActionInputApprovalDigestV1 } from '../actions/decisionAuthority.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { RPC_METHODS } from '../rpc/methods.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentDeployInputV1Schema, DeploymentDeployIntentInputV1Schema, DeploymentRollbackInputV1Schema, DeploymentRollbackIntentInputV1Schema, DeploymentPromoteInputV1Schema, DeploymentPublishInputV1Schema } from './deploymentActionsV1.js';
import { isDeploymentChildRootActionIdV1, deploymentChildEffectActionIdForRootV1 } from './deploymentActionIdsV1.js';
import { DeploymentDomainAddInputV1Schema, DeploymentDomainRemoveInputV1Schema, DeploymentDomainVerifyInputV1Schema,
    DeploymentDomainPlacementV1Schema, DeploymentDomainTopologyV1Schema } from './deploymentDomainV1.js';
import type { DeploymentPreparationAdmissionV1 } from './deploymentPreparationAdmissionV1.js';
import { DeploymentTemplateInstantiateInputV1Schema } from './deploymentTemplateInstantiationV1.js';
export { isDeploymentChildRootActionIdV1, deploymentOperationForRootActionV1, deploymentChildEffectActionIdForRootV1,
    isDeploymentDomainChildActionIdV1, type DeploymentRootOperationV1, type DeploymentDomainChildActionIdV1 } from './deploymentActionIdsV1.js';

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
export const DeploymentDomainDiscoverChildRpcV1Schema = lazyZodSchema(() => z.strictObject({
    ...placement, kind: z.literal('domainDiscover'), actionId: z.literal('deployments.domains.add'), input: DeploymentDomainAddInputV1Schema,
}));
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
    z.strictObject({ ...placement, kind: z.literal('prepare'), actionId: z.literal('deployments.deploy'),
        input: z.safeExtend(DeploymentDeployIntentInputV1Schema, { targetLinkId: id }), expectedRevision: revision, expectedTargetLinkRevision: revision }),
    ...job._zod.def.options.map(shape => z.union(root._zod.def.options.map(action => z.strictObject({ ...shape.shape, ...action.shape })))),
]).check(z.refine(value => value.kind !== 'member' || value.phase !== 'cleanup' || value.selectedDeploymentId === value.deploymentId)));
export type DeploymentChildRpcV1 = z.infer<typeof DeploymentChildRpcV1Schema>;

/** Input derivation is separate from admission: Home and the receiver must still
 * prove the current parent receipt, operation, candidate and installed role. */
export function doesDeploymentChildInputMatchRootV1(input: Readonly<{
    rootInput: unknown; child: DeploymentChildRpcV1; rootActionId?: string;
    rootPreparationAdmission?: DeploymentPreparationAdmissionV1; reviewedChild?: ReviewedActionChildHttpProofV1;
}>): boolean {
    const child = input.child;
    if (input.rootActionId === 'deployments.environments.create') {
        if (deploymentChildEffectActionIdForRootV1(input.rootActionId, input.rootPreparationAdmission) !== 'deployments.domains.add'
            || input.reviewedChild?.actionId !== 'deployments.domains.add' || child.actionId !== 'deployments.domains.add') return false;
        if (child.kind === 'domainDiscover') return input.reviewedChild.inputDigest
            === computeActionInputApprovalDigestV1('deployments.domains.add', child.input);
        // Native continuation consumes Home's accepted Domain capture. Its
        // original exact operand was admitted by the signed HTTP child proof.
        return child.kind === 'domain';
    }
    if (child.kind === 'domainDiscover') {
        const original = DeploymentDomainAddInputV1Schema.safeParse(input.rootInput);
        return input.rootActionId === child.actionId && original.success && sameStrictJsonValue(original.data, child.input);
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
    if (input.rootActionId === 'deployments.publish') {
        const original = DeploymentPublishInputV1Schema.safeParse(input.rootInput);
        return original.success && child.actionId === 'deployments.deploy' && child.kind !== 'prepare'
            && sameStrictJsonValue(original.data.preparedChildren.deploy, child.input);
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
    rootPreparationAdmission?: DeploymentPreparationAdmissionV1; reviewedChild?: ReviewedActionChildHttpProofV1;
}>): DeploymentChildRpcV1 | null {
    const effect = deploymentChildEffectActionIdForRootV1(input.rootActionId, input.rootPreparationAdmission);
    if (!isDeploymentChildRootActionIdV1(input.rootActionId, input.rootPreparationAdmission) || input.effectActionId !== effect
        || input.method !== RPC_METHODS.DAEMON_DEPLOYMENT_CHILD) return null;
    const parsed = DeploymentChildRpcV1Schema.safeParse(input.params);
    return parsed.success && parsed.data.actionId === input.effectActionId ? parsed.data : null;
}
