import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createManagedMachineV1BaseShape } from '../machines/managed/managedMachineV1.js';
import { PluginJsonValueV2Schema } from '../plugins/contributions/jsonSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
import type { DeploymentChildRpcV1 } from './deploymentChildRpcV1.js';
import { DeploymentDomainChildRoutingV1Schema, DeploymentDomainDiscoverChildRoutingV1Schema, DeploymentDomainReviewChildRoutingV1Schema } from './deploymentChildRpcV1.js';
import { isDeploymentDomainNativeAdmissionV1, projectDeploymentNativeAdmissionV1 } from './deploymentCandidatePublicationV1.js';
import { DeploymentTeardownStepV1Schema } from './deploymentTeardownRequestV1.js';

const common = { v: z.literal(1), actionId: z.enum(['deployments.deploy', 'deployments.rollback', 'deployments.promote']),
    machineId: id, installationId: id,
    promotion: z.optional(z.strictObject({ sourceEnvironmentId: id, sourceDeploymentId: id,
        artifact: z.enum(['image', 'rebuild']), destinationContent: DeploymentArtifactContentReferenceV1Schema })),
    input: z.strictObject({ serverId: id, environmentId: id, targetLinkId: id, expectedRevision: revision,
        expectedTargetLinkRevision: revision, requestKey: id, deploymentId: z.optional(id),
        ...DeploymentArtifactContentReferenceV1Schema.shape }) };

/** Non-content admission references beside E2EE params, authenticated by the incumbent source signature. */
export const DeploymentChildRoutingV1Schema = lazyZodSchema(() => {
    const managedFields = createManagedMachineV1BaseShape(PluginJsonValueV2Schema, PluginJsonValueV2Schema);
    return z.discriminatedUnion('kind', [
    z.strictObject({ v: z.literal(1), kind: z.literal('snapshot'), actionId: z.literal('deployments.backups.restore'),
        machineId: id, installationId: id, managedId: id, intentRevision: managedFields.intentRevision, actionOperationId: id,
        input: z.strictObject({ serverId: id, environmentId: id, targetLinkId: id, machineId: id,
            installationId: id, prepareOperationId: id, expectedRevision: revision }) }),
    z.strictObject({ v: z.literal(1), kind: z.literal('dataRole'), actionId: z.literal('deployments.bindings.set'),
        machineId: id, installationId: id, input: z.strictObject({ serverId: id, environmentId: id, expectedRevision: revision }),
        targetLinkId: id, deploymentId: id, service: id, candidateContent: z.optional(DeploymentArtifactContentReferenceV1Schema) }),
    DeploymentDomainChildRoutingV1Schema, DeploymentDomainDiscoverChildRoutingV1Schema, DeploymentDomainReviewChildRoutingV1Schema,
    z.strictObject({ v: z.literal(1), kind: z.literal('domainDns'), actionId: z.literal('deployments.domains.verify'),
        machineId: id, installationId: id, input: z.strictObject({ serverId: id, environmentId: id,
            targetLinkId: id, expectedRevision: revision, expectedTargetLinkRevision: revision, requestKey: id }) }),
    z.strictObject({ v: z.literal(1), kind: z.literal('teardown'), actionId: z.literal('deployments.teardown'),
        machineId: id, installationId: id, input: common.input, deploymentId: id, actionOperationId: id,
        step: DeploymentTeardownStepV1Schema, mode: z.enum(['observe', 'execute']) }),
    z.strictObject({ v: z.literal(1), kind: z.literal('prepare'), actionId: z.enum(['deployments.deploy', 'deployments.teardown']),
        machineId: id, installationId: id, input: z.strictObject({ serverId: id, environmentId: id, targetLinkId: id }),
        expectedRevision: revision, expectedTargetLinkRevision: revision }),
    z.strictObject({ ...common, kind: z.literal('review') }),
    z.strictObject({ ...common, kind: z.literal('build'), deploymentId: id, actionOperationId: id }),
    z.strictObject({ ...common, kind: z.literal('retention'), deploymentId: id, actionOperationId: id,
        settledTargetLinkRevision: revision, settledDeploymentRevision: revision, activeDeploymentId: id }),
    z.strictObject({ ...common, kind: z.literal('member'), deploymentId: id, actionOperationId: id,
        phase: z.enum(['activate', 'restore', 'observe', 'cleanup']), selectedDeploymentId: id }),
]).check(z.refine(value => value.kind !== 'member' || value.phase !== 'cleanup' || value.selectedDeploymentId === value.deploymentId),
    z.refine(value => value.kind === 'domainDns' || value.kind === 'snapshot' || value.kind === 'dataRole' || value.kind === 'domain' || value.kind === 'domainDiscover' || value.kind === 'domainReview' || value.kind === 'prepare' || value.kind === 'teardown' || (value.actionId === 'deployments.promote') === (value.promotion !== undefined)),
    z.refine(value => value.kind === 'domainDns' || value.kind === 'snapshot' || value.kind === 'dataRole' || value.kind === 'domain' || value.kind === 'domainDiscover' || value.kind === 'domainReview' || value.kind === 'prepare' || value.kind === 'teardown' || (value.actionId === 'deployments.rollback') === (value.input.deploymentId !== undefined)));
});
export type DeploymentChildRoutingV1 = z.infer<typeof DeploymentChildRoutingV1Schema>;

