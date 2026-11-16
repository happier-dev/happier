import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentObservationGetInputV1Schema,
    DeploymentObservationGetResultV1Schema, DeploymentReceiptGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { readDeploymentTargetLinkArtifactV1, type DeploymentArtifactDocumentV1 } from '@happier-dev/deployment-protocol';
import type { z } from 'zod/mini';
import { openDeploymentReceiptForHost } from './readReceiptForHost';

/** Native rollout owns own-server settlement; provider observations are not available there. */
export function readDeploymentObservationTargetFailure(targetKind: string): ActionExecuteFailure | null {
    if (targetKind !== 'ownServer') return null;
    return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action', effectAttempted: false,
        details: { reason: 'target_not_supported', targetKind, requiredFact: 'providerDeploymentObservation',
            supportedAction: 'deployments.receipts.get',
            remedy: 'Own-server targets do not produce provider deployment observations. Use deployments.receipts.get for the recorded receipt (deployments.receipts.list to find one), or deployments.health.read and deployments.logs.read for native runtime state.' } };
}

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
): Promise<z.infer<typeof DeploymentObservationGetResultV1Schema> | ActionExecuteFailure> {
    const detail = await host.readEnvironment(input.environmentId, context);
    const mismatch = () => { throw createActionExecuteFailureError({ ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' }); };
    if (detail.environment.id !== input.environmentId) return mismatch();
    if (!detail.environment.capabilities.read) return { ok: false, error: 'deployment_access_denied' };
    const targetLink = detail.targetLinks.find(link => link.id === input.targetLinkId);
    if (!targetLink || targetLink.environmentId !== input.environmentId) return mismatch();
    const receipt = input.deploymentId === undefined ? undefined
        : (await host.readReceipt(input.environmentId, input.deploymentId, context)).deployment;
    if (receipt && (receipt.id !== input.deploymentId || receipt.environmentId !== input.environmentId
        || receipt.targetLinkId !== input.targetLinkId)) return mismatch();
    const targetFailure = readDeploymentObservationTargetFailure(targetLink.targetKind);
    if (targetFailure) return targetFailure;
    const link = readDeploymentTargetLinkArtifactV1(targetLink, await host.open(targetLink.contentArtifactId, context));
    if (!link.ok) return link;
    if (!link.content.credentialPrincipal) return { ok: false, error: 'deployment_content_unavailable' };
    const opened = receipt && await openDeploymentReceiptForHost(receipt, context, host);
    const providerDeploymentId = opened?.content.platform?.observation.providerDeploymentId;
    if (receipt && !providerDeploymentId) return { ok: false, error: 'deployment_content_unavailable' };
    if (!receipt) await host.assertCurrent(context);
    return { ok: true, environment: detail.environment, targetLink, credentialPrincipal: link.content.credentialPrincipal,
        ...(receipt && providerDeploymentId ? { receipt: { deployment: receipt, providerDeploymentId } } : {}) };
}
