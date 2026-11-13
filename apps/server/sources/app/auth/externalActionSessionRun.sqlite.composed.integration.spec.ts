import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
    EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
    ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { verifyExternalActionExecutionAuthorizationCurrentness, verifyExternalActionMachineRpcExecution } from './externalActionExecutionAuthorization';
import { db } from '@/storage/db';
import { createFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import { qualifyCurrentAccountStoredContentSocket } from '@/app/api/testkit/accountStoredContentCompatibility';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { readCurrentSessionInputMachineTargetInTx } from '@/app/session/messages/sessionInputAdmission';
import axios, { AxiosHeaders } from 'axios';
import { verifyExternalActionExecutionAuthorizationCurrent } from '../../../../cli/src/api/externalActionExecutionAuthorization';
import { RpcHandlerManager } from '../../../../cli/src/api/rpc/RpcHandlerManager';
import { prepareRequesterAccountActionContext } from '../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { createCliActionExecutorFromCredentials } from '../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { createRequesterCurrentnessSocketHarness } from '../../../../cli/src/testkit/backends/requesterCurrentnessSocketHarness';
import { prepareAccountSettingsV2Content } from '../../../../cli/src/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { EXECUTION_RUN_KIND_BY_INTENT, ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { readLlmTaskPermissionModeV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerSelection';

describe('signed Account Session Run RPC admission', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'account-session-run-', initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 300_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture(actionId: 'execution.run.start' | 'execution.run.ensure' | 'execution.run.ensure_or_start' | 'scm.diffSummary.generate', preflight = false) {
        const account = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            installationId: randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey),
            metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: account.id, machineId: machine.id, sessionId: session.id, data: 'session-key' } });
        const methodSuffix = preflight ? RPC_METHODS.CAPABILITIES_DESCRIBE : actionId === 'execution.run.start' || actionId === 'scm.diffSummary.generate' ? SESSION_RPC_METHODS.EXECUTION_RUN_START
            : actionId === 'execution.run.ensure' ? SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE : SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START;
        const params = preflight ? {} : actionId === 'scm.diffSummary.generate'
            ? ExecutionRunStartRequestSchema.parse({ kind: EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary,
                intent: 'scm_diff_summary', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                permissionMode: readLlmTaskPermissionModeV1('scm_diff_summary'), retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
                intentInput: { cwd: '/repository', source: { kind: 'workingTree' }, comparisonId: 'a'.repeat(64), resultId: 'result', expectedRevision: 1,
                    outputs: ['summary', 'walkthrough', 'commitPlan'] } })
            : { runId: 'run-voice' };
        const input: Record<string, string> = preflight ? { sessionId: session.id } : { sessionId: session.id, runId: 'run-voice' };
        const envelope = { v: 1 as const, requestId: randomUUID(), target: { kind: 'machine' as const, machineId: machine.id }, input };
        const root = ExternalActionExecutionAuthorizationV1Schema.parse(await auth.mintExternalActionExecutionAuthorization({
            serverIdentityId: await getOrCreateServerIdentityId(), accountId: account.id,
            authentication: { kind: 'account', tokenEpoch: account.tokenEpoch }, actionId,
            machineId: machine.id, target: envelope.target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        }));
        const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root,
            credentials: { token: await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' }) },
            invocation: { caller: { kind: 'host' }, surface: 'voice', authority: 'present_user' },
            purpose: { kind: 'machine_rpc', method: methodSuffix, params }, installationPublicKey: new Uint8Array(keys.publicKey), randomBytes: nacl.randomBytes });
        const effectActionId = actionId === 'scm.diffSummary.generate' ? 'execution.run.start' : actionId;
        const packet = (sessionId = preflight ? machine.id : session.id, signingKey = keys.secretKey) => {
            const method = `${sessionId}:${methodSuffix}`;
            const requestId = randomUUID();
            return { method, requestId, params, externalActionExecution: { v: 1 as const, authorization,
                effectActionId, target: authorization.binding.target, installationId: machine.installationId!,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    requesterAccountContext: authorization.requesterAccountContext, effectActionId,
                    target: authorization.binding.target, installationId: machine.installationId!, method, requestId, params, privateKey: signingKey }) } };
        };
        const resolveCurrentSessionMachine = async (input: Readonly<{ accountId: string; sessionId: string }>) =>
            input.accountId === account.id && input.sessionId === session.id ? machine.id : null;
        return { account, machine, session, authorization, packet, resolveCurrentSessionMachine, keys };
    }

    it.each(['execution.run.start', 'execution.run.ensure', 'execution.run.ensure_or_start'] as const)(
        'admits only the exact installed Machine preflight under %s', async actionId => {
            const f = await fixture(actionId, true);
            const packet = f.packet();
            expect(await verifyExternalActionMachineRpcExecution(packet.externalActionExecution,
                { ...packet, resolveCurrentSessionMachine: f.resolveCurrentSessionMachine })).not.toBeNull();
            const foreign = f.packet(randomUUID());
            expect(await verifyExternalActionMachineRpcExecution(foreign.externalActionExecution,
                { ...foreign, resolveCurrentSessionMachine: f.resolveCurrentSessionMachine })).toBeNull();
            const forged = f.packet(f.machine.id, nacl.sign.keyPair().secretKey);
            expect(await verifyExternalActionMachineRpcExecution(forged.externalActionExecution,
                { ...forged, resolveCurrentSessionMachine: f.resolveCurrentSessionMachine })).toBeNull();
        });

    async function relayFixture(publisherOnOtherMachine = false, actionId: 'execution.run.start' | 'scm.diffSummary.generate' = 'execution.run.start',
        receive?: (issued: Awaited<ReturnType<typeof fixture>>, packet: SocketRpcRequestPayload) => Promise<unknown>) {
        const f = await fixture(actionId);
        const publisherMachine = publisherOnOtherMachine
            ? await db.machine.create({ data: { id: randomUUID(), accountId: f.account.id,
                installationId: randomUUID(), installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey),
                metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } })
            : f.machine;
        if (publisherOnOtherMachine) await db.accessKey.create({ data: {
            accountId: f.account.id, machineId: publisherMachine.id, sessionId: f.session.id, data: 'session-key' } });
        const forwarded: SocketRpcRequestPayload[] = [];
        const publisher = createFakeSocket({ id: 'run-publisher', data: { clientType: 'session-scoped', userId: f.account.id,
            sessionId: f.session.id, machineId: publisherMachine.id }, timeout: () => ({ emitWithAck: async (_event, packet: SocketRpcRequestPayload) => {
                forwarded.push(packet); return receive ? receive(f, packet) : { runId: 'run-voice' };
            } }) });
        qualifyCurrentAccountStoredContentSocket(publisher);
        const presence = createSessionPublisherPresence();
        expect(await presence.registerPublisher({ socket: publisher,
            binding: { accountId: f.account.id, sessionId: f.session.id, machineId: publisherMachine.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).toMatchObject({ status: 'registered' });
        const target = await readCurrentSessionInputMachineTargetInTx(db, { accountId: f.account.id, sessionId: f.session.id, machineId: publisherMachine.id });
        expect(target).toBeDefined();
        await db.session.update({ where: { id: f.session.id }, data: { runtimeMachineTarget: target } });
        const packet = f.packet();
        const rooms = new Map<string, readonly unknown[]>([
            [`rpc:${f.account.id}:${packet.method}`, [publisher]], [publisher.id, [publisher]],
            [`session:${f.session.id}:${f.account.id}`, [publisher]],
        ]);
        const io = createSocketRoomDiscoveryHarness(async room => rooms.get(room) ?? []);
        const caller = createFakeSocket({ id: 'account-start-caller', data: { clientType: 'user-scoped', userId: f.account.id,
            authTokenKind: 'account', tokenEpoch: f.account.tokenEpoch, authAuthority: 'present_user', authTokenAuthenticationEvidence: [] } });
        qualifyCurrentAccountStoredContentSocket(caller);
        registerSocketRpcHandlers({ userId: f.account.id, socket: caller as unknown as Socket, io, sessionPublisherPresence: presence });
        return { ...f, forwarded, makePacket: f.packet, packet, caller, io, presence };
    }

    it.each(['execution.run.start', 'execution.run.ensure', 'execution.run.ensure_or_start'] as const)(
        'verifies %s without resolving publisher currentness before routing admission', async actionId => {
            const f = await fixture(actionId);
            const packet = f.packet();
            let publisherResolutionReads = 0;
            expect(await verifyExternalActionMachineRpcExecution(packet.externalActionExecution,
                { ...packet, resolveCurrentSessionMachine: async input => {
                    publisherResolutionReads += 1;
                    return f.resolveCurrentSessionMachine(input);
                } }))
                .toMatchObject({ binding: f.authorization.binding, effectActionId: actionId,
                    sessionRpcTarget: { sessionId: f.session.id, machineId: f.machine.id } });
            expect(publisherResolutionReads).toBe(0);
        });

    it('forwards a signed SCM summary nested Start to its exact Session publisher', async () => {
        const f = await relayFixture(false, 'scm.diffSummary.generate');
        const ack = vi.fn();
        await triggerSocketHandler(f.caller, SOCKET_RPC_EVENTS.CALL, f.packet, ack);
        expect(ack).toHaveBeenCalledWith({ ok: true, result: { runId: 'run-voice' } });
        expect(f.forwarded).toHaveLength(1);
        expect(f.forwarded[0]).toMatchObject({ callerInputAuthorization: f.authorization,
            authorization: { kind: 'session.write', sessionId: f.session.id } });
    });

    it('admits the issued SCM root through the relay and real daemon requester preparation', async () => {
        const channel = await createRequesterCurrentnessSocketHarness();
        const get = vi.spyOn(axios, 'get');
        const post = vi.spyOn(axios, 'post');
        try {
            const f = await relayFixture(false, 'scm.diffSummary.generate', async (issued, packet) => {
                const credentials = { token: await auth.createToken(issued.account.id, undefined,
                    { kind: 'account', authority: 'present_user' }), encryption: null };
                const settings = prepareAccountSettingsV2Content({ credentials, raw: {}, envelopeKind: 'plain' });
                // HTTP and socket transport are the only substituted boundaries. Keep custody opening,
                // Account identity/settings admission and the executor factory real beneath them.
                get.mockImplementation(async url => {
                    if (String(url).endsWith('/v1/account/profile')) return { status: 200, data: { id: issued.account.id } };
                    if (String(url).endsWith('/v2/account/settings')) return { status: 200, data: { content: settings, version: 1 } };
                    if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
                        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
                    throw new Error(`Unexpected requester HTTP read: ${url}`);
                });
                post.mockImplementation(async (url, body, config) => {
                    const headers = AxiosHeaders.from(config?.headers);
                    const verified = await verifyExternalActionExecutionAuthorizationCurrentness({
                        authorizationToken: String(headers.get(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER)),
                        machineSignature: String(headers.get(EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER)),
                        effectActionId: String(headers.get(EXTERNAL_ACTION_EFFECT_ACTION_HEADER)),
                        encodedTarget: String(headers.get(EXTERNAL_ACTION_RESOLVED_TARGET_HEADER)),
                        method: 'POST', path: new URL(String(url)).pathname, body,
                        outerActionId: issued.authorization.binding.actionId,
                    });
                    return { status: verified ? 200 : 403, data: { ok: !!verified } };
                });
                const receiver = new RpcHandlerManager({ scopePrefix: issued.session.id, scopeKind: 'session',
                    localMachineId: issued.machine.id, encryptionMode: 'plain', logger: () => {},
                    prepareRequesterAccountContext: ({ authorization, purpose, signal }) => prepareRequesterAccountActionContext({
                        authorization, purpose: purpose ?? { kind: 'external_action' }, signal,
                        machineId: issued.machine.id, installationId: issued.machine.installationId!,
                        installationPrivateKey: issued.keys.secretKey, serverId: 'test-home',
                        serverIdentityId: authorization.binding.serverIdentityId, serverHttpBaseUrl: 'https://requester.test',
                        isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization,
                            effectActionId: authorization.binding.actionId, target: authorization.binding.target,
                            privateKey: issued.keys.secretKey, installationId: issued.machine.installationId!,
                            serverHttpBaseUrl: 'https://requester.test', signal }),
                        createExecutor: admitted => createCliActionExecutorFromCredentials({ credentials: admitted.credentials,
                            serverId: 'test-home', serverApiUrl: 'https://requester.test',
                            serverIdentityId: authorization.binding.serverIdentityId, machineId: issued.machine.id,
                            externalActionMachineInstallationId: issued.machine.installationId!,
                            externalActionMachineRequestPrivateKey: issued.keys.secretKey }),
                    }),
                });
                receiver.registerHandler(SESSION_RPC_METHODS.EXECUTION_RUN_START, (_input, context) => ({
                    runId: 'scm-admitted', requesterAccountId: context?.callerInputAuthorization?.requesterAccountProjection?.accountId,
                    hasRequesterExecutor: !!context?.callerInputAuthorization?.requesterAccountExecutor,
                    rootActionId: context?.callerInputAuthorization?.binding.actionId,
                }));
                const result = await receiver.handleRequest(packet);
                // A permitted child method never widens the sealed request or receiving Session.
                for (const changed of [
                    { ...packet, params: { runId: 'substituted-input' } },
                    { ...packet, method: `another-session:${SESSION_RPC_METHODS.EXECUTION_RUN_START}` },
                    { ...packet, method: `${issued.session.id}:${SESSION_RPC_METHODS.EXECUTION_RUN_SEND}` },
                ]) expect(await receiver.handleRequest(changed)).toMatchObject({ errorCode: 'RPC_FORBIDDEN', effectAttempted: false });
                return result;
            });
            const ack = vi.fn();
            await triggerSocketHandler(f.caller, SOCKET_RPC_EVENTS.CALL, f.packet, ack);
            expect(ack).toHaveBeenCalledWith({ ok: true, result: { runId: 'scm-admitted',
                requesterAccountId: f.account.id, hasRequesterExecutor: true, rootActionId: 'scm.diffSummary.generate' } });
        } finally { get.mockRestore(); post.mockRestore(); await channel.close(); }
    });

    it('keeps SCM Start isolated to its signed installation, Account and current Session publisher', async () => {
        const f = await relayFixture(true, 'scm.diffSummary.generate');
        const ack = vi.fn();
        await triggerSocketHandler(f.caller, SOCKET_RPC_EVENTS.CALL, f.packet, ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(f.forwarded).toEqual([]);
        const forged = f.makePacket(f.session.id, nacl.sign.keyPair().secretKey);
        expect(await verifyExternalActionMachineRpcExecution(forged.externalActionExecution, forged)).toBeNull();
        const other = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const otherSession = await db.session.create({ data: { accountId: other.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const foreignAck = vi.fn();
        await triggerSocketHandler(f.caller, SOCKET_RPC_EVENTS.CALL, f.makePacket(otherSession.id), foreignAck);
        expect(foreignAck).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(f.forwarded).toEqual([]);
    });

    it('refuses an installation signature substitution', async () => {
        const f = await fixture('execution.run.start');
        const packet = f.packet(f.session.id, nacl.sign.keyPair().secretKey);
        expect(await verifyExternalActionMachineRpcExecution(packet.externalActionExecution,
            { ...packet, resolveCurrentSessionMachine: f.resolveCurrentSessionMachine })).toBeNull();
    });

    it('refuses a current Session publisher on another Machine before reaching any Run receiver', async () => {
        const f = await relayFixture(true);
        const ack = vi.fn();
        await triggerSocketHandler(f.caller, SOCKET_RPC_EVENTS.CALL, f.packet, ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(f.forwarded).toEqual([]);
    });

    it('projects the verified Account authority and sealed invocation to the exact Session publisher', async () => {
        const f = await relayFixture();
        const ack = vi.fn();
        await triggerSocketHandler(f.caller, SOCKET_RPC_EVENTS.CALL, f.packet, ack);
        expect(ack).toHaveBeenCalledWith({ ok: true, result: { runId: 'run-voice' } });
        expect(f.forwarded).toHaveLength(1);
        expect(f.forwarded[0]).toMatchObject({ callerAuthority: 'present_user', callerInputAuthorization: f.authorization,
            authorization: { kind: 'session.write', sessionId: f.session.id } });
        expect(f.forwarded[0]!.sessionActionOrigin).toBeUndefined();
    });

    it('keeps ordinary automation Voice intent without Account invocation custody', async () => {
        const f = await relayFixture();
        Object.assign(f.caller.data!, { authTokenKind: 'terminal', authAuthority: 'account_automation' });
        const ack = vi.fn();
        await triggerSocketHandler(f.caller, SOCKET_RPC_EVENTS.CALL, { method: f.packet.method, requestId: randomUUID(),
            params: { intent: 'voice_agent' } }, ack);
        expect(ack).toHaveBeenCalledWith({ ok: true, result: { runId: 'run-voice' } });
        expect(f.forwarded).toHaveLength(1);
        expect(f.forwarded[0]!.callerInputAuthorization).toBeUndefined();
        expect(f.forwarded[0]!.callerAuthority).not.toBe('present_user');
    });

    it('refuses a Session belonging to another Account before reaching any Run receiver', async () => {
        const f = await relayFixture();
        const other = await db.account.create({ data: { publicKey: null, encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: other.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const ack = vi.fn();
        await triggerSocketHandler(f.caller, SOCKET_RPC_EVENTS.CALL, f.makePacket(session.id), ack);
        expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(f.forwarded).toEqual([]);
        const otherCaller = createFakeSocket({ id: 'noncustodian-caller', data: { clientType: 'user-scoped', userId: other.id,
            authTokenKind: 'account', tokenEpoch: other.tokenEpoch, authAuthority: 'present_user', authTokenAuthenticationEvidence: [] } });
        qualifyCurrentAccountStoredContentSocket(otherCaller);
        registerSocketRpcHandlers({ userId: other.id, socket: otherCaller as unknown as Socket,
            io: f.io, sessionPublisherPresence: f.presence });
        const otherAck = vi.fn();
        await triggerSocketHandler(otherCaller, SOCKET_RPC_EVENTS.CALL, f.packet, otherAck);
        expect(otherAck).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(f.forwarded).toEqual([]);
    });
});
