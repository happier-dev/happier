import axios from 'axios';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { buildDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';

// Socket.IO and HTTP are the system boundaries. The operation runner,
// deployment owner and connection supervisor stay real.
const wire = vi.hoisted(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const emit = (event: string, ...args: unknown[]) => {
        for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    };
    const socket = {
        connected: false, io: { timeout() {}, on() {}, off() {} },
        on(event: string, listener: (...args: unknown[]) => void) {
            const group = listeners.get(event) ?? new Set(); group.add(listener); listeners.set(event, group);
        },
        off(event: string, listener: (...args: unknown[]) => void) { listeners.get(event)?.delete(listener); },
        connect() { socket.connected = true; emit('connect'); },
        disconnect() { socket.connected = false; emit('disconnect', 'client disconnect'); },
        removeAllListeners() { listeners.clear(); }, offAny() {},
    };
    return { socket, emit, io: vi.fn(() => socket), listeners };
});
vi.mock('socket.io-client', () => ({ io: wire.io }));

afterEach(() => { vi.restoreAllMocks(); wire.listeners.clear(); });

it.each(['requestKey', 'actionOperationId', 'sourceIntent', 'sourceMethod', 'services', 'triggerOccurrence', 'retained link advance'] as const)(
    'binds opened E2EE pending %s before storage mutation or native custody', async changed => {
        const detail = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const candidate = { ...receipt, content: { ...receipt.content, sourceMethod: 'gitIntegration' as const } };
        const machineKey = new Uint8Array(32).fill(71);
        const credentials = { token: 'fixture', encryption: { type: 'dataKey' as const,
            machineKey, publicKey: x25519.getPublicKey(machineKey) } };
        const resource = await createResourceDataKey({ credentials, mode: 'e2ee' });
        if (resource.mode !== 'e2ee') throw new Error('Expected encrypted fixture');
        const target = detail.targetLinks[0].targetLink;
        const operationId = 'pending-operation';
        const retained = changed === 'retained link advance';
        const sourceIntent = candidate.content.sourceIntent;
        if (sourceIntent.kind !== 'repository') throw new Error('Expected a repository receipt fixture');
        const privateIntent = { sourceIntent, sourceMethod: candidate.content.sourceMethod, requestKey: 'request', actionOperationId: operationId,
            targetLinkId: target.id };
        // This retained ciphertext was sealed by the previous pending writer.
        // Opening may drop its retired echo; TAKE must still send the exact c.
        const mismatched = retained ? { ...privateIntent, expectedLinkRevision: target.revision } : changed === 'sourceIntent'
            ? { ...privateIntent, sourceIntent: { ...sourceIntent, sha: 'e'.repeat(40) } }
            : changed === 'sourceMethod' ? { ...privateIntent, sourceMethod: 'upload' as const }
                : changed === 'services' ? { ...privateIntent, services: ['db'] }
                : changed === 'triggerOccurrence' ? { ...privateIntent, triggerOccurrence: { automationId: 'asserted-automation',
                        triggerId: 'asserted-trigger', triggerRevision: 1, occurrenceKey: Buffer.alloc(32).toString('base64url') } }
                        : { ...privateIntent, [changed]: 'another-identity' };
        const seal = (value: unknown) => encodeBase64(encryptWithDataKey(value, resource.dataKey));
        const pendingDeploy = { t: 'encrypted' as const, c: seal(mismatched) };
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const environment = String(url).endsWith(`/${detail.environment.contentArtifactId}`);
            const reference = environment ? detail.environment : candidate.deployment;
            return { status: 200, data: { id: reference.contentArtifactId, ownerAccountId: 'team-owner',
                access: 'view', publicAudience: 'none', encryptionMode: 'e2ee',
                dataEncryptionKey: resource.dataEncryptionKey,
                header: seal({ kind: environment ? 'deployment-environment.v1' : 'deployment-receipt.v1', title: 'Fixture' }),
                body: seal({ body: JSON.stringify(environment ? detail.content : candidate.content) }),
                headerVersion: reference.contentHeaderVersion, bodyVersion: reference.contentBodyVersion,
                seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        const writes: unknown[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (retained && request.method === 'GET' && new URL(String(request.url)).pathname.endsWith('/deployments')) {
                return { status: 200, data: { ok: true, items: [{ ...receipt.deployment, state: 'running' }], nextCursor: null } };
            }
            if (request.method === 'GET') return { status: 200, data: { ok: true,
                environment: detail.environment, targetLinks: detail.targetLinks.map(item => ({ ...item.targetLink,
                    revision: item.targetLink.revision + Number(retained) })),
                ...(retained ? { pendingDeploy } : {}) } };
            writes.push(request.data);
            return { status: 200, data: { ok: true, environmentId: detail.environment.id,
                revision: detail.environment.revision + 1, kind: 'pending', actionOperationId: operationId } };
        });
        const native = vi.fn(async () => { throw new Error('Refused intent cannot acquire native custody'); });
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials, serverId: detail.environment.serverId,
            serverHttpBaseUrl: 'https://home.test', machineId: detail.environment.controllerMachineId,
            runtime: { acquire: native } });
        const input = {
            serverId: detail.environment.serverId, environmentId: detail.environment.id,
            expectedRevision: detail.environment.revision, targetLinkId: target.id,
            expectedTargetLinkRevision: target.revision + Number(retained), requestKey: privateIntent.requestKey,
            contentArtifactId: candidate.deployment.contentArtifactId,
            contentHeaderVersion: candidate.deployment.contentHeaderVersion,
            contentBodyVersion: candidate.deployment.contentBodyVersion,
            whenBusy: 'supersede' as const, pendingDeploy,
        };
        const scope = { accountId: 'account', machineId: detail.environment.controllerMachineId };
        const store = createActionOperationStore();
        const runner = createActionOperationRunner({ store, generateOperationId: () => operationId,
            resolveAction: actionId => ({ actionId, title: 'Deploy', operation: getActionSpec('deployments.deploy').operation }) });
        try {
            const result = await runner.observe({ actionId: 'deployments.deploy', scope, input, execute: async context => {
                const result = await deps.deploymentAction('deployments.deploy', input, {
                    signal: context.signal, operationAcceptance: context.operationAcceptance,
                    operationOwnerUpdate: { update: context.publishOwnerUpdate },
                });
                return 'errorCode' in result ? result : { ok: true as const, result };
            } });
            if (retained) {
                expect(result).toMatchObject({ ok: true, result: { kind: 'pending', actionOperationId: operationId } });
                expect(writes).toHaveLength(1);
                expect(writes[0]).toMatchObject({ pendingDeploy });
                expect(store.get(scope, operationId)).toMatchObject({ state: 'running' });
            } else {
                expect(result).toMatchObject({ ok: false,
                    errorCode: changed === 'triggerOccurrence' ? 'unsupported_action' : 'deployment_conflict' });
                expect(writes).toEqual([]);
            }
            expect(native).not.toHaveBeenCalled();
        } finally {
            runner.cancel(scope, operationId);
            await runner.waitForTerminal(scope, operationId, undefined, { includeSetupReview: true });
        }
    },
);

