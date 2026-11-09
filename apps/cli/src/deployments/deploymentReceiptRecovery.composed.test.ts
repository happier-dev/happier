import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import tweetnacl from 'tweetnacl';
import axios from '@/api/client/credentialAxios';
import { createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DeploymentContentV1Schema } from '@happier-dev/deployment-protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { MachineInstallationIdentityV1Schema, DeploymentTransitionInputV1Schema } from '@happier-dev/protocol';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encryptWithDataKey, decryptWithDataKey } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import * as installationStore from '@/daemon/identity/store';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';

afterEach(() => vi.restoreAllMocks());

// Only Home HTTP and installation persistence are substituted. Receipt decoding,
// scoped operation custody, admission transport and signed settlement stay real.
const cases = (['plain', 'e2ee'] as const).flatMap(mode =>
    ([['missing', false], ['missing', true], ['succeeded', false], ['failed', false], ['running', false]] as const)
        .map(([operationState, existingFailure]) => ({ mode, operationState, existingFailure })));
it.each(cases)(
    'settles a dead running receipt before the next rollback admission ($mode / $operationState / existing reason: $existingFailure)', async ({ mode, operationState, existingFailure }) => {
    const token = `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`;
    const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
        : { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
    const resource = await createResourceDataKey({ credentials, mode });
    const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : Buffer.from(encryptWithDataKey(value, resource.dataKey)).toString('base64');
    const keys = tweetnacl.sign.keyPair();
    const identity = MachineInstallationIdentityV1Schema.parse({ version: 1, installationId: 'installation-a',
        publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url'), createdAt: 1 });
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(identity);
    const receipt = createDeploymentReceiptDetailV1();
    if (existingFailure) receipt.content.failure = { code: 'deployment_build_failed', phase: 'build' };
    Object.assign(receipt.deployment, { operation: 'rollback', state: 'running', revision: 2, requestedByAccountId: 'owner',
        actionOperationId: 'old-operation', acceptedExecution: { v: 1,
            controller: { machineId: 'machine-a', installationId: identity.installationId },
            builder: { machineId: 'machine-a', installationId: identity.installationId } } });
    const operations = createHostActionOperationRuntime({ machineId: 'machine-a', resolveAccountId: async () => 'owner',
        generateOperationId: () => 'fresh-operation' });
    const scope = { accountId: 'owner', machineId: 'machine-a' };
    if (operationState !== 'missing') {
        operations.store.create({ operationId: 'old-operation', scope, actionId: 'deployments.rollback',
            title: 'Rollback', cancellation: 'supported', inputIdentity: '{}' });
        if (operationState === 'failed') operations.store.fail('old-operation', { errorCode: 'action_forbidden', error: 'action_forbidden' });
        else if (operationState === 'succeeded') operations.store.succeed('old-operation', {});
        else operations.store.markRunning('old-operation');
    }
    let admittedOperationId: string | undefined;
    let writtenContent: unknown;
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
        if (path.endsWith('/access/recipients')) return { status: 200, data: {
            artifactId: receipt.deployment.contentArtifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
            dataEncryptionKey: resource.dataEncryptionKey, callerDataEncryptionKey: resource.dataEncryptionKey,
            recipients: [] } };
        expect(path).toBe(`/v1/artifacts/${receipt.deployment.contentArtifactId}`);
        return { status: 200, data: { id: receipt.deployment.contentArtifactId, ownerAccountId: 'owner', access: 'owner',
            publicAudience: 'none', encryptionMode: mode,
            dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
            header: encode({ kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'App' }),
            body: encode({ body: JSON.stringify(receipt.content) }),
            headerVersion: receipt.deployment.contentHeaderVersion, bodyVersion: receipt.deployment.contentBodyVersion,
            seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        const path = new URL(request.url!).pathname;
        if (path.endsWith('/deployments') && request.method === 'GET')
            return { status: 200, data: { ok: true, items: receipt.deployment.state === 'running' ? [receipt.deployment] : [], nextCursor: null } };
        if (path.endsWith('/transitions')) {
            const body = DeploymentTransitionInputV1Schema.parse(request.data);
            writtenContent = body;
            receipt.deployment.state = body.state;
            receipt.deployment.revision++;
            return { status: 200, data: { ok: true, environmentId: receipt.deployment.environmentId, revision: 1,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: body.state } };
        }
        expect(path).toBe(`/v1/deployments/environments/${receipt.deployment.environmentId}/rollback`);
        if (receipt.deployment.state === 'running') return { status: 200,
            data: { ok: false, error: 'deployment_in_progress', deploymentId: receipt.deployment.id } };
        admittedOperationId = request.data.actionOperationId;
        // Admission produces a distinct receipt; native effects are outside this recovery test.
        return { status: 200, data: { ok: true, environmentId: receipt.deployment.environmentId, revision: 2,
            deploymentId: 'fresh-receipt', deploymentRevision: 1, state: 'failed' } };
    });
    const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home',
        serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
        readOperation: (operationId, context) => operations.readRestorePreparation({ operationId, context }),
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        runtime: { async acquire() { throw new Error('Recovery must not execute an old receipt'); } } });
    const input = { serverId: 'home', environmentId: receipt.deployment.environmentId, targetLinkId: receipt.deployment.targetLinkId,
        deploymentId: 'retained-code', requestKey: 'fresh-request', expectedRevision: 1, expectedTargetLinkRevision: 1,
        contentArtifactId: 'fresh-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
    const compactInput = { serverId: input.serverId, environmentId: input.environmentId,
        deploymentId: input.deploymentId, requestKey: input.requestKey };
    const result = await operations.observeExecution({ actionId: 'deployments.rollback', input,
        execute: async context => {
            const requester = { ...context, runtimeAccountId: 'owner' };
            // The UI enters preparation before native admission. Recovery must
            // happen here even when later review cannot proceed.
            await deps.prepareDeploymentAction({ actionId: 'deployments.rollback', input: compactInput, context: requester });
            expect(receipt.deployment.state).toBe(operationState === 'running' ? 'running'
                : operationState === 'failed' ? 'failed' : 'outcome_unknown');
            const result = await deps.deploymentAction('deployments.rollback', input, requester);
            return 'errorCode' in result ? result : { ok: true as const, result };
        } });
    if (operationState === 'running') {
        expect(receipt.deployment.state).toBe('running');
        expect(admittedOperationId).toBeUndefined();
        expect(writtenContent).toBeUndefined();
    } else {
        expect(receipt.deployment.state, JSON.stringify(result)).toBe(operationState === 'failed' ? 'failed' : 'outcome_unknown');
        expect(writtenContent).toMatchObject({ kind: 'settle', expectedRevision: 2, actionOperationId: 'old-operation' });
        const transition = DeploymentTransitionInputV1Schema.parse(writtenContent);
        if (!existingFailure && (operationState === 'missing' || operationState === 'succeeded')) {
            expect(transition.contentUpdate).toBeDefined();
            const stored = transition.contentUpdate!.body!;
            const opened = resource.mode === 'plain' ? decodePlainArtifactStoredContent(stored)
                : decryptWithDataKey(Buffer.from(stored, 'base64'), resource.dataKey);
            const content = DeploymentContentV1Schema.parse(JSON.parse(z.object({ body: z.string() }).parse(opened).body));
            expect(content).toEqual({ ...receipt.content,
                failure: { code: 'deployment_activation_not_observed', phase: 'observe' } });
        } else expect(transition.contentUpdate).toBeUndefined();
        expect(admittedOperationId).toBe('fresh-operation');
        expect(result).toMatchObject({ ok: false, errorCode: 'deployment_failed', details: { deploymentId: 'fresh-receipt' } });
    }
});
