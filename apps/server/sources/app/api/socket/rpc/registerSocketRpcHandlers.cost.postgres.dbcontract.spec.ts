import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    MACHINE_PLAIN_DATA_KEY_MARKER,
    buildAccountStoredContentCompatibilitySocketAuthV1,
    decodeBase64,
    encodePlainMachineStoredContent,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '../../testkit/socketHarness';
import { registerSocketRpcHandlers } from './registerSocketRpcHandlers';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Socket RPC PostgreSQL request admission cost', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_DB_TX_MAX_RETRIES', '0');
        initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => {
        if (connected) await db.$disconnect();
        vi.unstubAllEnvs();
    });

    it.each(['owner', 'shared'] as const)('admits every %s call once and observes withdrawal on the next request', async relationship => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const actor = relationship === 'owner' ? owner : await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: {
            id: randomUUID(), accountId: owner.id, active: true, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'cost', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/cost', happyHomeDir: '/cost/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        } });
        const method = `${machine.id}:${RPC_METHODS.DAEMON_VOICE_INFERENCE_STATUS}`;
        const effect = vi.fn(async () => ({ status: 'ready' }));
        const accountStoredContentCompatibility = evaluateAccountStoredContentSocketCompatibility(
            buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
        ).evaluation;
        const target = { id: 'cost-daemon', data: { clientType: 'machine-scoped', machineId: machine.id,
            verifiedMachineInstallationId: machine.installationId, accountStoredContentCompatibility },
            timeout: () => ({ emitWithAck: effect }) };
        const io = createSocketRoomDiscoveryHarness(async room =>
            room === target.id || room === `rpc:${owner.id}:${method}` ? [target] : []);
        const caller = createAuthenticatedFakeSocket({ id: 'cost-caller', data: {
            clientType: 'user-scoped', accountStoredContentCompatibility,
        } });
        registerSocketRpcHandlers({ userId: actor.id, socket: caller as unknown as Socket, io });
        const call = async () => {
            const callback = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: {} }, callback);
            return callback;
        };
        if (relationship === 'shared') {
            expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(effect).not.toHaveBeenCalled();
            await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id, accountId: actor.id,
                accessLevel: 'view', createdByAccountId: owner.id } });
        }

        const machineDelegate = db.machine;
        const transaction = db.$transaction;
        let reads = 0;
        let transactions = 0;
        // Count the genuine Prisma/PostgreSQL boundary without replacing internal admission.
        // Prisma types client delegates readonly; the db proxy's set trap swaps the live boundary delegate.
        Reflect.set(db, 'machine', new Proxy(machineDelegate, { get(target, key, receiver) {
            const value = Reflect.get(target, key, receiver);
            return key === 'findUnique' || key === 'findFirst' || key === 'findMany'
                ? (...args: unknown[]) => { reads++; return Reflect.apply(value, target, args); } : value;
        } }));
        db.$transaction = new Proxy(transaction, { apply(target, receiver, args) {
            transactions++;
            return Reflect.apply(target, receiver, args);
        } });
        try {
            const readsPerRequest = relationship === 'owner' ? 1 : 2;
            for (let index = 0; index < 16; index++) {
                expect(await call()).toHaveBeenCalledWith({ ok: true, result: { status: 'ready' } });
                expect(reads).toBe((index + 1) * readsPerRequest);
                expect(transactions).toBe(0);
            }
            expect(effect).toHaveBeenCalledTimes(16);
            if (relationship === 'owner') {
                await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
            } else {
                await db.machineGrant.delete({ where: { principalKind: 'account',
                    machineId_accountId: { machineId: machine.id, accountId: actor.id },
                } });
            }
            expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(effect).toHaveBeenCalledTimes(16);
        } finally {
            Reflect.set(db, 'machine', machineDelegate);
            db.$transaction = transaction;
        }
    });
});
