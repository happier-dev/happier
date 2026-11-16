import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import tweetnacl from 'tweetnacl';
import { expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';
import { ExternalActionDaemonDispatchRequestSchema, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@happier-dev/protocol/actions/externalActionApi';
import { MANAGED_FINITE_WAKE_RPC_METHOD, ManagedFiniteWakeRequestV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { startWorkflowApprovedOperationServer } from '@/testkit/workflowApprovedOperationServer.testkit';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { encrypt, decrypt } from '../../../../../../cli/src/api/encryption';
import { configuration } from '../../../../../../cli/src/configuration';
import { ApiClient } from '../../../../../../cli/src/api/api';
import { CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1 } from '../../../../../../cli/src/api/apiMachine';
import { fetchServerFeaturesSnapshot } from '../../../../../../cli/src/features/serverFeaturesClient';
import { registerExternalActionRpcHandler } from '../../../../../../cli/src/rpc/handlers/externalAction';
import { createDaemonExternalActionTargetResolver } from '../../../../../../cli/src/daemon/externalActions/daemonExternalActionTargetResolver';
import { verifyExternalActionExecutionAuthorizationCurrent } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import type { RpcHandler } from '../../../../../../cli/src/api/rpc/types';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import { prepareRequesterAccountActionContext } from '../../../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { withConfiguredDaemonTestHome } from '../../../../../../cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { forwardRpcCall } from '@/app/api/socket/rpc/forwardRpcCall';
import { resolveRpcForwardTimeoutMs } from '@/app/api/socket/rpc/rpcForwardTimeout';
import { createSocketRoomDiscoveryHarness } from '@/app/api/testkit/socketHarness';
import { qualifyCurrentAccountStoredContentSocket } from '@/app/api/testkit/accountStoredContentCompatibility';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { hasManagedWakeAuthority } from '@/app/machines/managed/managedWakeBinding';

it('preserves owner-enabled input wake for Use-only public Send without granting other finite work power', () => {
    expect(hasManagedWakeAuthority('use', true, 'finite-command', 'session.message.send')).toBe(true);
    expect(hasManagedWakeAuthority('use', false, 'finite-command', 'session.message.send')).toBe(false);
    expect(hasManagedWakeAuthority('use', true, 'finite-command', 'execution.run.start')).toBe(false);
});

it.each([true, false].flatMap(managed => (['default', 'enqueue', 'send_now'] as const).map(kind => ({ managed, kind }))))(
    'admits public Session Send through Home and wakes only an asleep managed guest (managed=$managed, input=$kind)', async ({ managed, kind }) => {
    const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey;
    const delivered: unknown[] = [];
    const effects: string[] = [];
    let managedId = '';
    let receive: RpcHandler | undefined;
    let connectGuest: (() => Promise<void>) | undefined;
    const server = await startWorkflowApprovedOperationServer({ workflowSessions: true,
        e2ee: { contentPublicKey: publicKey,
            encodeMachine: (key, value) => encodeBase64(encrypt(key, 'dataKey', value)),
            decodeMachine: (key, value): unknown => decrypt(key, 'dataKey', decodeBase64(value)) },
        // The socket transport is the only substituted boundary. CLI selection,
        // encryption, HTTP routing, signed admission and wake custody stay real.
        forwardRpc: async request => {
            if (request.method.endsWith(`:${MANAGED_FINITE_WAKE_RPC_METHOD}`)) {
                const wake = ManagedFiniteWakeRequestV1Schema.parse(request.callParams);
                expect(wake.target.managedId).toBe(managedId);
                expect(wake.actionOrigin.binding).toMatchObject({ actionId: 'session.message.send', machineRuntimeDemand: 'required' });
                effects.push('controller-wake');
                const legacyDeadline = resolveRpcForwardTimeoutMs();
                if (legacyDeadline === null) throw new Error('The fixture requires a configured legacy RPC deadline');
                let submitted = () => {};
                const received = new Promise<void>(resolve => { submitted = resolve; });
                // Socket.IO ACKs are the boundary. Keep the real forwarder and
                // cross its legacy deadline while the invoking Send stays live.
                const socket = { id: 'installed-controller', connected: true, data: {
                    clientType: 'machine-scoped', userId: server.accountId, machineId: controller.id,
                    verifiedMachineInstallationId: controller.installationId,
                }, timeout: (ackDeadline: number) => ({
                    emitWithAck: (_event: string, _packet: SocketRpcRequestPayload) => new Promise<unknown>((resolve, reject) => {
                        const native = setTimeout(async () => {
                            clearTimeout(deadline);
                            await db.machine.update({ where: { id: wake.target.enrolledMachineId },
                                data: { active: true, lastActiveAt: new Date() } });
                            resolve({ ok: true, result: { kind: 'accepted', managedId,
                                intentRevision: wake.target.expectedIntentRevision + 1 } });
                        }, legacyDeadline + 1);
                        const deadline = setTimeout(() => {
                            clearTimeout(native);
                            reject(new Error('operation has timed out'));
                        }, ackDeadline);
                        submitted();
                    }),
                }) };
                qualifyCurrentAccountStoredContentSocket(socket);
                vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
                try {
                    const pending = forwardRpcCall({ ...request,
                        io: createSocketRoomDiscoveryHarness(async () => [socket]) });
                    await Promise.race([received, pending.then(result => {
                        throw new Error(`Controller transport was not submitted: ${JSON.stringify(result)}`);
                    })]);
                    await vi.advanceTimersByTimeAsync(legacyDeadline + 1);
                    return await pending;
                } finally { vi.useRealTimers(); }
            }
            const packet = ExternalActionDaemonDispatchRequestSchema.parse(request.callParams);
            if (!receive) throw new Error('Guest Action receiver was not registered');
            await connectGuest?.();
            effects.push('send-now');
            delivered.push(packet.actionId);
            return { ok: true, result: await receive(packet, { authorization: ACTION_API_SERVER_ORIGIN,
                signal: request.cancellation?.signal }) };
        } });
    const [controller, guest] = server.machines;
    const sessionKey = tweetnacl.randomBytes(32);
    const session = await db.session.create({ data: { accountId: server.accountId, tag: randomUUID(),
        active: false, encryptionMode: 'e2ee',
        metadata: encodeBase64(encrypt(sessionKey, 'dataKey', { machineId: guest.id, path: '/workspace' })),
        dataKeyEnvelopes: { create: { recipientAccountId: server.accountId,
            encryptedDataKey: Uint8Array.from(sealEncryptedDataKeyEnvelopeV1({ recipientPublicKey: publicKey,
                dataKey: sessionKey, randomBytes: tweetnacl.randomBytes })) } } } });
    expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: server.accountId,
        sessionId: session.id, machineId: guest.id,
        data: encodeBase64(encrypt(material.machineKey, 'dataKey', Array.from(sessionKey))) })))
        .toMatchObject({ ok: true });
    try {
        const row = managed ? await db.managedMachine.create({ data: { homeId: server.homeId, custodianAccountId: server.accountId,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId,
            admittedActionRequestId: randomUUID(), admittedInput: {}, enrolledMachineId: guest.id,
            allocation: 'bound', creationState: 'active', desired: 'stop', intentRevision: 2,
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Send-now guest', choices: {} },
            resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
            observation: { availability: 'present', power: 'stopped', storage: 'retained', observedAt: Date.now() } } }) : null;
        managedId = row?.id ?? '';
        await db.machine.update({ where: { id: guest.id }, data: {
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                sessionInputAdmission: { protocolVersions: [1, 2] } } } });
        await server.setMachineOnline(guest.id, false);
        await withConfiguredDaemonTestHome({ prefix: 'managed-send-now-' }, async () => {
            const credentials = { token: server.token, credentialProvenance: 'stored_session' as const,
                encryption: { ...material, publicKey } };
            await writeFile(configuration.installationIdentityFile, JSON.stringify({ version: 1,
                installationId: guest.installationId, createdAt: Date.now(),
                publicKey: encodeBase64(guest.keys.publicKey, 'base64url'),
                privateKey: encodeBase64(guest.keys.secretKey, 'base64url') }), { mode: 0o600 });
            const api = await runWithServerHttpBaseUrl(server.baseUrl, () => ApiClient.create(credentials));
            const machine = await runWithServerHttpBaseUrl(server.baseUrl, () => api.getMachine(guest.id));
            if (!machine) throw new Error('Guest Machine was not readable');
            const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: server.baseUrl, token: server.token });
            const machineClient = await runWithServerHttpBaseUrl(server.baseUrl, () => api.machineSyncClient(machine, undefined, {
                getServerFeaturesSnapshot: () => snapshot, resolveCurrentServerIdentityId: () => server.homeId,
            }));
            let connected: Promise<void> | undefined;
            connectGuest = () => runWithServerHttpBaseUrl(server.baseUrl,
                () => connected ??= new Promise<void>((resolve, reject) => machineClient.connect({ onConnect: async () => {
                // This receiver supports Pending input, without advertising a
                // native Session-spawn host that this fixture does not install.
                await machineClient.publishOperationProtocolCapabilities({
                    sessionInputAdmission: CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1.sessionInputAdmission,
                    externalActionExecutionAuthorization: CURRENT_MACHINE_OPERATION_PROTOCOL_CAPABILITIES_V1.externalActionExecutionAuthorization,
                }).then(() => resolve(), reject);
            } })));
            // This transport fixture deliberately waives the CLI native confirmation.
            const settings = setActionApprovalOverride({ settings: ActionsSettingsV1Schema.parse({ v: 1 }),
                actionId: 'session.message.send', surface: 'cli', approvalRequired: false });
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId: configuration.activeServerId, serverIdentityId: server.homeId, serverApiUrl: server.baseUrl,
                resolveServerFeaturesSnapshot: () => snapshot,
                actionsSettingsProvider: { getActionsSettings: () => settings } });
            const receiver = createCliActionExecutorFromCredentials({ credentials,
                serverId: configuration.activeServerId, serverIdentityId: server.homeId, serverApiUrl: server.baseUrl,
                machineActionDirectTargetTransport: { machineId: guest.id,
                    invoke: async () => { throw new Error('Send-now uses real Home Pending admission, not another Machine RPC'); } },
                machineAdmissionTransport: (request, options) => machineClient.enqueueSessionPendingByMachine(request, options),
                machineId: guest.id, externalActionMachineInstallationId: guest.installationId,
                externalActionMachineRequestPrivateKey: guest.keys.secretKey,
                resolveServerFeaturesSnapshot: () => snapshot,
                actionsSettingsProvider: { getActionsSettings: () => settings } });
            registerExternalActionRpcHandler({ registerHandler: (method, handler) => {
                if (method === EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1) receive = handler;
            } }, { machineId: guest.id, currentServerId: configuration.activeServerId,
                currentServerHttpBaseUrl: server.baseUrl, resolveAccountId: async () => server.accountId,
                resolveInstallationId: () => guest.installationId,
                externalActionMachineRequestPrivateKey: guest.keys.secretKey,
                verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
                    privateKey: guest.keys.secretKey, installationId: guest.installationId, serverHttpBaseUrl: server.baseUrl }),
                prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ ...request,
                    purpose: { kind: 'external_action' }, machineId: guest.id, installationId: guest.installationId,
                    installationPrivateKey: guest.keys.secretKey, serverId: configuration.activeServerId,
                    serverIdentityId: server.homeId, serverHttpBaseUrl: server.baseUrl, ownCredentials: credentials,
                    createExecutor: () => receiver,
                    isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: request.authorization,
                        effectActionId: request.authorization.binding.actionId, target: request.authorization.binding.target,
                        privateKey: guest.keys.secretKey, installationId: guest.installationId, serverHttpBaseUrl: server.baseUrl }),
                }),
                resolveEncryption: async () => ({ serverIdentityId: server.homeId, material }),
                resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: server.baseUrl }),
                executor: receiver });
            const input = { sessionId: session.id, message: 'Wake and accept this input', localId: 'send-now-input',
                ...(kind === 'default' ? {} : { requestedAction: { v: 1, kind } }), reply: 'none' };
            try {
                const result = await runWithServerHttpBaseUrl(server.baseUrl,
                    () => executor.execute('session.message.send', input, { surface: 'cli' }));
                if (managed) {
                expect(result, JSON.stringify({ result, effects, requests: server.readRequestCosts() }))
                    .toMatchObject({ ok: true, result: { status: 'accepted', localId: 'send-now-input' } });
                expect(delivered).toEqual(['session.message.send']);
                expect(effects).toEqual(['controller-wake', 'send-now']);
                const admitted = await db.session.findUniqueOrThrow({ where: { id: session.id } });
                expect(admitted).toMatchObject({ pendingCount: 1, pendingActivationStatus: 'waiting',
                    pendingActivationRequestId: input.localId });
                expect(await db.sessionPendingMessage.findMany({ where: { sessionId: session.id } }))
                    .toMatchObject([{ localId: input.localId, status: 'queued' }]);
                } else {
                expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
                expect(delivered).toEqual([]);
                expect(effects).toEqual([]);
                }
            } finally { connectGuest = undefined; await machineClient.shutdown(); }
        });
    } finally { await server.close(); }
});
