import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { computeHomeQrBindingProofV2} from '@happier-dev/protocol/crypto/qrProvisioningV2';
import { type ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { encodeBase64 } from '@/encryption/base64';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Keep the actual Socket and Sync lifecycle; only external Engine.IO packets stay disconnected.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// This native rendering package is outside the transport process and never renders here.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));
// Entropy is a genuine system boundary; this pins the request binding proof.
vi.mock('@/platform/cryptoRandom', () => ({ getRandomBytes: (size: number) => new Uint8Array(size).fill(7) }));
// Daemon RPC is the external terminal process boundary; Action admission and
// the canonical terminal request/response adapter remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.rpc }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Install genuine boundaries before the state graph resolves its transport imports.
const { storage } = await import('@/sync/domains/state/storageStore');
const { discardMachineAddFlowDraft, readMachineAddFlowDraft, updateMachineAddFlowDraft } = await import('@/components/machines/add/machineAddFlowStore');
const { createManualSystemTaskRunner } = await import('@/dev/testkit/harness/manualSystemTaskRunner');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { createAccountSettingsScope } = await import('@/sync/domains/settings/scope/accountSettingsScope');
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
const { createMachineConnectionActionDeps } = await import('./machineConnectionActionDeps');
const makeExecutor = (runner?: ReturnType<typeof createManualSystemTaskRunner>['runner']) => createActionExecutor({
    ...createMachineConnectionActionDeps({ runner }),
    // The terminal adapter does not own policy; compose the real host policy port.
    readActionsSettings: (context) => normalizeActionsSettingsV1(context.actionsSettings),
} satisfies Partial<ActionExecutorDeps> as unknown as ActionExecutorDeps);

async function activateSshAccount(serverId: string, accountId: string) {
    const scope = createAccountSettingsScope(serverId, accountId);
    if (!scope) throw new Error('Invalid SSH fixture Account scope');
    await storage.getState().activateSettingsScope(scope);
    storage.getState().activateProfileScope(scope);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
}

describe('UI machine connection Actions', () => {
    beforeEach(async () => { await harness.reset(); boundary.rpc.mockReset(); });
    afterEach(() => { discardMachineAddFlowDraft(); publishAppliedActiveServerRuntimeAvailability(false); vi.unstubAllGlobals(); standardCleanup(); });
    it.each([{ mode: 'plain' as const, mismatch: false }, { mode: 'e2ee' as const, mismatch: false },
        { mode: 'plain' as const, mismatch: true }])('approves requester pairing without a controller key and refuses another enrollment Account ($mode, mismatch=$mismatch)', async ({ mode, mismatch }) => {
        const nacl = (await import('tweetnacl')).default;
        const machineKey = new Uint8Array(32).fill(3);
        const requesterPublicKey = nacl.box.keyPair.fromSecretKey(machineKey).publicKey;
        const requesterToken = createAccountTokenForTests('member');
        const homeId = `srv_requester_pairing_${mode}_${mismatch}`;
        const serverId = await harness.addHome({ name: 'Requester Home', serverUrl: `https://requester-pairing-${mode}-${mismatch}.example`,
            serverIdentityId: homeId, accountId: 'member', accountEncryptionMode: mode,
            ...(mode === 'e2ee' ? { credentials: { token: requesterToken,
                encryption: { publicKey: encodeBase64(requesterPublicKey), machineKey: encodeBase64(machineKey) } } } : {}) });
        await activateSshAccount(serverId, 'member');
        if (mode === 'e2ee') harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode, version: 1, signingKeyFingerprint: null,
            contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(requesterPublicKey), updatedAt: 0 } });
        const features = createRootLayoutFeaturesResponse({ features: { encryption: { plaintextStorage: { enabled: true } },
            e2ee: { keylessAccounts: { enabled: true } } }, capabilities: { serverIdentity: { serverIdentityId: homeId } } });
        harness.answer(serverId, '/v1/features', { body: features });
        const machine = { id: 'member-managed', homeId, custodianAccountId: 'company', enrollmentAccountId: 'member',
            controller: { machineId: 'company-controller', installationId: 'company-installation' },
            launch: { provider: { pluginId: 'test.machine', localId: 'guest' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'test.machine', localId: 'guest' }, schemaVersion: 1, value: { id: 'native' } },
            allocation: 'bound', creationState: 'active', intentRevision: 0, desired: 'start', desiredWhen: 'now',
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        harness.answer(serverId, '/v1/machines/managed/actions/get', { body: machine });
        harness.answer(serverId, '/v1/auth/request/status', { body: { status: 'pending', supportsV2: true } });
        harness.answer(serverId, '/v1/auth/response', { body: { success: true } });
        const { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
        const guest = nacl.box.keyPair();
        const calls: unknown[] = [];
        installDisconnectedServerSocketBoundary(socket => {
            configureConnectedServerSocketBoundary(socket);
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
                if (event !== SOCKET_RPC_EVENTS.CALL) return {};
                calls.push(payload);
                const params = payload && typeof payload === 'object' && 'params' in payload ? payload.params : undefined;
                if (!params || typeof params !== 'object' || !('params' in params)) throw new Error('Missing managed response correlation');
                const input = params.params;
                const delivery = input && typeof input === 'object' && 'delivery' in input;
                return { ok: true, result: { ok: true, result: delivery ? {
                    publicKey: encodeBase64(guest.publicKey), homeServerIdentityId: homeId,
                    pairing: { secretB64Url: encodeBase64(new Uint8Array(32).fill(9), 'base64url'), createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000 },
                    supportsTokenOnly: true, pairingRequirement: 'v3', enrollmentAccountId: mismatch ? 'company' : 'member',
                } : { ok: true } } };
            });
        });
        boundary.rpc.mockRejectedValue(Object.assign(new Error('No controller Machine key'), { code: 'MACHINE_ENCRYPTION_UNAVAILABLE' }));
        const input = { serverId, homeId, managedId: machine.id, operationId: 'creation-operation', taskId: 'installation-task',
            purpose: 'approve', prompt: { kind: 'auth.approveRemoteProvisioning', message: 'Sign in to Guest?' }, approved: true };
        const result = await makeExecutor().execute('machines.managed.bootstrap.respond', input,
            { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'member', bypassApprovals: true });
        expect(result).toMatchObject(mismatch ? { ok: false, errorCode: 'action_account_scope_changed' }
            : { ok: true, result: { taskId: input.taskId } });
        expect(boundary.rpc).not.toHaveBeenCalled();
        expect(calls).toHaveLength(mismatch ? 1 : 2);
        expect(harness.requestsFor('/v1/auth/response')).toHaveLength(mismatch ? 0 : 1);
        if (!mismatch) {
            const approval = harness.requestsFor('/v1/auth/response')[0];
            expect(approval?.input).toMatchObject({ responseKind: mode === 'plain' ? 'tokenOnly' : 'dataKey' });
            expect(approval?.token).toBe(requesterToken);
        }
    });

    it.each(['plain', 'e2ee'] as const)('opens %s Pool labels and retains exact deployment roles in the managed removal census', async (mode) => {
        const homeId = `srv_deployment_census_${mode}`;
        const nacl = (await import('tweetnacl')).default;
        const machineKey = new Uint8Array(32).fill(3);
        const publicKey = nacl.box.keyPair.fromSecretKey(machineKey).publicKey;
        const serverId = await harness.addHome({ name: 'References', serverUrl: 'https://deployment-census.example',
            serverIdentityId: homeId, accountId: 'alice', accountEncryptionMode: mode,
            ...(mode === 'e2ee' ? { credentials: { token: createAccountTokenForTests('alice'),
                encryption: { publicKey: encodeBase64(publicKey), machineKey: encodeBase64(machineKey) } } } : {}) });
        if (mode === 'e2ee') harness.answer(serverId, '/v1/account/encryption/currentness', { body: {
            mode, version: 1, signingKeyFingerprint: null,
            contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(publicKey), updatedAt: 0 } });
        const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
        const { MachineDeploymentReferencesPageV1Schema } = await import('@happier-dev/protocol/machines/machineReferenceCensusV1');
        const { createUiManagedMachineReferenceReader } = await import('./managedMachineReferenceDeps');
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const machine = ManagedMachineV1Schema.parse({ id: 'managed', homeId, custodianAccountId: 'alice',
            controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'example.machine', localId: 'guest' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'example.machine', localId: 'guest' }, schemaVersion: 1, value: { id: 'native' } },
            enrolledMachineId: 'runtime', desired: 'start', desiredWhen: 'now', allocation: 'bound', creationState: 'active',
            intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        harness.answer(serverId, '/v1/machines/managed/actions/get', { body: machine });
        const { sealPrivateLabelV1 } = await import('@happier-dev/protocol/crypto/privateLabelV1');
        const { sealEncryptedDataKeyEnvelopeV1 } = await import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1');
        const { computeContentPublicKeyFingerprint } = await import('@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint');
        const poolId = '00000000-0000-4000-8000-000000000001';
        const dataKey = new Uint8Array(32).fill(13);
        const binding = { entity: 'machine_pool', field: 'name', id: poolId } as const;
        const label = mode === 'plain' ? sealPrivateLabelV1({ mode, binding, value: 'Private builders' })
            : sealPrivateLabelV1({ mode, binding, value: 'Private builders', dataKey,
                recipients: [{ accountId: 'alice', envelope: {
                    encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: publicKey,
                        randomBytes: length => new Uint8Array(length).fill(17) })),
                    recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(publicKey),
                } }], randomBytes: length => new Uint8Array(length).fill(19) });
        const { machinePoolActionEndpointPathV1 } = await import('@happier-dev/protocol/machines/pools/actionsV1');
        harness.answer(serverId, machinePoolActionEndpointPathV1('machines.pools.list'), { body: { pools: [{
            pool: { id: poolId, name: { kind: 'available', label: { content: label.content,
                recipientEnvelope: mode === 'e2ee' && 'recipients' in label ? label.recipients[0]!.envelope : null } },
                description: { kind: 'unavailable' }, revision: 1, createdAt: 1, updatedAt: 1,
                members: [{ machineId: 'runtime', priorityTier: 0, enabled: true, state: 'connected' }] },
            availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
        }] } });
        const selected: string[] = [];
        harness.answer(serverId, 'GET /v1/deployments/machine-references', { select: (_input, request) => {
            const url = new URL(request.url);
            selected.push(`${url.searchParams.get('homeId')}:${url.searchParams.get('machineId')}`);
            return { body: MachineDeploymentReferencesPageV1Schema.parse({ homeId, machineId: 'runtime', coverage: 'complete',
                references: [{ kind: 'deployment_environment', id: 'environment', name: '', deploymentRoles: ['build', 'edge'] }], nextCursor: null }) };
        } });
        const account = await captureLazyActionAccountContext(serverId);
        try {
            const result = await createUiManagedMachineReferenceReader(account)({ input: { homeId, managedId: machine.id }, context: {} });
            expect(result.references).toContainEqual({ kind: 'deployment_environment', id: 'environment', name: '', deploymentRoles: ['build', 'edge'] });
            expect(result.references).toContainEqual({ kind: 'machine_pool', id: poolId, name: 'Private builders' });
            expect(result.unavailable).not.toContain('pools');
            expect(result.coverage).toBe('partial');
            expect(result.unavailable).not.toContain('deployments');
            expect(selected).toEqual([`${homeId}:runtime`]);
        } finally { account.dispose(); }
    });
    it('answers only the current managed installation prompt through the client Action and exact controller', async () => {
        const actionId = ActionIdSchema.parse('machines.managed.bootstrap.respond');
        const serverId = await harness.addHome({ name: 'Managed Home', serverUrl: 'https://managed-consent.example', serverIdentityId: 'srv_managed_consent', accountId: 'alice' });
        await activateSshAccount(serverId, 'alice');
        const machine = {
            id: 'managed', homeId: 'srv_managed_consent', custodianAccountId: 'alice',
            controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'example.machine', localId: 'guest' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'example.machine', localId: 'guest' }, schemaVersion: 1, value: { id: 'native' } },
            desired: 'start', desiredWhen: 'now', allocation: 'bound', creationState: 'active', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        };
        harness.answer(serverId, '/v1/machines/managed/actions/get', { body: machine });
        const { ActionOperationSnapshotV1Schema, ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
        let operation = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'creation', revision: 2,
            actionId: 'machines.managed.acquire', state: 'running', scope: { accountId: 'alice', machineId: 'controller' },
            title: 'Create Guest', createdAt: 1, startedAt: 1, cancellation: 'supported',
            domainRef: { kind: 'managedMachine', id: machine.id, controller: machine.controller, resource: machine.resource,
                bootstrapTask: { id: 'install-task', taskKind: 'remote.ssh.bootstrapMachine.v1',
                    prompt: { kind: 'auth.approveRemoteProvisioning', message: 'Sign in to Guest?' } } },
        });
        boundary.rpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
            if (request.method === ACTION_OPERATION_RPC_METHODS_V2.get) return { kind: 'found', operation };
            expect(request.method).toBe(RPC_METHODS.CAPABILITIES_INVOKE);
            return { ok: true, result: {} };
        });
        const input = { serverId, homeId: machine.homeId, managedId: machine.id, operationId: operation.operationId, taskId: 'install-task',
            purpose: 'approve', prompt: { kind: 'auth.approveRemoteProvisioning', message: 'Sign in to Guest?' }, approved: true };
        const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId, expectedAccountId: 'alice', bypassApprovals: true };
        const executor = makeExecutor();
        expect(await executor.execute(actionId, input, context)).toEqual({ ok: true, result: { taskId: input.taskId } });
        expect(boundary.rpc.mock.calls.map(([request]) => request)).toEqual([
            expect.objectContaining({ machineId: 'controller', serverId: machine.homeId, accountId: 'alice', method: ACTION_OPERATION_RPC_METHODS_V2.get, payload: { operationId: 'creation' } }),
            expect.objectContaining({ machineId: 'controller', serverId: machine.homeId, accountId: 'alice', method: RPC_METHODS.CAPABILITIES_INVOKE,
                payload: { id: 'tool.systemTasks', method: 'respond', params: { taskId: 'install-task',
                    expectedPromptKind: 'auth.approveRemoteProvisioning', answer: { approved: true } } } }),
        ]);
        boundary.rpc.mockClear();
        expect(await executor.execute(actionId, input, { ...context, surface: 'mcp' }))
            .toEqual({ ok: true, result: { taskId: input.taskId } });
        expect(boundary.rpc.mock.calls.map(([request]) => request).at(-1)).toMatchObject({
            method: RPC_METHODS.CAPABILITIES_INVOKE,
            payload: { id: 'tool.systemTasks', method: 'respond', params: { taskId: input.taskId,
                expectedPromptKind: 'auth.approveRemoteProvisioning', answer: { approved: true } } },
        });
        boundary.rpc.mockClear();
        expect(await executor.execute(actionId, { ...input, taskId: 'other-task' }, context)).toMatchObject({ ok: false, errorCode: 'no_prompt' });
        expect(boundary.rpc).toHaveBeenCalledTimes(1);
        boundary.rpc.mockClear();
        expect(await executor.execute(actionId, { ...input, approved: false }, { ...context, expectedAccountId: 'bob' })).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(boundary.rpc).not.toHaveBeenCalled();
        expect(await executor.execute(actionId, { ...input, answer: { approved: true } }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        // One task can advance from SSH trust to sign-in; an earlier decision must not approve its next question.
        const trustPrompt = { kind: 'ssh.trustHost', message: 'Review SSH key',
            host: 'guest.example', keyType: 'ssh-ed25519', fingerprint: 'SHA256:guest', existingFingerprint: null };
        boundary.rpc.mockClear();
        expect(await executor.execute(actionId, { ...input, prompt: trustPrompt }, context)).toMatchObject({ ok: false, errorCode: 'no_prompt' });
        expect(boundary.rpc.mock.calls.map(([request]) => request.method)).toEqual([ACTION_OPERATION_RPC_METHODS_V2.get]);
        if (operation.domainRef?.kind !== 'managedMachine' || !operation.domainRef.bootstrapTask) throw new Error('Expected bootstrap task');
        operation = { ...operation, revision: 3, domainRef: { ...operation.domainRef,
            bootstrapTask: { ...operation.domainRef.bootstrapTask, prompt: { ...trustPrompt, kind: 'ssh.trustHost' } } } };
        for (const surface of ['agent', 'mcp', 'cli'] as const) {
            boundary.rpc.mockClear();
            expect(await executor.execute(actionId, { ...input, prompt: trustPrompt }, { ...context, surface }))
                .toEqual({ ok: true, result: { taskId: input.taskId } });
            expect(boundary.rpc.mock.calls.map(([request]) => request).at(-1)).toMatchObject({
                method: RPC_METHODS.CAPABILITIES_INVOKE,
                payload: { id: 'tool.systemTasks', method: 'respond', params: { taskId: input.taskId,
                    expectedPromptKind: 'ssh.trustHost', answer: { trusted: true } } },
            });
        }
        boundary.rpc.mockClear();
        expect(await executor.execute(actionId, { ...input, prompt: { ...trustPrompt, fingerprint: 'SHA256:other-key' } }, context))
            .toMatchObject({ ok: false, errorCode: 'no_prompt' });
        expect(boundary.rpc.mock.calls.map(([request]) => request.method)).toEqual([ACTION_OPERATION_RPC_METHODS_V2.get]);
        // Foreground Account enrollment owns its private answers; a retained
        // Machine prompt cannot be answered after removing its controller.
        harness.answer(serverId, '/v1/machines/managed/actions/get', { body: { ...machine, controller: undefined } });
        boundary.rpc.mockClear();
        expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: false, errorCode: 'no_prompt' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
    it('answers an exact establishment prompt through the managed Action, transient task response and cold snapshot', async () => {
        const serverId = await harness.addHome({ name: 'Establish Home', serverUrl: 'https://managed-establish.example',
            serverIdentityId: 'srv_establish', accountId: 'alice' });
        await activateSshAccount(serverId, 'alice');
        const machine = { id: 'managed', homeId: 'srv_establish', custodianAccountId: 'alice',
            controller: { machineId: 'controller', installationId: 'installation' },
            launch: { provider: { pluginId: 'example.machine', localId: 'guest' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'example.machine', localId: 'guest' }, schemaVersion: 1, value: { id: 'native' } },
            desired: 'start', desiredWhen: 'now', allocation: 'bound', creationState: 'active', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false };
        harness.answer(serverId, '/v1/machines/managed/actions/get', { body: machine });
        const { createSystemTasksRunner } = await import('@happier-dev/cli-common/systemTasks');
        const { ActionOperationSnapshotV1Schema, ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
        let delivered: unknown;
        const runner = createSystemTasksRunner({ kinds: {} });
        const prompt = { kind: 'administrator.establish' as const, promptId: 'administrator-1', administratorUsername: 'operator',
            message: 'Establish reviewed administrator' };
        await runner.startAdmitted({ taskId: 'install-task', kind: 'remote.ssh.bootstrapMachine.v1', params: {} }, {
            async run(context) {
                const { kind, message, ...data } = prompt;
                delivered = await context.prompt({ kind, message, data });
                return { established: true };
            },
        });
        boundary.rpc.mockImplementation(async (request: { method: string; payload: unknown }) => {
            if (request.method === ACTION_OPERATION_RPC_METHODS_V2.get) {
                const held = await runner.poll({ taskId: 'install-task', cursor: 0 });
                return { kind: 'found', operation: ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'creation', revision: 2,
                    actionId: 'machines.managed.acquire', state: 'running', scope: { accountId: 'alice', machineId: 'controller' },
                    title: 'Create Guest', createdAt: 1, startedAt: 1, cancellation: 'supported',
                    domainRef: { kind: 'managedMachine', id: machine.id, controller: machine.controller, resource: machine.resource,
                        bootstrapTask: { id: 'install-task', taskKind: 'remote.ssh.bootstrapMachine.v1',
                            ...(held.pendingPrompt ? { prompt } : {}) } } }) };
            }
            expect(request.method).toBe(RPC_METHODS.CAPABILITIES_INVOKE);
            const response = request.payload as { params: Parameters<typeof runner.respond>[0] };
            await runner.respond(response.params);
            return { ok: true, result: { ok: true } };
        });
        const executor = makeExecutor();
        const input = { purpose: 'establish' as const, serverId, homeId: machine.homeId, managedId: machine.id,
            operationId: 'creation', taskId: 'install-task', promptId: prompt.promptId, password: 'private-establishment-password' };
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: 'alice', bypassApprovals: true };
        expect(await executor.execute('machines.managed.bootstrap.respond', { ...input, promptId: 'stale-prompt' }, context))
            .toMatchObject({ ok: false, errorCode: 'no_prompt' });
        expect(delivered).toBeUndefined();
        expect(await executor.execute('machines.managed.bootstrap.respond', input, context)).toEqual({ ok: true, result: { taskId: input.taskId } });
        expect(delivered).toEqual({ password: input.password });
        expect(boundary.rpc.mock.calls.map(([request]) => request).at(-1)).toMatchObject({
            machineId: 'controller', serverId: machine.homeId, accountId: 'alice', method: RPC_METHODS.CAPABILITIES_INVOKE,
            payload: { id: 'tool.systemTasks', method: 'respond', params: { taskId: input.taskId,
                expectedPromptKind: prompt.kind, expectedPromptId: input.promptId, answer: { password: input.password } } },
        });
        expect(await executor.execute('machines.managed.bootstrap.respond', input, context)).toMatchObject({ ok: false, errorCode: 'no_prompt' });
        const snapshot = JSON.parse(JSON.stringify(await runner.poll({ taskId: 'install-task', cursor: 0 })));
        expect(snapshot).toMatchObject({ pendingPrompt: null, result: { ok: true, data: { established: true } } });
        expect(JSON.stringify(snapshot)).not.toContain(input.password);
    });
    it.each(['password', 'keyfile'] as const)('keeps entered SSH %s credentials private while invoking start, password response, status and cancel through UI Actions', async authMode => {
        vi.stubGlobal('isTauri', true);
        const serverId = await harness.addHome({ name: 'SSH Home', serverUrl: 'https://ssh-private.example', accountId: 'alice' });
        await activateSshAccount(serverId, 'alice');
        const manual = createManualSystemTaskRunner('native');
        updateMachineAddFlowDraft(draft => ({ ...draft, serverId, path: 'ssh', sshDraft: {
            ...draft.sshDraft, host: 'box', authMode, password: 'entered-password',
            ...(authMode === 'keyfile' ? { privateKeyMaterial: 'fixture-private-key' } : {}),
        } }));
        const executor = makeExecutor(manual.runner);
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, bypassApprovals: true };
        const started = await executor.execute('machines.add.ssh.start', { serverId, host: 'box', authMode }, context);
        expect(started).toMatchObject({ ok: true, result: { taskId: expect.any(String) } });
        const taskId = readMachineAddFlowDraft().sshTask?.taskId;
        expect(manual.bridge.start).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ ssh: expect.objectContaining(
            authMode === 'keyfile' ? { identityPrivateKey: 'fixture-private-key' } : { password: 'entered-password' },
        ) }) }));
        manual.emitEvent(taskId!, { type: 'prompt', message: 'Password needed', data: { kind: 'ssh.password', target: 'box' } });
        updateMachineAddFlowDraft(draft => ({ ...draft, sshDraft: { ...draft.sshDraft, password: 'corrected-password' } }));
        const answered = await executor.execute('machines.add.ssh.respond', { taskId, answer: { kind: 'ssh.password' } }, context);
        expect(answered).toEqual({ ok: true, result: { taskId } });
        expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { password: 'corrected-password' });
        const status = await executor.execute('machines.add.ssh.status', { taskId }, context);
        expect(status).toMatchObject({ ok: true, result: { taskId, machineId: null } });
        expect(JSON.stringify([started, answered, status])).not.toMatch(/entered-password|corrected-password|fixture-private-key/);
        manual.bridge.cancel.mockRejectedValueOnce(new Error('Native cancellation included fixture-cancel-secret-marker'));
        const failedCancel = await executor.execute('machines.add.ssh.cancel', { taskId }, context);
        expect(JSON.stringify(failedCancel).includes('fixture-cancel-secret-marker')).toBe(false);
        expect(failedCancel).toMatchObject({ ok: false, errorCode: 'machine_enroll_cancel_failed', error: 'machine_enroll_cancel_failed' });
        expect(await executor.execute('machines.add.ssh.cancel', { taskId }, context)).toEqual({ ok: true, result: { taskId } });
        expect(manual.bridge.cancel).toHaveBeenCalledWith(taskId);
        manual.emitResult(taskId!, { protocolVersion: 1, taskId: taskId!, ok: false, error: { code: 'ssh_failed', message: 'fixture-diagnostic-marker' } });
        const failedStatus = await executor.execute('machines.add.ssh.status', { taskId }, context);
        expect(JSON.stringify(failedStatus).includes('fixture-diagnostic-marker')).toBe(false);
    });
    it('captures a saved host and SavedSecret for Agent/MCP without a mounted draft and persists exact completion', async () => {
        await loadSyncSingletonForTests();
        vi.stubGlobal('isTauri', true);
        const serverId = await harness.addHome({ name: 'Saved SSH', serverUrl: 'https://ssh-saved.example', accountId: 'alice' });
        harness.answer(serverId, '/v1/account/encryption/currentness', { body: AccountEncryptionCurrentnessResponseSchema.parse({
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0,
        }) });
        await activateSshAccount(serverId, 'alice');
        const features = createRootLayoutFeaturesResponse({ features: { remoteHosts: { management: { enabled: true }, secretMaterial: { enabled: true } } } });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
        harness.answer(serverId, '/v1/features', { body: features });
        const ref = formatSharedSavedSecretRefV1('ssh-password');
        const host = { id: 'saved-box', name: 'Saved box', createdAt: 1, updatedAt: 1, lastUsedAt: null,
            ssh: { target: 'alice@saved-box.example', authMode: 'password', passwordSecretRef: ref } };
        harness.answer(serverId, REMOTE_HOST_ROWS_ROUTE_V1, { body: { status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, hosts: [host] } } } });
        harness.answer(serverId, '/v1/account/saved-secrets/resources/materials', { body: SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
            resourceId: 'ssh-password', encryptionMode: 'plain', recipientEnvelope: null,
            entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'SSH password', kind: 'password',
                encryptionMode: 'plain', revision: 2, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            storedContent: { t: 'plain', v: { v: 1, name: 'SSH password', kind: 'password', value: 'saved-password' } },
        }] }) });
        harness.answer(serverId, `POST ${REMOTE_HOST_ROWS_ROUTE_V1}`, { body: { status: 'updated', revision: 5, cursor: 5 } });
        const manual = createManualSystemTaskRunner('native');
        const executor = makeExecutor(manual.runner);
        const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId, bypassApprovals: true };
        const started = await executor.execute('machines.add.ssh.start', { serverId, savedHostId: host.id, expectedHostRevision: 4 }, context);
        expect(readMachineAddFlowDraft().sshTask?.startError, JSON.stringify(harness.requests.map(request => ({ serverId: request.serverId, path: request.path })))).toBeNull();
        expect(started).toEqual({ ok: true, result: { taskId: expect.any(String) } });
        const taskId = readMachineAddFlowDraft().sshTask?.taskId;
        expect(manual.bridge.start).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ ssh: expect.objectContaining({ target: host.ssh.target, password: 'saved-password' }) }) }));
        updateMachineAddFlowDraft(draft => ({ ...draft, sshDraft: { ...draft.sshDraft, host: 'unrelated-host', savedHostId: null, password: 'unrelated-password' } }));
        manual.emitEvent(taskId!, { type: 'prompt', message: 'Password needed', data: { kind: 'ssh.password', target: host.ssh.target } });
        const answered = await executor.execute('machines.add.ssh.respond', { taskId, answer: { kind: 'ssh.password' } }, { ...context, surface: 'mcp' });
        expect(answered).toEqual({ ok: true, result: { taskId } });
        expect(manual.bridge.respond).toHaveBeenCalledWith(taskId, { password: 'saved-password' });
        manual.emitResult(taskId!, { protocolVersion: 1, taskId: taskId!, ok: true, data: { machineId: 'joined-machine' } });
        await vi.waitFor(() => expect(harness.requestsFor(REMOTE_HOST_ROWS_ROUTE_V1).some(request => {
            const input = request.input as { mutation?: { expectedRevision?: number; content?: { v?: { hosts?: { linkedMachineId?: string; id?: string }[] } } } };
            return input?.mutation?.expectedRevision === 4 && input.mutation.content?.v?.hosts?.some(row => row.id === host.id && row.linkedMachineId === 'joined-machine');
        })).toBe(true));
        expect(JSON.stringify([started, answered])).not.toMatch(/saved-password|unrelated-password/);
        const restarted = await executor.execute('machines.add.ssh.start', { serverId, savedHostId: host.id, expectedHostRevision: 4 }, context);
        expect(restarted).toEqual({ ok: true, result: { taskId: expect.any(String) } });
        const nextTaskId = readMachineAddFlowDraft().sshTask?.taskId;
        manual.emitEvent(nextTaskId!, { type: 'prompt', message: 'Password needed', data: { kind: 'ssh.password', target: host.ssh.target } });
        manual.bridge.respond.mockRejectedValueOnce(new Error('Transport included fixture-secret-marker'));
        const refused = await executor.execute('machines.add.ssh.respond', { taskId: nextTaskId, answer: { kind: 'ssh.password' } }, { ...context, surface: 'mcp' });
        const saves = harness.requestsFor(REMOTE_HOST_ROWS_ROUTE_V1).filter(request => request.input !== null).length;
        await harness.switchAccount(serverId, 'bob');
        await activateSshAccount(serverId, 'bob');
        await vi.waitFor(() => expect(manual.bridge.cancel).toHaveBeenCalledWith(nextTaskId));
        expect(manual.runner.getSnapshot(nextTaskId!)?.cancelRequested).toBe(true);
        const cancellations = manual.bridge.cancel.mock.calls.length;
        discardMachineAddFlowDraft();
        expect(readMachineAddFlowDraft().sshTask).toBeNull();
        expect(manual.bridge.cancel.mock.calls).toHaveLength(cancellations);
        manual.emitResult(nextTaskId!, { protocolVersion: 1, taskId: nextTaskId!, ok: true, data: { machineId: 'retired-machine' } });
        expect(harness.requestsFor(REMOTE_HOST_ROWS_ROUTE_V1).filter(request => request.input !== null)).toHaveLength(saves);
        expect(JSON.stringify(refused).includes('fixture-secret-marker')).toBe(false);
        expect(refused).toMatchObject({ ok: false, errorCode: 'machine_enroll_response_failed', error: 'machine_enroll_response_failed' });
    });
    it.each(['machines.replacement.set', 'machines.replacement.clear'] as const)('invokes %s through Account admission and refuses a disabled policy before HTTP', async rawId => {
        const actionId = ActionIdSchema.parse(rawId);
        const serverId = await harness.addHome({ name: 'Replacement Home', serverUrl: 'https://replacement.example', accountId: 'alice' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ settingsScope: { serverId, accountId: 'alice' }, profileScope: { serverId, accountId: 'alice' } });
        const path = '/v1/machines/old/replacement';
        harness.answer(serverId, path, { body: {} });
        const input = rawId === 'machines.replacement.set'
            ? { serverId, machineId: 'old', replacementMachineId: 'new', confirmActiveOldMachine: true }
            : { serverId, machineId: 'old' };
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: 'alice' };
        expect(await makeExecutor().execute(actionId, input, { ...context,
            actionsSettings: normalizeActionsSettingsV1({ v: 1, actions: { [rawId]: { enabled: false } } }),
        })).toMatchObject({ ok: false, errorCode: 'action_disabled' });
        expect(harness.requestsFor(path)).toHaveLength(0);
        expect(await makeExecutor().execute(actionId, input, { ...context,
            surface: 'agent', authority: 'account_automation',
        })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(harness.requestsFor(path)).toHaveLength(0);
        expect(await makeExecutor().execute(actionId, input, { ...context,
            presentUserConfirmation: { actionId },
        })).toEqual({ ok: true, result: { ok: true } });
        expect(harness.requestsFor(path)).toHaveLength(1);
        expect(harness.requestsFor(path)[0]).toMatchObject({ serverId, input: rawId.endsWith('set')
            ? { replacementMachineId: 'new', confirmActiveOldMachine: true } : null });
        expect(await makeExecutor().execute(actionId, input, { ...context,
            expectedAccountId: 'bob', presentUserConfirmation: { actionId },
        })).toMatchObject({ ok: false, errorCode: 'account_settings_scope_changed' });
        expect(harness.requestsFor(path)).toHaveLength(1);
    });
    it('lists existing terminals on the requested Home and preserves method-unavailable fallback', async () => {
        const serverId = await harness.addHome({ name: 'Shell Home', serverUrl: 'https://shell.example', accountId: 'alice' });
        const signal = new AbortController().signal;
        boundary.rpc.mockResolvedValueOnce({ ok: true, terminals: [] });
        expect(await makeExecutor().execute('machines.terminal.list', { machineId: 'machine', serverId }, { surface: 'ui', authority: 'present_user', serverId, signal }))
            .toEqual({ ok: true, result: { ok: true, terminals: [] } });
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({ machineId: 'machine', serverId, signal, method: 'daemon.terminal.list', payload: {} }));
        boundary.rpc.mockRejectedValueOnce({ rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE' });
        expect(await makeExecutor().execute('machines.terminal.list', { machineId: 'machine', serverId }, { surface: 'ui', authority: 'present_user', serverId }))
            .toEqual({ ok: true, result: null });
    });
    it('preserves a terminal write pre-effect refusal through the real Action executor', async () => {
        const serverId = await harness.addHome({ name: 'Input Home', serverUrl: 'https://input.example', accountId: 'alice' });
        const input = { machineId: 'machine', serverId, terminalId: 'pty', event: { t: 'text' as const, text: 'safe' } };
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId,
            actionsSettings: { v: 1 as const, actions: {}, approvalWaivedSurfaces: { 'machines.terminal.write': ['ui' as const] } } };
        boundary.rpc.mockRejectedValueOnce(markRpcRequestDisposition(Object.assign(new Error('offline'), {
            code: 'RPC_CLIENT_NOT_AVAILABLE', rpcErrorCode: 'RPC_CLIENT_NOT_AVAILABLE',
        }), 'notSent'));
        expect(await makeExecutor().execute('machines.terminal.write', input, context)).toMatchObject({
            ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE', effectAttempted: false,
        });
        boundary.rpc.mockResolvedValueOnce({ ok: true });
        expect(await makeExecutor().execute('machines.terminal.write', input, context)).toEqual({ ok: true, result: { ok: true } });
    });

    it('refreshes Tools through one admitted Action without returning private capability facts or adding idle reads', async () => {
        const serverId = await harness.addHome({ name: 'Tools Home', serverUrl: 'https://tools.example', accountId: 'alice' });
        await activateSshAccount(serverId, 'alice');
        const id = 'machines.capabilities.detect';
        const response = { protocolVersion: 1, results: {
            'tool.tmux': { ok: true, checkedAt: 1, data: { available: true, version: '3.5' } },
            'cli.claude': { ok: true, checkedAt: 1, data: { signIn: { accountLabel: 'private@example.test' } } },
        } };
        boundary.rpc.mockResolvedValue(response);
        const executor = makeExecutor();
        const context = { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'alice' } as const;
        const rejected = await executor.execute(id, { serverId, machineId: 'machine', request: {
            requests: [{ id: 'tool.acpAgentInventory', params: { definitions: [] } }],
        } }, context);
        expect(rejected).toMatchObject({ ok: false });
        expect(boundary.rpc).not.toHaveBeenCalled();
        for (const surface of ['ui', 'agent'] as const) {
            expect(await executor.execute(id, { serverId, machineId: 'machine' }, {
                ...context, surface, authority: surface === 'ui' ? 'present_user' : 'account_automation',
            })).toEqual({ ok: true, result: { status: 'completed' } });
        }
        const { CAPABILITIES_REQUEST_MACHINE_DETAILS } = await import('@/capabilities/requests');
        expect(boundary.rpc).toHaveBeenCalledTimes(2);
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({
            machineId: 'machine', serverId, accountId: 'alice', method: RPC_METHODS.CAPABILITIES_DETECT,
            payload: CAPABILITIES_REQUEST_MACHINE_DETAILS,
        }));
        boundary.rpc.mockResolvedValueOnce({ error: 'RPC_METHOD_NOT_FOUND', errorCode: 'RPC_METHOD_NOT_FOUND' });
        expect(await executor.execute(id, { serverId, machineId: 'machine' }, context))
            .toEqual({ ok: true, result: { status: 'failed', reason: 'not-supported' } });
        boundary.rpc.mockRejectedValueOnce(Object.assign(new Error('private transport details'), { rpcErrorCode: 'RPC_FORBIDDEN' }));
        expect(await executor.execute(id, { serverId, machineId: 'machine' }, context)).toEqual({ ok: true,
            result: { status: 'failed', reason: 'error', error: { name: 'Error', rpcErrorCode: 'RPC_FORBIDDEN' } } });
        const { renderHook, flushHookEffects, createDeferred } = await import('@/dev/testkit');
        const { act } = await import('react-test-renderer');
        const { useMachineCapabilitiesCache, prefetchMachineCapabilities } = await import('@/hooks/server/useMachineCapabilitiesCache');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const accountLifetime = captureActiveServerAccountScopeLifetime()!;
        const cacheParams = { serverId, machineId: 'machine', accountLifetime, request: CAPABILITIES_REQUEST_MACHINE_DETAILS };
        const cache = await renderHook(() => useMachineCapabilitiesCache({ ...cacheParams, enabled: false }));
        expect(cache.getCurrent().state).toMatchObject({ status: 'error', error: { name: 'Error', rpcErrorCode: 'RPC_FORBIDDEN' } });
        const pendingPassiveRead = createDeferred<typeof response>();
        boundary.rpc.mockImplementationOnce(() => pendingPassiveRead.promise);
        let passiveReads!: Promise<void[]>;
        await act(async () => { passiveReads = Promise.all([
            prefetchMachineCapabilities(cacheParams), prefetchMachineCapabilities(cacheParams),
        ]); });
        await flushHookEffects();
        expect(boundary.rpc).toHaveBeenCalledTimes(5);
        let refreshActionEntries = 0;
        let refresh!: ReturnType<typeof executor.execute>;
        const updatedResponse = { ...response, results: { ...response.results,
            'tool.tmux': { ok: true, checkedAt: 2, data: { available: true, version: '3.6' } },
        } };
        boundary.rpc.mockResolvedValueOnce(updatedResponse);
        await act(async () => {
            refreshActionEntries += 1;
            refresh = executor.execute(id, { serverId, machineId: 'machine' }, context);
        });
        await act(async () => { pendingPassiveRead.resolve(response); await passiveReads; await refresh; });
        await flushHookEffects();
        expect(await refresh).toEqual({ ok: true, result: { status: 'completed' } });
        expect(cache.getCurrent().state).toMatchObject({ status: 'loaded', snapshot: { response: updatedResponse } });
        expect(refreshActionEntries).toBe(1);
        expect(boundary.rpc).toHaveBeenCalledTimes(6);
        vi.useFakeTimers();
        try {
            await vi.advanceTimersByTimeAsync(60_000);
            expect(boundary.rpc).toHaveBeenCalledTimes(6);
            expect(refreshActionEntries).toBe(1);
        } finally { vi.useRealTimers(); }
        await cache.unmount();
    });
    it('stops the exact Machine daemon through admitted UI Action RPC', async () => {
        const serverId = await harness.addHome({ name: 'Stop Home', serverUrl: 'https://stop.example', accountId: 'alice' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        storage.setState({ profileScope: { serverId, accountId: 'alice' } });
        boundary.rpc.mockResolvedValueOnce({ message: 'Stopped' });
        expect(await makeExecutor().execute('machines.daemon.stop', { serverId, machineId: 'machine' }, {
            surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'alice',
            presentUserConfirmation: { actionId: 'machines.daemon.stop' },
        })).toEqual({ ok: true, result: { message: 'Stopped' } });
        expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine', serverId, method: RPC_METHODS.STOP_DAEMON, payload: {} }));
    });
    it('refuses a daemon stop after its captured Account changes before issuing RPC', async () => {
        const serverId = await harness.addHome({ name: 'Stop Home', serverUrl: 'https://stop.example', accountId: 'alice' });
        await harness.switchAccount(serverId, 'bob');
        const result = await createMachineConnectionActionDeps().machinePageAction!({
            actionId: 'machines.daemon.stop', input: { serverId, machineId: 'machine' },
            context: { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'alice' },
        });
        expect(result).toMatchObject({ ok: false, errorCode: 'account_settings_scope_changed' });
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
    it('opens a terminal with a configured UI waiver on the requested Home and retains the daemon handle', async () => {
        const serverId = await harness.addHome({ name: 'Shell Home', serverUrl: 'https://shell.example', accountId: 'alice' });
        const signal = new AbortController().signal;
        boundary.rpc.mockResolvedValueOnce({ ok: true, terminalId: 'pty', reused: true });
        expect(await makeExecutor().execute('machines.terminal.open', { machineId: 'machine', serverId, terminalKey: 'shell', cwd: '/project' }, {
            surface: 'ui', authority: 'present_user', serverId, signal,
            actionsSettings: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.terminal.open': ['ui'] } },
        })).toEqual({ ok: true, result: { ok: true, terminalId: 'pty', reused: true } });
        expect(boundary.rpc).toHaveBeenLastCalledWith(expect.objectContaining({ serverId, machineId: 'machine', signal,
            method: RPC_METHODS.DAEMON_TERMINAL_ENSURE, payload: { terminalKey: 'shell', cwd: '/project' } }));
    });
    it('rejects an invalid Home address through the canonical connection owner', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://existing.example', accountId: 'alice' });
        expect(await makeExecutor().execute('homes.connect', { address: 'ftp://wrong.example' }, {
            surface: 'ui', authority: 'present_user', serverId,
        })).toEqual({ ok: true, result: { kind: 'invalid_address' } });
        expect(harness.requests.some((request) => request.serverUrl === 'ftp://wrong.example')).toBe(false);
    });
    it('reconnects the focused Home through the real connection lifecycle', async () => {
        await loadSyncSingletonForTests();
        const serverId = await harness.addHome({ name: 'Focused Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        expect(getActiveServerAccountScope()).toBeNull();
        try {
            expect(await makeExecutor().execute('homes.reconnect', { serverId }, {
                surface: 'ui', authority: 'present_user', serverId,
            })).toEqual({ ok: true, result: { serverId } });
            expect(getActiveServerAccountScope()).toMatchObject({
                serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'alice',
            });
        } finally {
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
        }
    });
    it('refuses reconnecting an unfocused Home rather than retrying another Home', async () => {
        const other = await harness.addHome({ name: 'Other Home', serverUrl: 'https://other.example', accountId: 'alice' });
        await harness.addHome({ name: 'Focused Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const requestCount = harness.requests.length;
        expect(await makeExecutor().execute('homes.reconnect', { serverId: other }, {
            surface: 'ui', authority: 'present_user', serverId: other,
        })).toMatchObject({ ok: false, errorCode: 'home_not_focused' });
        expect(harness.requests).toHaveLength(requestCount);
    });
    it('does not retry using a replacement Account after the admitted Account retires', async () => {
        await loadSyncSingletonForTests();
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const { captureLazyActionAccountContext } = await import('./actionAccountContext');
        const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
        const account = await captureLazyActionAccountContext(serverId);
        try {
            await harness.switchAccount(serverId, 'bob');
            expect(account.accountLifetime.isCurrent()).toBe(false);
            const executor = createActionExecutor(createMachineConnectionActionDeps({ account }) as ActionExecutorDeps);
            const result = await executor.execute('homes.reconnect', { serverId }, {
                surface: 'ui', authority: 'present_user', serverId, runtimeAccountId: 'alice',
            });
            expect(result.ok).toBe(false);
            expect(getActiveServerAccountScope()).toBeNull();
        } finally {
            account.dispose();
            const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
            await disconnectActiveServerConnection();
        }
    });
    it('refuses reconnecting with a mismatched Action scope before touching transport', async () => {
        const other = await harness.addHome({ name: 'Other Home', serverUrl: 'https://other.example', accountId: 'alice' });
        const focused = await harness.addHome({ name: 'Focused Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const requestCount = harness.requests.length;
        expect(await makeExecutor().execute('homes.reconnect', { serverId: focused }, {
            surface: 'ui', authority: 'present_user', serverId: other,
        })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
        expect(harness.requests).toHaveLength(requestCount);
    });
    it('does not reconnect after caller cancellation', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://focused.example', accountId: 'alice' });
        const controller = new AbortController();
        controller.abort();
        const requestCount = harness.requests.length;
        expect(await makeExecutor().execute('homes.reconnect', { serverId }, {
            surface: 'ui', authority: 'present_user', serverId, signal: controller.signal,
        })).toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(harness.requests).toHaveLength(requestCount);
    });
    it('prepares Windows SSH setup without exposing credentials or starting a native task', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://setup.example', accountId: 'alice' });
        const result = await makeExecutor().execute('machines.add.command', {
            serverId, method: 'ssh', os: 'windows', host: 'ssh.example', port: 2222, username: 'alice', authMode: 'keyfile', identityFilePath: 'C:\\Keys\\ssh key',
        }, { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: true, result: { descriptorFileRequired: false } });
        if (!result.ok || typeof result.result !== 'object' || result.result === null || !('command' in result.result)) throw new Error('No setup command');
        expect(result.result.command).toContain('happier machine enroll');
        expect(result.result.command).toContain('--ssh-port 2222');
        expect(result.result.command).toContain('--home-url https://setup.example');
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
    it.each(['another_computer', 'ssh'] as const)('refuses a controller-only Home at the public %s command entry', async method => {
        const serverId = await harness.addHome({ name: 'Local Home', serverUrl: 'http://happier-agent-qa-unified-work-dev.localhost:3009', accountId: 'alice' });
        const result = await makeExecutor().execute('machines.add.command', {
            serverId, os: 'linux', ...(method === 'ssh' ? { method, host: 'nl1' } : { method }),
        }, { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: false, errorCode: 'home_not_guest_reachable' });
    });
    it('prepares reviewed dedicated SSH administrator identity through the public command Action', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://setup.example', accountId: 'alice' });
        const { ManagedMachineEnrollmentIdentityV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
        const enrollmentIdentity = ManagedMachineEnrollmentIdentityV1Schema.parse({ kind: 'dedicatedDaemonUser', username: 'happier',
            serviceMode: 'user', role: 'server', adminAccessAtCreation: 'ask', administrator: { username: 'operator' } });
        const result = await makeExecutor().execute('machines.add.command', {
            serverId, method: 'ssh', os: 'windows', host: 'ssh.example', username: 'root', enrollmentIdentity,
        }, { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toMatchObject({ ok: true, result: { descriptorFileRequired: false } });
        if (!result.ok || typeof result.result !== 'object' || result.result === null || !('command' in result.result)) throw new Error('No setup command');
        expect(result.result.command).toContain('--role server --admin-access ask --administrator operator');
        expect(result.result.command).not.toContain('--password');
        expect(boundary.rpc).not.toHaveBeenCalled();
    });
    it('retires the trusted pairing lifecycle after returning its link when the Home Account changes', async () => {
        await loadSyncSingletonForTests();
        const identity = 'srv_pairing-home';
        const serverUrl = 'https://pairing.example';
        const serverId = await harness.addHome({ name: 'Pairing Home', serverUrl, serverIdentityId: identity, accountId: 'alice' });
        const descriptor = { v: 1 as const, homeServerIdentityId: identity, canonicalServerUrl: serverUrl, revision: 1,
            endpoints: [{ kind: 'https' as const, url: serverUrl }] };
        const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
        await adoptHomeProfile({ descriptor, source: 'manual' });
        const features = { ...createRootLayoutFeaturesResponse({
            capabilities: { serverIdentity: { serverIdentityId: identity } },
            features: { auth: { pairing: { boundQrV2: { enabled: true }, desktopQrMobileScan: { enabled: false } } } } }), homeConnectionDescriptor: descriptor };
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features, serverIdentityId: identity } });
        harness.answer(serverId, '/v1/features', { body: features });
        harness.answer(serverId, '/v1/features/authenticated', { body: features });
        const expiresAtMs = Date.now() + 60_000;
        const expiresAt = new Date(expiresAtMs).toISOString();
        harness.answer(serverId, '/v1/auth/pairing/start', { body: { pairId: 'pair', expiresAt } });
        let releaseStatus!: () => void;
        const heldStatus = new Promise<void>((resolve) => { releaseStatus = resolve; });
        const requesterPublicKey = new Uint8Array(32).fill(9);
        const statusPath = '/v1/auth/pairing/status?pairId=pair';
        harness.answer(serverId, statusPath, { respondAfter: heldStatus, body: { state: 'requested', pairId: 'pair', expiresAt,
            requestedPublicKey: encodeBase64(requesterPublicKey), requestedDeviceLabel: 'Computer', homeServerIdentityId: identity,
            bindingProof: computeHomeQrBindingProofV2({ direction: 'trusted_home_displays', qrSecret: new Uint8Array(32).fill(7),
                pairId: 'pair', homeServerIdentityId: identity, requesterPublicKey, expiresAtMs }) } });
        harness.answer(serverId, '/v1/auth/pairing/consume', { body: {} });
        try {
            const result = await makeExecutor().execute('machines.pairing.create', { serverId }, {
                surface: 'ui', authority: 'present_user', serverId,
                presentUserConfirmation: { actionId: 'machines.pairing.create' },
            });
            if (!result.ok) throw new Error(JSON.stringify(result));
            expect(result).toMatchObject({ ok: true, result: { pairId: 'pair', expiresAtMs } });
            await vi.waitFor(() => expect(harness.requestsFor(statusPath)).toHaveLength(1));
            await harness.switchAccount(serverId, 'bob');
            await vi.waitFor(() => expect(harness.requestsFor('/v1/auth/pairing/consume')).toHaveLength(1));
            expect(harness.requestsFor('/v1/auth/pairing/consume')[0]?.input).toEqual({ pairId: 'pair', intent: 'cancel' });
            releaseStatus();
            await Promise.resolve();
            expect(harness.requests.some((request) => request.path.includes('response'))).toBe(false);
        } finally { releaseStatus(); }
    });
});
