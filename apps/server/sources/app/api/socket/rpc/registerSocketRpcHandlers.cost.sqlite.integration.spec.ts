import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, MACHINE_PLAIN_DATA_KEY_MARKER,
    buildAccountStoredContentCompatibilitySocketAuthV1, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
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
        const machineDelegate = db.machine;
        let reads = 0;
        // Prisma types client delegates readonly; the db proxy's set trap swaps the live boundary delegate.
        Reflect.set(db, 'machine', new Proxy(machineDelegate, { get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            return key === 'findUnique' || key === 'findFirst' || key === 'findMany'
                ? (...args: unknown[]) => { reads++; return Reflect.apply(value, target, args); } : value;
        } }));
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
        } finally { Reflect.set(db, 'machine', machineDelegate); db.$transaction = transaction; }
    });
});
