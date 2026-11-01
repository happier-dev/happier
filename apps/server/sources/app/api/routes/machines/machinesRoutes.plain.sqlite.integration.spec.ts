import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Socket } from 'socket.io';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { machinesRoutes } from './machinesRoutes';
import { machineUpdateHandler } from '@/app/api/socket/machineUpdateHandler';

const { emitUpdate, emitEphemeral } = vi.hoisted(() => ({ emitUpdate: vi.fn(), emitEphemeral: vi.fn() }));
// Socket delivery is the external transport boundary; keep payload construction and persistence real.
vi.mock('@/app/events/eventRouter', async () => {
    const actual = await vi.importActual<typeof import('@/app/events/eventRouter')>('@/app/events/eventRouter');
    return { ...actual, eventRouter: { ...actual.eventRouter, emitUpdate, emitEphemeral } };
});

const plain = (value: unknown) => Buffer.from(JSON.stringify({ t: 'plain', v: value })).toString('base64');
const marker = plain(null);

describe('machine plaintext storage (SQLite route and socket integration)', () => {
    let harness: LightSqliteHarness;
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    let userId = '';

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-machine-plain-' });
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        app.decorate('authenticate', async (request: { userId: string }) => { request.userId = userId; });
        machinesRoutes(app as Parameters<typeof machinesRoutes>[0]);
        await app.ready();
    }, 120_000);

    beforeEach(() => {
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
    });

    afterEach(async () => {
        vi.unstubAllEnvs();
        emitUpdate.mockClear();
        emitEphemeral.mockClear();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => { await app.close(); await harness?.close(); });

    async function account(mode: 'plain' | 'e2ee' = 'plain') {
        const row = await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: mode } });
        userId = row.id;
        return row;
    }

    async function register(id: string, metadata = plain({ host: 'local', displayName: 'kept' }), daemonState = plain({ pid: 1 })) {
        return app.inject({ method: 'POST', url: '/v1/machines', payload: { id, metadata, daemonState, dataEncryptionKey: marker } });
    }

    async function encryptedMachine() {
        return db.machine.create({ data: {
            accountId: userId, id: randomUUID(), metadata: 'historical-ciphertext', metadataVersion: 7,
            daemonState: 'historical-state', daemonStateVersion: 4, dataEncryptionKey: new Uint8Array([0, 1, 2, 3]),
            contentPublicKeyFingerprint: 'f'.repeat(64), active: true,
        } });
    }

    it('admits plaintext only for plain accounts and keeps existing canonical fields on re-registration', async () => {
        await account('e2ee');
        const denied = await register(randomUUID());
        expect(denied.statusCode).toBe(400);
        expect(await db.machine.count()).toBe(0);
        await account();
        const id = randomUUID();
        expect((await register(id)).statusCode).toBe(200);
        const refreshed = await register(id, plain({ host: 'new' }), plain({ pid: 2 }));
        expect(refreshed.statusCode).toBe(200);
        expect(refreshed.json().machine).toMatchObject({ metadata: plain({ host: 'local', displayName: 'kept' }), daemonState: plain({ pid: 1 }), daemonStateVersion: 1 });
        const mismatch = await app.inject({ method: 'POST', url: '/v1/machines', payload: { id, metadata: 'cipher', dataEncryptionKey: 'AAECAw==' } });
        expect(mismatch.statusCode).toBe(400);
        expect((await db.machine.findFirstOrThrow({ where: { id } })).dataEncryptionKey).toEqual(new Uint8Array(Buffer.from(marker, 'base64')));
    });

    it('rejects malformed or mixed plaintext fields before storage', async () => {
        await account();
        for (const [metadata, daemonState] of [[plain({ host: 'ok' }), 'cipher'], ['cipher', plain({ pid: 1 })]]) {
            expect((await register(randomUUID(), metadata, daemonState)).statusCode).toBe(400);
        }
        expect(await db.machine.count()).toBe(0);
    });

    it('rechecks account mode in the create transaction after the preliminary mode read', async () => {
        await account();
        // The DB boundary yields a genuine stale read while another Account-mode writer commits.
        const accountDelegate = db.account;
        const readAccount = accountDelegate.findUnique.bind(accountDelegate);
        const staleAccountRead = async (args: Parameters<typeof db.account.findUnique>[0]) => {
            const current = await readAccount(args);
            await db.account.update({ where: { id: userId }, data: { encryptionMode: 'e2ee' } });
            return current;
        };
        // This DB-boundary fixture is awaited directly; Prisma's unused fluent relation methods are not exercised.
        const staleRead = vi.spyOn(db.account, 'findUnique').mockImplementationOnce(staleAccountRead as unknown as typeof db.account.findUnique);
        try {
            expect((await register(randomUUID())).statusCode).toBe(400);
            expect(await db.machine.count()).toBe(0);
        } finally {
            staleRead.mockRestore();
            // Prisma delegates synthesize methods through a Proxy; spy restoration otherwise deletes that method.
            accountDelegate.findUnique = readAccount;
        }
    });

    it('enforces the canonical feature deny on plaintext writes while retaining encrypted registration', async () => {
        await account();
        vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', 'encryption.plaintextMachine');
        expect((await register(randomUUID())).statusCode).toBe(404);
        const old = await encryptedMachine();
        const transition = await app.inject({ method: 'POST', url: `/v1/machines/${old.id}/content-key/transition`, payload: {
            machineId: old.id, expected: { dataEncryptionKey: 'AAECAw==', metadataVersion: 7, daemonStateVersion: 4 },
            next: { dataEncryptionKey: marker, metadata: plain({ host: 'local' }), daemonState: null },
        } });
        expect(transition.statusCode).toBe(404);
        const encrypted = await app.inject({ method: 'POST', url: '/v1/machines', payload: { id: randomUUID(), metadata: 'cipher' } });
        expect(encrypted.statusCode).toBe(200);
    });

    it('retains historical encrypted content and key when registration presents another encrypted envelope', async () => {
        await account();
        const old = await encryptedMachine();
        for (const dataEncryptionKey of ['AAkJCQ==', undefined]) {
            const response = await app.inject({ method: 'POST', url: '/v1/machines', payload: {
                id: old.id, metadata: 'new-ciphertext', daemonState: 'new-state', dataEncryptionKey,
            } });
            expect(response.statusCode).toBe(200);
            expect(response.json().machine).toMatchObject({ metadata: old.metadata, daemonState: old.daemonState, dataEncryptionKey: 'AAECAw==', daemonStateVersion: 4 });
        }
    });

    it('atomically transitions historical encrypted fields, publishes the key with both versions, and conflicts on stale basis', async () => {
        await account();
        const old = await encryptedMachine();
        const payload = {
            machineId: old.id,
            expected: { dataEncryptionKey: 'AAECAw==', metadataVersion: 7, daemonStateVersion: 4 },
            next: { dataEncryptionKey: marker, metadata: plain({ host: 'local', displayName: 'preserved' }), daemonState: plain({ pid: 1 }) },
        };
        const response = await app.inject({ method: 'POST', url: `/v1/machines/${old.id}/content-key/transition`, payload });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ kind: 'committed', machine: { ...payload.next, metadataVersion: 8, daemonStateVersion: 5, contentPublicKeyFingerprint: null } });
        const update = emitUpdate.mock.calls.map(([entry]) => entry.payload.body).find(body => body.t === 'update-machine' && body.dataEncryptionKey === marker);
        expect(update).toMatchObject({ metadata: { value: payload.next.metadata, version: 8 }, daemonState: { value: payload.next.daemonState, version: 5 }, dataEncryptionKey: marker });
        const stale = await app.inject({ method: 'POST', url: `/v1/machines/${old.id}/content-key/transition`, payload });
        expect(stale.json()).toMatchObject({ kind: 'conflict', current: { dataEncryptionKey: marker, metadataVersion: 8, daemonStateVersion: 5 } });
        expect((await app.inject({ method: 'GET', url: `/v1/machines/${old.id}` })).json().machine).toMatchObject(payload.next);
    });

    it('refuses transitions with a wrong owner, encrypted account, revoked machine, or malformed next content', async () => {
        await account('e2ee');
        const old = await encryptedMachine();
        const payload = { machineId: old.id, expected: { dataEncryptionKey: 'AAECAw==', metadataVersion: 7, daemonStateVersion: 4 }, next: { dataEncryptionKey: marker, metadata: plain({ host: 'local' }), daemonState: null } };
        const invoke = () => app.inject({ method: 'POST', url: `/v1/machines/${old.id}/content-key/transition`, payload });
        expect((await invoke()).json()).toMatchObject({ kind: 'refused', code: 'forbidden' });
        await db.account.update({ where: { id: userId }, data: { encryptionMode: 'plain' } });
        payload.next.metadata = 'not-plain';
        expect((await invoke()).json()).toMatchObject({ kind: 'refused', code: 'machine_storage_mode_mismatch' });
        payload.next.metadata = plain({ host: 'local' });
        const replacement = await db.machine.create({ data: { accountId: userId, id: randomUUID(), metadata: 'cipher' } });
        await db.machine.update({ where: { accountId_id: { accountId: userId, id: old.id } }, data: { replacedByMachineId: replacement.id } });
        expect((await invoke()).json()).toMatchObject({ kind: 'refused', code: 'machine_unavailable' });
        await db.machine.update({ where: { accountId_id: { accountId: userId, id: old.id } }, data: { revokedAt: new Date() } });
        expect((await invoke()).json()).toMatchObject({ kind: 'refused', code: 'machine_unavailable' });
        await account();
        expect((await invoke()).json()).toMatchObject({ kind: 'refused', code: 'machine_unavailable' });
    });

    it('converts released absent-key encrypted history with a null daemon state without inventing state', async () => {
        await account();
        const old = await db.machine.create({ data: { accountId: userId, id: randomUUID(), metadata: 'legacy-cipher', daemonState: null } });
        const response = await app.inject({ method: 'POST', url: `/v1/machines/${old.id}/content-key/transition`, payload: {
            machineId: old.id,
            expected: { dataEncryptionKey: null, metadataVersion: old.metadataVersion, daemonStateVersion: old.daemonStateVersion },
            next: { dataEncryptionKey: marker, metadata: plain({ host: 'retained' }), daemonState: null },
        } });
        expect(response.json()).toMatchObject({ kind: 'committed', machine: { daemonState: null, daemonStateVersion: old.daemonStateVersion + 1, dataEncryptionKey: marker } });
    });

    it('uses stored row mode for versioned socket writes even when the account is plain', async () => {
        await account();
        const encrypted = await encryptedMachine();
        const id = randomUUID();
        const registration = await register(id);
        expect(registration.statusCode, registration.body).toBe(200);
        for (const [machineId, nextMetadata, nextState, version, permitted] of [
            [id, 'cipher', 'cipher', 1, false],
            [encrypted.id, plain({ host: 'bad' }), plain({ pid: 2 }), 7, false],
            [id, plain({ host: 'updated' }), plain({ pid: 2 }), 1, true],
            [encrypted.id, 'next-cipher', 'next-state', 7, true],
        ] as const) {
            const socket = createFakeSocket({ data: { clientType: 'machine-scoped', machineId } });
            machineUpdateHandler(userId, socket as unknown as Socket);
            const metadataCallback = vi.fn();
            await getSocketHandler(socket, 'machine-update-metadata')({ machineId, metadata: nextMetadata, expectedVersion: version }, metadataCallback);
            expect(metadataCallback.mock.calls[0][0], `${machineId === id ? 'plain' : 'encrypted'} metadata write`).toMatchObject({ result: permitted ? 'success' : 'error' });
            const stateCallback = vi.fn();
            await getSocketHandler(socket, 'machine-update-state')({ machineId, daemonState: nextState, expectedVersion: machineId === id ? 1 : 4 }, stateCallback);
            expect(stateCallback.mock.calls[0][0].result).toBe(permitted ? 'success' : 'error');
        }
    });

    it('admits action-operation revisions only in their persisted machine mode', async () => {
        await account();
        const encrypted = await encryptedMachine();
        const plainId = randomUUID();
        const registration = await register(plainId);
        expect(registration.statusCode, registration.body).toBe(200);
        const snapshot = (machineId: string) => ({
            version: 1, operationId: 'op-1', revision: 1, actionId: 'session.fork', state: 'accepted',
            scope: { accountId: userId, machineId }, title: 'Fork', createdAt: 1, cancellation: 'unsupported',
        });
        for (const [machineId, t, permitted] of [
            [plainId, 'encrypted', false], [plainId, 'plain', true],
            [encrypted.id, 'plain', false], [encrypted.id, 'encrypted', true],
        ] as const) {
            const socket = createFakeSocket({ data: { clientType: 'machine-scoped', machineId } });
            machineUpdateHandler(userId, socket as unknown as Socket);
            emitEphemeral.mockClear();
            await getSocketHandler(socket, 'action-operation-updated')({
                type: 'action-operation-updated', machineId,
                content: t === 'plain' ? { t, v: snapshot(machineId) } : { t, c: 'cipher' },
            });
            expect(emitEphemeral, `${t} revision on ${machineId === plainId ? 'plain' : 'encrypted'} machine`).toHaveBeenCalledTimes(permitted ? 1 : 0);
        }
        const socket = createFakeSocket({ data: { clientType: 'machine-scoped', machineId: plainId } });
        machineUpdateHandler(userId, socket as unknown as Socket);
        const payload = { type: 'action-operation-updated', machineId: plainId, content: { t: 'plain', v: snapshot(plainId) } };
        payload.content.v.scope.accountId = 'another-account';
        emitEphemeral.mockClear();
        await getSocketHandler(socket, 'action-operation-updated')(payload);
        expect(emitEphemeral).not.toHaveBeenCalled();
        payload.content.v.scope.accountId = userId;
        await db.machine.update({ where: { accountId_id: { accountId: userId, id: plainId } }, data: { revokedAt: new Date() } });
        await getSocketHandler(socket, 'action-operation-updated')(payload);
        expect(emitEphemeral).not.toHaveBeenCalled();
    });
});