it.each(['local cancellation', 'superseding intent', 'unsigned public cancellation'] as const)(
    'returns pending acceptance while its real operation remains nonterminal and %s retires the observer', async ending => {
    const detail = createDeploymentEnvironmentDetailV1();
    const receipt = createDeploymentReceiptDetailV1();
    const scope = { accountId: 'account', machineId: 'machine' };
    const pendingDeploy = { t: 'plain' as const, v: {
        sourceIntent: receipt.content.sourceIntent, requestKey: 'request', targetLinkId: detail.targetLinks[0].targetLink.id,
        actionOperationId: 'pending-operation',
    } };
    let currentPending = pendingDeploy;
    const input = { serverId: detail.environment.serverId, environmentId: detail.environment.id,
        expectedRevision: detail.environment.revision, targetLinkId: pendingDeploy.v.targetLinkId,
        expectedTargetLinkRevision: detail.targetLinks[0].targetLink.revision, requestKey: pendingDeploy.v.requestKey,
        contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
        whenBusy: 'supersede' as const, pendingDeploy };
    const pending = { ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1,
        kind: 'pending', actionOperationId: pendingDeploy.v.actionOperationId };
    let environmentReads = 0;
    let receiptReads = 0;
    let deploymentWrites = 0;
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.method !== 'GET') {
            deploymentWrites += 1;
            return { status: 200, data: pending };
        }
        if (new URL(String(request.url)).pathname.endsWith('/deployments')) {
            receiptReads += 1;
            if (new URL(String(request.url)).searchParams.get('inProgressOnly') === 'true') {
                return { status: 200, data: { ok: true, items: [{ ...receipt.deployment, state: 'running' }], nextCursor: null } };
            }
            const older = new URL(String(request.url)).searchParams.get('cursor') === 'older-page';
            return { status: 200, data: { ok: true, items: older ? [{ ...receipt.deployment, state: 'running' }]
                : [{ ...receipt.deployment, id: 'lexically-later-old-receipt' }], nextCursor: older ? null : 'older-page' } };
        }
        environmentReads += 1;
        return { status: 200, data: { ok: true, environment: detail.environment,
            targetLinks: detail.targetLinks.map(item => item.targetLink), pendingDeploy: currentPending } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        const environment = String(url).endsWith(`/${detail.environment.contentArtifactId}`);
        return { status: 200, data: { id: environment ? detail.environment.contentArtifactId : input.contentArtifactId,
            ownerAccountId: 'team-owner', access: 'view', publicAudience: 'none', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: environment ? 'deployment-environment.v1' : 'deployment-receipt.v1', title: 'Fixture' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(environment ? detail.content : receipt.content) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    const nativeEffects = vi.fn(async () => { throw new Error('Pending work cannot acquire native custody'); });
    const deps = createDaemonDeploymentActionDeps({
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
        credentials: { token: 'fixture', encryption: null },
        serverId: input.serverId, serverHttpBaseUrl: 'https://home.test', machineId: scope.machineId,
        runtime: { acquire: nativeEffects } });
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => pending.actionOperationId,
        resolveAction: actionId => ({ actionId, title: 'Deploy', operation: getActionSpec('deployments.deploy').operation }) });
    try {
        const accepted = await runner.observe({ actionId: 'deployments.deploy', scope, input, execute: async context => {
            const result = await deps.deploymentAction('deployments.deploy', input, {
                signal: context.signal, operationAcceptance: context.operationAcceptance,
                operationOwnerUpdate: { update: context.publishOwnerUpdate },
                operationCancellation: { onRequest: context.onCancellationRequested },
            });
            return 'errorCode' in result ? result : { ok: true as const, result };
        } });
        expect(accepted).toEqual({ ok: true, result: pending });
        expect(store.get(scope, pending.actionOperationId)).toMatchObject({ state: 'running' });
        expect(store.get(scope, pending.actionOperationId)).not.toHaveProperty('settledAt');
        expect(nativeEffects).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(receiptReads).toBe(1));
        const baseline = environmentReads;
        const push = (environmentId: string) => {
            const change = buildDeploymentAccountChangeV1({ environmentId, revision: 2 });
            wire.emit('update', UpdateContainerSchema.parse({ id: 'wake', seq: 1, createdAt: 1,
                body: { t: 'account-change', changeKinds: [change.kind], entityIds: [change.entityId] } }));
        };
        for (let index = 0; index < 100; index += 1) push(`unrelated-${index}`);
        await Promise.resolve();
        expect(environmentReads).toBe(baseline);
        expect(receiptReads).toBe(1);
        push(input.environmentId);
        await vi.waitFor(() => expect(receiptReads).toBe(2));
        expect(environmentReads).toBe(baseline + 1);
        wire.emit('connect');
        await vi.waitFor(() => expect(receiptReads).toBe(3));
        expect(environmentReads).toBe(baseline + 2);
        expect(store.get(scope, pending.actionOperationId)).toMatchObject({ state: 'running' });
        expect(nativeEffects).not.toHaveBeenCalled();
        if (ending === 'unsigned public cancellation') {
            const handlers = createActionOperationRpcHandlers({ store, runner, machineId: scope.machineId,
                resolveAccountId: async () => scope.accountId });
            const readsBeforeCancel = environmentReads;
            const opensBeforeCancel = vi.mocked(axios.get).mock.calls.length;
            const writesBeforeCancel = deploymentWrites;
            await expect(handlers.cancel({ operationId: pending.actionOperationId }))
                .rejects.toMatchObject({ rpcErrorCode: 'action_forbidden' });
            expect(store.get(scope, pending.actionOperationId)).toMatchObject({ state: 'running' });
            expect(currentPending).toEqual(pendingDeploy);
            expect(environmentReads).toBe(readsBeforeCancel);
            expect(vi.mocked(axios.get).mock.calls).toHaveLength(opensBeforeCancel);
            expect(deploymentWrites).toBe(writesBeforeCancel);
        }
        if (ending === 'superseding intent') {
            currentPending = { ...pendingDeploy, v: { ...pendingDeploy.v, actionOperationId: 'newer-operation' } };
            push(input.environmentId);
            await expect(runner.waitForTerminal(scope, pending.actionOperationId, undefined, { includeSetupReview: true }))
                .resolves.toMatchObject({ state: 'cancelled' });
            expect(currentPending.v.actionOperationId).toBe('newer-operation');
        }
    } finally {
        runner.cancel(scope, pending.actionOperationId);
    }
    await expect(runner.waitForTerminal(scope, pending.actionOperationId, undefined, { includeSetupReview: true })).resolves.toMatchObject({ state: 'cancelled' });
    expect([...wire.listeners.values()].reduce((total, group) => total + group.size, 0)).toBe(0);
});
