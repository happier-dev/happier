import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, MACHINE_PLAIN_DATA_KEY_MARKER,
    buildAccountStoredContentCompatibilitySocketAuthV1, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '../../testkit/socketHarness';
import { registerSocketRpcHandlers } from './registerSocketRpcHandlers';

describe('Socket RPC request admission cost', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'rpc-admission-cost-', initAuth: false,
            initEncrypt: false, initFiles: false });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('registers distinct methods on one admitted Machine socket without rereading its availability', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: randomUUID() } });
        const socket = Object.assign(createAuthenticatedFakeSocket({ id: 'registered-daemon', data: {
            clientType: 'machine-scoped', machineId: machine.id, verifiedMachineInstallationId: machine.installationId,
        } }), { join: vi.fn(async () => {}), leave: vi.fn(async () => {}) });
        registerSocketRpcHandlers({ userId: owner.id, socket: socket as unknown as Socket,
            io: createSocketRoomDiscoveryHarness(async () => []) });
        const machineDelegate = db.machine;
        let reads = 0;
        // Prisma types client delegates readonly; the db proxy's set trap swaps the live boundary delegate.
        Reflect.set(db, 'machine', new Proxy(machineDelegate, { get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            return key === 'findFirst' ? (...args: unknown[]) => { reads++; return Reflect.apply(value, target, args); } : value;
        } }));
        try {
            for (const method of [RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS, 'daemon.vitals.get', 'git.status']) {
                await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: `${machine.id}:${method}` });
                expect(socket.emit).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, { method: `${machine.id}:${method}` });
            }
            expect(reads).toBe(0);
            socket.connected = false;
            socket.emit.mockClear();
            await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.REGISTER, { method: `${machine.id}:other` });
            expect(socket.emit).not.toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REGISTERED, expect.anything());
        } finally { Reflect.set(db, 'machine', machineDelegate); }
    });

    it('admits each owner request with one read and no repeated database decisions during forwarding', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, active: true,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'cost', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/cost', happyHomeDir: '/cost/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const method = `${machine.id}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS}`;
        const effect = vi.fn(async () => ({ status: 'ready' }));
        const target = { id: 'cost-daemon', data: { clientType: 'machine-scoped', machineId: machine.id,
            verifiedMachineInstallationId: machine.installationId,
            accountStoredContentCompatibility: evaluateAccountStoredContentSocketCompatibility(
                buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)).evaluation },
            timeout: () => ({ emitWithAck: effect }) };
        let registered = true;
        const io = createSocketRoomDiscoveryHarness(async room => registered
            && (room === target.id || room === `rpc:${owner.id}:${method}`) ? [target] : []);
        const caller = createAuthenticatedFakeSocket({ id: 'cost-caller', data: { clientType: 'user-scoped',
            accountStoredContentCompatibility: target.data.accountStoredContentCompatibility } });
        registerSocketRpcHandlers({ userId: owner.id, socket: caller as unknown as Socket, io });
        // Admission reads through read-snapshot clients, so count real SQLite requests, not the db delegate.
        let reads = 0;
        const stopObserving = observeSqliteRequests({ before: request => { if (request.model === 'Machine') reads++; } });
        const transaction = db.$transaction;
        let transactions = 0;
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args) {
            transactions++;
            return Reflect.apply(target, receiver, args);
        } });
        try {
            // One receiving registration serves repeated, independently admitted requests.
            for (let index = 0; index < 16; index++) {
                const callback = vi.fn();
                await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: {} }, callback);
                expect(callback).toHaveBeenCalledWith({ ok: true, result: { status: 'ready' } });
            }
            expect(effect).toHaveBeenCalledTimes(16);
            expect(reads).toBe(16);
            expect(transactions).toBe(0);
            // Missing targets consume the same admission when classifying recovery.
            registered = false;
            const unavailable = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: {} }, unavailable);
            expect(unavailable).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(reads).toBe(17);
            expect(transactions).toBe(0);
            registered = true;
            // A fresh request observes revocation; no permission survives across calls.
            await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
            const callback = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: {} }, callback);
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(effect).toHaveBeenCalledTimes(16);
        } finally { stopObserving(); db.$transaction = transaction; }
    });

    it('carries only authorized Machine availability facts through direct admission and forwarding at the existing IO cost', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, installationId: randomUUID(), active: false,
            metadata: encodePlainMachineStoredContent({ host: 'availability', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/availability', happyHomeDir: '/availability/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        } });
        const compatibility = evaluateAccountStoredContentSocketCompatibility(
            buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)).evaluation;
        const discover = vi.fn(async () => []);
        const io = createSocketRoomDiscoveryHarness(discover);
        const method = `${machine.id}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS}`;
        const caller = (accountId: string) => {
            const socket = createAuthenticatedFakeSocket({ id: accountId, data: {
                clientType: 'user-scoped', accountStoredContentCompatibility: compatibility,
            } });
            registerSocketRpcHandlers({ userId: accountId, socket: socket as unknown as Socket, io });
            return socket;
        };
        const ownerSocket = caller(owner.id);
        const guestSocket = caller(guest.id);
        const call = async (socket: typeof ownerSocket, path: string) => {
            const callback = vi.fn();
            const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
            const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
            let requests = 0;
            const stopObserving = observeSqliteRequests({ before: () => { requests++; } });
            discover.mockClear();
            try {
                await triggerSocketHandler(socket, SOCKET_RPC_EVENTS.CALL, { method, params: {} }, callback);
                expect(callback).toHaveBeenCalledTimes(1);
                const guest = socket === guestSocket;
                // Measured on the same fixture before adding the diagnostic. Count
                // physical SQLite statements, Prisma requests and room lookups.
                expect([prepare.mock.calls.length + exec.mock.calls.length, requests, discover.mock.calls.length], path)
                    .toEqual([guest ? 16 : 3, guest ? 2 : 1, path.endsWith('/forward') && !path.startsWith('unshared/')
                        && !path.startsWith('withdrawn/') ? 2 : 0]);
                return callback.mock.calls[0][0] as unknown;
            } finally {
                stopObserving();
                prepare.mockRestore();
                exec.mockRestore();
            }
        };
        const forbidden = {
            ok: false, error: RPC_ERROR_MESSAGES.FORBIDDEN, errorCode: RPC_ERROR_CODES.FORBIDDEN,
            effectAttempted: false,
            failureCause: { phase: 'rpc.admission.machine', errorClass: 'Error', errorCode: 'access_denied', httpStatus: 403 },
        };
        const compare = async (response: unknown, reason: string) => {
            const diagnostic = { reason, requiredFact: 'machine_online', remedy: 'reconnect_machine' };
            expect.soft(response).toMatchObject({ ok: false, machineAvailabilityDiagnostic: diagnostic });
            await expect.soft(socketRpcCodec.decodeResult({ mode: 'plain' }, response, 'availability')).rejects
                .toMatchObject({ details: diagnostic });
        };
        await compare(await call(ownerSocket, 'unmanaged/direct'), 'machine_offline');
        const managed = await db.managedMachine.create({ data: {
            homeId: 'home', custodianAccountId: owner.id, enrolledMachineId: machine.id,
            admittedActionRequestId: randomUUID(), admittedInput: {}, launch: {}, retention: { kind: 'until-delete' },
            wakeOnAcceptedMessage: false,
        } });
        for (const power of ['running', 'stopped', 'suspended'] as const) {
            await db.managedMachine.update({ where: { id: managed.id }, data: {
                observation: { observedAt: 1, availability: 'present', power },
            } });
            for (const active of [false, true]) {
                await db.machine.update({ where: { id: machine.id }, data: { active } });
                const path = active ? 'forward' : 'direct';
                await compare(await call(ownerSocket, `${power}/${path}`), power === 'running' ? 'machine_offline' : `machine_${power}`);
                if (power === 'stopped') {
                    expect(await call(guestSocket, `unshared/${path}`)).toStrictEqual(forbidden);
                    const grant = await db.machineGrant.create({ data: {
                        principalKind: 'account', machineId: machine.id, accountId: guest.id, accessLevel: 'view', createdByAccountId: owner.id,
                    } });
                    await compare(await call(guestSocket, `use/${path}`), 'machine_stopped');
                    await db.machineGrant.delete({ where: { id: grant.id } });
                    expect(await call(guestSocket, `withdrawn/${path}`)).toStrictEqual(forbidden);
                }
            }
        }
    });

    // OWNER-RULINGS 2026-11-16 "Remove overbuilt re-reads": target selection is a local match; the receiver's
    // Machine kind is checked fresh once, immediately before the call, not once per selection pass.
    it('checks a persistent daemon receiver of Runner-authority methods once per call', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, active: true,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'runner-cost', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/cost', happyHomeDir: '/cost/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') } });
        const method = `${machine.id}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_SNAPSHOT}`;
        const effect = vi.fn(async () => ({ status: 'ready' }));
        const compatibility = evaluateAccountStoredContentSocketCompatibility(
            buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)).evaluation;
        const target = { id: 'runner-cost-daemon', data: { clientType: 'machine-scoped', machineId: machine.id,
            verifiedMachineInstallationId: machine.installationId, accountStoredContentCompatibility: compatibility },
            timeout: () => ({ emitWithAck: effect }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === target.id
            || room === `rpc:${owner.id}:${method}` ? [target] : []);
        const caller = createAuthenticatedFakeSocket({ id: 'runner-cost-caller', data: { clientType: 'user-scoped',
            accountStoredContentCompatibility: compatibility } });
        registerSocketRpcHandlers({ userId: owner.id, socket: caller as unknown as Socket, io });
        let kindReads = 0;
        const stopObserving = observeSqliteRequests({ before: request => {
            if (request.model === 'Machine' && request.action === 'findFirst') kindReads++;
        } });
        try {
            for (let index = 0; index < 3; index++) {
                const callback = vi.fn();
                await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: {} }, callback);
                expect(callback).toHaveBeenCalledWith({ ok: true, result: { status: 'ready' } });
            }
            expect(effect).toHaveBeenCalledTimes(3);
            expect(kindReads).toBe(3);
        } finally { stopObserving(); }
    });
});
