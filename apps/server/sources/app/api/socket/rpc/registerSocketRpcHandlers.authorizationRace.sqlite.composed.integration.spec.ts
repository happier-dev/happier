import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";

import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from "@happier-dev/protocol/rpc";
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, MACHINE_PLAIN_DATA_KEY_MARKER,
    buildAccountStoredContentCompatibilitySocketAuthV1, decodeBase64, encodePlainMachineStoredContent } from "@happier-dev/protocol";
import tweetnacl from 'tweetnacl';
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { db } from "@/storage/db";
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';

import { createAuthenticatedFakeSocket, createFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from "../../testkit/socketHarness";
import { registerSocketRpcHandlers } from "./registerSocketRpcHandlers";
import { dispatchMachineAccessLossCustody } from '@/app/machines/machineAccessCustody';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { inTx } from '@/storage/inTx';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { forwardRpcCall } from './forwardRpcCall';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { resolveMachineAdmission } from '@/app/machines/machineAccess';
import { createActionOperationStore } from '../../../../../../cli/src/daemon/actionOperations/actionOperationStore';
import { createActionOperationRunner } from '../../../../../../cli/src/daemon/actionOperations/actionOperationRunner';
import { createActionOperationRpcHandlers } from '../../../../../../cli/src/daemon/actionOperations/actionOperationRpcHandlers';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createTestGitRpcManager } from '../../../../../../cli/src/scm/rpc/__tests__/testRpcHarness';
import { ScmBranchListResponseSchema } from '@happier-dev/protocol/scm';
import { callSocketRpc } from '../../../../../../../packages/sync-client/src/rpc/callSocketRpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ProjectWorkerActionInputSchemasV1, ProjectWorkerStatusResultV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { RpcHandlerManager } from '../../../../../../cli/src/api/rpc/RpcHandlerManager';
import { registerExecutionRunRpcHandlers } from '../../../../../../cli/src/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers';
import { retainExecutionRunState } from '../../../../../../cli/src/daemon/executionRunRegistry';
import { reloadConfiguration } from '../../../../../../cli/src/configuration';
import type { ExecutionRunState } from '../../../../../../cli/src/agent/runtime/bridges/executionRun/executionRunTypes';
import type { ExecutionRunHostBridge } from '../../../../../../cli/src/agent/runtime/bridges/executionRun/ExecutionRunHostBridge';

