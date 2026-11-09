import { expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { executeActionOperationActionV1 } from '@happier-dev/protocol/actions/executor/actionOperationActions';
import type { DeploymentPendingDeployV1 } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { createActionOperationCancellationFixture } from '@/daemon/actionOperations/actionOperationCancellation.testkit';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';

// The requester fixture supplies real encrypted custody, Socket.IO currentness,
// RPC admission and the operation owner. Only Home HTTP is substituted.
it.each(['plain', 'e2ee'] as const)('clears exact pending through the fresh cancellation root (%s)', async mode => {
    await exerciseCancellation(mode, 'accepted');
});

it.each(['clear refused', 'proof withdrawn after read', 'newer pending'] as const)(
    'keeps the accepted operation running when %s prevents protected cleanup', async outcome => {
        await exerciseCancellation('e2ee', outcome);
    },
);

async function exerciseCancellation(mode: 'plain' | 'e2ee', outcome: 'accepted' | 'clear refused' | 'proof withdrawn after read' | 'newer pending') {
    const detail = createDeploymentEnvironmentDetailV1();
    const receipt = createDeploymentReceiptDetailV1();
    const serverId = 'srv_cancel_pending';
    const operationId = 'pending-operation';
    const scope = { accountId: 'requester', machineId: 'machine' };
    const environment = { ...detail.environment, serverId, controllerMachineId: scope.machineId };
    const target = detail.targetLinks[0].targetLink;
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => operationId,
        resolveAction: actionId => ({ actionId, title: 'Deploy', operation: getActionSpec('deployments.deploy').operation }) });
    let retained: DeploymentPendingDeployV1 | undefined;
    let metadataRevision = environment.revision;
    let metadataReads = 0;
    let artifactOpens = 0;
    let receiptReads = 0;
    let cancellationStarted = false;
    const clearBodies: unknown[] = [];
    let fixture: Awaited<ReturnType<typeof createActionOperationCancellationFixture>> | undefined;
    let content: (value: unknown) => string = () => { throw new Error('Artifact codec not prepared'); };
    let dataEncryptionKey = ARTIFACT_PLAIN_DATA_KEY_MARKER;
    fixture = await createActionOperationCancellationFixture({ mode, accountId: scope.accountId,
        address: { serverId, machineId: scope.machineId, operationId }, store, runner,
        async requestHttp(request) {
            const url = new URL(request.url);
            if (request.method === 'GET' && url.pathname.startsWith('/v1/artifacts/')) {
                artifactOpens += 1;
                const isEnvironment = url.pathname.endsWith(`/${environment.contentArtifactId}`);
                return { status: 200, data: { id: isEnvironment ? environment.contentArtifactId : 'candidate',
                    ownerAccountId: scope.accountId, access: 'view', publicAudience: 'none', encryptionMode: mode,
                    dataEncryptionKey, header: content({ kind: isEnvironment ? 'deployment-environment.v1' : 'deployment-receipt.v1', title: 'Fixture' }),
                    body: content({ body: JSON.stringify(isEnvironment ? detail.content : receipt.content) }),
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
            }
            if (request.method === 'GET' && url.pathname === `/v1/deployments/environments/${environment.id}`) {
                metadataReads += 1;
                if (cancellationStarted && outcome === 'proof withdrawn after read') fixture?.setCurrent(false);
                return { status: 200, data: { ok: true, environment: { ...environment, revision: metadataRevision },
                    targetLinks: detail.targetLinks.map(item => item.targetLink), ...(retained ? { pendingDeploy: retained } : {}) } };
            }
            if (request.method === 'GET' && url.pathname.endsWith('/deployments')) {
                receiptReads += 1;
                return { status: 200, data: { ok: true, items: [{ ...receipt.deployment, state: 'running' }], nextCursor: null } };
            }
            if (request.method === 'POST' && url.pathname.endsWith('/pending/cancel')) {
                clearBodies.push(request.body);
                expect(request.options?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: fixture?.root.token });
                if (outcome === 'clear refused') return { status: 403, data: { ok: false, error: 'deployment_access_denied' } };
                retained = undefined;
                metadataRevision += 1;
                return { status: 200, data: { ok: true, environmentId: environment.id, revision: metadataRevision } };
            }
            if (request.method === 'POST' && url.pathname === `/v1/deployments/environments/${environment.id}/deploy`) {
                metadataRevision += 1;
                return { status: 200, data: { ok: true, environmentId: environment.id, revision: metadataRevision,
                    kind: 'pending', actionOperationId: operationId } };
            }
            return undefined;
        },
    });
    const resource = await createResourceDataKey({ credentials: fixture.credentials, mode });
    dataEncryptionKey = resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey;
    content = value => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : encodeBase64(encryptWithDataKey(value, resource.dataKey));
    const intent = { sourceIntent: receipt.content.sourceIntent, requestKey: 'request', targetLinkId: target.id,
        actionOperationId: operationId };
    const pendingDeploy: DeploymentPendingDeployV1 = resource.mode === 'plain' ? { t: 'plain', v: intent }
        : { t: 'encrypted', c: encodeBase64(encryptWithDataKey(intent, resource.dataKey)) };
    retained = pendingDeploy;
    const input = { serverId, environmentId: environment.id, expectedRevision: environment.revision,
        targetLinkId: target.id, expectedTargetLinkRevision: target.revision, requestKey: intent.requestKey,
        contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
        whenBusy: 'supersede' as const, pendingDeploy };
    const native = vi.fn(async () => { throw new Error('Pending cancellation cannot acquire native custody'); });
    const deps = createDaemonDeploymentActionDeps({
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
        credentials: fixture.credentials, serverId,
        serverHttpBaseUrl: 'https://cancel-home.invalid', machineId: scope.machineId, runtime: { acquire: native } });
    try {
        const accepted = await runner.observe({ actionId: 'deployments.deploy', scope, input, execute: async operation => {
            const result = await deps.deploymentAction('deployments.deploy', input, { signal: operation.signal,
                operationAcceptance: operation.operationAcceptance, operationOwnerUpdate: { update: operation.publishOwnerUpdate },
                operationCancellation: { onRequest: operation.onCancellationRequested } });
            return 'errorCode' in result ? result : { ok: true as const, result };
        } });
        expect(accepted, JSON.stringify({ errorCode: accepted.ok ? undefined : accepted.errorCode,
            metadataReads, artifactOpens, receiptReads }))
            .toMatchObject({ ok: true, result: { kind: 'pending', actionOperationId: operationId } });
        await vi.waitFor(() => expect(receiptReads).toBe(1));
        const opensBeforeCancellation = artifactOpens;
        const readsBeforeCancellation = metadataReads;
        if (outcome === 'newer pending') retained = resource.mode === 'plain'
            ? { t: 'plain', v: { ...intent, actionOperationId: 'newer-operation' } }
            : { t: 'encrypted', c: encodeBase64(encryptWithDataKey({ ...intent, actionOperationId: 'newer-operation' }, resource.dataKey)) };
        const before = retained;
        cancellationStarted = true;
        const cancel = fixture.cancel;
        if (outcome === 'accepted') {
            const result = await cancel(operationId);
            expect(result, JSON.stringify(fixture.diagnostics)).toEqual({ kind: 'requested' });
            expect(clearBodies).toEqual([{ serverId, environmentId: environment.id, expectedRevision: environment.revision + 1,
                actionOperationId: operationId, pendingDeploy }]);
            expect(retained).toBeUndefined();
            await expect(runner.waitForTerminal(scope, operationId, undefined, true)).resolves.toMatchObject({ state: 'cancelled' });
        } else {
            const errorCode = outcome === 'clear refused' ? 'deployment_access_denied'
                : outcome === 'newer pending' ? 'deployment_conflict' : 'action_forbidden';
            // Exercise the public Action adapter after the real RPC response;
            // an exception message alone must not erase the domain refusal code.
            await expect(executeActionOperationActionV1({ actionId: 'action.operations.cancel',
                input: { serverId, machineId: scope.machineId, operationId },
                transport: async () => cancel(operationId),
            })).rejects.toMatchObject({ rpcErrorCode: errorCode });
            expect(store.get(scope, operationId)).toMatchObject({ state: 'running' });
            expect(retained).toEqual(before);
            expect(clearBodies).toHaveLength(outcome === 'clear refused' ? 1 : 0);
        }
        expect(metadataReads).toBe(readsBeforeCancellation + 1);
        expect(artifactOpens).toBe(opensBeforeCancellation);
        expect(native).not.toHaveBeenCalled();
    } finally {
        runner.cancel(scope, operationId);
        await runner.waitForTerminal(scope, operationId, undefined, true);
    }
}
