import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePlugin, type DatabaseEngineConnectionV1 } from '@happier-dev/plugin-sdk';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { openSqliteConnection } from '../../../../../../../packages/plugins/database-workbench/src/sqlite';
import { openManualDatabaseConnection } from '../../../../../../../packages/plugins/database-workbench/src/connection';
import { PluginContributesV2Schema } from '@happier-dev/protocol/plugins/contributions/v2';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { activatePluginRuntimeRegistry } from '../manager';
import { createDatabaseEnginesService } from './databaseEngines';

describe('contributed database engine catalogue compatibility', () => {
    const postgresBinaries = process.env.HAPPIER_TEST_POSTGRES_BIN ?? '/usr/lib/postgresql/16/bin';
    it.skipIf(!existsSync(join(postgresBinaries, 'initdb')))('opens builtin PostgreSQL through the same SDK engine service and settles one transaction', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'dbw-engine-pg-'));
        const run = promisify(execFile);
        let started = false;
        const contributes = createResolvedContributionRegistry({});
        const registry = await activatePluginRuntimeRegistry({ contributes, generation: 1 });
        try {
            await run(join(postgresBinaries, 'initdb'), ['-D', join(directory, 'data'), '-A', 'trust', '-U', 'fixture', '--no-locale', '-E', 'UTF8']);
            await run(join(postgresBinaries, 'pg_ctl'), ['-D', join(directory, 'data'), '-l', join(directory, 'postgres.log'),
                '-o', `-c listen_addresses='' -k ${directory}`, '-w', 'start']);
            started = true;
            const sql = (statement: string) => run(join(postgresBinaries, 'psql'), ['-X', '-At', '-h', directory, '-U', 'fixture', '-d', 'postgres', '-c', statement]);
            expect((await sql('SELECT 1')).stdout.trim()).toBe('1');
            await sql("CREATE TABLE selected(id bigint PRIMARY KEY, value text, mutations integer NOT NULL DEFAULT 0); INSERT INTO selected(id,value) VALUES(1,'before')");
            const engines = createDatabaseEnginesService({ targets: [], registry });
            const connection = await engines.open('postgresql', {
                connectionString: `postgresql://fixture@localhost/postgres?host=${encodeURIComponent(directory)}`, access: 'write' });
            const target = { kind: 'managed_deployment' as const, environment: { serverId: 'home', projectSourceId: 'project', environmentId: 'environment' },
                targetLinkId: 'selected', contribution: { pluginId: 'happier.deploy.neon', contributionId: 'database' },
                platformProjectId: 'project', branchId: 'branch', database: 'postgres' };
            try {
                expect(await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [{
                    sql: 'UPDATE selected SET value=$1, mutations=mutations+1 RETURNING value AS duplicate, 9007199254740993::bigint AS duplicate',
                    parameters: [{ type: 'text', value: 'committed' }],
                }] })).toMatchObject({ ok: true, results: [{ affectedRows: '1', columns: [{ name: 'duplicate' }, { name: 'duplicate' }],
                    rows: [{ cells: [{ type: 'text', value: 'committed' }, { type: 'integer', value: '9007199254740993' }] }] }] });
                expect((await sql('SELECT mutations FROM selected')).stdout.trim()).toBe('1');
                expect(await connection.execute({ operation: 'statement.run', target, mode: 'write', executionMode: 'transaction', statements: [
                    { sql: "UPDATE selected SET value='rollback'", parameters: [] },
                    { sql: "INSERT INTO selected VALUES(1,'duplicate')", parameters: [] },
                ] })).toMatchObject({ ok: false, status: 'failed', cause: { code: '23505' } });
                expect((await sql('SELECT value FROM selected')).stdout.trim()).toBe('committed');
            } finally { await connection.close(); }
        } finally {
            await registry.dispose();
            if (started) await run(join(postgresBinaries, 'pg_ctl'), ['-D', join(directory, 'data'), '-m', 'immediate', '-w', 'stop']);
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('keeps mounted bundled peers without engine contributions available', async () => {
        // Build-admitted bundled JSON is the real cold declaration boundary.
        const source: CanonicalPluginManifest = JSON.parse(readFileSync(new URL('../../../../../assets/bundled-plugin-manifests/deployment-neon.json', import.meta.url), 'utf8'));
        // Preserve the omission observed in the mounted workflow/Muse startup,
        // even after the bundled publisher regenerates its new empty default.
        Reflect.deleteProperty(source.contributes, 'databaseEngines');
        const admitted = ingestCanonicalPluginManifest(source, { admission: 'build', manifestAuthority: 'bundled_first_party' });
        if (!admitted.ok) throw new Error('Expected bundled declaration');
        expect(PluginContributesV2Schema.parse({}).databaseEngines).toEqual([]);
        // A mounted registry admitted before this family existed retains its old shape.
        const mounted = { ...admitted.manifest, contributes: { ...admitted.manifest.contributes } };
        Reflect.deleteProperty(mounted.contributes, 'databaseEngines');
        const contributes = createResolvedContributionRegistry({ activationTargets: [{
            provenance: 'first_party', source: { kind: 'bundled' }, pluginId: source.id,
            manifestPath: '/fixture/neon/plugin.json', daemonEntryPath: '/fixture/neon/daemon.mjs',
            sourceSpec: { kind: 'path', locator: '/fixture/neon', trustPolicy: 'local_trusted', installPolicy: 'link' },
            activationEvents: [], manifest: mounted,
        }] });
        const registry = await activatePluginRuntimeRegistry({ contributes, generation: 1,
            resolveActivationSource: () => ({ kind: 'bundled', moduleId: 'fixture-neon', load: async () => {
                throw new Error('Cold engine discovery must not load an unrelated provider');
            } }),
        });
        try { expect(createDatabaseEnginesService({ targets: contributes.activationTargets, registry }).list()).toEqual([]); }
        finally { await registry.dispose(); }
    });
    it('cold-discovers, demands only the selected runtime, executes real SQLite, and retires with ordinary activation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'dbw-engine-extension-'));
        const path = join(directory, 'fixture.sqlite');
        const db = openSqliteDatabaseSync(path);
        db.exec("CREATE TABLE selected(id INTEGER PRIMARY KEY, label TEXT); INSERT INTO selected VALUES(1,'third-party');");
        db.close();
        let loads = 0; let opens = 0; let closes = 0;
        const handles = new Set<DatabaseEngineConnectionV1>();
        const controller = new AbortController();
        const plugin = definePlugin({ id: 'acme.database', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
            databaseEngines: { analytical: { declaration: { engineId: 'acme-analytical', scheme: 'analytical',
                capabilities: [{ operation: 'statement.run', available: true }] }, runtime: {
                async open(input) {
                    expect(input.signal).toBe(controller.signal);
                    opens++;
                    const connection = { engine: 'acme-analytical', ...await openSqliteConnection(path, { readOnly: input.access === 'read' }) };
                    handles.add(connection); return connection;
                },
                execute: (connection: DatabaseEngineConnectionV1, operation, signal) => connection.execute(operation, signal),
                async close(connection: DatabaseEngineConnectionV1) { handles.delete(connection); closes++; await connection.close(); },
            } } },
            async setup() { return async () => { await Promise.all([...handles].map(connection => connection.close())); handles.clear(); }; },
        });
        const ingested = ingestCanonicalPluginManifest(plugin.manifest, { sourceProvenance: 'registryCustodied' });
        if (!ingested.ok) throw new Error('Expected admitted public engine manifest');
        const contributes = createResolvedContributionRegistry({ activationTargets: [{
            provenance: 'first_party', source: { kind: 'bundled' }, pluginId: plugin.manifest.id,
            manifestPath: '/virtual/engine/plugin.json', daemonEntryPath: '/virtual/engine/daemon.mjs',
            sourceSpec: { kind: 'package', locator: '@acme/database', trustPolicy: 'local_trusted', installPolicy: 'copy' },
            activationEvents: [], manifest: ingested.manifest,
        }] });
        const registry = await activatePluginRuntimeRegistry({ contributes, generation: 1,
            resolveActivationSource: () => ({ kind: 'bundled', moduleId: '@acme/database/daemon', load: async () => { loads++; return plugin; } }),
        });
        const engines = createDatabaseEnginesService({ targets: contributes.activationTargets, registry });
        try {
            expect(engines.list()).toMatchObject([{ engineId: 'acme-analytical', scheme: 'analytical' }]);
            expect({ loads, opens }).toEqual({ loads: 0, opens: 0 });
            const target = { kind: 'manual' as const, accountId: 'account', installationId: 'installation', projectKey: 'project', savedSecretId: 'secret',
                workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'checkout', rootPath: directory } };
            const connection = await openManualDatabaseConnection({ target, secretValue: 'analytical://fixture/selected', access: 'read',
                signal: controller.signal, databaseEngines: engines });
            expect(connection.engine).toBe('acme-analytical');
            expect(await connection.execute({ operation: 'statement.run', target, mode: 'read',
                statement: { sql: 'SELECT label FROM selected', parameters: [] } }, controller.signal))
                .toMatchObject({ ok: true, results: [{ rows: [{ cells: [{ type: 'text', value: 'third-party' }] }] }] });
            expect({ loads, opens }).toEqual({ loads: 1, opens: 1 });
            await connection.close(); expect(closes).toBe(1);
            await registry.dispose();
            await expect(engines.open('acme-analytical', { connectionString: 'analytical://fixture/selected', access: 'read' }))
                .rejects.toBeDefined();
            const disabled = createDatabaseEnginesService({ targets: [], registry });
            expect(disabled.list()).toEqual([]);
            await expect(disabled.open('acme-analytical', { connectionString: 'analytical://fixture/selected', access: 'read' }))
                .rejects.toMatchObject({ code: 'plugin_service_unavailable' });
            await expect(openManualDatabaseConnection({ target, secretValue: 'analytical://fixture/selected', access: 'read', databaseEngines: disabled }))
                .rejects.toMatchObject({ code: 'plugin_service_unavailable' });
        } finally { await registry.dispose(); await rm(directory, { recursive: true, force: true }); }
    });
});
