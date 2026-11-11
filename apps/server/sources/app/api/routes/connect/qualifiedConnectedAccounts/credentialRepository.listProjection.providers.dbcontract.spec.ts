import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { db, initDbMysql, initDbPostgres } from '@/storage/db';
import { initEncrypt } from '@/modules/encrypt';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { QualifiedConnectedAccountMultiServiceListResponseV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { registerQualifiedConnectedAccountCredentialRoutesV4 } from './registerQualifiedConnectedAccountCredentialRoutesV4';
import { createQualifiedConnectedAccountIdentityDigest } from './identity';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import {
    listAllQualifiedConnectedAccountsInTx,
    listQualifiedConnectedAccountsInTx,
    listQualifiedConnectedAccountSourceOffersInTx,
    mutateQualifiedConnectedServiceCredential,
} from './credentialRepository';

const service = { pluginId: 'fixture.list-projection', localId: 'accounts' };
const externalProvider = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL ? 'postgres'
    : process.env.HAPPIER_TEST_MYSQL_DATABASE_URL ? 'mysql' : null;

describe('qualified Connected Account list payload admission', () => {
    let harness: LightSqliteHarness | undefined;
    let previousMasterSecret: string | undefined;
    const ownedAccounts: string[] = [];
    beforeAll(async () => {
        if (externalProvider === null) {
            harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-list-projection-', initEncrypt: true });
        } else {
            const testUrl = externalProvider === 'postgres'
                ? process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL : process.env.HAPPIER_TEST_MYSQL_DATABASE_URL;
            if (process.env.DATABASE_URL !== testUrl) throw new Error('Use the disposable DB-contract harness');
            previousMasterSecret = process.env.HANDY_MASTER_SECRET;
            process.env.HANDY_MASTER_SECRET ??= 'perf-c199-synthetic-contract';
            await initEncrypt();
            if (externalProvider === 'postgres') initDbPostgres();
            else await initDbMysql();
            await db.$connect();
        }
    }, 120_000);
    afterAll(async () => {
        if (harness) await harness.close();
        else {
            await db.$disconnect();
            if (previousMasterSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
            else process.env.HANDY_MASTER_SECRET = previousMasterSecret;
        }
    });
    afterEach(async () => {
        await db.account.deleteMany({ where: { id: { in: ownedAccounts.splice(0) } } });
    });

    async function createAccount() {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        ownedAccounts.push(account.id);
        return account;
    }

    async function createCredential(accountId: string, profileId: string, configured = true, localId = service.localId) {
        const ref = { service: { ...service, localId }, accountId: profileId };
        const result = await mutateQualifiedConnectedServiceCredential({
            accountId, ref, authenticationModeId: 'api-key', expectedCredentialRevision: null,
            content: { t: 'plain', v: { token: 'synthetic-token'.repeat(512) } },
            metadata: { displayName: profileId, scopes: ['account.read'] },
            ...(configured ? { initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: { t: 'plain' as const, v: { region: 'eu' } },
            } } : {}),
        });
        if (result.status !== 'written') throw new Error('Expected synthetic credential');
        return { ref, ...result };
    }

    it('uses provider email instead of an opaque account id stored as the display name in share-source offers', async () => {
        const account = await createAccount();
        const opaqueId = '35f1d8ec-633c-4bda-9e0d-7055ac95b8af';
        const ref = { service, accountId: opaqueId };
        await mutateQualifiedConnectedServiceCredential({
            accountId: account.id, ref, authenticationModeId: 'api-key', expectedCredentialRevision: null,
            content: { t: 'plain', v: { token: 'synthetic-token' } },
            metadata: { displayName: opaqueId, providerIdentity: { email: 'ada@example.com' }, scopes: [] },
        });
        const offers = await listQualifiedConnectedAccountSourceOffersInTx(db, { accountId: account.id });
        expect(offers).toContainEqual(expect.objectContaining({ ref, label: 'ada@example.com' }));
        expect(offers.map(offer => offer.label)).not.toContain(opaqueId);
    });

    it('reads one body-free row set for a filtered list while preserving profile facts and all-list consumers', async () => {
        const account = await createAccount();
        const outsider = await createAccount();
        const created = [];
        for (let index = 0; index < 32; index++) {
            created.push(await createCredential(account.id, `profile-${index.toString().padStart(2, '0')}`, index % 2 === 0));
        }
        await createCredential(account.id, 'other-service', true, 'other');
        await createCredential(outsider.id, 'other-account');
        const expiresAt = new Date('2026-10-25T13:00:00Z');
        const lastUsedAt = new Date('2026-10-24T12:00:00Z');
        await db.serviceAccountToken.updateMany({ where: { accountId: account.id }, data: { expiresAt, lastUsedAt } });

        const readColumns: string[][] = [];
        async function capture(query: PromiseLike<unknown>) {
            const rows = await query;
            if (!Array.isArray(rows)) throw new Error('Expected a database row set');
            readColumns.push(rows.flatMap(row => Object.keys(row)));
            return rows;
        }
        // Observe the real ORM/raw database boundary, without replacing internal
        // admission or query execution. Captured values are synthetic fixtures.
        const storage = new Proxy(db, { get(target, property, receiver) {
            if (property === '$queryRaw') return (...args: unknown[]) => capture(Reflect.apply(target.$queryRaw, target, args));
            if (property !== 'serviceAccountToken') return Reflect.get(target, property, receiver);
            return new Proxy(target.serviceAccountToken, { get(delegate, method, delegateReceiver) {
                if (method !== 'findMany') return Reflect.get(delegate, method, delegateReceiver);
                return (...args: unknown[]) => capture(Reflect.apply(delegate.findMany, delegate, args));
            } });
        } });
        const profiles = await listQualifiedConnectedAccountsInTx(storage, { accountId: account.id, service });
        expect(readColumns).toHaveLength(1);
        expect(readColumns.flat().filter(column => column === 'token' || column === 'configurationContent')).toHaveLength(0);
        expect(profiles).toEqual(created.map(row => expect.objectContaining({
            ref: row.ref, displayName: row.ref.accountId, scopes: ['account.read'],
            credentialRevision: row.credentialRevision, configurationRevision: row.configurationRevision,
            configurationReady: row.configurationRevision !== null, expiresAt: expiresAt.getTime(), lastUsedAt: lastUsedAt.getTime(),
        })));
        const all = await listAllQualifiedConnectedAccountsInTx(storage, { accountId: account.id });
        expect(all).toHaveLength(33);
        expect(all.filter(profile => profile.ref.service.localId === service.localId)).toEqual(profiles);
        expect(await listQualifiedConnectedAccountSourceOffersInTx(storage, { accountId: account.id }))
            .toEqual(all.map(profile => expect.objectContaining({ ref: profile.ref, label: profile.ref.service.localId === 'other' ? 'Other' : 'Accounts' })));
        expect(readColumns).toHaveLength(3);
        expect(readColumns.flat().filter(column => column === 'token' || column === 'configurationContent')).toHaveLength(0);
    });

    it('selects an explicit service set in one body-free statement, including an empty set', async () => {
        const account = await createAccount();
        const outsider = await createAccount();
        const services = [service, { ...service, localId: 'second' }];
        await createCredential(account.id, 'first');
        await createCredential(account.id, 'second', true, 'second');
        await createCredential(account.id, 'unrelated', true, 'unrelated');
        await createCredential(outsider.id, 'outsider');
        const expected = (await Promise.all(services.map(selected => listQualifiedConnectedAccountsInTx(db, {
            accountId: account.id, service: selected,
        })))).flat().sort((a, b) => a.ref.accountId.localeCompare(b.ref.accountId));
        const readColumns: string[][] = [];
        const readRowCounts: number[] = [];
        const storage = new Proxy(db, { get(target, property, receiver) {
            if (property !== '$queryRaw') return Reflect.get(target, property, receiver);
            return async (...args: unknown[]) => {
                const rows: unknown = await Reflect.apply(target.$queryRaw, target, args);
                if (!Array.isArray(rows)) throw new Error('Expected a database row set');
                readColumns.push(rows.flatMap(row => Object.keys(row)));
                readRowCounts.push(rows.length);
                return rows;
            };
        } });
        expect(await listQualifiedConnectedAccountsInTx(storage, { accountId: account.id, services })).toEqual(expected);
        expect(readColumns).toHaveLength(1);
        expect(readRowCounts).toEqual([expected.length]);
        expect(readColumns.flat()).not.toContain('token');
        expect(readColumns.flat()).not.toContain('configurationContent');
        expect(await listQualifiedConnectedAccountsInTx(storage, { accountId: account.id, services: [] })).toEqual([]);
        expect(readColumns).toHaveLength(2);
        expect(readRowCounts).toEqual([expected.length, 0]);
    });

    it('selects exact qualified refs without inventory rows or exceeding the portable SQL bind boundary', async () => {
        const account = await createAccount();
        const outsider = await createAccount();
        const first = await createCredential(account.id, 'first');
        const second = await createCredential(account.id, 'second', false, 'second');
        await createCredential(account.id, 'first', false, 'unrelated-service');
        await createCredential(outsider.id, 'first');
        const sample = await db.serviceAccountToken.findFirstOrThrow({ where: {
            accountId: account.id, qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(first.ref),
        } });
        await db.serviceAccountToken.createMany({ data: Array.from({ length: 1024 }, (_, index) => {
            const ref = { service: first.ref.service, accountId: `unrelated-${index}` };
            return { ...sample, id: `${account.id}-unrelated-${index}`, connectedAccountId: ref.accountId,
                qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(ref) };
        }) });
        const expected = (await listAllQualifiedConnectedAccountsInTx(db, { accountId: account.id }))
            .filter(profile => profile.credentialRevision === first.credentialRevision || profile.credentialRevision === second.credentialRevision)
            .filter(profile => profile.ref.accountId === 'first' && profile.ref.service.localId === service.localId
                || profile.ref.accountId === 'second' && profile.ref.service.localId === 'second');
        const rowCounts: number[] = [];
        const bindCounts: number[] = [];
        const storage = new Proxy(db, { get(target, property, receiver) {
            if (property !== '$queryRaw') return Reflect.get(target, property, receiver);
            return async (...args: unknown[]) => {
                const rows: unknown = await Reflect.apply(target.$queryRaw, target, args);
                if (!Array.isArray(rows)) throw new Error('Expected a database row set');
                rowCounts.push(rows.length);
                const query = args[0];
                if (!query || typeof query !== 'object') throw new Error('Expected bound SQL');
                bindCounts.push(Reflect.get(query, 'values').length);
                expect(rows.flatMap(row => Object.keys(row))).not.toContain('token');
                expect(rows.flatMap(row => Object.keys(row))).not.toContain('configurationContent');
                return rows;
            };
        } });
        // Beyond PostgreSQL's 32,767 bind boundary. Only the storage-owned
        // transport chunks bound each statement; no requested ref is dropped.
        const refs = [first.ref, first.ref, ...Array.from({ length: 35_000 }, (_, index) => ({
            service, accountId: `missing-${index}`,
        })), second.ref];
        const profiles = await listQualifiedConnectedAccountsInTx(storage, { accountId: account.id, refs });
        const chunks = portableQueryChunks({ values: [...new Set(refs.map(createQualifiedConnectedAccountIdentityDigest))], bindingsPerValue: 1, fixedBindings: 1 });
        expect(rowCounts).toEqual(chunks.map((_, index) => index === 0 || index === chunks.length - 1 ? 1 : 0));
        expect(bindCounts).toEqual(chunks.map(chunk => chunk.length + 1));
        expect(profiles).toEqual(expected);
        expect(await listQualifiedConnectedAccountsInTx(storage, { accountId: account.id, refs: [] })).toEqual([]);
        expect(rowCounts).toHaveLength(chunks.length);
    });

    it('serves multi-service projections through the real route and refuses malformed or mixed selectors', async () => {
        const account = await createAccount();
        const outsider = await createAccount();
        const services = [service, { ...service, localId: 'second' }];
        await createCredential(account.id, 'first');
        await createCredential(account.id, 'second', false, 'second');
        await createCredential(account.id, 'unrelated', true, 'unrelated');
        await createCredential(outsider.id, 'outsider');
        const expected = (await Promise.all(services.map(selected => listQualifiedConnectedAccountsInTx(db, {
            accountId: account.id, service: selected,
        })))).flat().sort((a, b) => a.ref.accountId.localeCompare(b.ref.accountId));
        const originalQueryRaw = db.$queryRaw;
        const readColumns: string[][] = [];
        // Observe the real SQL boundary while preserving the default route →
        // repository wiring and all real internal projection/validation logic.
        db.$queryRaw = new Proxy(originalQueryRaw, { async apply(target, receiver, args: unknown[]) {
            const rows: unknown = await Reflect.apply(target, receiver, args);
            if (!Array.isArray(rows)) throw new Error('Expected a database row set');
            readColumns.push(rows.flatMap(row => Object.keys(row)));
            return rows;
        } });
        try {
            await withAuthenticatedTestApp(registerQualifiedConnectedAccountCredentialRoutesV4, async app => {
                const headers = { 'x-test-user-id': account.id };
                const request = (query: URLSearchParams) => app.inject({ method: 'GET',
                    url: `/v4/connect/qualified/accounts?${query}`, headers });
                const response = await request(new URLSearchParams({ services: JSON.stringify(services) }));
                expect(response.statusCode, response.body).toBe(200);
                expect(QualifiedConnectedAccountMultiServiceListResponseV4Schema.parse(response.json())).toEqual({ services, accounts: expected });
                expect(readColumns).toHaveLength(1);
                expect(readColumns.flat()).not.toContain('token');
                expect(readColumns.flat()).not.toContain('configurationContent');
                const selectedRefs = expected.slice(0, 1).map(profile => profile.ref);
                const selected = await request(new URLSearchParams({ accounts: JSON.stringify(selectedRefs) }));
                expect(selected.statusCode, selected.body).toBe(200);
                expect(selected.json()).toEqual({ accounts: expected.slice(0, 1) });
                expect(readColumns).toHaveLength(2);
                expect(readColumns[1]).not.toContain('token');
                expect(readColumns[1]).not.toContain('configurationContent');
                const stranger = await app.inject({ method: 'GET',
                    url: `/v4/connect/qualified/accounts?${new URLSearchParams({ accounts: JSON.stringify(selectedRefs) })}`,
                    headers: { 'x-test-user-id': outsider.id } });
                expect(stranger.statusCode, stranger.body).toBe(200);
                expect(stranger.json()).toEqual({ accounts: [] });
                const emptyRefs = await request(new URLSearchParams({ accounts: '[]' }));
                expect(emptyRefs.statusCode, emptyRefs.body).toBe(200);
                expect(emptyRefs.json()).toEqual({ accounts: [] });
                const empty = await request(new URLSearchParams({ services: '[]' }));
                expect(empty.statusCode, empty.body).toBe(200);
                expect(empty.json()).toEqual({ services: [], accounts: [] });
                const beforeInvalid = readColumns.length;
                for (const query of [
                    new URLSearchParams({ service: JSON.stringify(service), services: JSON.stringify(services) }),
                    new URLSearchParams({ service: JSON.stringify(service), accounts: JSON.stringify(selectedRefs) }),
                    new URLSearchParams({ services: JSON.stringify(services), accounts: JSON.stringify(selectedRefs) }),
                    new URLSearchParams({ accounts: JSON.stringify([{ ...selectedRefs[0], unexpected: true }]) }),
                    new URLSearchParams({ accounts: JSON.stringify(selectedRefs[0]) }),
                    new URLSearchParams([['accounts', '[]'], ['accounts', '[]']]),
                    new URLSearchParams({ services: JSON.stringify([{ ...service, unexpected: true }]) }),
                    new URLSearchParams({ services: JSON.stringify(service) }),
                    new URLSearchParams({ services: '[' }),
                    new URLSearchParams([['services', '[]'], ['services', '[]']]),
                    new URLSearchParams(),
                ]) {
                    expect((await request(query)).statusCode).toBe(400);
                }
                expect(readColumns).toHaveLength(beforeInvalid);
            });
        } finally {
            db.$queryRaw = originalQueryRaw;
        }
    });

    // Only SQLite has a connection-local check-constraint bypass. The same
    // admission branch sees both invalid states here; other providers enforce
    // the constraint and exercise configured/unconfigured rows above.
    it.skipIf(externalProvider !== null).each(['content', 'revision'] as const)('rejects a missing configuration %s without reading its body', async missing => {
        const account = await createAccount();
        await createCredential(account.id, 'inconsistent');
        await db.$executeRawUnsafe('PRAGMA ignore_check_constraints = ON');
        try {
            await db.serviceAccountToken.updateMany({ where: { accountId: account.id }, data:
                missing === 'content' ? { configurationContent: null } : { configurationRevision: null } });
        } finally {
            await db.$executeRawUnsafe('PRAGMA ignore_check_constraints = OFF');
        }
        await expect(listQualifiedConnectedAccountsInTx(db, { accountId: account.id, service }))
            .rejects.toThrow(/configuration sidecar is incomplete/);
    });
});
