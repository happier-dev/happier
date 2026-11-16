import { createServer } from 'node:http';
import { Server } from 'socket.io';
import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { withConfiguredDaemonTestHome, writeDaemonSettingsFixture } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/v1';
import { createClientActionReverseDispatcher } from './clientActionReverseDispatch';
import { createCliActionExecutorFromCredentials } from './createCliActionExecutorFromCredentials';

// Exact nonsecret request captured in LUME-LIVE-164/retry-trust-input.json.
const input = { serverId: 'env_1569ad7d', homeId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN',
    managedId: 'cmwji1vgx006amc4hr4azc71w', operationId: '65d53d6e-f04b-4b3f-8424-65743bd79946',
    taskId: 'system-task:e237630b-ff84-4fa7-a30b-b7d5ffd1e1a7', purpose: 'approve', approved: true,
    prompt: { kind: 'ssh.trustHost', message: 'Trust this SSH host?', host: '192.168.64.62', keyType: 'ssh-ed25519',
        fingerprint: 'SHA256:QN9IsA0CGqjeg7WPFbYlHPY9BLUUnalCjrUoXrHdfGg', existingFingerprint: null } } as const;
afterEach(() => vi.restoreAllMocks());
it.each(['owner', 'foreign-account', 'foreign-home', 'stale-task', 'own-controller', 'own-stale-prompt', 'pairing-home-changed'] as const)(
    'answers managed Trust as the credentialed CLI client without an App (%s)', async variant => withConfiguredDaemonTestHome({ prefix: 'managed-installation-answer-' }, async ({ homeDir }) => {
        const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'requester', provenance: {
            v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const requestInput = variant === 'pairing-home-changed'
            ? { ...input, prompt: { kind: 'auth.approveRemoteProvisioning' as const, message: 'Sign this guest in?' } } : input;
        const own = variant === 'own-controller' || variant === 'own-stale-prompt';
        const machine = ManagedMachineFullV1Schema.parse({ id: input.managedId, homeId: input.homeId,
            custodianAccountId: own ? 'requester' : 'controller-owner', enrollmentAccountId: variant === 'foreign-account' ? 'someone-else' : 'requester',
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound',
            resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
        const operations = createActionOperationStore();
        operations.create({ operationId: input.operationId, scope: { accountId: 'requester', machineId: 'controller' },
            actionId: 'machines.managed.acquire', title: 'Create guest', cancellation: 'supported', inputIdentity: '{}',
            domainRef: { kind: 'managedMachine', id: machine.id, controller: machine.controller, resource: machine.resource,
                bootstrapTask: { id: input.taskId, taskKind: 'remote.ssh.bootstrapMachine.v1', prompt: variant === 'own-stale-prompt'
                    ? { ...input.prompt, fingerprint: 'SHA256:changed' } : input.prompt } } });
        operations.markRunning(input.operationId);
        if (variant === 'pairing-home-changed') await writeDaemonSettingsFixture(homeDir, { activeServerId: input.serverId,
            servers: { [input.serverId]: { id: input.serverId, name: 'Changed Home',
                serverUrl: 'https://changed-home.test', webappUrl: 'https://changed-home.test', createdAt: 0, updatedAt: 1,
                homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_foreign', canonicalServerUrl: 'https://changed-home.test',
                    revision: 1, endpoints: [{ kind: 'https', url: 'https://changed-home.test' }] } } } });
        const http = createServer();
        const io = new Server(http, { path: '/v1/updates/' });
        const answers: unknown[] = [];
        io.on('connection', socket => socket.on('rpc-call', async (packet, ack) => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
            if (packet.method === `controller:${ACTION_OPERATION_RPC_METHODS_V2.get}`) {
                ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' },
                    { kind: 'found', operation: operations.get({ accountId: 'requester', machineId: 'controller' }, input.operationId) }, decoded.callId) });
                return;
            }
            answers.push(decoded.params);
            ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, variant === 'stale-task'
                ? { ok: false, error: { code: 'no_prompt', message: 'No current task' } }
                : { ok: true, result: variant === 'pairing-home-changed' ? {
                    publicKey: 'not-used-before-home-check', homeServerIdentityId: input.homeId,
                    pairing: { secretB64Url: 'not-used-before-home-check', createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000 },
                    supportsTokenOnly: true, pairingRequirement: 'v3', enrollmentAccountId: 'requester' } : {} }, decoded.callId) });
        }));
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address();
        if (!address || typeof address === 'string') throw new Error('No fixture address');
        vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data: String(url).endsWith('/v1/account/encryption')
            ? { mode: 'plain', updatedAt: 1 } : { machine: { id: 'controller', kind: 'persistent', active: true,
                installationId: 'installation', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
                revokedAt: null, replacedByMachineId: null,
                access: { custodian: { accountId: 'requester', displayName: 'Owner' }, role: 'manage',
                    resourceMode: 'plain', accessState: 'ready' } } } }));
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: machine });
        const executor = createCliActionExecutorFromCredentials({ credentials: { token, encryption: null,
            credentialProvenance: 'stored_session' }, externalActionClient: true,
            // Real reverse dispatcher with no connected answering App at its socket boundary.
            clientActionExecute: createClientActionReverseDispatcher(() => ({ hasConnectedClientRpcHandler: () => false,
                callConnectedClientRpc: async () => ({ ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' }) })), serverId: input.serverId,
            serverIdentityId: variant === 'foreign-home' ? 'srv_foreign' : input.homeId,
            serverApiUrl: `http://127.0.0.1:${address.port}`,
            actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
        try {
            const result = await executor.execute('machines.managed.bootstrap.respond', requestInput, {
                surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                presentUserConfirmation: { actionId: 'machines.managed.bootstrap.respond' },
                serverId: input.serverId, runtimeAccountId: 'requester' });
            expect(result, JSON.stringify(result)).toMatchObject(variant === 'owner' || variant === 'own-controller' ? { ok: true, result: { taskId: input.taskId } }
                : { ok: false, errorCode: variant === 'foreign-account' ? 'action_account_scope_changed'
                    : variant === 'foreign-home' || variant === 'pairing-home-changed' ? 'server_target_mismatch' : 'no_prompt' });
            if (variant === 'own-controller') expect(answers).toEqual([{ id: 'tool.systemTasks', method: 'respond', params: {
                taskId: input.taskId, expectedPromptKind: 'ssh.trustHost', answer: { trusted: true } } }]);
            if (variant === 'own-stale-prompt') expect(answers).toHaveLength(0);
            if (variant === 'owner') expect(answers).toEqual([{ id: 'tool.systemTasks', method: 'respond', params: {
                homeId: input.homeId, managedId: input.managedId, operationId: input.operationId, taskId: input.taskId,
                controller: machine.controller, resource: machine.resource, expectedIntentRevision: 1,
                expectedPromptKind: 'ssh.trustHost', answer: { trusted: true } } }]);
            if (variant === 'foreign-account' || variant === 'foreign-home') expect(answers).toHaveLength(0);
            if (variant === 'foreign-home') expect(post).not.toHaveBeenCalled();
            if (variant === 'pairing-home-changed') {
                expect(answers).toHaveLength(1);
                expect(post.mock.calls.every(([url]) => String(url).startsWith('http://127.0.0.1:'))).toBe(true);
            }
        } finally { await new Promise<void>(resolve => io.close(() => resolve())); }
    }));
