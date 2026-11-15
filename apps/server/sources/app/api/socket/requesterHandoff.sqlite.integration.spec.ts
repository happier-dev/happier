import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import nacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { computeExternalActionRequestEnvelopeDigestV1, createExternalActionDaemonDispatchResponseV1, ExternalActionDaemonDispatchRequestSchema,
    prepareExternalActionResponseEnvelopeV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '../testkit/socketHarness';
import { currentAccountStoredContentCompatibilitySocketAuth } from '../testkit/accountStoredContentCompatibility';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { registerSocketRpcHandlers } from './rpc/registerSocketRpcHandlers';
import { createExternalActionDaemonDispatcher, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from './externalActionDispatcher';
import { ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';

describe('requester handoff placement and exact signed ingress', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-fx14-handoff-',
        initAuth: true, env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' } }); }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function fixture() {
        const alice = await db.account.create({ data: { encryptionMode: 'plain' } });
        const bob = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const machineData = { metadata: encodePlainMachineStoredContent({ host: 'shared', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/shared', happyHomeDir: '/home/shared/.happier' }), active: true,
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } };
        const source = await db.machine.create({ data: { ...machineData, id: randomUUID(), accountId: alice.id,
            installationId: randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        const target = await db.machine.create({ data: { ...machineData, id: randomUUID(), accountId: bob.id,
            installationId: randomUUID(), installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey) } });
        const grant = { machineId: source.id, accountId: bob.id, accessLevel: 'view' as const, createdByAccountId: alice.id };
        await db.machineGrant.create({ data: { ...grant, principalKind: 'account' } });
        const session = await db.session.create({ data: { accountId: bob.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: bob.id, sessionId: session.id, machineId: source.id, data: 'opaque' } });
        const envelope = { v: 1 as const, requestId: randomUUID(), target: { kind: 'machine' as const, machineId: source.id },
            handoffAdmission: { sessionId: session.id, sourceMachineId: source.id, targetMachineId: target.id },
            input: { sessionId: session.id, sourceMachineId: source.id, targetMachineId: target.id } };
        const principal = { accountId: bob.id, authority: 'present_user' as const,
            authentication: { kind: 'account' as const, tokenEpoch: bob.tokenEpoch } };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: bob.id, authentication: principal.authentication,
            serverIdentityId: await getOrCreateServerIdentityId(), machineId: source.id, actionId: 'session.handoff',
            requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            target: envelope.target, handoffAdmission: { ...envelope.handoffAdmission,
                sourceInstallationId: source.installationId!, targetInstallationId: target.installationId! } }, { input: envelope.input });
        const compatibility = evaluateAccountStoredContentSocketCompatibility(currentAccountStoredContentCompatibilitySocketAuth).evaluation;
        const effect = vi.fn(async (_event: string, payload: unknown) => {
            const method = (payload as { method: string }).method;
            if (!method.endsWith(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)) return { accepted: true };
            const dispatch = ExternalActionDaemonDispatchRequestSchema.parse((payload as { params: unknown }).params);
            return createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({ v: 1,
                actionId: dispatch.actionId, requestId: dispatch.envelope.requestId, execution: { ok: true,
                    result: dispatch.actionId === 'action.operations.list'
                        ? ActionOperationListV1ResponseSchema.parse({ items: [], nextCursor: null }) : { handoffId: 'accepted' } } }));
        });
        const daemon = { id: 'fx14-source', data: { clientType: 'machine-scoped', userId: alice.id,
            machineId: source.id, verifiedMachineInstallationId: source.installationId, accountStoredContentCompatibility: compatibility },
            timeout: () => ({ emitWithAck: effect }) };
        const discovery: { duringLatest?: () => Promise<unknown> } = {};
        const read = async (room: string) => {
            if (room === daemon.id && discovery.duringLatest) { const mutate = discovery.duringLatest; discovery.duringLatest = undefined; await mutate(); }
            return room === daemon.id || room.startsWith(`rpc:${alice.id}:${source.id}:`) ? [daemon] : [];
        };
        const io = createSocketRoomDiscoveryHarness(read);
        const dispatch = createExternalActionDaemonDispatcher({ io });
        const relay = (alreadyAdmitted = true) => dispatch({ actionId: 'session.handoff', envelope, principal,
            ...(alreadyAdmitted ? { executionAuthorization: authorization } : {}) });
        return { alice, bob, keys, source, target, grant, session, envelope, authorization, compatibility, effect, discovery, io, dispatch, relay };
    }

    it('admits an own Session on a shared source, rechecks both installations and refuses unsigned or stale effects', async () => {
        const { alice, bob, keys, source, target, grant, session, envelope, authorization, compatibility, effect, discovery, io, relay } = await fixture();
        expect(await relay()).toMatchObject({ kind: 'response', prepared: { response: { execution: { ok: true } } } });
        expect(await relay(false)).toMatchObject({ kind: 'response', prepared: { response: { execution: { ok: true } } } });
        const method = `${source.id}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3}`;
        const params = 'sealed-own-session';
        const execution = { v: 1 as const, authorization, effectActionId: 'session.handoff', target: envelope.target,
            installationId: source.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({
                authorizationToken: authorization.token, effectActionId: 'session.handoff', target: envelope.target,
                installationId: source.installationId!, event: SOCKET_RPC_EVENTS.CALL, method,
                requestId: envelope.requestId, params, privateKey: keys.secretKey }) };
        const caller = createAuthenticatedFakeSocket({ id: 'fx14-caller', data: { clientType: 'user-scoped', accountStoredContentCompatibility: compatibility } });
        registerSocketRpcHandlers({ userId: bob.id, socket: caller as unknown as Socket, io });
        const call = async (signed = true) => {
            const callback = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params, requestId: envelope.requestId,
                ...(signed ? { externalActionExecution: execution } : {}) }, callback);
            return callback;
        };
        expect(await call()).toHaveBeenCalledWith({ ok: true, result: { accepted: true } });
        effect.mockClear();
        expect(await call(false)).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
        for (const machine of [source, target]) {
            discovery.duringLatest = () => db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } });
            expect(await relay()).toMatchObject({ kind: 'placement_error' });
            expect(effect).not.toHaveBeenCalled();
            await db.machine.update({ where: { id: machine.id }, data: { installationId: machine.installationId } });
            discovery.duringLatest = () => db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } });
            expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(effect).not.toHaveBeenCalled();
            await db.machine.update({ where: { id: machine.id }, data: { installationId: machine.installationId } });
        }
        await db.session.update({ where: { id: session.id }, data: { accountId: alice.id } });
        expect(await relay()).toMatchObject({ kind: 'placement_error' });
        expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
        await db.session.update({ where: { id: session.id }, data: { accountId: bob.id } });
        discovery.duringLatest = () => db.machineGrant.delete({ where: { principalKind: 'account', machineId_accountId: { machineId: source.id, accountId: bob.id } } });
        expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
        expect(await relay()).toMatchObject({ kind: 'placement_error' });
        await db.machineGrant.create({ data: { ...grant, principalKind: 'account' } });
        await db.machine.update({ where: { id: source.id }, data: { active: false } });
        expect(await relay()).toMatchObject({ kind: 'placement_error' });
        expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
    });

    it('refuses offline signed handoff delivery while preserving live retained operation reads', async () => {
        const { source, alice, authorization, envelope, dispatch, effect, relay } = await fixture();
        expect(await relay()).toMatchObject({ kind: 'response', prepared: { response: { execution: { ok: true } } } });
        effect.mockClear();
        await db.machine.update({ where: { id: source.id }, data: { active: false } });
        expect(await relay()).toMatchObject({ kind: 'placement_error', code: 'target_unavailable',
            machineAvailabilityDiagnostic: { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' } });
        expect(effect).not.toHaveBeenCalled();
        // Retained operation controls use the actual selected socket, even when
        // persistent daemon presence lags; they do not begin new native work.
        const operationEnvelope = { v: 1 as const, requestId: randomUUID(), target: envelope.target,
            input: { serverId: authorization.binding.serverIdentityId, machineId: source.id } };
        const operationPrincipal = { accountId: alice.id, authority: 'present_user' as const,
            authentication: { kind: 'account' as const, tokenEpoch: alice.tokenEpoch } };
        const operationAuthorization = await auth.mintExternalActionExecutionAuthorization({ accountId: alice.id,
            authentication: operationPrincipal.authentication, serverIdentityId: authorization.binding.serverIdentityId,
            machineId: source.id, actionId: 'action.operations.list', requestId: operationEnvelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(operationEnvelope), target: operationEnvelope.target },
        { input: operationEnvelope.input });
        expect(await dispatch({ actionId: 'action.operations.list', envelope: operationEnvelope,
            principal: operationPrincipal, executionAuthorization: operationAuthorization })).toMatchObject({ kind: 'response',
            prepared: { response: { execution: { ok: true, result: { items: [], nextCursor: null } } } } });
    });
});
