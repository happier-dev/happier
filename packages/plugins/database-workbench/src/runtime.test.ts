import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { definePlugin, PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import type { ResourcesService } from '@happier-dev/plugin-sdk/resources';
import type { StorageScopeService, StorageService } from '@happier-dev/plugin-sdk/storage';
import {
    DATABASE_ACCESS_READ_ACTION_ID_V1,
    DATABASE_ACCESS_SET_ACTION_ID_V1,
    DATABASE_DESCRIBE_ACTION_ID_V1,
    DATABASE_EDITS_APPLY_ACTION_ID_V1,
    DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1,
    DATABASE_STATEMENT_RUN_ACTION_ID_V1,
    DATABASE_STATS_READ_ACTION_ID_V1,
    DATABASE_TARGETS_CONNECT_ACTION_ID_V1,
    DATABASE_TARGETS_FORGET_ACTION_ID_V1,
    DATABASE_TARGETS_LIST_ACTION_ID_V1,
} from '@happier-dev/database-protocol';
import {
    DatabaseDescriptorV1Schema,
    type DatabaseDescriptorV1,
    type DatabaseManualTargetV1,
} from '@happier-dev/plugin-sdk/database';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { createDatabaseActions } from './actions.js';
import { openManualDatabaseConnection } from './connection.js';
import { createDatabaseConnectionResourceRuntime, DATABASE_CONNECTION_RESOURCE_ID_V1 } from './resources.js';
import { createDatabaseRuntime } from './runtime.js';
import { plugin as databasePlugin } from './manifest.js';

const target: DatabaseManualTargetV1 = { kind: 'manual', accountId: 'alice', installationId: 'installation',
    projectKey: 'project', savedSecretId: 'selected', workspace: { serverId: 'server', machineId: 'machine', workspaceId: 'workspace', rootPath: '/project' } };
const descriptor: DatabaseDescriptorV1 = { target, label: 'Selected', engine: 'sqlite', origin: { label: 'Manual' }, capabilities: [],
    placement: { serverId: 'server', accountId: 'alice', machineId: 'machine', installationId: 'installation' } };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const runId = databaseActionLocalIdV1(DATABASE_STATEMENT_RUN_ACTION_ID_V1);

describe('semantic database Action runtime', () => {
    it('activates the actual manifest through public Connect, held reads, committed writes and Forget', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'dbw-manifest-')); directories.push(directory);
        const path = join(directory, 'selected.sqlite');
        const database = openSqliteDatabaseSync(path);
        database.exec("CREATE TABLE selected(label TEXT); INSERT INTO selected VALUES('before')"); database.close();
        const kv = openSqliteDatabaseSync(join(directory, 'daemon.sqlite'));
        kv.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
        let storageReads = 0;
        // This is the persistent daemon KV boundary; the plugin's association and access owners remain real.
        const scopeStorage: StorageScopeService = {
            async get<T extends JsonValue = JsonValue>(key: string): Promise<T | null> {
                storageReads++;
                // The fixture's declared TEXT column narrows the unknown SQLite boundary result.
                const row = kv.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined;
                return row ? JSON.parse(String(row.value)) as T : null;
            },
            async set(key, value) { kv.prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); },
            async delete(key) { kv.prepare('DELETE FROM kv WHERE key=?').run(key); },
            async list(options) {
                storageReads++;
                const prefix = options?.prefix ?? '';
                // The fixture's declared TEXT column narrows the unknown SQLite boundary result.
                const rows = kv.prepare('SELECT key FROM kv WHERE substr(key,1,length(?))=? ORDER BY key').all(prefix, prefix) as Array<{ key: string }>;
                return { items: rows.map(row => ({ key: String(row.key) })) };
            },
            consistency() { return { kind: 'authoritativeSerializable' }; },
            async transaction(operation) {
                kv.exec('BEGIN');
                try { const value = await operation(scopeStorage); kv.exec('COMMIT'); return value; }
                catch (error) { kv.exec('ROLLBACK'); throw error; }
            },
        };
        const unavailable = async (): Promise<never> => { throw new Error('This host boundary operation is not used'); };
        const daemonStorage = { ...scopeStorage, database: unavailable };
        const storage: StorageService = { daemon: daemonStorage, ephemeral: scopeStorage, daemonSession: scopeStorage };
        let acquisitions = 0;
        const secrets = { async readSavedSecret() { acquisitions++; return pathToFileURL(path).toString(); },
            saveShared: unavailable, status: unavailable, get: unavailable, set: unavailable, delete: unavailable };
        const invocation = { requesterAccount: { accountId: 'alice' }, chosenMachine: { machineId: 'machine', installationId: 'installation' },
            agentCaller: false, authority: 'present_user' as const };
        const resourceContext = createTestResourceInvocationContext();
        let producer: Awaited<ReturnType<NonNullable<import('@happier-dev/plugin-sdk/resources').PluginDynamicResourceRuntime['createProducer']>>> | undefined;
        const resources: ResourcesService = { ...resourceContext.resources,
            async invokeDemand(input, options) { return await producer!.invoke!(input.input, { signal: options?.signal ?? resourceContext.signal }); },
            async notifyDemands(input) { await producer!.notify!(input.input); },
        };
        const writeAudit: unknown[] = [];
        const logger = { debug() {}, warn() {}, error() {}, diagnostic() {}, info(message: string, fields?: unknown) {
            if (message === 'Database write committed') writeAudit.push(fields);
        } };
        const kit = await createPluginTestkit({ manifest: databasePlugin.manifest, module: databasePlugin, services: { storage, secrets, resources, logger } });
        try {
            expect({ storageReads, acquisitions }).toEqual({ storageReads: 0, acquisitions: 0 });
            const scope = { kind: 'worktree', accountId: 'alice', installationId: 'installation', projectKey: 'project', workspace: target.workspace } as const;
            const connected = DatabaseDescriptorV1Schema.parse(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_TARGETS_CONNECT_ACTION_ID_V1),
                { scope, savedSecretRef: 'selected', label: 'Selected' }, invocation));
            expect(connected).toMatchObject({ engine: 'sqlite', target, access: { canRead: true, canWrite: true } });
            const beforeList = acquisitions;
            expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1), { scope }, invocation))
                .toMatchObject({ targets: [connected] });
            expect(acquisitions).toBe(beforeList);
            await expect(kit.invokeAction(databaseActionLocalIdV1(DATABASE_DESCRIBE_ACTION_ID_V1), { operation: 'describe', target },
                { ...invocation, requesterAccount: { accountId: 'visitor' } })).rejects.toMatchObject({ code: 'database_target_unavailable' });
            // A manual address starts at Agents: Read (P3 A1/D14).
            const agentReadOnly = { canRead: true, canWrite: false, reason: 'database_agent_access_read_only' };
            expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_DESCRIBE_ACTION_ID_V1), { operation: 'describe', target },
                { ...invocation, authority: 'account_automation' })).toMatchObject({ ok: true, descriptor: { access: agentReadOnly } });
            expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_DESCRIBE_ACTION_ID_V1), { operation: 'describe', target },
                { ...invocation, agentCaller: true })).toMatchObject({ ok: true, descriptor: { access: agentReadOnly } });
            const readAccessId = databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1);
            const setAccessId = databaseActionLocalIdV1(DATABASE_ACCESS_SET_ACTION_ID_V1);
            expect(await kit.invokeAction(readAccessId, { target }, { ...invocation, agentCaller: true }))
                .toEqual({ setBy: 'machine', agentAccess: 'read', access: agentReadOnly });
            const beforeAccessSet = acquisitions;
            expect(await kit.invokeAction(setAccessId, { target, agentAccess: 'read' }, invocation)).toEqual({ ok: true, agentAccess: 'read' });
            expect(acquisitions).toBe(beforeAccessSet);
            await expect(kit.invokeAction(databaseActionLocalIdV1(DATABASE_DESCRIBE_ACTION_ID_V1), { operation: 'describe', target },
                { ...invocation, authority: undefined })).rejects.toMatchObject({ code: 'plugin_service_unavailable' });
            const demand = kit.registration('resources', DATABASE_CONNECTION_RESOURCE_ID_V1)!;
            producer = await demand.createProducer!(createTestResourceInvocationContext({ ...invocation, daemonStorage, secrets,
                context: { kind: 'surface', mountInstanceKey: 'pane', launchInput: { operation: 'describe', target } } }));
            let publications = 0;
            const observation = await producer.observe(() => { publications++; }, resourceContext);
            try {
                const read = { operation: 'statement.run', target, subscriptionId: 'pane', mode: 'read', statement: { sql: 'SELECT label FROM selected', parameters: [] } } satisfies JsonValue;
                const heldAcquisitions = acquisitions;
                expect(await kit.invokeAction(runId, read, invocation)).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ value: 'before' }] }] }] });
                expect(await kit.invokeAction(runId, read, invocation)).toMatchObject({ ok: true });
                expect(acquisitions).toBe(heldAcquisitions);
                expect(await kit.invokeAction(runId, { operation: 'statement.run', target, mode: 'write', executionMode: 'transaction',
                    statements: [{ sql: "UPDATE selected SET label='committed' WHERE label=? /* audit-private-comment */",
                        parameters: [{ type: 'text', value: 'before' }] }] }, invocation)).toMatchObject({ ok: true });
                expect(writeAudit).toEqual([{ operation: 'statement.run', target, requesterAccountId: 'alice',
                    statements: [{ shape: 'update selected set label = ? where label = ?', affectedRows: '1' }] }]);
                expect(publications).toBe(1);
                expect(await kit.invokeAction(runId, read, invocation)).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ value: 'committed' }] }] }] });
                // G1: the agent reads through the held demand at Read; then the owner sets None.
                expect(await kit.invokeAction(runId, read, { ...invocation, agentCaller: true })).toMatchObject({ ok: true });
                expect(await kit.invokeAction(setAccessId, { target, agentAccess: 'none' }, invocation)).toEqual({ ok: true, agentAccess: 'none' });
                // Each request is admitted for its own requester; the held connection never carries a person's access to an agent.
                await expect(kit.invokeAction(runId, read, { ...invocation, agentCaller: true }))
                    .rejects.toMatchObject({ code: 'database_agent_access_none' });
                await expect(kit.invokeAction(runId, read, { ...invocation, authority: 'account_automation' }))
                    .rejects.toMatchObject({ code: 'database_agent_access_none' });
                const heldPerson = acquisitions;
                expect(await kit.invokeAction(runId, read, invocation)).toMatchObject({ ok: true });
                expect(acquisitions).toBe(heldPerson);
                expect(await kit.invokeAction(readAccessId, { target }, invocation))
                    .toEqual({ setBy: 'machine', agentAccess: 'none', access: { canRead: true, canWrite: true } });
            } finally { await observation.dispose(); await producer.dispose(); producer = undefined; }
            expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_TARGETS_FORGET_ACTION_ID_V1), { target }, invocation)).toEqual({ ok: true });
            expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1), { scope }, invocation)).toMatchObject({ targets: [] });
            await expect(kit.invokeAction(databaseActionLocalIdV1(DATABASE_DESCRIBE_ACTION_ID_V1), { operation: 'describe', target }, invocation))
                .rejects.toMatchObject({ code: 'database_target_unavailable' });
        } finally { await producer?.dispose(); await kit.dispose(); kv.close(); }
    });

    const postgresBinaries = process.env.HAPPIER_TEST_POSTGRES_BIN ?? '/usr/lib/postgresql/16/bin';
    describe.skipIf(!existsSync(join(postgresBinaries, 'initdb')))('native PostgreSQL cleanup', () => {
        let directory: string;
        let secretValue: string;
        let started = false;
        const run = promisify(execFile);
        beforeAll(async () => {
            directory = await mkdtemp(join(tmpdir(), 'dbw-runtime-settlement-'));
            await run(join(postgresBinaries, 'initdb'), ['-D', join(directory, 'data'), '-A', 'trust', '-U', 'fixture', '--no-locale', '-E', 'UTF8']);
            await run(join(postgresBinaries, 'pg_ctl'), ['-D', join(directory, 'data'), '-l', join(directory, 'postgres.log'), '-o', `-c listen_addresses='' -k ${directory} -c shared_preload_libraries=pg_stat_statements`, '-w', 'start']);
            started = true;
            secretValue = `postgresql://fixture@localhost/postgres?host=${encodeURIComponent(directory)}`;
            const setup = new Client({ connectionString: secretValue });
            try {
                await setup.connect();
                await setup.query("CREATE EXTENSION pg_stat_statements; CREATE TABLE selected(label TEXT); INSERT INTO selected VALUES ('before')");
            } finally { await setup.end(); }
        });
        afterAll(async () => {
            if (started) await run(join(postgresBinaries, 'pg_ctl'), ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop']);
            if (directory) await rm(directory, { recursive: true, force: true });
        });
        it('settles native size and statements reads when the observation catalog is unavailable', async () => {
            // The optional Event catalog is a host boundary. The SDK still owns its unsettled disposition.
            const readSourceCatalog = vi.fn(async () => { throw new PluginError({ code: 'plugin_service_unavailable' }); });
            const unexpectedActionCall = async (): Promise<never> => { throw new Error('Unexpected host Action operation in the catalog fixture'); };
            const actions: ActionsService = {
                execute: readSourceCatalog,
                observe: unexpectedActionCall,
                observeAdmittedTargetedOperation: unexpectedActionCall,
                executeAdmittedTargetedOperation: unexpectedActionCall,
                executeWithExecutionOrigin: unexpectedActionCall,
                executeAdmittedTargetedOperationWithExecutionOrigin: unexpectedActionCall,
            };
            const runtime = createDatabaseRuntime({ async admit() {}, async resolve(input) {
                return { descriptor: { ...descriptor, engine: 'postgresql' }, connection: await openManualDatabaseConnection({
                    target, secretValue, access: input.access, signal: input.context.signal,
                }) };
            } });
            const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', displayName: 'Database', actions: createDatabaseActions(runtime) });
            const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { actions } });
            // A native Action always carries the routed Machine and invocation identity.
            const identity = { requesterAccount: { accountId: 'alice' }, chosenMachine: { machineId: 'machine', installationId: 'installation' },
                agentCaller: false, authority: 'present_user' as const };
            const environmentTarget = { kind: 'deployment_service', environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' },
                deploymentId: 'deployment', targetLinkId: 'link', serviceId: 'postgres', database: 'postgres' } as const;
            const statsId = databaseActionLocalIdV1(DATABASE_STATS_READ_ACTION_ID_V1);
            // An Environment-admitted editor reaches this Machine without Machine admission, so no Machine is stamped.
            const editor = { requesterAccount: { accountId: 'editor' }, agentCaller: false, authority: 'present_user' as const };
            try {
                for (const [selected, invocation] of [[target, identity], [environmentTarget, identity], [environmentTarget, editor]] as const) {
                    expect(await kit.invokeAction(statsId, { operation: 'stats.read', target: selected,
                        request: { kind: 'stats.read', group: 'size', selection: {} } }, invocation))
                        .toMatchObject({ ok: true, operation: 'stats.read', observation: { status: 'available' } });
                    expect(await kit.invokeAction(statsId, { operation: 'stats.read', target: selected, request: { kind: 'stats.read', group: 'statements',
                        selection: { order: 'totalTime', page: { rows: 50, offset: 0 } } } }, invocation))
                        .toMatchObject({ ok: true, operation: 'stats.read', observation: { status: 'available' } });
                }
                // Each completed stats read addresses the Machine-wide and exact Database sources.
                expect(readSourceCatalog).toHaveBeenCalledTimes(12);
                expect(readSourceCatalog).toHaveBeenLastCalledWith('automation.event.sources.list',
                    expect.objectContaining({ transport: { kind: 'checkpointedPull' } }), expect.anything());
            } finally { await kit.dispose(); }
        });
        it('preserves native settlement when connection cleanup rejects', async () => {
            const warnings: unknown[] = [];
            let publications = 0;
            const runtime = createDatabaseRuntime({ async admit() {}, async resolve(input) {
                return { descriptor: { ...descriptor, engine: 'postgresql' }, connection: await openManualDatabaseConnection({
                    target, secretValue, access: input.access, signal: input.context.signal,
                }) };
            } });
            const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', displayName: 'Database', actions: createDatabaseActions(runtime) });
            const resources = createTestResourceInvocationContext().resources;
            const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: {
                resources: { ...resources, async notifyDemands() { publications++; } },
                logger: { debug() {}, info() {}, error() {}, diagnostic() {}, warn(_message, fields) { warnings.push(fields); } },
            } });
            const nativeEnd = Client.prototype.end;
            // pg.Client.end is the genuine network transport boundary. Queries, transactions and decoding remain real.
            const ending = vi.spyOn(Client.prototype, 'end').mockImplementation(async function(this: Client) {
                await new Promise<void>((resolve, reject) => { nativeEnd.call(this, error => error ? reject(error) : resolve()); });
                throw Object.assign(new Error('Private transport context must not enter the diagnostic'), { code: 'ECONNRESET' });
            });
            try {
                expect(await kit.invokeAction(runId, { operation: 'statement.run', target, mode: 'write', executionMode: 'transaction',
                    statements: [{ sql: "UPDATE selected SET label='committed'", parameters: [] }] }))
                    .toMatchObject({ ok: true, results: [{ affectedRows: '1' }] });
                expect(await kit.invokeAction(runId, { operation: 'statement.run', target, mode: 'write', executionMode: 'transaction',
                    statements: [{ sql: 'UPDATE absent SET label=1', parameters: [] }] }))
                    .toMatchObject({ ok: false, status: 'failed', cause: { source: 'engine', code: '42P01' } });
                expect(publications).toBe(1);
                expect(warnings).toEqual([{ code: 'ECONNRESET' }, { code: 'ECONNRESET' }]);
                ending.mockRestore();
                const verify = new Client({ connectionString: secretValue });
                try {
                    await verify.connect();
                    expect((await verify.query('SELECT label FROM selected')).rows).toEqual([{ label: 'committed' }]);
                } finally { await verify.end(); }
            } finally {
                ending.mockRestore();
                await kit.dispose();
            }
        });
    });

    it('uses one held read connection and standalone write lifetimes, publishing only committed changes', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'dbw-runtime-')); directories.push(directory);
        const path = join(directory, 'selected.sqlite');
        const db = openSqliteDatabaseSync(path);
        db.exec("CREATE TABLE selected(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO selected VALUES (1,'before');"); db.close();
        const secretValue = pathToFileURL(path).toString();
        let acquisitions = 0;
        let openings = 0;
        let closures = 0;
        const unavailable = async (): Promise<never> => { throw new Error('This Saved Secret boundary operation is not used'); };
        const secrets = { async readSavedSecret() { acquisitions++; return secretValue; },
            saveShared: unavailable, status: unavailable, get: unavailable, set: unavailable, delete: unavailable };
        const demand = createDatabaseConnectionResourceRuntime({ async resolve(input) {
            const connection = await openManualDatabaseConnection({ target, secretValue: await input.secrets.readSavedSecret(target.savedSecretId), access: 'read' });
            openings++;
            return { descriptor, connection: { ...connection, async close() { closures++; await connection.close(); } } };
        } });
        const controller = new AbortController();
        const context = createTestResourceInvocationContext({ signal: controller.signal, requesterAccount: { accountId: 'alice' }, secrets,
            context: { kind: 'surface', mountInstanceKey: 'selected', launchInput: { operation: 'describe', target } } });
        const producer = await demand.createProducer!(context);
        let publications = 0;
        const observation = await producer.observe(() => { publications++; }, context);
        // This adapter is the daemon transport boundary; its actual Resource producer and native engine remain real.
        const resources: ResourcesService = { ...context.resources,
            async invokeDemand(input, options) {
                expect(input.resourceId).toBe(DATABASE_CONNECTION_RESOURCE_ID_V1);
                expect(input.subscriptionId).toBe('open-pane');
                return await producer.invoke!(input.input, { signal: options?.signal ?? controller.signal });
            },
            async notifyDemands(input) { await producer.notify!(input.input); },
        };
        const resolvedAccesses: string[] = [];
        const runtime = createDatabaseRuntime({ async admit() {}, async resolve(input) {
            resolvedAccesses.push(input.access);
            const connection = await openManualDatabaseConnection({ target, secretValue: await input.context.services.secrets.readSavedSecret(target.savedSecretId), access: input.access });
            openings++;
            return { descriptor, connection: { ...connection, async close() { closures++; await connection.close(); } } };
        } });
        const plugin = definePlugin({ id: 'happier.database', version: '0.0.0', displayName: 'Database', actions: createDatabaseActions(runtime) });
        const audit = vi.fn();
        const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { resources, secrets,
            logger: { debug() {}, warn() {}, error() {}, diagnostic() {}, info: audit } } });
        const read = { operation: 'statement.run', target, subscriptionId: 'open-pane', mode: 'read', statement: { sql: 'SELECT label FROM selected', parameters: [] } } satisfies JsonValue;
        try {
            expect(await kit.invokeAction(runId, read)).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'before' }] }] }] });
            expect(await kit.invokeAction(runId, read)).toMatchObject({ ok: true });
            expect({ acquisitions, openings, closures }).toEqual({ acquisitions: 1, openings: 1, closures: 0 });
            expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_DESCRIBE_ACTION_ID_V1), { operation: 'describe', target }))
                .toEqual({ ok: true, operation: 'describe', descriptor: {
                    ...descriptor,
                    automationSubject: { ok: true, subject: { kind: 'database', serverId: 'server', target } },
                } });
            expect({ acquisitions, openings, closures }).toEqual({ acquisitions: 2, openings: 2, closures: 1 });
            expect(await kit.invokeAction(runId, { operation: 'statement.run', target, subscriptionId: 'open-pane', mode: 'write', executionMode: 'transaction',
                statements: [{ sql: "UPDATE selected SET label='after'", parameters: [] }] })).toMatchObject({ ok: true });
            expect({ acquisitions, openings, closures, publications }).toEqual({ acquisitions: 3, openings: 3, closures: 2, publications: 1 });
            expect(await kit.invokeAction(runId, read)).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'after' }] }] }] });
            expect(await kit.invokeAction(runId, { operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
                { sql: "UPDATE selected SET label='rolled-back'", parameters: [] }, { sql: 'INSERT INTO missing VALUES (1)', parameters: [] },
            ] })).toMatchObject({ ok: false, status: 'failed' });
            expect(publications).toBe(1);
            expect(await kit.invokeAction(runId, read)).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'after' }] }] }] });
            expect({ acquisitions, openings, closures }).toEqual({ acquisitions: 4, openings: 4, closures: 3 });
            const relation = { schema: 'main', name: 'selected' };
            expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_EDITS_APPLY_ACTION_ID_V1), {
                operation: 'edits.apply', target, relation, changes: [{ kind: 'update',
                    key: [{ column: 'id', value: { type: 'integer', value: '1' } }],
                    original: [{ column: 'label', value: { type: 'text', value: 'after' } }],
                    values: [{ column: 'label', value: { kind: 'value', cell: { type: 'text', value: 'edited' } } }],
                }],
            })).toMatchObject({ ok: true, status: 'committed', updated: '1' });
            expect(audit.mock.calls).toEqual([
                ['Database write committed', { operation: 'statement.run', target,
                    statements: [{ shape: 'update selected set label = ?', affectedRows: '1' }] }],
                ['Database write committed', { operation: 'edits.apply', target, relation, columns: ['id', 'label'],
                    inserted: '0', updated: '1', deleted: '0' }],
            ]);
            expect(publications).toBe(2);
            expect(JSON.parse(String(await producer.read(context)))).toMatchObject({
                ownWriteRevision: 1, relationRevisions: [{ relation, revision: 1 }],
            });
            expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1), {
                operation: 'statement.explain', target, accessMode: 'write', mode: 'plan',
                statement: { sql: "UPDATE selected SET label='explained'", parameters: [] },
            })).toMatchObject({ ok: true });
            expect(publications).toBe(2);
            expect(await kit.invokeAction(runId, read)).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'edited' }] }] }] });
            expect(await kit.invokeAction(databaseActionLocalIdV1(DATABASE_STATEMENT_EXPLAIN_ACTION_ID_V1), {
                operation: 'statement.explain', target, accessMode: 'write', mode: 'analyze',
                statement: { sql: "UPDATE selected SET label='analyzed'", parameters: [] },
            })).toMatchObject({ ok: false, status: 'unavailable' });
            expect(publications).toBe(2);
            const warnings: unknown[] = [];
            const afterCommit = new AbortController();
            expect(await kit.invokeAction(runId, { operation: 'statement.run', target, mode: 'write', executionMode: 'transaction',
                statements: [{ sql: "UPDATE selected SET label='committed-without-push'", parameters: [] }] }, {
                signal: afterCommit.signal,
                services: { resources: { ...resources, async notifyDemands() {
                    afterCommit.abort();
                    throw new PluginError({ code: 'plugin_resource_demand_unavailable' });
                } },
                    logger: { debug() {}, info() {}, error() {}, diagnostic() {}, warn(_message, fields) { warnings.push(fields); } } },
            })).toMatchObject({ ok: true });
            expect(warnings).toEqual([{ code: 'plugin_resource_demand_unavailable' }]);
            expect(publications).toBe(2);
            expect(await kit.invokeAction(runId, read)).toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'committed-without-push' }] }] }] });
        } finally { await kit.dispose(); observation.dispose(); controller.abort(); await producer.dispose(); }
        expect(closures).toBe(8);
        expect(resolvedAccesses).toEqual(['read', 'write', 'write', 'write', 'read', 'write', 'write']);
    });
});