// These fake transport peers advertise the same declaration as current clients;
// Plain Machine routing must retain its real compatibility admission underneath.
const accountStoredContentCompatibility = evaluateAccountStoredContentSocketCompatibility(
    buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
).evaluation;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe("Session RPC final access admission on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-dev-session-rpc-access-race-",
            initAuth: true,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);
    beforeEach(() => harness.resetEnv());
    afterAll(async () => { if (harness) await harness.close(); });

    it.each([
        SESSION_RPC_METHODS.EXECUTION_RUN_GET, SESSION_RPC_METHODS.EXECUTION_RUN_LIST,
        SESSION_RPC_METHODS.EXECUTION_RUN_WAIT, SESSION_RPC_METHODS.EXECUTION_RUN_SEND,
        SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
    ])('admits requester-owned detached %s through real Account admission without exposing foreign Runs', async rpcMethod => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const third = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, active: true,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'run-worker', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/worker', happyHomeDir: '/worker/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: guest.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const directory = await mkdtemp(join(tmpdir(), 'happier-run-route-'));
        vi.stubEnv('HAPPIER_HOME_DIR', directory);
        reloadConfiguration();
        const rpc = new RpcHandlerManager({ scopePrefix: machine.id, encryptionMode: 'plain' });
        let manager: ExecutionRunHostBridge | undefined;
        const registration = registerExecutionRunRpcHandlers(rpc, { sessionId: null, serverId: 'home',
            cwd: directory, runtimeAccountId: owner.id, parentProvider: 'daemon.executionRuns', sendAcp: async () => {},
            onManagerCreated: created => { manager = created; } });
        try {
            for (const account of [owner, guest, third]) {
                const run: ExecutionRunState = { runId: account.id, callId: randomUUID(), sidechainId: randomUUID(), sessionId: null,
                    depth: 0, intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, backendId: 'codex',
                    instructions: 'Private child result', permissionMode: 'read_only', retentionPolicy: 'resumable',
                    runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
                    requesterWorkAttributionV1: { serverId: 'home', accountId: account.id, machineId: machine.id,
                        installationId: machine.installationId! } };
                await retainExecutionRunState(run);
            }
            if (rpcMethod === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) {
                await manager!.recoverRetainedRuns();
                for (const account of [owner, guest]) {
                    const run = manager!.get(account.id)!;
                    run.status = 'running';
                    await retainExecutionRunState(run);
                }
            }
            // Only Socket.IO is substituted. Real token issuance, SQLite grants,
            // Home admission, daemon registration and retained store remain composed.
            const target = { id: 'run-daemon', data: { clientType: 'machine-scoped', userId: owner.id,
                machineId: machine.id, verifiedMachineInstallationId: machine.installationId, accountStoredContentCompatibility },
                timeout: () => ({ emitWithAck: async (_event: string, request: SocketRpcRequestPayload) =>
                    rpc.invokeLocal(rpcMethod, request.params, { rpcContext: { signal: new AbortController().signal,
                        callerAuthority: request.callerAuthority, machineAdmission: request.machineAdmission } }) }) };
            const method = `${machine.id}:${rpcMethod}`;
            const io = createSocketRoomDiscoveryHarness(async room => room === target.id || room === `rpc:${owner.id}:${method}` ? [target] : []);
            const call = async (accountId: string, runId: string) => {
                const token = await createAccountTokenForTests(accountId, { kind: 'account', authority: 'present_user' });
                const caller = Object.assign(createAuthenticatedFakeSocket({ id: `run-${randomUUID()}`, data: {
                    clientType: 'user-scoped', accountStoredContentCompatibility,
                } }), { handshake: { auth: { token } } });
                registerSocketRpcHandlers({ userId: accountId, socket: caller as unknown as Socket, io });
                const callback = vi.fn();
                await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: {
                    sessionId: null,
                    ...(rpcMethod === SESSION_RPC_METHODS.EXECUTION_RUN_LIST ? {} : { runId }),
                    ...(rpcMethod === SESSION_RPC_METHODS.EXECUTION_RUN_SEND ? { message: 'Continue', localInputId: randomUUID() } : {}),
                } }, callback);
                expect(callback).toHaveBeenCalledOnce();
                return callback.mock.calls[0]![0];
            };
            const own = await call(guest.id, guest.id);
            expect(own).toMatchObject({ ok: true });
            if (rpcMethod === SESSION_RPC_METHODS.EXECUTION_RUN_LIST) {
                expect(own.result.runs).toMatchObject([{ runId: guest.id }]);
                expect(own.result.runs).toHaveLength(1);
                expect((await call(owner.id, owner.id)).result.runs).toMatchObject([{ runId: owner.id }]);
            } else {
                // A completed Run rejects new input through its normal lifecycle,
                // proving own Send reached the owner without inventing an Agent runtime.
                expect(own.result, JSON.stringify(own.result)).toMatchObject(rpcMethod === SESSION_RPC_METHODS.EXECUTION_RUN_SEND
                    ? { ok: false, errorCode: 'execution_run_not_allowed' }
                    : rpcMethod === SESSION_RPC_METHODS.EXECUTION_RUN_STOP ? { ok: true }
                    : rpcMethod === SESSION_RPC_METHODS.EXECUTION_RUN_WAIT ? { ok: true, status: 'succeeded', result: { run: { runId: guest.id } } }
                    : { run: { runId: guest.id } });
                const missing = await call(guest.id, 'missing-run');
                expect(missing).toMatchObject({ ok: true, result: { ok: false, errorCode: 'execution_run_not_found' } });
                expect(await call(guest.id, owner.id)).toEqual(missing);
                expect(await call(guest.id, third.id)).toEqual(missing);
                expect(await call(owner.id, guest.id)).toEqual(missing);
                expect((await call(owner.id, owner.id)).result).not.toMatchObject({ errorCode: 'execution_run_not_found' });
            }
        } finally {
            await registration.dispose();
            await manager?.dispose();
            vi.unstubAllEnvs();
            reloadConfiguration();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('preserves the typed Machine admission refusal through the RPC error path', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, active: true,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'private-worker', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/worker', happyHomeDir: '/worker/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: guest.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const token = await createAccountTokenForTests(guest.id, { kind: 'account', authority: 'present_user' });
        const caller = Object.assign(createAuthenticatedFakeSocket({ id: 'refused-run-client', data: {
            clientType: 'user-scoped', accountStoredContentCompatibility,
        } }), { handshake: { auth: { token } } });
        registerSocketRpcHandlers({ userId: guest.id, socket: caller as unknown as Socket,
            io: createSocketRoomDiscoveryHarness(async () => []) });
        const callback = vi.fn();
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method: `${machine.id}:${RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE}`, params: {},
        }, callback);
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN,
            failureCause: expect.objectContaining({ phase: 'rpc.admission.machine', errorCode: 'custodian_only' }) }));
    });

    it.each(['skills.read', 'session.user_action.answer'] as const)('admits a paired terminal daemon Session %s and rechecks credential, installation and Session binding', async (rpcMethod) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, active: true,
            installationId: randomUUID(), installationPublicKey: tweetnacl.sign.keyPair().publicKey,
            metadata: encodePlainMachineStoredContent({ host: 'skill-worker', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/worker', happyHomeDir: '/worker/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: JSON.stringify({ t: 'plain', v: {} }) } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: session.id, data: 'opaque' } });
        const presence = createSessionPublisherPresence();
        const publisher = {};
        const registered = await presence.registerPublisher({ socket: publisher,
            binding: { accountId: owner.id, machineId: machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } });
        if (registered.status !== 'registered') throw new Error('Expected current Session publisher');
        const publisherAuthority = { v: 1, accountId: owner.id, sessionId: session.id, machineId: machine.id,
            committedFenceMs: registered.committedFence.getTime(), publisherGeneration: String(registered.publisherGeneration) };
        const token = await createAccountTokenForTests(owner.id, { kind: 'terminal', authority: 'account_automation' });
        const source = Object.assign(createAuthenticatedFakeSocket({ id: 'paired-daemon', data: {
            clientType: 'machine-scoped', machineId: machine.id, authTokenKind: 'terminal', authAuthority: 'account_automation',
            verifiedMachineInstallationId: machine.installationId, accountStoredContentCompatibility,
        } }), { handshake: { auth: { token } } });
        const method = `${session.id}:${rpcMethod}`;
        // The receiving Session is the transport boundary. The Home token,
        // Machine/Session rows, publisher proof and relay all remain real.
        const effect = vi.fn(async () => ({ sourceAdmitted: true }));
        const target = { id: 'skill-session', data: { clientType: 'session-scoped', sessionPublisherAuthority: publisherAuthority },
            timeout: () => ({ emitWithAck: effect }) };
        let sourceBindingReads = 0;
        let invalidateDuringFinalSourceRead: (() => Promise<unknown>) | undefined;
        const peers = async (room: string) => {
            if (room === `session:${session.id}:${owner.id}`) {
                sourceBindingReads += 1;
                if (sourceBindingReads === 2) await invalidateDuringFinalSourceRead?.();
                return [{ data: { sessionPublisherAuthority: publisherAuthority } }];
            }
            return room === target.id || room === `rpc:${owner.id}:${method}` ? [target] : [];
        };
        const io = createSocketRoomDiscoveryHarness(peers);
        registerSocketRpcHandlers({ userId: owner.id, socket: source as unknown as Socket, io, sessionPublisherPresence: presence });
        const origin = { v: 1 as const, caller: { kind: 'session' as const, sessionId: session.id, starterDepth: 0, turnDepth: 1 },
            sourceTurnId: 'admitted-turn', requestId: 'skill-read', callerPermissionMode: 'read-only' as const,
            causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'read-only' as const } };
        const read = () => callSocketRpc({ socket: { connected: true, emit: () => undefined,
            emitWithAck: (event, payload) => new Promise((resolve, reject) => {
                triggerSocketHandler(source, event, payload, resolve).catch(reject);
            }) }, target: { kind: 'session', id: session.id }, method: rpcMethod,
            params: rpcMethod === 'skills.read' ? { name: 'own-skill', sessionId: session.id }
                : { id: 'question-one', answers: { branch: ['dev'] }, approved: true }, content: { mode: 'plain' },
            authorization: { kind: 'session.action', sessionId: session.id, origin } });
        expect(await read()).toEqual({ sourceAdmitted: true });
        expect(effect).toHaveBeenLastCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            callerAuthority: 'account_automation', sessionActionOrigin: origin,
            authorization: rpcMethod === 'skills.read' ? { kind: 'session.write', sessionId: session.id }
                : { kind: 'session.permission.respond', sessionId: session.id,
                    actor: { kind: 'accountUser', accountId: owner.id, relationship: 'owner' } },
        }));
        await db.account.update({ where: { id: owner.id }, data: { tokenEpoch: { increment: 1 } } });
        expect(readRpcErrorCode(await read().catch((error: unknown) => error))).toBe(RPC_ERROR_CODES.FORBIDDEN);
        source.handshake.auth.token = await createAccountTokenForTests(owner.id, { kind: 'terminal', authority: 'account_automation' });
        await db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } });
        expect(readRpcErrorCode(await read().catch((error: unknown) => error))).toBe(RPC_ERROR_CODES.FORBIDDEN);
        await db.machine.update({ where: { id: machine.id }, data: { installationId: machine.installationId } });
        expect(await read()).toEqual({ sourceAdmitted: true });
        // The source proof resolves a live Socket.IO publisher after token
        // admission. Revocation during that boundary must still precede effect.
        for (const invalidate of [
            () => db.account.update({ where: { id: owner.id }, data: { tokenEpoch: { increment: 1 } } }),
            () => db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } }),
            () => db.accessKey.deleteMany({ where: { accountId: owner.id, sessionId: session.id, machineId: machine.id } }),
        ]) {
            sourceBindingReads = 0;
            invalidateDuringFinalSourceRead = invalidate;
            expect(readRpcErrorCode(await read().catch((error: unknown) => error))).toBe(RPC_ERROR_CODES.FORBIDDEN);
            expect(sourceBindingReads).toBe(2);
            source.handshake.auth.token = await createAccountTokenForTests(owner.id, { kind: 'terminal', authority: 'account_automation' });
            await db.machine.update({ where: { id: machine.id }, data: { installationId: machine.installationId } });
        }
        expect(effect).toHaveBeenCalledTimes(2);
    });

    it('retains exact Work Session proof from Home admission through the real SCM ingress', async () => {
        const owner = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
        const stranger = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const foreign = await db.session.create({ data: { accountId: stranger.id, tag: randomUUID(), metadata: "{}" } });
        // No repository: an admitted read reaches NOT_REPOSITORY. Lost proof instead
        // fails INVALID_REQUEST before the backend. Both internal owners remain real.
        const scm = createTestGitRpcManager({ workingDirectory: harness.baseDir });
        const request = { cwd: harness.baseDir, workEvidence: { sessionId: session.id } };
        const effect = vi.fn(async (_event: string, forwarded: SocketRpcRequestPayload) =>
            scm.call(RPC_METHODS.SCM_BRANCH_LIST, request, forwarded.authorization));
        const method = `${machineId}:${RPC_METHODS.SCM_BRANCH_LIST}`;
        const target = { id: "work-daemon", data: { clientType: "machine-scoped", machineId },
            timeout: () => ({ emitWithAck: effect }) };
        // Socket.IO is the transport boundary; SQLite authorization, server stamp,
        // encrypted CLI codec, registration and SCM scope admission execute in process.
        const io = createSocketRoomDiscoveryHarness(async () => [target]);
        const caller = createFakeSocket({ data: { clientType: "user-scoped", authAuthority: "present_user",
            authTokenAuthenticationEvidence: [] } });
        registerSocketRpcHandlers({ userId: owner.id, socket: caller as unknown as Socket, io });
        const callback = vi.fn();
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: "sealed-work-request",
            authorization: { kind: "session.write", sessionId: foreign.id } }, callback);
        expect(callback).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).not.toHaveBeenCalled();
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: "sealed-work-request",
            authorization: { kind: "session.write", sessionId: session.id } }, callback);
        expect(callback).toHaveBeenLastCalledWith({ ok: true, result: expect.objectContaining({ success: false, errorCode: 'NOT_REPOSITORY' }) });
        const result = await effect.mock.results[0]!.value;
        expect(ScmBranchListResponseSchema.parse(result)).toMatchObject({ success: false, errorCode: 'NOT_REPOSITORY' });
    });

    async function seedDirectEditor() {
        const owner = await db.account.create({
            data: { publicKey: `owner-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const editor = await db.account.create({
            data: { publicKey: `editor-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: JSON.stringify({ t: "plain", v: {} }),
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.sessionShare.create({
            data: {
                sessionId: session.id,
                sharedByUserId: owner.id,
                sharedWithUserId: editor.id,
                accessLevel: "edit",
                canApprovePermissions: false,
            },
        });
        return { owner, editor, session };
    }

    async function seedRestrictedTeamEditor() {
        const owner = await db.account.create({
            data: { publicKey: `owner-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        // The editor qualifies with native Key-Challenge evidence, and that route
        // is only available to a keyed Account (`key_challenge` is a keyed-mode
        // action), so this Account is e2ee exactly like the sibling qualification
        // fixtures in `resolveTeamAuthenticationPolicy.sqlite.integration.spec.ts`.
        const editor = await db.account.create({
            data: { publicKey: `editor-${randomUUID()}`, encryptionMode: "e2ee" },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: JSON.stringify({ t: "plain", v: {} }),
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const team = await db.team.create({ data: { name: `Team ${randomUUID()}` }, select: { id: true } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: "owner" } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: editor.id, role: "member" } });
        await db.sessionTeamGrant.create({
            data: {
                sessionId: session.id,
                teamId: team.id,
                accessLevel: "edit",
                canApprovePermissions: false,
                effectiveAt: new Date(0),
            },
        });
        return { owner, editor, session, team };
    }

    function createCaller(
        evidence: readonly Readonly<{ kind: "home_method"; methodId: string }>[] = [],
    ) {
        return createAuthenticatedFakeSocket({
            id: `caller-${randomUUID()}`,
            data: { clientType: "user-scoped", authTokenAuthenticationEvidence: evidence, accountStoredContentCompatibility },
        });
    }

    it('classifies an offline worker through shared RPC transport and recovers without changing access authority', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, active: false,
            installationId: randomUUID(), installationPublicKey: tweetnacl.sign.keyPair().publicKey,
            metadata: encodePlainMachineStoredContent({ host: 'worker', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/worker', happyHomeDir: '/worker/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const actionId = 'projects.worker.status';
        const rpcMethod = getActionSpec(actionId).bindings!.rpcMethod!;
        const request = ProjectWorkerActionInputSchemasV1[actionId].parse({ workspace: { serverId: 'home', refId: 'source' },
            destination: { kind: 'machine', machineId: machine.id }, purpose: 'finite' });
        const result = ProjectWorkerStatusResultV1Schema.parse({ eligible: false, candidate: null,
            load: { kind: 'unknown' }, explanation: 'unsupported' });
        const effect = vi.fn(async () => result);
        const target = { id: 'worker-status-daemon', data: { clientType: 'machine-scoped', userId: owner.id,
            machineId: machine.id, verifiedMachineInstallationId: machine.installationId, accountStoredContentCompatibility },
            timeout: () => ({ emitWithAck: effect }) };
        let connected = false;
        const io = createSocketRoomDiscoveryHarness(async () => connected ? [target] : []);
        const read = (accountId: string) => {
            const caller = createCaller();
            registerSocketRpcHandlers({ userId: accountId, socket: caller as unknown as Socket, io });
            // Socket.IO is the only substituted boundary. Both App and CLI use
            // this real client codec and the registered server admission/forwarder.
            return callSocketRpc({ socket: { connected: true, emit: () => undefined,
                emitWithAck: (event, payload) => new Promise((resolve, reject) => {
                    triggerSocketHandler(caller, event, payload, resolve).catch(reject);
                }) }, target: { kind: 'machine', id: machine.id }, method: rpcMethod,
                params: request, content: { mode: 'plain' } });
        };
        const offline = await read(owner.id).catch((error: unknown) => error);
        expect(readRpcErrorCode(offline)).toBe('target_unavailable');
        expect(readRpcErrorCode(await read(outsider.id).catch((error: unknown) => error))).toBe(RPC_ERROR_CODES.FORBIDDEN);
        expect(effect).not.toHaveBeenCalled();
        await db.machine.update({ where: { id: machine.id }, data: { active: true } });
        connected = true;
        expect(ProjectWorkerStatusResultV1Schema.parse(await read(owner.id))).toEqual(result);
        // A current authenticated socket is reachability evidence even when its
        // persisted presence bit lags; a passive read does not wake the Machine.
        await db.machine.update({ where: { id: machine.id }, data: { active: false } });
        expect(ProjectWorkerStatusResultV1Schema.parse(await read(owner.id))).toEqual(result);
        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
        expect(readRpcErrorCode(await read(owner.id).catch((error: unknown) => error))).toBe(RPC_ERROR_CODES.FORBIDDEN);
        expect(effect).toHaveBeenCalledTimes(2);
    });

    it('cancels only the admitted requester operation on a shared Machine through real socket admission and operation custody', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, active: true,
            installationId: randomUUID(), installationPublicKey: tweetnacl.sign.keyPair().publicKey,
            metadata: encodePlainMachineStoredContent({ host: 'shared', platform: 'linux', happyCliVersion: 'test', homeDir: '/shared', happyHomeDir: '/shared/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: actor.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const store = createActionOperationStore();
        const scope = { accountId: actor.id, machineId: machine.id };
        for (const accountId of [owner.id, stranger.id]) store.create({ operationId: accountId, actionId: 'projects.script.run',
            title: 'Private operation', scope: { accountId, machineId: machine.id }, cancellation: 'unsupported', inputIdentity: '{}' });
        const runner = createActionOperationRunner({ store, generateOperationId: () => 'own-script', resolveAction: actionId => ({
            actionId, title: 'Script', operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } } }) });
        let cancelled = false;
        await runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
            context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
                machineId: machine.id, workspaceRefId: 'workspace', cwd: '/project' } });
            await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
            return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        } });
        const handlers = createActionOperationRpcHandlers({ store, runner, machineId: machine.id, resolveAccountId: async () => owner.id });
        const method = `${machine.id}:${ACTION_OPERATION_RPC_METHODS_V1.cancel}`;
        const effect = vi.fn(async (_event: string, raw: unknown) => {
            const payload = raw as SocketRpcRequestPayload;
            const admission = payload.machineAdmission;
            return handlers.cancel(payload.params, { machineAdmission: admission, verifyMachineAdmissionCurrent: async () => {
                const current = await resolveMachineAdmission({ actorAccountId: admission!.actorAccountId, machineId: machine.id, rpcMethod: ACTION_OPERATION_RPC_METHODS_V1.cancel });
                return current.kind === 'admitted' && current.installationId === admission!.installationId;
            } });
        });
        const daemon = { id: 'fx14-operation-daemon', data: { clientType: 'machine-scoped', userId: owner.id, machineId: machine.id,
            verifiedMachineInstallationId: machine.installationId, accountStoredContentCompatibility }, timeout: () => ({ emitWithAck: effect }) };
        const read = (room: string) => room === daemon.id || room === `rpc:${owner.id}:${method}` ? [daemon] : [];
        const io = createSocketRoomDiscoveryHarness(async room => read(room));
        const caller = createCaller();
        registerSocketRpcHandlers({ userId: actor.id, socket: caller as unknown as Socket, io });
        const call = async (operationId: string) => {
            const callback = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: { operationId } }, callback);
            return callback;
        };
        try {
            for (const id of [owner.id, stranger.id, 'guessed']) expect(await call(id)).toHaveBeenCalledWith({ ok: true, result: { kind: 'not_found' } });
            expect(cancelled).toBe(false);
            expect(await call('own-script')).toHaveBeenCalledWith({ ok: true, result: { kind: 'requested' } });
            expect(cancelled).toBe(true);
            await runner.waitForTerminal(scope, 'own-script');
            await db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: machine.id, accountId: actor.id } } });
            effect.mockClear();
            expect(await call('own-script')).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(effect).not.toHaveBeenCalled();
        } finally { runner.cancel(scope, 'own-script'); await runner.waitForTerminal(scope, 'own-script'); }
    });

    it("refuses a caller-minted Machine admission instead of forwarding it as trusted context", async () => {
        const owner = await db.account.create({ data: { publicKey: `machine-owner-${randomUUID()}`, encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'shared', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/shared', happyHomeDir: '/home/shared/.happier' }),
            active: true, installationId: randomUUID(), installationPublicKey: tweetnacl.sign.keyPair().publicKey,
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const method = `${machine.id}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS}`;
        const effect = vi.fn(async () => ({ status: "ready" }));
        const target = { id: "owner-machine-daemon", data: { clientType: "machine-scoped", userId: owner.id,
            machineId: machine.id, verifiedMachineInstallationId: machine.installationId, accountStoredContentCompatibility },
            timeout: vi.fn(() => ({ emitWithAck: effect })) };
        const io = createSocketRoomDiscoveryHarness(async room =>
            room === `rpc:${owner.id}:${method}` || room === target.id ? [target] : []);
        const caller = createCaller();
        registerSocketRpcHandlers({ userId: owner.id, socket: caller as unknown as Socket, io });
        const callback = vi.fn();
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: {}, machineAdmission: {
            actorAccountId: randomUUID(), custodianAccountId: owner.id, machineId: machine.id,
            installationId: machine.installationId, role: "manage", encryptionMode: "plain",
        } }, callback);
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
    });

    it("routes a shared actor to the exact custodian and refuses access or installation lost during discovery", async () => {
        const owner = await db.account.create({ data: { publicKey: `machine-owner-${randomUUID()}`, encryptionMode: "plain" } });
        const actor = await db.account.create({ data: { publicKey: `machine-actor-${randomUUID()}`, encryptionMode: "plain" } });
        const installationId = randomUUID();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'shared', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/shared', happyHomeDir: '/home/shared/.happier' }),
            active: true, installationId, installationPublicKey: tweetnacl.sign.keyPair().publicKey,
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const grant = { machineId: machine.id, accountId: actor.id, accessLevel: "view", createdByAccountId: owner.id };
        await db.machineAccountGrant.create({ data: grant });
        const method = `${machine.id}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS}`;
        const effect = vi.fn(async () => ({ status: "ready" }));
        const target = { id: "custodian-machine-daemon", data: { clientType: "machine-scoped", userId: owner.id,
            machineId: machine.id, verifiedMachineInstallationId: installationId, accountStoredContentCompatibility },
            timeout: vi.fn(() => ({ emitWithAck: effect })) };
        let duringDiscovery: (() => Promise<void>) | undefined;
        let duringLatestTarget: (() => Promise<void>) | undefined;
        const readTargets = async (room: string) => {
            if (duringDiscovery) { const current = duringDiscovery; duringDiscovery = undefined; await current(); }
            if (room === target.id && duringLatestTarget) {
                const current = duringLatestTarget; duringLatestTarget = undefined; await current();
            }
            return room === `rpc:${owner.id}:${method}` || room === target.id ? [target] : [];
        };
        const io = createSocketRoomDiscoveryHarness(readTargets);
        const caller = createCaller();
        registerSocketRpcHandlers({ userId: actor.id, socket: caller as unknown as Socket, io });
        const call = async () => {
            const callback = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: {} }, callback);
            return callback;
        };
        expect(await call()).toHaveBeenCalledWith({ ok: true, result: { status: "ready" } });
        expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            machineAdmission: { actorAccountId: actor.id, custodianAccountId: owner.id, machineId: machine.id,
                installationId, role: "use", encryptionMode: "plain" },
        }));
        effect.mockClear();
        duringDiscovery = () => db.machineAccountGrant.delete({ where: { machineId_accountId: {
            machineId: machine.id, accountId: actor.id,
        } } }).then(() => undefined);
        expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
        await db.machineAccountGrant.create({ data: grant });
        duringLatestTarget = () => db.machineAccountGrant.delete({ where: { machineId_accountId: {
            machineId: machine.id, accountId: actor.id,
        } } }).then(() => undefined);
        expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
        await db.machineAccountGrant.create({ data: grant });
        duringDiscovery = () => db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } }).then(() => undefined);
        expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
    });

    it('finishes admitted custody cleanup without final rechecks and refuses the next replaced-installation request', async () => {
        const owner = await db.account.create({ data: { publicKey: `cleanup-owner-${randomUUID()}`, encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { publicKey: `cleanup-actor-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'shared', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/shared', happyHomeDir: '/home/shared/.happier' }), active: true,
            installationId: randomUUID(), installationPublicKey: tweetnacl.sign.keyPair().publicKey,
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const method = `${machine.id}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`;
        const effect = vi.fn(async () => ({ kind: 'settled' }));
        const target = { id: 'custody-cleanup-daemon', data: { clientType: 'machine-scoped', userId: owner.id,
            machineId: machine.id, verifiedMachineInstallationId: machine.installationId, accountStoredContentCompatibility },
            timeout: () => ({ emitWithAck: effect }) };
        let duringDiscovery: (() => Promise<void>) | undefined;
        const latestTargetRead = vi.fn();
        const read = async (room: string) => {
            if (room === target.id) latestTargetRead();
            if (room === `rpc:${owner.id}:${method}` && duringDiscovery) {
                const mutation = duringDiscovery; duringDiscovery = undefined; await mutation();
            }
            return room === target.id || room === `rpc:${owner.id}:${method}` ? [target] : [];
        };
        const io = createSocketRoomDiscoveryHarness(read);
        eventRouter.setIo(io, { forwardRpc: request => forwardRpcCall({ io, ...request }) });
        const input = { machineId: machine.id, subjectAccountId: actor.id,
            expectedCustodianAccountId: owner.id, expectedInstallationId: machine.installationId! };
        try {
            expect(await dispatchMachineAccessLossCustody(input)).toEqual({ kind: 'settled' });
            expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
                authorization: { kind: 'machine.accessLoss.serverOrigin' }, params: { v: 1, subjectAccountId: actor.id },
                machineAdmission: expect.objectContaining({ actorAccountId: owner.id, custodianAccountId: owner.id }),
            }));
            effect.mockClear();
            duringDiscovery = () => db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: actor.id,
                accessLevel: 'view', createdByAccountId: owner.id } }).then(() => undefined);
            expect(await dispatchMachineAccessLossCustody(input)).toEqual({ kind: 'settled' });
            expect(effect).toHaveBeenCalledOnce();
            expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
                params: { v: 1, subjectAccountId: actor.id },
            }));
            effect.mockClear();
            expect(await dispatchMachineAccessLossCustody(input)).toEqual({ kind: 'settled' });
            expect(effect).toHaveBeenCalledOnce();
            expect(effect).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
                params: { v: 1, subjectAccountId: actor.id, remainingRole: 'use' },
            }));
            effect.mockClear();
            await db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: machine.id, accountId: actor.id } } });
            duringDiscovery = () => db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } }).then(() => undefined);
            expect(await dispatchMachineAccessLossCustody(input)).toEqual({ kind: 'settled' });
            expect(effect).toHaveBeenCalledOnce();
            effect.mockClear();
            expect(await dispatchMachineAccessLossCustody(input)).toEqual({ kind: 'incomplete', reason: 'installation_mismatch' });
            expect(effect).not.toHaveBeenCalled();
            expect(latestTargetRead).not.toHaveBeenCalled();
        } finally { eventRouter.clearIo(); }
    });

    it('recovers offline requester cleanup with surviving Use access and refuses the next request after withdrawal', async () => {
        const owner = await db.account.create({ data: { publicKey: `reconnect-owner-${randomUUID()}`, encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { publicKey: `reconnect-actor-${randomUUID()}`, encryptionMode: 'plain' } });
        const survivor = await db.account.create({ data: { publicKey: `reconnect-survivor-${randomUUID()}`, encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'shared', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/shared', happyHomeDir: '/home/shared/.happier' }), active: true,
            installationId: randomUUID(), installationPublicKey: tweetnacl.sign.keyPair().publicKey,
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const history = await db.session.create({ data: { accountId: actor.id, tag: randomUUID(),
            metadata: JSON.stringify({ t: 'plain', v: { retained: true } }), encryptionMode: 'plain' } });
        for (const accountId of [actor.id, survivor.id]) await db.machineAccountGrant.create({ data: {
            machineId: machine.id, accountId, accessLevel: 'view', createdByAccountId: owner.id,
        } });
        const team = await db.team.create({ data: { name: `Independent ${randomUUID()}` } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: survivor.id, role: 'member' } });
        await db.machineTeamGrant.create({ data: { machineId: machine.id, teamId: team.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const method = `${machine.id}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`;
        let online = false;
        const cleaned = new Map<string, string | undefined>();
        const effect = vi.fn(async (_event: string, request: { params: { kind?: string; subjectAccountId?: string; remainingRole?: string } }) => {
            // Genuine daemon transport boundary: the receiver's real inventory/native cleanup is covered in its owner suite.
            if (request.params.kind === 'requesters') return { kind: 'requesters', accountIds: [actor.id, survivor.id], coverage: 'complete' };
            if (request.params.subjectAccountId) {
                cleaned.set(request.params.subjectAccountId, request.params.remainingRole);
                return { kind: 'settled' };
            }
            return { status: 'ready' };
        });
        const target = { id: 'reconnect-custody-daemon', data: { clientType: 'machine-scoped', userId: owner.id,
            machineId: machine.id, verifiedMachineInstallationId: machine.installationId, accountStoredContentCompatibility }, timeout: () => ({ emitWithAck: effect }) };
        const statusMethod = `${machine.id}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS}`;
        const read = async (room: string) => online && (room === target.id || room === `rpc:${owner.id}:${method}`
            || room === `rpc:${owner.id}:${statusMethod}`) ? [target] : [];
        const io = createSocketRoomDiscoveryHarness(read);
        eventRouter.setIo(io, { forwardRpc: request => forwardRpcCall({ io, ...request }) });
        const custody = { machineId: machine.id, expectedCustodianAccountId: owner.id, expectedInstallationId: machine.installationId! };
        try {
            for (const accountId of [actor.id, survivor.id]) expect(await inTx(tx => removeMachineAccessGrantInTx(tx, {
                actorAccountId: owner.id, machineId: machine.id, principal: { kind: 'account', accountId },
            }))).toMatchObject({ kind: 'removed' });
            expect(await dispatchMachineAccessLossCustody({ ...custody, subjectAccountId: actor.id })).toEqual({ kind: 'incomplete', reason: 'target_not_found' });
            expect(await db.accessKey.count({ where: { machineId: machine.id } })).toBe(0);
            online = true;
            const publisher = { ...createAuthenticatedFakeSocket({ id: target.id, data: target.data }), join: async () => {} };
            registerSocketRpcHandlers({ userId: owner.id, socket: publisher as unknown as Socket, io });
            await triggerSocketHandler(publisher, SOCKET_RPC_EVENTS.REGISTER, { method });
            expect(publisher.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
            expect([...cleaned]).toEqual([[actor.id, undefined], [survivor.id, 'use']]);
            expect(await db.session.findUnique({ where: { id: history.id } })).toEqual(history);
            const caller = createCaller();
            registerSocketRpcHandlers({ userId: survivor.id, socket: caller as unknown as Socket, io });
            const call = async () => {
                const callback = vi.fn();
                await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method: statusMethod, params: {} }, callback);
                return callback;
            };
            expect(await call()).toHaveBeenCalledWith({ ok: true, result: { status: 'ready' } });
            effect.mockClear();
            await db.machineTeamGrant.delete({ where: { machineId_teamId: { machineId: machine.id, teamId: team.id } } });
            expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
            expect(effect).not.toHaveBeenCalled();
        } finally { eventRouter.clearIo(); }
    });

    it("answers an unqualified restricted-Team editor with the typed authentication requirement", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" });
        const { owner, editor, session, team } = await seedRestrictedTeamEditor();
        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        const method = `${session.id}:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`;
        const targetEffect = vi.fn(async () => ({ ok: true, status: "applied" }));
        const target = {
            id: "owner-daemon",
            data: { clientType: "session-scoped" },
            timeout: vi.fn(() => ({ emitWithAck: targetEffect })),
        };
        const io = createSocketRoomDiscoveryHarness(async room =>
            room === `rpc:${owner.id}:${method}` || room === target.id ? [target] : []);

        const unqualified = createCaller();
        const refusal = vi.fn();
        registerSocketRpcHandlers({ userId: editor.id, socket: unqualified as unknown as Socket, io });
        await triggerSocketHandler(unqualified, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { v: 1, goal: "do the work" },
        }, refusal);

        expect(targetEffect).not.toHaveBeenCalled();
        expect(refusal).toHaveBeenCalledWith({
            ok: false,
            error: "Team authentication required",
            errorCode: RPC_ERROR_CODES.TEAM_AUTHENTICATION_REQUIRED,
        });

        const qualified = createCaller([{ kind: "home_method", methodId: "key_challenge" }]);
        const accepted = vi.fn();
        registerSocketRpcHandlers({ userId: editor.id, socket: qualified as unknown as Socket, io });
        await triggerSocketHandler(qualified, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { v: 1, goal: "do the work" },
        }, accepted);

        expect(targetEffect).toHaveBeenCalledOnce();
        expect(accepted).toHaveBeenCalledWith({ ok: true, result: { ok: true, status: "applied" } });
    });

    it("surfaces the typed authentication requirement lost during target discovery", async () => {
        harness.resetEnv({ HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: "1" });
        const { owner, editor, session, team } = await seedRestrictedTeamEditor();
        const method = `${session.id}:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`;
        const targetEffect = vi.fn(async () => ({ ok: true }));
        const target = {
            id: "owner-daemon",
            data: { clientType: "session-scoped" },
            timeout: vi.fn(() => ({ emitWithAck: targetEffect })),
        };
        const discoveryStarted = deferred<void>();
        const resumeDiscovery = deferred<void>();
        const io = createSocketRoomDiscoveryHarness(async room => {
            if (room === `rpc:${owner.id}:${method}`) {
                discoveryStarted.resolve();
                await resumeDiscovery.promise;
                return [target];
            }
            return room === target.id ? [target] : [];
        });
        const caller = createCaller();
        const callback = vi.fn();

        registerSocketRpcHandlers({ userId: editor.id, socket: caller as unknown as Socket, io });
        const call = triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { v: 1, goal: "do the work" },
        }, callback);

        await discoveryStarted.promise;
        await db.team.update({
            where: { id: team.id },
            data: {
                authenticationPolicy: {
                    v: 1,
                    mode: "restricted",
                    accepted: [{ kind: "home_method", methodId: "key_challenge" }],
                },
            },
        });
        resumeDiscovery.resolve();
        await call;

        expect(targetEffect).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Team authentication required",
            errorCode: RPC_ERROR_CODES.TEAM_AUTHENTICATION_REQUIRED,
        });
    });

    it("does not dispatch an ordinary effectful Session RPC when access is revoked during target discovery", async () => {
        const { owner, editor, session } = await seedDirectEditor();
        const method = `${session.id}:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`;
        const targetEffect = vi.fn(async () => ({ ok: true }));
        const target = {
            id: "owner-daemon",
            data: { clientType: "session-scoped" },
            timeout: vi.fn(() => ({ emitWithAck: targetEffect })),
        };
        const discoveryStarted = deferred<void>();
        const resumeDiscovery = deferred<void>();
        const io = createSocketRoomDiscoveryHarness(async room => {
            if (room === `rpc:${owner.id}:${method}`) {
                discoveryStarted.resolve();
                await resumeDiscovery.promise;
                return [target];
            }
            return room === target.id ? [target] : [];
        });
        const caller = createCaller();
        const callback = vi.fn();

        registerSocketRpcHandlers({
            userId: editor.id,
            socket: caller as unknown as Socket,
            io,
        });
        const call = triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { v: 1, goal: "do the work" },
        }, callback);

        await discoveryStarted.promise;
        await db.sessionShare.delete({
            where: {
                sessionId_sharedWithUserId: {
                    sessionId: session.id,
                    sharedWithUserId: editor.id,
                },
            },
        });
        resumeDiscovery.resolve();
        await call;

        expect(targetEffect).not.toHaveBeenCalled();
        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "RPC method not available",
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
        });
    });

    it("allows an already-dispatched Session RPC to finish when access is revoked after emission starts", async () => {
        const { owner, editor, session } = await seedDirectEditor();
        const method = `${session.id}:${SESSION_RPC_METHODS.SESSION_GOAL_SET}`;
        const emissionStarted = deferred<void>();
        const finishEmission = deferred<void>();
        const targetEffect = vi.fn(async () => {
            emissionStarted.resolve();
            await finishEmission.promise;
            return { ok: true, status: "applied" };
        });
        const target = {
            id: "owner-daemon",
            data: { clientType: "session-scoped" },
            timeout: vi.fn(() => ({ emitWithAck: targetEffect })),
        };
        const io = createSocketRoomDiscoveryHarness(async () => [target]);
        const caller = createCaller();
        const callback = vi.fn();

        registerSocketRpcHandlers({
            userId: editor.id,
            socket: caller as unknown as Socket,
            io,
        });
        const call = triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: { v: 1, goal: "do the work" },
        }, callback);

        await emissionStarted.promise;
        await db.sessionShare.delete({
            where: {
                sessionId_sharedWithUserId: {
                    sessionId: session.id,
                    sharedWithUserId: editor.id,
                },
            },
        });
        finishEmission.resolve();
        await call;

        expect(targetEffect).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({
            ok: true,
            result: { ok: true, status: "applied" },
        });
    });
});
