import type { ActionExecutorContext, DeploymentReceiptGetResultV1Schema } from '@happier-dev/protocol';
import { readDeploymentReceiptArtifactV1, type DeploymentArtifactDocumentV1, type DeploymentReceiptDetailV1,
    type DeploymentReceiptHeaderV1, DeploymentOwnServerContentV1Schema, isDeploymentSettledV1 } from '@happier-dev/deployment-protocol';
import { DeploymentReceiptListResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';

/** Incumbent history pager shared by member-version and finite health reads.
 * Settled headers are immutable; live receipts and conflicted headers reopen
 * through the canonical exact current reader, never a second artifact store. */
export async function* readOwnServerDeploymentReceiptHistoryForHost(input: Readonly<{
    environmentId: string;
    lineage: ReadonlySet<string>;
    readPage(cursor?: string): Promise<unknown>;
    readCurrent(deploymentId: string): Promise<DeploymentReceiptDetailV1>;
    open(deployment: DeploymentReceiptHeaderV1): Promise<DeploymentReceiptDetailV1>;
}>) {
    let cursor: string | undefined;
    for (;;) {
        const page = DeploymentReceiptListResultV1Schema.parse(await input.readPage(cursor));
        if (!page.ok) throw Object.assign(new Error(page.error), { code: page.error });
        for (const deployment of page.items) {
            if (deployment.environmentId !== input.environmentId || !input.lineage.has(deployment.targetLinkId)) continue;
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
        if (!page.nextCursor) return;
        cursor = page.nextCursor;
    }
}

/** One mode-correct private receipt opener for exact execution/history reads.
 * Storage and Artifact authorization remain with their existing caller. */
export async function openDeploymentReceiptForHost(deployment: DeploymentReceiptHeaderV1,
    context: ActionExecutorContext, host: Readonly<{
        open(artifactId: string, context: ActionExecutorContext): Promise<DeploymentArtifactDocumentV1 | null>;
        assertCurrent(context: ActionExecutorContext): Promise<void>;
    }>): Promise<DeploymentReceiptDetailV1> {
    const content = readDeploymentReceiptArtifactV1(deployment, await host.open(deployment.contentArtifactId, context));
    if (!content.ok) throw Object.assign(new Error(content.error), { code: content.error });
    await host.assertCurrent(context);
    return { deployment, content: content.content };
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
        throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
    }
    return openDeploymentReceiptForHost(detail.deployment, request.context, host);
}
