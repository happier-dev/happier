import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Socket } from 'socket.io';
import { decodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, computeContentPublicKeyFingerprint, encodePlainMachineStoredContent, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { projectSourceRoutes } from '@/app/api/routes/projects/projectSourceRoutes';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { auth } from '@/app/auth/auth';
import { accessKeyHandler } from '@/app/api/socket/accessKeyHandler';
import { createFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { dispatchMachineAccessLossCustody, recoverMachineAccessLossCustody } from '@/app/machines/machineAccessCustody';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { resolveMachineSetup } from '@/app/machines/managed/machineSetup';
import { prepareManagedPolicy } from '@/app/machines/managed/managedMutations';

/** Pause only the Prisma transport after a real statement; all domain owners and SQL run unchanged. */
async function acrossCommit<T>(input: {
    model: 'machine' | 'projectSource' | 'session' | 'managedMachine'; method: 'findUnique' | 'findMany' | 'findFirst';
    write: (tx: Tx) => Promise<unknown>; read: () => Promise<T>;
}) {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const writer = inTx(async tx => { await input.write(tx); ready(); await released; }, { isolationLevel: 'Serializable' });
    const writerOutcome = Promise.allSettled([writer]);
    const original = db.$transaction;
    let observed: { locks: number; readOnly: string } | undefined;
    try {
        await Promise.race([started, writer]);
        db.$transaction = new Proxy(original, {
            apply(target, thisArg, args) {
                const [run, options] = args;
                return Reflect.apply(target, thisArg, [async (tx: Tx) => run(new Proxy(tx, {
                    get(transaction, property, receiver) {
                        const value = Reflect.get(transaction, property, receiver);
                        if (property !== input.model) return typeof value === 'function' ? value.bind(transaction) : value;
                        return new Proxy(value, {
                            get(delegate, method, delegateReceiver) {
                                const operation = Reflect.get(delegate, method, delegateReceiver);
                                if (method !== input.method) return typeof operation === 'function' ? operation.bind(delegate) : operation;
                                return async (...queryArgs: unknown[]) => {
                                    const result = await Reflect.apply(operation, delegate, queryArgs);
                                    if (!observed) {
                                        const [{ pid, readOnly }] = await tx.$queryRaw<Array<{ pid: number; readOnly: string }>>`
                                            SELECT pg_backend_pid() AS pid, current_setting('transaction_read_only') AS "readOnly"
                                        `;
                                        const [{ count }] = await db.$queryRaw<Array<{ count: number }>>`
                                            SELECT count(*)::int AS count FROM pg_locks WHERE mode = 'SIReadLock' AND pid = ${pid}
                                            AND virtualtransaction IN (SELECT virtualtransaction FROM pg_locks
                                                WHERE pid = ${pid} AND locktype = 'virtualxid' AND mode = 'ExclusiveLock' AND granted)
                                        `;
                                        observed = { locks: count, readOnly };
                                        release();
                                        await writer;
                                    }
                                    return result;
                                };
                            },
                        });
                    },
                })), options]);
            },
        });
        const result = await input.read();
        expect(observed, 'the real reader must reach its first database statement').toBeDefined();
        return { result, observed: observed! };
    } finally {
        db.$transaction = original;
        release();
        await writerOutcome;
    }
}

const headers = (accountId: string) => ({ 'x-test-user-id': accountId, 'x-happier-account-stored-content-protocol': '4' });
const repository = { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'acme/repo', cloneUrl: 'https://github.com/acme/repo.git', visibility: 'private' }, protocol: 'https' };
const homeId = `srv_${'b'.repeat(32)}`;

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Machine and Project coherent read snapshots', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with an explicit disposable PostgreSQL DB-contract database');
        }
        initDbPostgres();
        await db.$connect();
        vi.stubEnv('HANDY_MASTER_SECRET', 'machine-project-snapshot-contract');
        vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
        vi.stubEnv('HAPPIER_SERVER_IDENTITY_ID', homeId);
        await auth.init();
    });
    afterAll(async () => { await db.$disconnect(); vi.unstubAllEnvs(); });

    it('keeps Machine recovery content and Account key readiness coherent without predicate locks', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const metadata = encodePlainMachineStoredContent({ host: 'before', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata,
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId: randomUUID() } });
        try {
            await withAuthenticatedTestApp(machinesRoutes, async (app: FastifyInstance) => {
                const read = () => app.inject({ method: 'GET', url: `/v1/machines/${machine.id}/content-key/transition`, headers: headers(owner.id) });
                const captured = await acrossCommit({ model: 'machine', method: 'findUnique', read, write: async tx => {
                    await tx.machine.update({ where: { id: machine.id }, data: { metadata: 'after' } });
                    await tx.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee' } });
                } });
                expect(captured.result.statusCode, captured.result.body).toBe(200);
                expect(captured.result.json()).toMatchObject({ machine: { metadata } });
                expect((await read()).statusCode).toBe(404);
                expect(captured.observed).toEqual({ locks: 0, readOnly: 'on' });
            });
        } finally { await db.machine.delete({ where: { id: machine.id } }); await db.account.delete({ where: { id: owner.id } }); }
    });

    it('keeps Machine census content and recipient binding coherent without predicate locks', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const recipient = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const afterBinding = createSignedAccountContentBinding();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: 'before', daemonState: 'opaque', installationId: randomUUID(),
            dataEncryptionKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32), recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes })) } });
        await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: recipient.id, accessLevel: 'view', createdByAccountId: owner.id } });
        try {
            await withAuthenticatedTestApp(machinesRoutes, async (app: FastifyInstance) => {
                const read = () => app.inject({ method: 'GET', url: `/v1/machines/${machine.id}/data-key-envelopes`, headers: headers(owner.id) });
                const captured = await acrossCommit({ model: 'machine', method: 'findUnique', read, write: async tx => {
                    await tx.machine.update({ where: { id: machine.id }, data: { metadata: 'after' } });
                    await tx.account.update({ where: { id: recipient.id }, data: afterBinding });
                } });
                expect(captured.result.statusCode, captured.result.body).toBe(200);
                expect(captured.result.json()).toMatchObject({ content: { metadata: 'before' }, recipients: [{ recipientAccountId: recipient.id,
                    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipient.contentPublicKey!) }] });
                expect((await read()).json()).toMatchObject({ content: { metadata: 'after' }, recipients: [{ recipientAccountId: recipient.id,
                    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(afterBinding.contentPublicKey) }] });
                expect(captured.observed).toEqual({ locks: 0, readOnly: 'on' });
            });
        } finally { await db.machine.delete({ where: { id: machine.id } }); await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } }); }
    });

    it('uses a predicate-lock-free pending-reply snapshot and still refuses revoked Machine readmission', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'before', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        try {
            await withAuthenticatedTestApp(machinesRoutes, async (app: FastifyInstance) => {
                const read = () => app.inject({ method: 'GET', url: `/v2/machines/${machine.id}/session-message-replies/pending`, headers: headers(owner.id) });
                expect((await read()).json()).toEqual({ v: 1, entries: [], nextAfter: null });
                const captured = await acrossCommit({ model: 'machine', method: 'findMany', read, write: tx =>
                    tx.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } }) });
                // The capture may see the incumbent installation, but its separate current-admission read must refuse it.
                expect(captured.result.statusCode, captured.result.body).toBe(404);
                expect((await read()).statusCode).toBe(404);
                expect(captured.observed).toEqual({ locks: 0, readOnly: 'on' });
            });
        } finally { await db.machine.delete({ where: { id: machine.id } }); await db.account.delete({ where: { id: owner.id } }); }
    });

    it.each(['list', 'read'] as const)('keeps Project Source %s metadata and admission coherent without predicate locks', async kind => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await db.projectSource.create({ data: { name: 'before', repository, audience: [], attachments: [], createdByAccountId: owner.id } });
        try {
            await withAuthenticatedTestApp(projectSourceRoutes, async (app: FastifyInstance) => {
                const read = () => app.inject({ method: 'GET', url: kind === 'list' ? '/v1/projects/sources?serverId=home'
                    : `/v1/projects/sources/${source.id}?serverId=home`, headers: headers(owner.id) });
                const captured = await acrossCommit({ model: 'projectSource', method: kind === 'list' ? 'findMany' : 'findUnique', read, write: async tx => {
                    await tx.projectSource.update({ where: { id: source.id }, data: { name: 'after' } });
                    await tx.account.update({ where: { id: owner.id }, data: { status: 'disabled' } });
                } });
                expect(captured.result.statusCode, captured.result.body).toBe(200);
                expect(captured.result.json()).toMatchObject(kind === 'list' ? { ok: true, sources: [{ id: source.id, name: 'before' }] }
                    : { ok: true, source: { id: source.id, name: 'before' } });
                expect((await read()).json()).toEqual({ ok: false, error: 'source_unavailable' });
                expect(captured.observed).toEqual({ locks: 0, readOnly: 'on' });
            });
        } finally { await db.projectSource.delete({ where: { id: source.id } }); await db.account.delete({ where: { id: owner.id } }); }
    });

    it('keeps socket AccessKey ciphertext and Machine admission coherent without predicate locks', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: owner.id, sessionId: session.id, machineId: machine.id, data: 'before' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const socket = Object.assign(createFakeSocket({ data: { clientType: 'user-scoped' } }), { handshake: { auth: { token } }, disconnect: vi.fn() });
        const transport = socket as unknown as Socket;
        accessKeyHandler(owner.id, transport, { connectionType: 'user-scoped', socket: transport, userId: owner.id });
        const read = async () => {
            const callback = vi.fn();
            await getSocketHandler(socket, 'access-key-get')({ sessionId: session.id, machineId: machine.id }, callback);
            return callback.mock.calls[0]?.[0] as unknown;
        };
        try {
            const captured = await acrossCommit({ model: 'session', method: 'findFirst', read, write: async tx => {
                await tx.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
                await tx.accessKey.update({ where: { accountId_machineId_sessionId: { accountId: owner.id, machineId: machine.id, sessionId: session.id } }, data: { data: 'after' } });
            } });
            expect(captured.result).toMatchObject({ ok: true, accessKey: { data: 'before' } });
            expect(await read()).toMatchObject({ ok: false });
            expect(captured.observed).toEqual({ locks: 0, readOnly: 'on' });
        } finally {
            await db.accessKey.deleteMany({ where: { machineId: machine.id } });
            await db.session.delete({ where: { id: session.id } });
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it('keeps lost-access and cleanup installation custody coherent without predicate locks', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const subject = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, active: true,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'before', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        // The daemon RPC transport is the only substituted boundary; admission remains real PostgreSQL.
        const forward = vi.spyOn(eventRouter, 'forwardServerOwnedRpc').mockResolvedValue({ ok: true, result: { kind: 'settled' } });
        const read = () => dispatchMachineAccessLossCustody({ machineId: machine.id, subjectAccountId: subject.id,
            expectedCustodianAccountId: owner.id, expectedInstallationId: machine.installationId! });
        try {
            const captured = await acrossCommit({ model: 'machine', method: 'findUnique', read, write: async tx => {
                await tx.machineAccountGrant.create({ data: { machineId: machine.id, accountId: subject.id, accessLevel: 'view', createdByAccountId: owner.id } });
                await tx.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } });
            } });
            expect(captured.result).toEqual({ kind: 'settled' });
            expect(forward.mock.calls[0]?.[0]).toMatchObject({ machineAdmission: { installationId: machine.installationId } });
            forward.mockClear();
            expect(await read()).toEqual({ kind: 'settled' });
            expect(forward).not.toHaveBeenCalled();
            expect(captured.observed).toEqual({ locks: 0, readOnly: 'on' });
        } finally {
            forward.mockRestore();
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, subject.id] } } });
        }
    });

    it('keeps managed environment and target authority coherent without predicate locks', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}', installationId: randomUUID() } });
        const guest = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}', installationId: randomUUID() } });
        const launch = { provider: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} };
        const preset = await db.managedMachinePreset.create({ data: { homeId, custodianAccountId: owner.id, name: 'Preset', launch,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, setup: { scripts: [{ body: 'preset' }] } } });
        const row = await db.managedMachine.create({ data: { homeId, custodianAccountId: owner.id,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, admittedActionRequestId: randomUUID(), admittedInput: {},
            presetId: preset.id, presetRevision: preset.revision, launch, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            allocation: 'bound', enrolledMachineId: guest.id, resource: { contributionRef: launch.provider, schemaVersion: 1, value: { id: 'native' } },
            machineSetup: { setup: { scripts: [{ body: 'before' }] }, state: 'pending' } } });
        const read = () => resolveMachineSetup({ actorAccountId: owner.id, custodianAccountId: owner.id, creationManagedId: row.id,
            input: { homeId, machineId: guest.id, sources: [
                { kind: 'accountPreset', presetId: preset.id, presetRevision: preset.revision, setup: { scripts: [{ body: 'before' }] } },
                { kind: 'direct', setup: {} },
            ] } });
        try {
            const captured = await acrossCommit({ model: 'machine', method: 'findUnique', read, write: async tx => {
                await tx.managedMachine.update({ where: { id: row.id }, data: { machineSetup: { setup: { scripts: [{ body: 'after' }] }, state: 'pending' } } });
                await tx.account.update({ where: { id: owner.id }, data: { status: 'disabled' } });
            } });
            expect(captured.result).toEqual({ sources: [
                { kind: 'accountPreset', presetId: preset.id, presetRevision: preset.revision, setup: { scripts: [{ body: 'before' }] } },
                { kind: 'direct', setup: {} },
            ], creation: { managedId: row.id, preset: { id: preset.id, revision: preset.revision } } });
            await expect(read()).rejects.toMatchObject({ code: 'permission_denied' });
            expect(captured.observed).toEqual({ locks: 0, readOnly: 'on' });
        } finally {
            await db.managedMachine.delete({ where: { id: row.id } });
            await db.managedMachinePreset.delete({ where: { id: preset.id } });
            await db.machine.deleteMany({ where: { id: { in: [controller.id, guest.id] } } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it('uses the exact recovery-census custody snapshot without predicate locks', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, active: true, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'before', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const forward = vi.spyOn(eventRouter, 'forwardServerOwnedRpc').mockResolvedValue({ ok: true, result: { kind: 'requesters', accountIds: [], coverage: 'complete' } });
        const read = () => recoverMachineAccessLossCustody({ machineId: machine.id,
            expectedCustodianAccountId: owner.id, expectedInstallationId: machine.installationId! });
        try {
            const captured = await acrossCommit({ model: 'machine', method: 'findMany', read, write: tx =>
                tx.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } }) });
            expect(forward.mock.calls[0]?.[0]).toMatchObject({ machineAdmission: { installationId: machine.installationId } });
            forward.mockClear();
            await read();
            expect(forward).not.toHaveBeenCalled();
            expect(captured.observed).toEqual({ locks: 0, readOnly: 'on' });
        } finally {
            forward.mockRestore();
            await db.machine.delete({ where: { id: machine.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });

    it('keeps managed policy review and controller custody coherent without predicate locks', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: '{}', installationId: randomUUID() } });
        const rowId = randomUUID();
        const input = { homeId, managedId: rowId, expectedIntentRevision: 0, requestId: randomUUID(),
            controller: { machineId: controller.id, installationId: controller.installationId! }, purpose: { kind: 'retention' as const } };
        const launch = { provider: { pluginId: 'fixture.setup', localId: 'vm' }, schemaVersion: 1, name: 'before', choices: {} };
        await db.managedMachine.create({ data: { id: rowId, homeId, custodianAccountId: owner.id,
            controllerMachineId: controller.id, controllerInstallationId: controller.installationId!, admittedActionRequestId: randomUUID(),
            admittedInput: { currentAdmission: { kind: 'policy', request: input } }, launch,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } });
        const read = () => prepareManagedPolicy({ custodianAccountId: owner.id, input });
        try {
            const captured = await acrossCommit({ model: 'managedMachine', method: 'findFirst', read, write: async tx => {
                await tx.managedMachine.update({ where: { id: rowId }, data: { launch: { ...launch, name: 'after' } } });
                await tx.machine.update({ where: { id: controller.id }, data: { revokedAt: new Date() } });
            } });
            expect(captured.result).toMatchObject({ machine: { id: rowId, launch: { name: 'before' } } });
            await expect(read()).rejects.toMatchObject({ code: 'controller_retired' });
            expect(captured.observed).toEqual({ locks: 0, readOnly: 'on' });
        } finally {
            await db.managedMachine.delete({ where: { id: rowId } });
            await db.machine.delete({ where: { id: controller.id } });
            await db.account.delete({ where: { id: owner.id } });
        }
    });
});
