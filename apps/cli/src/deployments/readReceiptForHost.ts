import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { refuseDeploymentArtifactRead } from '@/deployments/deploymentFailure';
import type { ActionExecutorContext, DeploymentReceiptGetResultV1Schema } from '@happier-dev/protocol';
import { readDeploymentReceiptArtifactV1 } from '@happier-dev/deployment-protocol';
import { type DeploymentReceiptDetailV1, type DeploymentReceiptHeaderV1, DeploymentOwnServerContentV1Schema, isDeploymentSettledV1, projectDeploymentCancellationConsequenceV1 } from '@happier-dev/deployments/contracts/v1';
import { type DeploymentArtifactDocumentV1 } from '@happier-dev/deployments';
import { DeploymentReceiptListResultV1Schema, hasDeploymentReceiptContentV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { deploymentArtifactReadFailureV1 } from '@happier-dev/protocol/deployments/deploymentArtifactContentReferenceV1';

type ReceiptHistoryPages = Readonly<{
    environmentId: string;
    lineage?: ReadonlySet<string>;
    readPage(cursor?: string): Promise<unknown>;
}>;

export async function* readDeploymentReceiptHistoryHeadersForHost(input: ReceiptHistoryPages) {
    let cursor: string | undefined;
    for (;;) {
        const page = DeploymentReceiptListResultV1Schema.parse(await input.readPage(cursor));
        if (!page.ok) throw createActionExecuteFailureError({ ok: false, errorCode: page.error, error: page.error });
        for (const deployment of page.items) {
            if (deployment.environmentId !== input.environmentId || input.lineage && !input.lineage.has(deployment.targetLinkId)) continue;
            yield deployment;
        }
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
    }
}

/** Settled headers are immutable; live receipts and conflicted headers reopen
 * through the canonical exact current reader. */
export async function* readOwnServerDeploymentReceiptHistoryForHost(input: ReceiptHistoryPages & Readonly<{
    readCurrent(deploymentId: string): Promise<DeploymentReceiptDetailV1>;
    open(deployment: DeploymentReceiptHeaderV1): Promise<DeploymentReceiptDetailV1>;
}>) {
    for await (const deployment of readDeploymentReceiptHistoryHeadersForHost(input)) {
        if (!hasDeploymentReceiptContentV1(deployment)) continue;
        let receipt: DeploymentReceiptDetailV1;
        if (deployment.operation === 'teardown' || !isDeploymentSettledV1(deployment.state)) {
            receipt = await input.readCurrent(deployment.id);
        } else {
            try { receipt = await input.open(deployment); }
            catch (error) {
                if (!(error instanceof Error) || !('code' in error) || error.code !== 'deployment_conflict') throw error;
                receipt = await input.readCurrent(deployment.id);
            }
        }
        yield { ...receipt, content: DeploymentOwnServerContentV1Schema.parse(receipt.content) };
    }
}

/** One mode-correct private receipt opener for exact execution/history reads.
 * Storage and Artifact authorization remain with their existing caller. */
export async function openDeploymentReceiptForHost(deployment: DeploymentReceiptHeaderV1,
    context: ActionExecutorContext, host: Readonly<{
        open(artifactId: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null>;
        assertCurrent(context: ActionExecutorContext): Promise<void>;
    }>): Promise<DeploymentReceiptDetailV1> {
    if (!hasDeploymentReceiptContentV1(deployment)) return refuseDeploymentArtifactRead(deploymentArtifactReadFailureV1('missing'));
    const content = readDeploymentReceiptArtifactV1(deployment, await host.open(deployment.contentArtifactId, context));
    if (!content.ok) return refuseDeploymentArtifactRead(content);
    await host.assertCurrent(context);
    const receipt = { deployment, content: content.content };
    const cancellationConsequence = projectDeploymentCancellationConsequenceV1(receipt);
    return { ...receipt, ...(cancellationConsequence ? { cancellationConsequence } : {}) };
}

export async function readDeploymentReceiptForHost(
    request: Readonly<{ environmentId: string; deploymentId: string; context: ActionExecutorContext }>,
    host: Parameters<typeof openDeploymentReceiptForHost>[2] & Readonly<{
        readMetadata(request: Readonly<{ environmentId: string; deploymentId: string; context: ActionExecutorContext }>):
            Promise<Extract<import('zod/mini').infer<typeof DeploymentReceiptGetResultV1Schema>, { ok: true }>>;
    }>,
): Promise<DeploymentReceiptDetailV1> {
    const detail = await host.readMetadata(request);
    if (detail.deployment.id !== request.deploymentId || detail.deployment.environmentId !== request.environmentId) {
        throw createActionExecuteFailureError({ ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' });
    }
    return openDeploymentReceiptForHost(detail.deployment, request.context, host);
}
