import { expect, it, vi } from 'vitest';
import { DeploymentDeployInputV1Schema } from '@happier-dev/protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { waitForPendingDeploymentForHost } from './pendingDeploy';

// Socket observation is the network boundary; admission and the waiter stay real.
vi.mock('@/session/transport/socket/sessionSocketAgentState', () => ({
    observeSessionSocketEvents: (_connection: unknown, events: { onConnected(): void }) => {
        queueMicrotask(() => events.onConnected());
        return { async dispose() {} };
    },
}));

it.each([false, true])('accepted pending deploy consumes its captured intent once (replaced=%s)', async replaced => {
    const detail = createDeploymentEnvironmentDetailV1();
    const candidate = createDeploymentReceiptDetailV1();
    const link = detail.targetLinks[0]!.targetLink;
    const intent = { sourceIntent: candidate.content.sourceIntent, requestKey: 'pending-once',
        actionOperationId: 'pending-operation', targetLinkId: link.id };
    const pendingDeploy = { t: 'plain' as const, v: intent };
    const input = DeploymentDeployInputV1Schema.parse({ serverId: detail.environment.serverId,
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
        targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: intent.requestKey,
        contentArtifactId: candidate.deployment.contentArtifactId, contentHeaderVersion: candidate.deployment.contentHeaderVersion,
        contentBodyVersion: candidate.deployment.contentBodyVersion, whenBusy: 'supersede', pendingDeploy });
    let resourceReads = 0;
    const settled = { ok: true as const, environmentId: detail.environment.id, revision: detail.environment.revision,
        deploymentId: candidate.deployment.id, deploymentRevision: candidate.deployment.revision, state: 'running' as const };
    const host = {
        credentials: { token: 'unused-network-boundary', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        serverHttpBaseUrl: 'https://home.invalid', async assertCurrent() {}, async cancel() {},
        async readEnvironment() { return { ok: true, environment: detail.environment,
            targetLinks: detail.targetLinks.map(row => row.targetLink),
            pendingDeploy: replaced ? { ...pendingDeploy, v: { ...intent, requestKey: 'another-request' } } : pendingDeploy }; },
        async readResource() { resourceReads++; throw new Error('Approved intent must not be reopened'); },
        async readReceipts() { return { ok: true, items: [], nextCursor: null }; },
        async resume() { return settled; },
    } satisfies Parameters<typeof waitForPendingDeploymentForHost>[1] & { readResource(): Promise<never> };
    const result = waitForPendingDeploymentForHost({ input, context: {}, result: { ok: true, kind: 'pending',
        environmentId: detail.environment.id, revision: detail.environment.revision, actionOperationId: intent.actionOperationId } }, host);
    if (replaced) await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    else expect(await result).toEqual(settled);
    expect(resourceReads).toBe(0);
});
