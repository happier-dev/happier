import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server, Socket } from "socket.io";

import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from "@happier-dev/protocol/rpc";
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, MACHINE_PLAIN_DATA_KEY_MARKER,
    buildAccountStoredContentCompatibilitySocketAuthV1, decodeBase64, encodePlainMachineStoredContent } from "@happier-dev/protocol";
import tweetnacl from 'tweetnacl';
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createAuthenticatedFakeSocket, triggerSocketHandler } from "../../testkit/socketHarness";
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
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    }, 120_000);
    beforeEach(() => harness.resetEnv());
    afterAll(async () => { if (harness) await harness.close(); });

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
        const io = { in: (room: string) => ({ timeout: () => ({ fetchSockets: async () => read(room) }), fetchSockets: async () => read(room) }) } as unknown as Server;
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
        const io = { in: (room: string) => ({
            timeout: () => ({ fetchSockets: async () => room === `rpc:${owner.id}:${method}` || room === target.id ? [target] : [] }),
            fetchSockets: async () => room === target.id ? [target] : [],
        }) } as unknown as Server;
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
        const io = { in: vi.fn((room: string) => ({
            timeout: vi.fn(() => ({ fetchSockets: () => readTargets(room) })), fetchSockets: () => readTargets(room),
        })) } as unknown as Server;
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

    it('cleans lost requester Sessions through custody only and refuses delayed rejoin or installation replacement', async () => {
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
        let duringLatest: (() => Promise<void>) | undefined;
        const read = async (room: string) => {
            if (room === target.id && duringLatest) { const mutation = duringLatest; duringLatest = undefined; await mutation(); }
            return room === target.id || room === `rpc:${owner.id}:${method}` ? [target] : [];
        };
        const io = { in: (room: string) => ({ timeout: () => ({ fetchSockets: () => read(room) }), fetchSockets: () => read(room) }) } as unknown as Server;
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
            duringLatest = () => db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: actor.id,
                accessLevel: 'view', createdByAccountId: owner.id } }).then(() => undefined);
            expect(await dispatchMachineAccessLossCustody(input)).toEqual({ kind: 'settled' });
            expect(effect).not.toHaveBeenCalled();
            await db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: machine.id, accountId: actor.id } } });
            duringLatest = () => db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } }).then(() => undefined);
            expect(await dispatchMachineAccessLossCustody(input)).toEqual({ kind: 'incomplete' });
            expect(effect).not.toHaveBeenCalled();
        } finally { eventRouter.clearIo(); }
    });

    it('recovers offline sessionless requester cleanup from the daemon census while surviving grants and history remain intact', async () => {
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
        const cleaned = new Set<string>();
        const effect = async (_event: string, request: { params: { kind?: string; subjectAccountId?: string } }) => {
            // Genuine daemon transport boundary: the receiver's real inventory/native cleanup is covered in its owner suite.
            if (request.params.kind === 'requesters') return { kind: 'requesters', accountIds: [actor.id, survivor.id], coverage: 'complete' };
            if (request.params.subjectAccountId) cleaned.add(request.params.subjectAccountId);
            return { kind: 'settled' };
        };
        const target = { id: 'reconnect-custody-daemon', data: { clientType: 'machine-scoped', userId: owner.id,
            machineId: machine.id, verifiedMachineInstallationId: machine.installationId, accountStoredContentCompatibility }, timeout: () => ({ emitWithAck: effect }) };
        const read = async (room: string) => online && (room === target.id || room === `rpc:${owner.id}:${method}`) ? [target] : [];
        const io = { in: (room: string) => ({ timeout: () => ({ fetchSockets: () => read(room) }), fetchSockets: () => read(room) }) } as unknown as Server;
        eventRouter.setIo(io, { forwardRpc: request => forwardRpcCall({ io, ...request }) });
        const custody = { machineId: machine.id, expectedCustodianAccountId: owner.id, expectedInstallationId: machine.installationId! };
        try {
            for (const accountId of [actor.id, survivor.id]) expect(await inTx(tx => removeMachineAccessGrantInTx(tx, {
                actorAccountId: owner.id, machineId: machine.id, principal: { kind: 'account', accountId },
            }))).toMatchObject({ kind: 'removed' });
            expect(await dispatchMachineAccessLossCustody({ ...custody, subjectAccountId: actor.id })).toEqual({ kind: 'incomplete' });
            expect(await db.accessKey.count({ where: { machineId: machine.id } })).toBe(0);
            online = true;
            const publisher = { ...createAuthenticatedFakeSocket({ id: target.id, data: target.data }), join: async () => {} };
            registerSocketRpcHandlers({ userId: owner.id, socket: publisher as unknown as Socket, io });
            await triggerSocketHandler(publisher, SOCKET_RPC_EVENTS.REGISTER, { method });
            expect(publisher.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method });
            expect([...cleaned]).toEqual([actor.id]);
            expect(await db.session.findUnique({ where: { id: history.id } })).toEqual(history);
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
        const io = {
            in: vi.fn((room: string) => ({
                timeout: vi.fn(() => ({
                    fetchSockets: vi.fn(async () =>
                        room === `rpc:${owner.id}:${method}` || room === target.id ? [target] : []),
                })),
                fetchSockets: vi.fn(async () => room === target.id ? [target] : []),
            })),
        } as unknown as Server;

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
        const io = {
            in: vi.fn((room: string) => ({
                timeout: vi.fn(() => ({
                    fetchSockets: vi.fn(async () => {
                        if (room === `rpc:${owner.id}:${method}`) {
                            discoveryStarted.resolve();
                            await resumeDiscovery.promise;
                            return [target];
                        }
                        return room === target.id ? [target] : [];
                    }),
                })),
                fetchSockets: vi.fn(async () => room === target.id ? [target] : []),
            })),
        } as unknown as Server;
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
        const io = {
            in: vi.fn((room: string) => ({
                timeout: vi.fn(() => ({
                    fetchSockets: vi.fn(async () => {
                        if (room === `rpc:${owner.id}:${method}`) {
                            discoveryStarted.resolve();
                            await resumeDiscovery.promise;
                            return [target];
                        }
                        return room === target.id ? [target] : [];
                    }),
                })),
                fetchSockets: vi.fn(async () => room === target.id ? [target] : []),
            })),
        } as unknown as Server;
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
        const io = {
            in: vi.fn((room: string) => ({
                timeout: vi.fn(() => ({ fetchSockets: vi.fn(async () => [target]) })),
                fetchSockets: vi.fn(async () => room === target.id ? [target] : []),
            })),
        } as unknown as Server;
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
