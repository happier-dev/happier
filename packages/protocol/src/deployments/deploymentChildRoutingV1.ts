import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentArtifactContentReferenceV1Schema } from './deploymentArtifactContentReferenceV1.js';
import type { DeploymentChildRpcV1 } from './deploymentChildRpcV1.js';
import { DeploymentDomainChildRoutingV1Schema, DeploymentDomainDiscoverChildRpcV1Schema } from './deploymentChildRpcV1.js';

const common = { v: z.literal(1), actionId: z.enum(['deployments.deploy', 'deployments.rollback', 'deployments.promote']),
    machineId: id, installationId: id,
    promotion: z.optional(z.strictObject({ sourceEnvironmentId: id, sourceDeploymentId: id,
        artifact: z.enum(['image', 'rebuild']), destinationContent: DeploymentArtifactContentReferenceV1Schema })),
    input: z.strictObject({ serverId: id, environmentId: id, targetLinkId: id, expectedRevision: revision,
        expectedTargetLinkRevision: revision, requestKey: id, deploymentId: z.optional(id),
        ...DeploymentArtifactContentReferenceV1Schema.shape }) };

/** Non-content admission references beside E2EE params, authenticated by the incumbent source signature. */
export const DeploymentChildRoutingV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
    DeploymentDomainChildRoutingV1Schema, DeploymentDomainDiscoverChildRpcV1Schema,
    z.strictObject({ v: z.literal(1), kind: z.literal('prepare'), actionId: z.literal('deployments.deploy'),
        machineId: id, installationId: id, input: z.strictObject({ serverId: id, environmentId: id, targetLinkId: id }),
        expectedRevision: revision, expectedTargetLinkRevision: revision }),
    z.strictObject({ ...common, kind: z.literal('review') }),
    z.strictObject({ ...common, kind: z.literal('build'), deploymentId: id, actionOperationId: id }),
    z.strictObject({ ...common, kind: z.literal('retention'), deploymentId: id, actionOperationId: id,
        settledTargetLinkRevision: revision, settledDeploymentRevision: revision, activeDeploymentId: id }),
    z.strictObject({ ...common, kind: z.literal('member'), deploymentId: id, actionOperationId: id,
        phase: z.enum(['activate', 'restore', 'observe', 'cleanup']), selectedDeploymentId: id }),
]).check(z.refine(value => value.kind !== 'member' || value.phase !== 'cleanup' || value.selectedDeploymentId === value.deploymentId),
    z.refine(value => value.kind === 'domain' || value.kind === 'domainDiscover' || value.kind === 'prepare' || (value.actionId === 'deployments.promote') === (value.promotion !== undefined)),
    z.refine(value => value.kind === 'domain' || value.kind === 'domainDiscover' || value.kind === 'prepare' || (value.actionId === 'deployments.rollback') === (value.input.deploymentId !== undefined))));
export type DeploymentChildRoutingV1 = z.infer<typeof DeploymentChildRoutingV1Schema>;

/** The sender and receiver derive one tuple from admitted work; callers cannot author another routing basis. */
export function projectDeploymentChildRoutingV1(job: DeploymentChildRpcV1): DeploymentChildRoutingV1 {
    if (job.kind === 'domain') {
        const { topology: _privateTopology, cloudflareConnector: _privateConnector, ...routing } = job;
        return routing;
    }
    if (job.kind === 'domainDiscover') return job;
    if (job.kind === 'prepare') return { v: job.v, kind: job.kind, actionId: job.actionId,
        machineId: job.machineId, installationId: job.installationId, input: {
            serverId: job.input.serverId, environmentId: job.input.environmentId, targetLinkId: job.input.targetLinkId },
        expectedRevision: job.expectedRevision, expectedTargetLinkRevision: job.expectedTargetLinkRevision };
    const { serverId, environmentId, targetLinkId, expectedRevision, expectedTargetLinkRevision, requestKey,
        contentArtifactId, contentHeaderVersion, contentBodyVersion } = job.input;
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
