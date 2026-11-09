import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';
import tweetnacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'privacy-kit';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachineReadBatchResponseV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { inReadSnapshot } from '@/storage/inTx';
import { resolveEffectiveMachineAccessForMachinesInTx } from '@/app/machines/machineAccess';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { machinesRoutes } from './machinesRoutes';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Machine opening acquisition SQL (PostgreSQL)', () => {
    const statements: Prisma.QueryEvent[] = [];
    const selectedContent: { rows: number; bytes: number }[] = [];
    let client: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        client.$on('query', event => statements.push(event));
        await client.$connect();
    });
    afterAll(async () => { await client?.$disconnect(); await shutdownDbClient(); });

    const headers = (accountId: string) => ({ 'x-test-user-id': accountId, 'x-happier-account-stored-content-protocol': '4' });
    const contentBytes = (row: Readonly<{ metadata: string; daemonState: string | null; dataEncryptionKey: Uint8Array | null }>) =>
        Buffer.byteLength(row.metadata) + Buffer.byteLength(row.daemonState ?? '') + (row.dataEncryptionKey?.byteLength ?? 0);

    function tracedTransport() {
        // This transparent persistent-DB boundary measures actual returned content,
        // not response bytes or a SQL-text estimate. Policy and serialization stay real.
        return client.$extends({ query: { machine: { async $allOperations({ args, query }) {
            const result = await query(args);
            if (Array.isArray(result)) {
                let rows = 0;
                let bytes = 0;
                for (const row of result) {
                    if (typeof row === 'object' && row !== null && 'metadata' in row && typeof row.metadata === 'string') {
                        rows++;
                        bytes += Buffer.byteLength(row.metadata);
                        if ('daemonState' in row && typeof row.daemonState === 'string') bytes += Buffer.byteLength(row.daemonState);
                        if ('dataEncryptionKey' in row && row.dataEncryptionKey instanceof Uint8Array) bytes += row.dataEncryptionKey.byteLength;
                    }
                }
                if (rows) selectedContent.push({ rows, bytes });
            }
            return result;
        } } } });
    }

    async function fixture(mode: 'plain' | 'e2ee', count: number, contentRepeats = 1024) {
        const ownerKeys = tweetnacl.box.keyPair();
        const recipientKeys = tweetnacl.box.keyPair();
        const owner = await db.account.create({ data: { ...(mode === 'e2ee' ? createSignedAccountContentBinding(ownerKeys.publicKey) : {}), encryptionMode: mode, name: 'Custodian' } });
        const recipient = await db.account.create({ data: { ...createSignedAccountContentBinding(recipientKeys.publicKey), encryptionMode: 'e2ee' } });
        const dataKey = tweetnacl.randomBytes(32);
        const ownerEnvelope = new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: ownerKeys.publicKey, randomBytes: tweetnacl.randomBytes }));
        const recipientEnvelope = new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: recipientKeys.publicKey, randomBytes: tweetnacl.randomBytes }));
        const content = mode === 'plain' ? {
            metadata: encodePlainMachineStoredContent({ host: 'workstation', platform: 'linux', happyCliVersion: '0.3.0', homeDir: '/home/alice', happyHomeDir: '/home/alice/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        } : {
            metadata: encodeBase64(new Uint8Array(tweetnacl.secretbox(new TextEncoder().encode('machine metadata'.repeat(contentRepeats)), tweetnacl.randomBytes(24), dataKey))),
            daemonState: encodeBase64(new Uint8Array(tweetnacl.secretbox(new TextEncoder().encode('daemon state'.repeat(contentRepeats)), tweetnacl.randomBytes(24), dataKey))),
            dataEncryptionKey: ownerEnvelope,
        };
        const ids = Array.from({ length: count }, () => randomUUID());
        await db.machine.createMany({ data: ids.map((id, index) => ({ id, accountId: owner.id, ...content,
            installationId: `installation-${id}`, seq: index + 1, metadataVersion: 3, daemonStateVersion: 5,
            active: index % 2 === 0, lastActiveAt: new Date(1000 + index),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 2,
        })) });
        await db.machineAccountGrant.createMany({ data: ids.map(machineId => ({ machineId, accountId: recipient.id, accessLevel: 'view', createdByAccountId: owner.id })) });
        if (mode === 'e2ee') await db.machineKeyEnvelope.createMany({ data: ids.map(machineId => ({ machineId,
            recipientAccountId: recipient.id, encryptedDataKey: recipientEnvelope,
            machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(ownerEnvelope),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipientKeys.publicKey),
        })) });
        return { owner, recipient, ids, content, ownerEnvelope, recipientEnvelope };
    }

    it.each([
        { mode: 'plain', owned: true }, { mode: 'plain', owned: false },
        { mode: 'e2ee', owned: true }, { mode: 'e2ee', owned: false },
    ] as const)('acquires $mode owned=$owned content once for exact GET and a 128-Machine batch', async ({ mode, owned }) => {
        const data = await fixture(mode, 128);
        const actor = owned ? data.owner : data.recipient;
        const originalTransaction = db.$transaction;
        const traced = tracedTransport();
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
        try {
            await withAuthenticatedTestApp(machinesRoutes, async app => {
                const measure = async (ids: string[], exact: boolean) => {
                    statements.length = 0;
                    selectedContent.length = 0;
                    const response = await app.inject({ method: exact ? 'GET' : 'POST',
                        url: exact ? `/v1/machines/${ids[0]}` : '/v1/machines/read-batch', headers: headers(actor.id),
                        ...(exact ? {} : { payload: { machineIds: ids } }),
                    });
                    expect(response.statusCode, response.body).toBe(200);
                    const machines = exact ? [response.json().machine] : MachineReadBatchResponseV1Schema.parse(response.json()).results.map(result => {
                        expect(result.status).toBe('found');
                        if (result.status !== 'found') throw new Error('Expected accessible Machine');
                        return result.machine;
                    });
                    expect(machines.map(machine => machine.id)).toEqual(ids);
                    for (const machine of machines) {
                        expect(machine).toMatchObject({ metadata: data.content.metadata, daemonState: data.content.daemonState,
                            metadataVersion: 3, daemonStateVersion: 5, installationId: `installation-${machine.id}`,
                            operationProtocolCapabilitiesRevision: 2, operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } },
                            access: { custodian: { accountId: data.owner.id, displayName: 'Custodian' }, role: owned ? 'manage' : 'use', resourceMode: mode, accessState: 'ready' },
                            dataEncryptionKey: mode === 'plain' ? owned ? MACHINE_PLAIN_DATA_KEY_MARKER : null : encodeBase64(owned ? data.ownerEnvelope : data.recipientEnvelope),
                        });
                        expect(machine.keyBasis).toEqual({ dataEncryptionKey: encodeBase64(data.content.dataEncryptionKey), metadataVersion: 3, daemonStateVersion: 5 });
                    }
                    const selects = statements.filter(event => /^SELECT\b/i.test(event.query));
                    const machineContentSelects = selects.filter(event => /FROM "(?:public"\.")?Machine"(?:\s|$)/.test(event.query)
                        && event.query.includes('"metadata"'));
                    return { machines, statements: statements.length, selects: selects.length, machineContentSelects: machineContentSelects.length,
                        machineContentBindings: machineContentSelects.map(event => (JSON.parse(event.params) as unknown[]).length),
                        maxBindings: Math.max(...statements.map(event => (JSON.parse(event.params) as unknown[]).length)),
                        selectedRows: selectedContent.reduce((sum, read) => sum + read.rows, 0), selectedBytes: selectedContent.reduce((sum, read) => sum + read.bytes, 0) };
                };
                const one = await measure([data.ids[0]!], true);
                const many = await measure(data.ids, false);
                expect(many.machines[0]).toEqual(one.machines[0]);
                console.info('MACHINE_OPENING_SQL', JSON.stringify({ mode, owned, machines: data.ids.length,
                    one: { ...one, machines: undefined }, many: { ...many, machines: undefined }, expectedBytesPerMachine: contentBytes(data.content) }));
                expect.soft(one.machineContentSelects).toBe(1);
                expect.soft(many.machineContentSelects).toBe(1);
                expect.soft(many.selects).toBe(one.selects);
                expect.soft(one.selectedRows).toBe(1);
                expect.soft(many.selectedRows).toBe(data.ids.length);
                expect.soft(one.selectedBytes).toBe(contentBytes(data.content));
                expect.soft(many.selectedBytes).toBe(data.ids.length * contentBytes(data.content));
            });
        } finally { db.$transaction = originalTransaction; }
    });

    it('keeps an inventory-sized role map and opening read within the portable SQL bind boundary', async () => {
        const data = await fixture('e2ee', 1100, 1);
        const homeId = await getOrCreateServerIdentityId();
        await db.managedMachine.createMany({ data: data.ids.map(enrolledMachineId => ({
            homeId, custodianAccountId: data.owner.id, controllerMachineId: data.ids[0]!, controllerInstallationId: `installation-${data.ids[0]}`,
            enrolledMachineId, admittedActionRequestId: randomUUID(), admittedInput: {}, allocation: 'bound',
            launch: { provider: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'fixture.compute', localId: 'vm' }, schemaVersion: 1, value: {} },
            desired: 'stop', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true,
        })) });
        const originalTransaction = db.$transaction;
        const traced = tracedTransport();
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args) {
            return Reflect.apply(traced.$transaction, traced, args);
        } });
        try {
            statements.length = 0;
            const missing = randomUUID();
            const ids = [...data.ids, data.ids[0]!, missing];
            const roles = await inReadSnapshot(tx => resolveEffectiveMachineAccessForMachinesInTx(tx, {
                machineIds: ids, accountIds: [data.owner.id, data.recipient.id],
            }));
            expect([...roles.keys()]).toEqual([...data.ids, missing]);
            for (const machineId of data.ids) expect([...roles.get(machineId)!.values()]).toEqual(['manage', 'use']);
            expect([...roles.get(missing)!.values()]).toEqual([null, null]);
            const roleReads = statements.filter(event => /^SELECT\b/i.test(event.query));
            const roleBindings = roleReads.map(event => (JSON.parse(event.params) as unknown[]).length);
            console.info('MACHINE_ROLE_BIND_SQL', JSON.stringify({ machines: roles.size, selects: roleReads.length, bindings: roleBindings }));
            expect.soft(roleReads).toHaveLength(2);
            expect.soft(Math.max(...roleBindings)).toBeLessThanOrEqual(999);
            statements.length = 0;
            const singletonRoles = await inReadSnapshot(tx => resolveEffectiveMachineAccessForMachinesInTx(tx, {
                machineIds: ids, accountIds: [data.recipient.id],
            }));
            expect([...singletonRoles.keys()]).toEqual([...roles.keys()]);
            for (const machineId of singletonRoles.keys()) {
                expect(singletonRoles.get(machineId)?.get(data.recipient.id)).toBe(roles.get(machineId)?.get(data.recipient.id));
            }
            const singletonRoleReads = statements.filter(event => /^SELECT\b/i.test(event.query));
            const singletonRoleBindings = singletonRoleReads.map(event => (JSON.parse(event.params) as unknown[]).length);
            console.info('MACHINE_SINGLETON_ROLE_BIND_SQL', JSON.stringify({ machines: singletonRoles.size,
                selects: singletonRoleReads.length, bindings: singletonRoleBindings }));
            expect.soft(singletonRoleReads).toHaveLength(2);
            expect.soft(Math.max(...singletonRoleBindings)).toBeLessThanOrEqual(999);
            await withAuthenticatedTestApp(machinesRoutes, async app => {
                statements.length = 0;
                selectedContent.length = 0;
                const response = await app.inject({ method: 'POST', url: '/v1/machines/read-batch', headers: headers(data.recipient.id), payload: { machineIds: ids } });
                expect(response.statusCode, response.body).toBe(200);
                const results = MachineReadBatchResponseV1Schema.parse(response.json()).results;
                expect(results).toHaveLength(data.ids.length + 1);
                expect(results.slice(0, -1).every(result => result.status === 'found' && result.machine.access?.accessState === 'ready')).toBe(true);
                expect(results.at(-1)).toEqual({ machineId: missing, status: 'not_found' });
                const bindings = statements.map(event => (JSON.parse(event.params) as unknown[]).length);
                console.info('MACHINE_OPENING_BIND_SQL', JSON.stringify({ machines: data.ids.length,
                    selects: statements.filter(event => /^SELECT\b/i.test(event.query)).length, maxBindings: Math.max(...bindings),
                    selectedRows: selectedContent.reduce((sum, read) => sum + read.rows, 0) }));
                expect.soft(Math.max(...bindings)).toBeLessThanOrEqual(999);
                expect.soft(selectedContent.reduce((sum, read) => sum + read.rows, 0)).toBe(data.ids.length);
            });
        } finally { db.$transaction = originalTransaction; }
    });

    it('keeps exact and batch denial, key readiness, mode and fresh-grant decisions aligned', async () => {
        const data = await fixture('e2ee', 7);
        const [ready, missingKey, staleKey, revoked, replaced, runner, wrongMode] = data.ids;
        await db.machineKeyEnvelope.deleteMany({ where: { machineId: missingKey } });
        await db.machineKeyEnvelope.updateMany({ where: { machineId: staleKey }, data: { machineOwnerEnvelopeFingerprint: 'stale' } });
        await db.machine.update({ where: { id: revoked! }, data: { revokedAt: new Date() } });
        await db.machine.update({ where: { id: replaced! }, data: { replacedByMachineId: ready } });
        await db.machine.update({ where: { id: runner! }, data: { kind: 'ephemeral_session_runner' } });
        await db.machine.update({ where: { id: wrongMode! }, data: { metadata: encodePlainMachineStoredContent({ host: 'wrong-mode' }) } });
        const missing = randomUUID();
        const unrelated = await db.machine.create({ data: { id: randomUUID(), accountId: data.owner.id, ...data.content } });
        await withAuthenticatedTestApp(machinesRoutes, async app => {
            const ids = [ready!, missingKey!, staleKey!, revoked!, replaced!, runner!, wrongMode!, unrelated.id, missing];
            const batch = await app.inject({ method: 'POST', url: '/v1/machines/read-batch', headers: headers(data.recipient.id), payload: { machineIds: [...ids, ready!] } });
            expect(batch.statusCode, batch.body).toBe(200);
            const results = MachineReadBatchResponseV1Schema.parse(batch.json()).results;
            expect(results.map(result => result.machineId)).toEqual(ids);
            for (const result of results) {
                const exact = await app.inject({ method: 'GET', url: `/v1/machines/${result.machineId}`, headers: headers(data.recipient.id) });
                if (result.status === 'found') {
                    expect(exact.statusCode, exact.body).toBe(200);
                    expect(result.machine).toEqual(exact.json().machine);
                    if (result.machineId !== ready) expect(result.machine).toMatchObject({ metadata: null, daemonState: null, dataEncryptionKey: null,
                        access: { accessState: result.machineId === wrongMode ? 'refused' : 'key_pending' } });
                } else expect(exact.statusCode).toBe(404);
            }
            expect(results.filter(result => result.status === 'found').map(result => result.machineId)).toEqual([ready, missingKey, staleKey, wrongMode]);
            await db.machineAccountGrant.deleteMany({ where: { machineId: ready, accountId: data.recipient.id } });
            const withdrawn = await app.inject({ method: 'POST', url: '/v1/machines/read-batch', headers: headers(data.recipient.id), payload: { machineIds: [ready!] } });
            expect(withdrawn.json()).toEqual({ results: [{ machineId: ready, status: 'not_found' }] });
            const plain = await db.account.create({ data: { encryptionMode: 'plain' } });
            await db.machineAccountGrant.create({ data: { machineId: staleKey!, accountId: plain.id, accessLevel: 'view', createdByAccountId: data.owner.id } });
            const incompatible = await app.inject({ method: 'POST', url: '/v1/machines/read-batch', headers: headers(plain.id), payload: { machineIds: [staleKey!] } });
            expect(incompatible.json()).toMatchObject({ results: [{ status: 'found', machine: {
                metadata: null, daemonState: null, dataEncryptionKey: null, access: { accessState: 'refused' },
            } }] });
            await db.account.update({ where: { id: data.recipient.id }, data: { status: 'suspended' } });
            const suspended = await app.inject({ method: 'POST', url: '/v1/machines/read-batch', headers: headers(data.recipient.id), payload: { machineIds: [missingKey!] } });
            expect(suspended.json()).toEqual({ results: [{ machineId: missingKey, status: 'not_found' }] });
        });
    });
});
