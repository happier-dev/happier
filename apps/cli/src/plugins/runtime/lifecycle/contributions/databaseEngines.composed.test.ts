import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definePlugin, type DatabaseEngineConnectionV1 } from '@happier-dev/plugin-sdk';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { openSqliteConnection } from '../../../../../../../packages/plugins/database-workbench/src/sqlite';
import { openManualDatabaseConnection } from '../../../../../../../packages/plugins/database-workbench/src/connection';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { activatePluginRuntimeRegistry } from '../manager';
import { createDatabaseEnginesService } from './databaseEngines';

describe('contributed database engine through the semantic workbench connection', () => {
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