/** The sender and receiver derive one tuple from admitted work; callers cannot author another routing basis. */
export function projectDeploymentChildRoutingV1(job: DeploymentChildRpcV1): DeploymentChildRoutingV1 {
    if (job.kind === 'domainDns') {
        const { mode: _mode, content: _content, ...input } = job.input;
        return { v: job.v, kind: job.kind, actionId: job.actionId, machineId: job.machineId, installationId: job.installationId, input };
    }
    if (job.kind === 'snapshot') return { v: job.v, kind: job.kind, actionId: job.actionId,
        machineId: job.machineId, installationId: job.installationId, managedId: job.offer.managedId,
        intentRevision: job.offer.intentRevision, actionOperationId: job.actionOperationId,
        input: { serverId: job.input.serverId, environmentId: job.input.environmentId,
            targetLinkId: job.input.targetLinkId, machineId: job.input.machineId,
            installationId: job.input.installationId, prepareOperationId: job.input.prepareOperationId,
            expectedRevision: job.input.expectedRevision } };
    if (job.kind === 'dataRole') return { v: job.v, kind: job.kind, actionId: job.actionId,
        machineId: job.machineId, installationId: job.installationId,
        input: { serverId: job.input.serverId, environmentId: job.input.environmentId, expectedRevision: job.input.expectedRevision },
        targetLinkId: job.targetLinkId, deploymentId: job.deploymentId, service: job.service,
        ...('contentArtifactId' in job.input ? { candidateContent: {
            contentArtifactId: job.input.contentArtifactId, contentHeaderVersion: job.input.contentHeaderVersion,
            contentBodyVersion: job.input.contentBodyVersion } } : {}) };
    if (job.kind === 'domain') {
        const { topology: _privateTopology, cloudflareConnector: _privateConnector, ...routing } = job;
        return routing;
    }
    if (job.kind === 'domainDiscover') { const { telemetryApp: _privateApp, ...routing } = job; return routing; }
    if (job.kind === 'domainReview') {
        const { content: _content, ...input } = 'content' in job.input ? job.input : { ...job.input, content: undefined };
        const admitted = projectDeploymentNativeAdmissionV1(job.actionId, job.input);
        if (!isDeploymentDomainNativeAdmissionV1(admitted)) throw new Error('Missing Domain review operand digest');
        return { v: job.v, kind: job.kind, actionId: job.actionId, machineId: job.machineId, installationId: job.installationId,
            input, inputDigest: admitted.inputDigest,
            ...(job.telemetryMachineId ? { telemetryMachineId: job.telemetryMachineId } : {}) };
    }
    if (job.kind === 'prepare') return { v: job.v, kind: job.kind, actionId: job.actionId,
        machineId: job.machineId, installationId: job.installationId, input: {
            serverId: job.input.serverId, environmentId: job.input.environmentId, targetLinkId: job.input.targetLinkId },
        expectedRevision: job.expectedRevision, expectedTargetLinkRevision: job.expectedTargetLinkRevision };
    const { serverId, environmentId, targetLinkId, expectedRevision, expectedTargetLinkRevision, requestKey,
        contentArtifactId, contentHeaderVersion, contentBodyVersion } = job.input;
    if (job.kind === 'teardown') return { v: job.v, kind: job.kind, actionId: job.actionId,
        machineId: job.machineId, installationId: job.installationId,
        input: { serverId, environmentId, targetLinkId, expectedRevision, expectedTargetLinkRevision, requestKey,
            contentArtifactId, contentHeaderVersion, contentBodyVersion },
        deploymentId: job.deploymentId, actionOperationId: job.actionOperationId, step: job.step, mode: job.mode };
    const common = { v: job.v, actionId: job.actionId, machineId: job.machineId, installationId: job.installationId,
        ...(job.actionId === 'deployments.promote' ? { promotion: { sourceEnvironmentId: job.input.sourceEnvironmentId,
            sourceDeploymentId: job.input.sourceDeploymentId, artifact: job.input.artifact,
            destinationContent: job.input.destinationContent } } : {}),
        input: { serverId, environmentId, targetLinkId, expectedRevision, expectedTargetLinkRevision, requestKey,
            ...(job.actionId === 'deployments.rollback' ? { deploymentId: job.input.deploymentId } : {}),
            contentArtifactId, contentHeaderVersion, contentBodyVersion } };
    return job.kind === 'review' ? { ...common, kind: job.kind }
        : job.kind === 'retention' ? { ...common, kind: job.kind, deploymentId: job.deploymentId, actionOperationId: job.actionOperationId,
            settledTargetLinkRevision: job.settledTargetLinkRevision,
            settledDeploymentRevision: job.settledDeploymentRevision, activeDeploymentId: job.activeDeploymentId }
        : job.kind === 'build' ? { ...common, kind: job.kind, deploymentId: job.deploymentId, actionOperationId: job.actionOperationId }
            : { ...common, kind: job.kind, deploymentId: job.deploymentId, actionOperationId: job.actionOperationId,
                phase: job.phase, selectedDeploymentId: job.selectedDeploymentId };
}
