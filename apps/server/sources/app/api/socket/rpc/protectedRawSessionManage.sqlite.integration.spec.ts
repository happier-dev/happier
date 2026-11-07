import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, MACHINE_PLAIN_DATA_KEY_MARKER,
    buildAccountStoredContentCompatibilitySocketAuthV1, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { createAuthenticatedFakeSocket, triggerSocketHandler } from '../../testkit/socketHarness';
import { registerSocketRpcHandlers } from './registerSocketRpcHandlers';
import { buildRpcMethodRoom } from './rpcMethodRoom';

const accountStoredContentCompatibility = evaluateAccountStoredContentSocketCompatibility(
    buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
).evaluation;

describe('raw Session filesystem RPC authority through real admission', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-session-manage-', initAuth: true });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it.each(['owner', 'manage', 'use', 'foreign'] as const)(
        'admits only owner and Manage through a daemon-user Session receiver (%s)', async role => {
            const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
            const member = await db.account.create({ data: { encryptionMode: 'plain' } });
            const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
            const sessionOwner = role === 'owner' ? custodian : member;
            const actor = role === 'foreign' ? foreign : sessionOwner;
            const session = await db.session.create({ data: { accountId: sessionOwner.id, tag: randomUUID(),
                encryptionMode: 'plain', metadata: '{}' } });
            const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
                installationId: randomUUID(), active: true,
                metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test',
                    homeDir: '/home/custodian', happyHomeDir: '/home/custodian/.happier' }),
                dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
                operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] },
                    sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1 } });
            await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: member.id }, level: role === 'manage' ? 'admin' : 'view' }));
            expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: sessionOwner.id,
                machineId: machine.id, sessionId: session.id, data: 'opaque-session-key' }))).toMatchObject({ ok: true });
            // Socket transport is the only substitute. Tokens, grants, binding,
            // router admission and the final forwarding guard are production owners.
            const emitWithAck = vi.fn(async () => ({ path: '/home/custodian', content: 'file bytes' }));
            const target = { id: randomUUID(), connected: true, data: { clientType: 'session-scoped',
                userId: sessionOwner.id, accountStoredContentCompatibility,
                sessionScopedBinding: { sessionId: session.id, machineId: machine.id, proof: 'machine-access-key' } },
                timeout: () => ({ emitWithAck }) };
            const machineOnlyMethod = RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT;
            for (const rpcMethod of [RPC_METHODS.READ_FILE, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
                ...(role === 'owner' ? [machineOnlyMethod] : [])]) {
                emitWithAck.mockClear();
                const method = `${session.id}:${rpcMethod}`;
                const io = new Server();
                io.sockets.sockets.set(target.id, target as unknown as Socket);
                io.sockets.adapter.rooms.set(buildRpcMethodRoom({ userId: sessionOwner.id, method }), new Set([target.id]));
                const token = await createAccountTokenForTests(actor.id, { kind: 'account', authority: 'present_user' });
                const caller = Object.assign(createAuthenticatedFakeSocket({ id: randomUUID(), data: {
                    clientType: 'user-scoped', accountStoredContentCompatibility,
                } }), { handshake: { auth: { token } } });
                registerSocketRpcHandlers({ userId: actor.id, socket: caller as unknown as Socket, io });
                const callback = vi.fn();
                await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-file-request' }, callback);
                expect(callback).toHaveBeenCalledOnce();
                io.sockets.sockets.clear();
                const response = callback.mock.calls[0]![0];
                if (rpcMethod === machineOnlyMethod) {
                    // This Machine method has no protected raw Session guard to
                    // receive delegated authority. The Machine guard must refuse.
                    expect(resolveMachineRpcRoutePolicy(rpcMethod)).toMatchObject({ ephemeralRunnerAuthority: 'readTranscript' });
                    expect(resolveMachineRpcRoutePolicy(rpcMethod).requesterExecutionIsolationRequired).not.toBe(true);
                    expect(response).toMatchObject({ ok: false, errorCode: 'RPC_METHOD_NOT_AVAILABLE' });
                    expect(emitWithAck).not.toHaveBeenCalled();
                } else if (role === 'owner' || role === 'manage') {
                    expect(response, JSON.stringify(response)).toMatchObject({ ok: true,
                        result: { path: '/home/custodian', content: 'file bytes' } });
                    expect(emitWithAck).toHaveBeenCalledOnce();
                    expect(emitWithAck.mock.calls[0]).toMatchObject([expect.any(String), {
                        machineAdmission: { actorAccountId: actor.id, custodianAccountId: custodian.id, role: 'manage' },
                    }]);
                } else {
                    expect(response, JSON.stringify(response)).toMatchObject({ ok: false,
                        errorCode: role === 'use' ? 'agent_isolation_unavailable' : 'RPC_METHOD_NOT_AVAILABLE' });
                    expect(emitWithAck).not.toHaveBeenCalled();
                }
            }
        },
    );
});
