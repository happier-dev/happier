import type { ActionExecutorContext } from '@happier-dev/protocol';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentObservationGetInputV1Schema,
    DeploymentObservationGetResultV1Schema, DeploymentReceiptGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentTargetLinkArtifactV1, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
import type { z } from 'zod/mini';
import { openDeploymentReceiptForHost } from './readReceiptForHost';

/** Expose only recorded observation identities through the deployment read owner.
 * Metadata admits the exact Environment, Link and receipt before private content opens. */
export async function readDeploymentObservationForHost(
    input: z.infer<typeof DeploymentObservationGetInputV1Schema>, context: ActionExecutorContext,
    host: Readonly<{
        readEnvironment(environmentId: string, context: ActionExecutorContext): Promise<Extract<z.infer<typeof DeploymentEnvironmentGetResultV1Schema>, { ok: true }>>;
        readReceipt(environmentId: string, deploymentId: string, context: ActionExecutorContext): Promise<Extract<z.infer<typeof DeploymentReceiptGetResultV1Schema>, { ok: true }>>;
        open(artifactId: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null>;
        assertCurrent(context: ActionExecutorContext): Promise<void>;
    }>,
): Promise<z.infer<typeof DeploymentObservationGetResultV1Schema>> {
    const detail = await host.readEnvironment(input.environmentId, context);
    const mismatch = () => { throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' }); };
    if (detail.environment.id !== input.environmentId) return mismatch();
    if (!detail.environment.capabilities.read) return { ok: false, error: 'deployment_access_denied' };
    const targetLink = detail.targetLinks.find(link => link.id === input.targetLinkId);
    if (!targetLink || targetLink.environmentId !== input.environmentId) return mismatch();
    const receipt = input.deploymentId === undefined ? undefined
        : (await host.readReceipt(input.environmentId, input.deploymentId, context)).deployment;
    if (receipt && (receipt.id !== input.deploymentId || receipt.environmentId !== input.environmentId
        || receipt.targetLinkId !== input.targetLinkId)) return mismatch();
    const link = readDeploymentTargetLinkArtifactV1(targetLink, await host.open(targetLink.contentArtifactId, context));
    if (!link.ok) return { ok: false, error: link.error };
    if (!link.content.credentialPrincipal) return { ok: false, error: 'deployment_content_unavailable' };
    const opened = receipt && await openDeploymentReceiptForHost(receipt, context, host);
    const providerDeploymentId = opened?.content.platform?.observation.providerDeploymentId;
    if (receipt && !providerDeploymentId) return { ok: false, error: 'deployment_content_unavailable' };
    if (!receipt) await host.assertCurrent(context);
    return { ok: true, environment: detail.environment, targetLink, credentialPrincipal: link.content.credentialPrincipal,
        ...(receipt && providerDeploymentId ? { receipt: { deployment: receipt, providerDeploymentId } } : {}) };
}
