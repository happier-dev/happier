// Cross-package composition runs in the DB harness, outside the server-only compiler roots.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import type { Prisma } from '@prisma/client';
import { createDbMaintenanceClient, db, initDbPostgres } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerProjectAccountRowRoutes } from '@/app/api/routes/projects/registerProjectAccountRowRoutes';
import { encodeAccountScopedKvJson } from '@/app/kv/accountScopedKv';
import { decodeBase64 } from 'privacy-kit';
import { buildProjectAccountRowPhysicalKeyV1, type ProjectAccountRowKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedRowV1Schema } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { listProjectAccountRowsInTx } from './projectAccountRowService';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { onDbClientQuery, type PrismaClientType } from '@/storage/prisma';

function sqlBindCount(statement: string) {
    return [...statement.matchAll(/\$(\d+)/g)].reduce((count, match) => Math.max(count, Number(match[1])), 0);
}

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Project row narrow read costs (PostgreSQL)', () => {
    let client: PrismaClientType;
    let originalTransaction: typeof db.$transaction;
    const statements: Prisma.QueryEvent[] = [];
    let loadedRows = 0;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        client = await createDbMaintenanceClient('postgres', undefined, { log: [{ emit: 'event', level: 'query' }] });
        onDbClientQuery(client, event => statements.push(event));
        await client.$connect();
        originalTransaction = db.$transaction;
        // Instrument the genuine SQL boundary without substituting queries or admission.
        db.$transaction = new Proxy(originalTransaction, { apply(_target, _receiver, args: unknown[]) {
            const callback = args[0];
            if (typeof callback !== 'function') return Reflect.apply(client.$transaction, client, args);
            return Reflect.apply(client.$transaction, client, [async (tx: Tx) => callback(new Proxy(tx, {
                get(inner, property, receiver) {
                    if (property !== 'userKVStore') return Reflect.get(inner, property, receiver);
                    return new Proxy(inner.userKVStore, { get(delegate, method, delegateReceiver) {
                        const operation = Reflect.get(delegate, method, delegateReceiver);
                        if (method !== 'findMany') return operation;
                        return async (...parameters: unknown[]) => {
                            const rows: unknown = await Reflect.apply(operation, delegate, parameters);
                            if (!Array.isArray(rows)) throw new Error('Expected SQL rows');
                            loadedRows += rows.length;
                            return rows;
                        };
                    } });
                },
            })), ...args.slice(1)]);
        } });
    });
    afterAll(async () => {
        if (originalTransaction) db.$transaction = originalTransaction;
        await client?.$disconnect();
        await db.$disconnect();
    });

    it('selects literal encoded Home prefixes with the SQLite connector too', async () => {
        const sqlite = await createDbMaintenanceClient('sqlite', 'file::memory:?connection_limit=1');
        vi.stubEnv('HAPPIER_DB_PROVIDER', 'sqlite');
        try {
            await sqlite.$executeRawUnsafe('CREATE TABLE "Account" ("id" TEXT PRIMARY KEY, "encryptionMode" TEXT, "publicKey" TEXT, "contentPublicKey" BLOB, "contentPublicKeySig" BLOB)');
            await sqlite.$executeRawUnsafe('CREATE TABLE "UserKVStore" ("id" TEXT PRIMARY KEY, "accountId" TEXT, "key" TEXT, "version" INTEGER, "value" BLOB, "createdAt" DATETIME DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE ("accountId", "key"))');
            await sqlite.$executeRaw`INSERT INTO "Account" ("id", "encryptionMode") VALUES ('owner', 'plain')`;
            for (const serverId of ['home/a%', 'homeX2FaY25']) {
                const key = { kind: 'workspace-ref', serverId, id: 'needed' } as const;
                const value = decodeBase64(encodeAccountScopedKvJson({ t: 'plain', v: { key,
                    value: { id: key.id, serverId, machineId: 'a', rootPath: '/work/a', createdAtMs: 1 } } })!);
                await sqlite.$executeRaw`INSERT INTO "UserKVStore" ("id", "accountId", "key", "version", "value") VALUES (${serverId}, 'owner', ${buildProjectAccountRowPhysicalKeyV1(key)}, 0, ${value})`;
            }
            let readRows = 0;
            const result = await sqlite.$transaction(async tx => listProjectAccountRowsInTx(new Proxy(tx, {
                get(inner, property, receiver) {
                    if (property !== 'userKVStore') return Reflect.get(inner, property, receiver);
                    return new Proxy(inner.userKVStore, { get(delegate, method, delegateReceiver) {
                        const operation = Reflect.get(delegate, method, delegateReceiver);
                        if (method !== 'findMany') return operation;
                        return async (...parameters: unknown[]) => {
                            const rows: unknown = await Reflect.apply(operation, delegate, parameters);
                            if (!Array.isArray(rows)) throw new Error('Expected SQL rows');
                            readRows += rows.length;
                            return rows;
                        };
                    } });
                },
            }), { accountId: 'owner', kinds: ['workspace-ref'], serverId: 'home/a%' }));
            expect(result).toMatchObject({ status: 'listed', rows: [{ key: { serverId: 'home/a%' } }] });
            expect(readRows).toBe(1);
        } finally { vi.unstubAllEnvs(); await sqlite.$disconnect(); }
    });

    it('loads only matching rows through the filtered route and retains exact Account/envelope refusals', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const key = { kind: 'workspace-ref', serverId: 'home/a%', id: 'needed' } as const;
        const content = { t: 'plain', v: { key, value: { id: key.id, serverId: key.serverId,
            machineId: 'machine-a', rootPath: '/work/a', createdAtMs: 1 } } };
        const row = (key: ProjectAccountRowKeyV1, content: unknown) => ({ accountId: owner.id,
            key: buildProjectAccountRowPhysicalKeyV1(key), version: 0,
            value: decodeBase64(encodeAccountScopedKvJson(content)!) });
        await db.userKVStore.createMany({ data: [row(key, content), ...Array.from({ length: 1024 }, (_, index) => {
            const other = { kind: 'project-organization', serverId: key.serverId, projectKey: `unrelated-${index}` } as const;
            return row(other, { t: 'plain', v: { key: other, value: {} } });
        }), ...['other-home', 'homeX2FaY25'].map(serverId => row({ ...key, serverId }, { ...content,
            v: { key: { ...key, serverId }, value: { ...content.v.value, serverId } } }))] });
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            const read = (payload: object, accountId = owner.id, operation = 'list') => app.inject({ method: 'POST',
                url: `/v1/account/project-rows/${operation}`, headers: { 'x-test-user-id': accountId }, payload });
            loadedRows = 0;
            statements.length = 0;
            const selected = await read({ kinds: ['workspace-ref'], serverId: key.serverId });
            const cost = { fixtureRows: 1027, loadedRows, statements: statements.length,
                rowSelects: statements.filter(event => /^SELECT\b/i.test(event.query) && event.query.includes('"UserKVStore"')).length };
            const rowQuery = statements.find(event => /^SELECT\b/i.test(event.query) && event.query.includes('"UserKVStore"'))!;
            const distinctKindBinds = sqlBindCount(rowQuery.query);
            console.info('PROJECT_FILTERED_READ_COST', JSON.stringify(cost));
            expect(selected.statusCode).toBe(200);
            expect(selected.json()).toEqual({ status: 'listed', coverage: 'complete', rows: [{ key, revision: 0, content }] });
            expect.soft(cost.loadedRows).toBe(1);
            expect(cost.rowSelects).toBe(1);
            expect(cost.statements).toBeLessThanOrEqual(9);
            statements.length = 0;
            const repeated = await read({ kinds: Array.from({ length: 1024 }, () => 'workspace-ref'), serverId: key.serverId });
            expect(repeated.statusCode).toBe(200);
            const repeatedQuery = statements.find(event => /^SELECT\b/i.test(event.query) && event.query.includes('"UserKVStore"'))!;
            expect(sqlBindCount(repeatedQuery.query)).toBe(distinctKindBinds);
            expect(repeatedQuery.query.length).toBe(rowQuery.query.length);
            expect((await read({ kinds: ['workspace-ref'], serverId: key.serverId }, outsider.id)).json())
                .toEqual({ status: 'listed', rows: [], coverage: 'complete' });
            expect((await read({ key }, outsider.id, 'read')).json()).toEqual({ status: 'absent' });
            const session = { serverId: 'other-home', sessionId: 'authoring-session' };
            const recorded = await read({ key, session }, owner.id, 'authoring-session');
            expect(recorded.json()).toMatchObject({ status: 'recorded', row: { revision: 1, authoringSession: session } });
            const sequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            statements.length = 0;
            expect((await read({ key, session }, owner.id, 'authoring-session')).json()).toEqual(recorded.json());
            expect(statements.filter(event => /^(INSERT|UPDATE|DELETE)\b/i.test(event.query))).toHaveLength(0);
            expect(statements.filter(event => /^SELECT\b/i.test(event.query) && event.query.includes('"UserKVStore"'))).toHaveLength(1);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(sequence);
            expect((await read({ key, includeAuthoringSession: true }, owner.id, 'read')).json()).toMatchObject({ row: { authoringSession: session } });
            await db.userKVStore.update({ where: { accountId_key: { accountId: owner.id, key: buildProjectAccountRowPhysicalKeyV1(key) } },
                data: { value: row(key, { t: 'encrypted', c: 'wrong-mode' }).value } });
            expect((await read({ kinds: ['workspace-ref'], serverId: key.serverId })).json()).toEqual({ status: 'account-mode-mismatch' });
            expect((await read({ key }, owner.id, 'read')).json()).toEqual({ status: 'account-mode-mismatch' });
        });
    });

    it('prepares through the real CLI and HTTP row owners without organization census or serial endpoint reads', async () => {
        const { readWorkspaceSyncWorkerTargetSnapshot, prepareWorkspaceSyncBetween } = await import('../../../../cli/src/workspaces/sync/workspaceSyncPreparation');
        const { mutateProjectAccountOrganization, readProjectAccountRows, getActiveProjectAccountRowsSnapshot,
            withdrawActiveProjectAccountRowsSnapshot } = await import('../../../../cli/src/workspaces/projectAccountRows');
        const { resolveProjectSetupAcceptedWorkspace } = await import('../../../../cli/src/workspaces/projectSetup/projectSetupAcceptedWorkspace');
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const refs = ['a', 'b'].map(id => ({ id, serverId: 'home', machineId: `machine-${id}`, rootPath: `/work/${id}`,
            projectKey: 'project-a', createdAtMs: 1 }));
        const organizationKey = { kind: 'project-organization', serverId: 'home', projectKey: 'organization-0' } as const;
        const row = (key: ProjectAccountRowKeyV1, value: unknown) => ({ accountId: account.id,
            key: buildProjectAccountRowPhysicalKeyV1(key), version: 0,
            value: decodeBase64(encodeAccountScopedKvJson({ t: 'plain', v: { key, value } })!) });
        await db.userKVStore.createMany({ data: [...refs.map(value => row({ kind: 'workspace-ref', serverId: value.serverId, id: value.id }, value)),
            ...Array.from({ length: 1024 }, (_, index) => row({ ...organizationKey, projectKey: `organization-${index}` }, { pinned: true }))] });
        await withAuthenticatedTestApp(registerProjectAccountRowRoutes, async app => {
            const credentials = { token: 'test-project-reader', encryption: null };
            const latency = () => new Promise<void>(resolve => setTimeout(resolve, 20));
            let activeMachineReads = 0;
            let maxMachineReads = 0;
            const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                await latency();
                const response = await app.inject({ method: 'POST', url: new URL(url).pathname,
                    headers: { 'x-test-user-id': account.id }, payload: body });
                return { status: response.statusCode, data: response.json() };
            });
            const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url.endsWith('/v1/account/encryption')) {
                    await latency();
                    return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                }
                const id = url.slice(url.lastIndexOf('/') + 1);
                activeMachineReads += 1;
                maxMachineReads = Math.max(maxMachineReads, activeMachineReads);
                try {
                    await latency();
                    return { status: 200, data: { machine: { id, active: true, installationId: `${id}-installation`,
                        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
                        metadata: encodePlainMachineStoredContent({ host: id, platform: 'linux', homeDir: '/home/test', username: 'test',
                            happyCliVersion: 'test', happyHomeDir: '/home/test/.happier' }) } } };
                } finally { activeMachineReads -= 1; }
            });
            try { await runWithServerHttpBaseUrl('https://project-test.invalid', async () => {
                for (let invocation = 0; invocation < 2; invocation += 1) {
                    loadedRows = 0;
                    maxMachineReads = 0;
                    const started = performance.now();
                    const snapshot = await readWorkspaceSyncWorkerTargetSnapshot({ credentials, serverId: 'home',
                        serverHttpBaseUrl: 'https://project-test.invalid', sourceWorkspaceRefId: 'a', targetMachineId: 'machine-b' });
                    console.info('PROJECT_FIXED_LATENCY_PREPARATION', JSON.stringify({ invocation, latencyMs: 20,
                        elapsedMs: performance.now() - started, loadedRows, maxMachineReads }));
                    expect.soft(loadedRows).toBe(2);
                    expect.soft(maxMachineReads).toBe(2);
                    expect(snapshot.workspaceRefs).toEqual(refs);
                }
                const { readWorkspaceSyncChildMachineFacts } = await import('../../../../cli/src/workspaces/sync/workspaceSyncTargetAuthority');
                const normalGet = get.getMockImplementation()!;
                let release!: () => void;
                const held = new Promise<void>(resolve => { release = resolve; });
                const started: string[] = [];
                get.mockImplementation(async url => {
                    if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
                    const id = url.slice(url.lastIndexOf('/') + 1);
                    started.push(id);
                    await held;
                    if (id === 'machine-b') throw new Error('later endpoint transport failure');
                    const response: unknown = await normalGet(url);
                    if (!response || typeof response !== 'object') throw new Error('Expected HTTP response');
                    const data: unknown = Reflect.get(response, 'data');
                    if (!data || typeof data !== 'object') throw new Error('Expected Machine response');
                    const machine = MachinePublishedRowV1Schema.parse(Reflect.get(data, 'machine'));
                    return { status: 200, data: { machine: { ...machine, revokedAt: 1 } } };
                });
                const outcome = readWorkspaceSyncChildMachineFacts({ credentials, serverId: 'home',
                    serverHttpBaseUrl: 'https://project-test.invalid', machineIds: ['machine-a', 'machine-b', 'machine-a'] })
                    .catch((error: unknown) => error);
                try { await vi.waitFor(() => expect([...started].sort()).toEqual(['machine-a', 'machine-b'])); }
                finally { release(); }
                expect(await outcome).toMatchObject({ code: 'workspace_sync_child_unavailable' });
                get.mockImplementation(normalGet);
                loadedRows = 0;
                const result = await mutateProjectAccountOrganization({ credentials, serverId: 'home', projectKey: organizationKey.projectKey,
                    mutate: value => ({ ...value, hidden: true }) });
                expect(result).toMatchObject({ status: 'updated', value: { pinned: true, hidden: true } });
                // Shared KV CAS admission batches the selected key, never the organization census.
                expect.soft(loadedRows).toBe(1);
                await readProjectAccountRows({ credentials, serverId: 'home', publication: 'installed' });
                loadedRows = 0;
                const setup = { credentials, serverId: 'home', serverHttpBaseUrl: 'https://project-test.invalid',
                    address: { serverId: 'home', machineId: 'machine-a', workspaceId: 'a', rootPath: '/work/a' } };
                expect(await resolveProjectSetupAcceptedWorkspace(setup)).toEqual({ workspace: refs[0],
                    project: { serverId: 'home', projectId: 'project-a' } });
                expect.soft(loadedRows).toBe(0);
                await db.userKVStore.update({ where: { accountId_key: { accountId: account.id,
                    key: buildProjectAccountRowPhysicalKeyV1({ kind: 'workspace-ref', serverId: 'home', id: 'a' }) } },
                    data: { value: null, version: 1 } });
                await expect(resolveProjectSetupAcceptedWorkspace(setup)).rejects.toMatchObject({ code: 'project_workspace_unavailable' });
                const retired = await readProjectAccountRows({ credentials, serverId: 'home',
                    selection: { kinds: ['workspace-ref', 'relationship-graph'] } });
                expect(retired.workspaceRefs).toEqual([refs[1]]);
                expect.soft(getActiveProjectAccountRowsSnapshot()?.workspaceRefs).toEqual([refs[1]]);
                expect(getActiveProjectAccountRowsSnapshot()?.organizations).toHaveLength(1024);
                let routeReads = 0;
                const initial = { workspaceRefs: refs, relationships: [] };
                const preparation = { serverId: 'home', sourceWorkspaceRefId: 'a', targetWorkspaceRefId: 'a', initial,
                    readCurrent: async () => { routeReads += 1; return initial; },
                    flush: async () => { throw new Error('Same Workspace must not flush'); } };
                expect(await prepareWorkspaceSyncBetween(preparation)).toEqual({ ok: true, traversed: [] });
                expect.soft(routeReads).toBe(0);
                await readProjectAccountRows({ credentials, serverId: 'home', publication: 'installed' });
                expect(getActiveProjectAccountRowsSnapshot()).not.toBeNull();
                await db.userKVStore.update({ where: { accountId_key: { accountId: account.id,
                    key: buildProjectAccountRowPhysicalKeyV1(organizationKey) } },
                    data: { value: decodeBase64(encodeAccountScopedKvJson({ t: 'encrypted', c: 'wrong-mode' })!) } });
                await expect(readProjectAccountRows({ credentials, serverId: 'home', selection: { key: organizationKey } }))
                    .rejects.toMatchObject({ code: 'project_account_rows_account-mode-mismatch' });
                expect(getActiveProjectAccountRowsSnapshot()).toBeNull();
            }); } finally { get.mockRestore(); post.mockRestore(); withdrawActiveProjectAccountRowsSnapshot(); }
        });
    });
});
