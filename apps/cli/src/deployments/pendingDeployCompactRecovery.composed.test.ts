import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ActionExecutorContext, DeploymentSourceIntentV1 } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createActionOperationCancellationFixture } from '@/daemon/actionOperations/actionOperationCancellation.testkit';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { configuration } from '@/configuration';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readCompactPendingDeploymentRecovery } from './pendingDeploymentRecovery';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createOwnServerDockerBoundary } from './targets/ownServer/ownServerDeployment.testkit';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';

it.each([
    { sourceMethod: undefined, requestedSourceMethod: undefined, admittedMachineRole: 'manage', expectedError: 'deployment_conflict' },
    { sourceMethod: 'upload', requestedSourceMethod: 'upload', admittedMachineRole: 'use', expectedError: 'action_forbidden' },
    { sourceMethod: 'upload', requestedSourceMethod: undefined, admittedMachineRole: 'manage', expectedError: 'unsupported_action' },
    { sourceMethod: 'upload', requestedSourceMethod: 'gitIntegration', admittedMachineRole: 'manage', expectedError: 'deployment_conflict' },
    { sourceMethod: 'gitIntegration', requestedSourceMethod: undefined, admittedMachineRole: 'manage', expectedError: 'unsupported_action' },
] as const)('opens the retained compact source before candidate publication instead of preparing the latest stored definition (captured=$sourceMethod requested=$requestedSourceMethod)', async ({ sourceMethod, requestedSourceMethod, admittedMachineRole, expectedError }) => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-pending-compact-'));
    const detail = createDeploymentEnvironmentDetailV1();
    const serverId = 'srv_pending_compact';
    const machineId = 'machine-a';
    const accountId = 'custodian';
    const operationId = 'retained-compact-operation';
    const environment = { ...detail.environment, serverId, controllerMachineId: machineId, buildMachineId: machineId,
        owner: { kind: 'account' as const, accountId } };
    const link = detail.targetLinks[0].targetLink;
    const input = { serverId, environmentId: environment.id, targetLinkId: link.id, requestKey: 'retained-compact-request', whenBusy: 'supersede' as const,
        ...(requestedSourceMethod ? { sourceMethod: requestedSourceMethod } : {}) };
    let installationId = '';
    const candidatePublications: unknown[] = [];
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, resolveAction: () => null });
    const document = (image: string, contentRevision: number): DeploymentSourceIntentV1 => {
        const body = JSON.stringify({ services: { app: { image } } });
        return { kind: 'stored', contentRevision, document: body,
            composeDigest: `sha256:${createHash('sha256').update(body).digest('hex')}`, profiles: [], services: ['app'] };
    };
    let retained = document('registry.invalid/app:retained', 1);
    let current = document('registry.invalid/app:latest', 2);
    const readMetadata = () => ({ ok: true, environment, secretScope: detail.secretScope,
        targetLinks: [{ ...link, machines: [machineId], members: [{ ...link.members[0]!, machineId, installationId }] }],
        pendingDeploy: { t: 'plain', v: { sourceIntent: retained, requestKey: input.requestKey,
            targetLinkId: link.id, actionOperationId: operationId, ...(sourceMethod ? { sourceMethod } : {}) } },
        pendingAdmission: { requesterAccountId: accountId, serverId, requestKey: input.requestKey,
            actionOperationId: operationId, controller: { machineId, installationId }, environmentRevision: environment.revision } });
    const fixture = await createActionOperationCancellationFixture({ mode: 'plain', accountId, actionId: 'deployments.deploy', actionInput: input,
        admittedMachineRole,
        deploymentCandidateSource: { id: environment.projectSourceId, revision: 1 },
        address: { serverId, machineId, operationId }, store, runner,
        async requestHttp(request) {
            const path = new URL(request.url).pathname;
            if (request.method === 'GET' && path.startsWith('/v1/artifacts/')) {
                const isEnvironment = path.endsWith(`/${environment.contentArtifactId}`);
                return { status: 200, data: { id: isEnvironment ? environment.contentArtifactId : link.contentArtifactId,
                    ownerAccountId: accountId, access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    header: encodePlainArtifactStoredContent({ kind: isEnvironment ? 'deployment-environment.v1' : 'deployment-target-link.v1', title: 'Fixture' }),
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(isEnvironment ? { ...detail.content, definition: current } : {}) }),
                    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
            }
            if (request.method === 'GET' && path === `/v1/deployments/environments/${environment.id}`) return { status: 200, data: readMetadata() };
            if (request.method === 'GET' && path.endsWith('/deployments')) return { status: 200, data: { ok: true, items: [], nextCursor: null } };
            if (request.method === 'POST' && path === '/v1/artifacts') {
                candidatePublications.push(readCarrierMutation(request.body));
                // A real Home write refusal keeps the diagnostic finite. The
                // deciding contract is that this wrong-candidate write is never issued.
                return { status: 403, data: { error: 'Forbidden' } };
            }
            return undefined;
        },
    });
    installationId = fixture.installation.installationId;
    const mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
        controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
    let fresh: Awaited<ReturnType<typeof fixture.prepareRoot>> = null;
    const previousPath = process.env.PATH;
    try {
        const docker = await createOwnServerDockerBoundary(directory);
        const selectedImage = await docker.registerImage('app', 'retained');
        const latestImage = await docker.registerImage('app', 'latest');
        retained = document(selectedImage.registryReference!, 1);
        current = document(latestImage.registryReference!, 2);
        // With the same Source, omission must retain the admitted Upload choice;
        // this native target then refuses Upload at its own method boundary.
        if (sourceMethod === 'upload' && requestedSourceMethod === undefined) current = retained;
        vi.stubEnv('PATH', `${directory}${delimiter}${previousPath ?? ''}`);
        fresh = await fixture.prepareRoot();
        expect(fresh, JSON.stringify(fixture.diagnostics)).not.toBeNull();
        if (!fresh) throw new Error('Fresh requester unavailable');
        const requester = readRequesterAccountActionContext(fresh.authorization);
        if (!requester) throw new Error('Fresh requester custody unavailable');
        const runtime = createOwnServerDeploymentRuntimeForHost({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials: requester.credentials, serverId,
            serverHttpBaseUrl: requester.serverHttpBaseUrl, machineId,
            acquirePluginRuntimeRegistryLease: async () => mounted.lease });
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials: requester.credentials, serverId,
            serverHttpBaseUrl: requester.serverHttpBaseUrl, machineId, runtime });
        const context: ActionExecutorContext = { authority: 'present_user', actionCaller: { kind: 'ui' }, serverId,
            externalActionExecutionAuthorization: fresh.authorization, originalActionEnvelope: fixture.envelope };
        if (sourceMethod === undefined) {
            const artifacts = createAccountArtifactStore({ credentials: requester.credentials,
                getAccountEncryptionMode: async () => 'plain' });
            // Read the real retained envelope through its Account Artifact codec;
            // native recovery must preserve absence rather than invent platform Git.
            const recovered = await readCompactPendingDeploymentRecovery({ input, context,
                scope: { accountId, machineId }, custody: { serverId, installationId }, read: async () => readMetadata(),
                readResource: id => runWithServerHttpBaseUrl(requester.serverHttpBaseUrl, () => artifacts.readForUpdate(id,
                    { prepareRecipients: false, includeSharedAudience: false })), assertCurrent: async () => {} });
            expect(recovered).toMatchObject({ captured: { sourceIntent: retained } });
            expect(recovered?.captured.sourceMethod).toBeUndefined();
        }
        const result = await deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input, context });
        expect(candidatePublications).toEqual([]);
        // Manage reaches retained-pin correspondence and the native method
        // boundary. Use cannot request an explicit source method. The older
        // retained source conflicts with the current content revision; the
        // captured Git method is unsupported by this native target. Neither
        // may silently prepare the latest stored definition instead.
        expect(result).toMatchObject({ ok: false, errorCode: expectedError });
        expect(await docker.readInvocations()).toEqual([]);
    } finally {
        await fresh?.dispose();
        await mounted.dispose();
        if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
        await rm(directory, { recursive: true, force: true });
    }
});
