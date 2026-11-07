import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionDaemonDispatchRequestSchema, createExternalActionDaemonDispatchResponse } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequestV2, prepareExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { MANAGED_FINITE_WAKE_RPC_METHOD, ManagedFiniteWakeRequestV1Schema } from '@happier-dev/protocol/machines/managed/managedPolicyV1';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { db } from '@/storage/db';
import { startWorkflowApprovedOperationServer } from '@/testkit/workflowApprovedOperationServer.testkit';
import { createCliActionExecutorFromCredentials } from '../../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { runWithServerHttpBaseUrl } from '../../../../../../cli/src/api/client/serverHttpBaseUrl';
import { encrypt, decrypt } from '../../../../../../cli/src/api/encryption';
import { configuration } from '../../../../../../cli/src/configuration';
import { withConfiguredDaemonTestHome } from '../../../../../../cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { forwardRpcCall } from '@/app/api/socket/rpc/forwardRpcCall';
import { resolveRpcForwardTimeoutMs } from '@/app/api/socket/rpc/rpcForwardTimeout';
import { createSocketRoomDiscoveryHarness } from '@/app/api/testkit/socketHarness';
import { qualifyCurrentAccountStoredContentSocket } from '@/app/api/testkit/accountStoredContentCompatibility';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';

it.each([true, false])('admits stored-credential CLI Send-now through Home and wakes only an asleep managed guest (managed=%s)', async managed => {
    const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
    const publicKey = tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey;
    const delivered: unknown[] = [];
    const effects: string[] = [];
    let managedId = '';
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
            const envelope = packet.envelope;
            if (envelope.v !== 2) throw new Error('expected_encrypted_send');
            const binding = { serverIdentityId: server.homeId, accountId: server.accountId,
                authentication: { kind: 'account' as const, tokenEpoch: server.tokenEpoch },
                actionId: packet.actionId, requestId: envelope.requestId, target: envelope.target! };
            const opened = openExternalActionRequestV2({ envelope, binding, material,
                projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
            expect(opened).not.toBeNull();
            delivered.push(opened?.input);
            effects.push('send-now');
            return { ok: true, result: createExternalActionDaemonDispatchResponse(prepareExternalActionResponseV2({
                binding, request: envelope, material, randomBytes: tweetnacl.randomBytes,
                executedMachineId: packet.placement.machineId,
                execution: { ok: true, result: { status: 'accepted', localId: 'send-now-input' } },
            })) };
        } });
    const [controller, guest] = server.machines;
    const sessionKey = tweetnacl.randomBytes(32);
    const session = await db.session.create({ data: { accountId: server.accountId, tag: randomUUID(),
        active: false, encryptionMode: 'e2ee',
        metadata: encodeBase64(encrypt(sessionKey, 'dataKey', { machineId: guest.id, path: '/workspace' })),
        dataKeyEnvelopes: { create: { recipientAccountId: server.accountId,
            encryptedDataKey: Uint8Array.from(sealEncryptedDataKeyEnvelopeV1({ recipientPublicKey: publicKey,
                dataKey: sessionKey, randomBytes: tweetnacl.randomBytes })) } } } });
    try {
        const row = managed ? await db.managedMachine.create({ data: { homeId: server.homeId, custodianAccountId: server.accountId,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId,
            admittedActionRequestId: randomUUID(), admittedInput: {}, enrolledMachineId: guest.id,
            allocation: 'bound', creationState: 'active', desired: 'stop', intentRevision: 2,
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Send-now guest', choices: {} },
            resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            observation: { availability: 'present', power: 'stopped', storage: 'retained', observedAt: Date.now() } } }) : null;
        managedId = row?.id ?? '';
        await db.machine.update({ where: { id: guest.id }, data: {
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] },
                sessionInputAdmission: { protocolVersions: [1, 2] } } } });
        await server.setMachineOnline(guest.id, false);
        await withConfiguredDaemonTestHome({ prefix: 'managed-send-now-' }, async () => {
            const credentials = { token: server.token, credentialProvenance: 'stored_session' as const,
                encryption: { ...material, publicKey } };
            const executor = createCliActionExecutorFromCredentials({ credentials, externalActionClient: true,
                serverId: configuration.activeServerId, serverIdentityId: server.homeId, serverApiUrl: server.baseUrl,
                resolveServerFeaturesSnapshot: async () => ({ status: 'unsupported', reason: 'endpoint_missing' }),
                actionsSettingsProvider: { getActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1 }) } });
            const input = { sessionId: session.id, message: 'Wake and accept this input',
                requestedAction: { v: 1, kind: 'send_now' }, reply: 'none' };
            const result = await runWithServerHttpBaseUrl(server.baseUrl,
                () => executor.execute('session.message.send', input, { surface: 'cli' }));
            if (managed) {
                expect(result, JSON.stringify({ result, effects, requests: server.readRequestCosts() }))
                    .toMatchObject({ ok: true, result: { status: 'accepted', localId: 'send-now-input' } });
                expect(delivered).toEqual([expect.objectContaining(input)]);
                expect(effects).toEqual(['controller-wake', 'send-now']);
            } else {
                expect(result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
                expect(delivered).toEqual([]);
                expect(effects).toEqual([]);
            }
        });
    } finally { await server.close(); }
});
