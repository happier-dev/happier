import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ActionExecutorContext, DeploymentPendingDeployV1 } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { createActionOperationCancellationFixture } from '@/daemon/actionOperations/actionOperationCancellation.testkit';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { configuration } from '@/configuration';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { artifactReadResponse } from '@/testkit/http/artifactHome';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createOwnServerDockerBoundary } from './targets/ownServer/ownServerDeployment.testkit';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';

// Reload is represented by an empty real runner and an already persisted intent.
// Only Home HTTP and the Docker executable are substituted.
it('re-admits an encrypted cold pending intent through compact Deploy and clears it through public cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-pending-cold-'));
    const detail = createDeploymentEnvironmentDetailV1();
    const receipt = createDeploymentReceiptDetailV1();
    const serverId = 'srv_pending_cold';
    const machineId = 'machine-a';
    const accountId = 'custodian';
    const operationId = 'retained-cold-operation';
    let installationId = '';
    const scope = { accountId, machineId };
    const operations = createHostActionOperationRuntime({ serverId, machineId, resolveAccountId: async () => accountId,
        custodyBinding: { serverId, get installationId() { return installationId; } },
        generateOperationId: () => 'unrelated-new-operation' });
    const environment = { ...detail.environment, serverId, controllerMachineId: machineId, buildMachineId: machineId,
        owner: { kind: 'account' as const, accountId } };
    const link = detail.targetLinks[0].targetLink;
    const input = { serverId, environmentId: environment.id, targetLinkId: link.id,
        requestKey: 'retained-cold-request', whenBusy: 'supersede' as const };
    const key = new Uint8Array(32).fill(37);
    let dataEncryptionKey = ARTIFACT_PLAIN_DATA_KEY_MARKER;
    const encode = (value: unknown) => encodeBase64(encryptWithDataKey(value, key));
    let pendingDeploy: DeploymentPendingDeployV1 | undefined;
    let revision = environment.revision;
    let definition = detail.content.definition;
    const documents = new Map<string, { id: string } & Record<string, unknown>>();
    const readRow = (id: string): ({ id: string } & Record<string, unknown>) | null => documents.get(id) ?? ([environment.contentArtifactId, link.contentArtifactId,
        receipt.deployment.contentArtifactId].includes(id) ? { id, ownerAccountId: accountId, access: 'owner', publicAudience: 'none',
        encryptionMode: 'e2ee', dataEncryptionKey,
        header: encode({ kind: id === environment.contentArtifactId ? 'deployment-environment.v1'
            : id === link.contentArtifactId ? 'deployment-target-link.v1' : 'deployment-receipt.v1', title: 'Fixture' }),
        body: encode({ body: JSON.stringify(id === environment.contentArtifactId ? { ...detail.content, definition }
            : id === link.contentArtifactId ? {} : receipt.content) }),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } : null);
    const writes: unknown[] = [];
    const clears: unknown[] = [];
    const unmatched = new Map<string, number>();
    const httpCalls: string[] = [];
    const fixture = await createActionOperationCancellationFixture({ mode: 'e2ee', accountId,
        actionId: 'deployments.deploy', actionInput: input, admittedMachineRole: 'manage',
        deploymentCandidateSource: { id: environment.projectSourceId, revision: 1 },
        address: { serverId, machineId, operationId }, store: operations.store, runner: operations.runner,
        async requestHttp(request) {
            const path = new URL(request.url).pathname;
            httpCalls.push(`${request.method} ${path}`);
            if (request.method === 'GET' && path === '/v1/account/encryption') return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
            if (request.method === 'GET' && path === `/v1/deployments/environments/${environment.id}`) return { status: 200, data: {
                ok: true, environment: { ...environment, revision }, targetLinks: [{ ...link, machines: [machineId],
                    members: [{ ...link.members[0]!, machineId, installationId }] }],
                ...(pendingDeploy ? { pendingDeploy, pendingAdmission: { requesterAccountId: accountId, serverId,
                    requestKey: input.requestKey, actionOperationId: operationId, controller: { machineId, installationId },
                    environmentRevision: revision } } : {}),
            } };
            if (request.method === 'GET' && path.endsWith('/deployments')) return { status: 200, data: {
                ok: true, items: [{ ...receipt.deployment, state: 'running' }], nextCursor: null,
            } };
            if (request.method === 'GET' && path === `/v1/deployments/receipts/${receipt.deployment.id}`) return {
                status: 200, data: { ok: true, deployment: receipt.deployment },
            };
            if (request.method === 'GET' && path.startsWith('/v1/artifacts/')) {
                const id = path.split('/')[3]!;
                const row = readRow(id);
                if (!row) return { status: 404, data: {} };
                return { status: 200, data: path.endsWith('/recipients') ? { artifactId: id, ownerAccountId: accountId,
                    access: 'owner', encryptionMode: 'e2ee', dataEncryptionKey: row.dataEncryptionKey,
                    callerDataEncryptionKey: row.dataEncryptionKey,
                    provenanceDataEncryptionKey: row.provenanceDataEncryptionKey,
                    callerProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey, recipients: [] } : row };
            }
            if (request.method === 'POST' && path === '/v1/artifacts/read') return artifactReadResponse(request.body, readRow);
            if (request.method === 'POST' && path.startsWith('/v1/artifacts')) {
                const mutation = readCarrierMutation(request.body);
                const id = typeof mutation.id === 'string' ? mutation.id : path.split('/').at(-1)!;
                const prior = documents.get(id);
                const version = Number(prior?.bodyVersion ?? 0) + 1;
                documents.set(id, { ...prior, ...mutation, id, ownerAccountId: accountId, access: 'owner', publicAudience: 'none',
                    encryptionMode: 'e2ee', headerVersion: version, bodyVersion: version, seq: version, createdAt: 1, updatedAt: version });
                return { status: 200, data: { id, success: true, headerVersion: version, bodyVersion: version } };
            }
            if (request.method === 'POST' && path === `/v1/deployments/environments/${environment.id}/deploy`) {
                writes.push(request.body);
                return { status: 200, data: { ok: true, environmentId: environment.id, revision,
                    kind: 'pending', actionOperationId: operationId } };
            }
            if (request.method === 'POST' && path.endsWith('/secret-launch-admission')) return {
                status: 200, data: { ok: true, grants: [] },
            };
            if (request.method === 'POST' && path.endsWith('/pending/cancel')) {
                clears.push(request.body); pendingDeploy = undefined; revision++;
                return { status: 200, data: { ok: true, environmentId: environment.id, revision } };
            }
            const name = `${request.method} ${path}`;
            unmatched.set(name, (unmatched.get(name) ?? 0) + 1);
            return undefined;
        } });
    installationId = fixture.installation.installationId;
    await adoptServerProfileHomeConnectionDescriptor({ observation: 'exact', createIfMissing: true,
        descriptor: { v: 1, homeServerIdentityId: serverId, canonicalServerUrl: 'https://cancel-home.invalid', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://cancel-home.invalid' }] } });
    if (fixture.credentials.encryption?.type !== 'dataKey') throw new Error('Expected encrypted requester');
    dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
        recipientPublicKey: fixture.credentials.encryption.publicKey, randomBytes: size => new Uint8Array(size).fill(17) }));
    fixture.setAccountSettings({ actionsSettingsV1: setActionApprovalOverride({ settings: normalizeActionsSettingsV1(null),
        actionId: 'deployments.deploy', surface: 'ui', approvalRequired: false }) });
    const mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
        controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
    const previousPath = process.env.PATH;
    let fresh: Awaited<ReturnType<typeof fixture.prepareRoot>> = null;
    try {
        const docker = await createOwnServerDockerBoundary(directory);
        const image = await docker.registerImage('app', 'retained');
        const document = JSON.stringify({ services: { app: { image: image.registryReference } } });
        definition = { kind: 'stored', contentRevision: 1, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] };
        pendingDeploy = { t: 'encrypted', c: encode({ sourceIntent: definition, requestKey: input.requestKey,
            targetLinkId: link.id, actionOperationId: operationId }) };
        const retained = pendingDeploy;
        vi.stubEnv('PATH', `${directory}${delimiter}${previousPath ?? ''}`);
        fresh = await fixture.prepareRoot();
        expect(fresh, JSON.stringify(fixture.diagnostics)).not.toBeNull();
        if (!fresh) throw new Error('Fresh requester unavailable');
        const requester = readRequesterAccountActionContext(fresh.authorization);
        if (!requester) throw new Error('Fresh requester custody unavailable');
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: requester.credentials, serverId,
            serverHttpBaseUrl: requester.serverHttpBaseUrl, machineId,
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            acquirePluginRuntimeRegistryLease: async () => mounted.lease });
        const deps = createDaemonDeploymentActionDeps({ credentials: requester.credentials, serverId,
            serverHttpBaseUrl: requester.serverHttpBaseUrl, machineId, runtime,
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            preparePendingDeploymentObservation: operations.preparePendingDeploymentObservation });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps, serverId, machineId,
            runActionOperation: operation => operations.runActionOperation({ ...operation,
                recoverPendingDeployment: () => deps.readPendingDeploymentRecovery(operation.input, operation.context) }) });
        const context: ActionExecutorContext = { authority: 'present_user', actionCaller: { kind: 'ui' }, surface: 'ui', serverId,
            externalActionExecutionAuthorization: fresh.authorization, originalActionEnvelope: fixture.envelope,
            actionsSettings: requester.accountSettingsContext.settings.actionsSettingsV1 };
        expect(operations.store.get(scope, operationId)).toBeNull();
        const result = await executor.execute('deployments.deploy', input, context);
        expect(result, JSON.stringify({ ok: result.ok, ...(!result.ok ? { code: result.errorCode } : {}), unmatched: [...unmatched], httpCalls }))
            .toMatchObject({ ok: true, result: { kind: 'pending', actionOperationId: operationId,
                operation: { serverId, machineId, operationId } } });
        expect(operations.store.get(scope, 'unrelated-new-operation')).toBeNull();
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ pendingDeploy: retained, requestKey: input.requestKey, actionOperationId: operationId });
        expect(await fixture.cancel(operationId), JSON.stringify(fixture.diagnostics)).toEqual({ kind: 'requested' });
        expect(clears).toEqual([{ serverId, environmentId: environment.id, expectedRevision: revision - 1,
            actionOperationId: operationId, pendingDeploy: retained }]);
        expect(pendingDeploy).toBeUndefined();
        await expect(operations.runner.waitForTerminal(scope, operationId, undefined, true)).resolves.toMatchObject({ state: 'cancelled' });
        expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(false);
    } finally {
        operations.runner.cancel(scope, operationId);
        await operations.runner.waitForTerminal(scope, operationId, undefined, true);
        await fresh?.dispose(); await mounted.dispose();
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        await rm(directory, { recursive: true, force: true });
    }
}, 120_000);
