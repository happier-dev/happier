import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { DATABASE_DESCRIBE_ACTION_ID_V1, DATABASE_STATEMENT_RUN_ACTION_ID_V1, DATABASE_TARGETS_CONNECT_ACTION_ID_V1,
  DATABASE_TARGETS_LIST_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import { DatabaseOperationResultV1Schema } from '../../../database-protocol/src/databaseOperations';
import { DatabaseTargetsConnectResultV1Schema } from '../../../database-protocol/src/databaseTargetActions';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { applyTrustedLocalPluginFixture } from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { createRunDirs } from '../../src/testkit/runDir';

const run = createRunDirs({ runLabel: 'core' });
const pluginId = 'qa.dbw-native-engine';
const engineId = 'qa-native-sqlite';

// A third-party adapter uses only public SDK exports and the runtime's native
// SQLite file. It contributes no Action and never imports a first-party plugin.
const engineSource = `
import { definePlugin, type PluginDatabaseEngineRuntimeV1 } from '@happier-dev/plugin-sdk';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { fileURLToPath } from 'node:url';
const runtime: PluginDatabaseEngineRuntimeV1<ReturnType<typeof openSqliteDatabaseSync>> = {
  async open(input) {
    const fileUrl = 'file:' + input.connectionString.slice(input.connectionString.indexOf(':') + 1);
    return openSqliteDatabaseSync(fileURLToPath(fileUrl), { readOnly: input.access === 'read' });
  },
  async execute(database, input) {
    if (input.operation !== 'statement.run' || input.mode !== 'read') {
      return { ok: false, status: 'unavailable', code: 'database_operation_unavailable', reason: 'This fixture engine supports read statements' };
    }
    const statement = database.prepare(input.statement.sql);
    const columns = statement.columns();
    const rows = statement.values();
    return { ok: true, operation: 'statement.run', results: [{
      columns: columns.map(column => ({ name: column.name, nativeType: column.type ?? 'unknown',
        semanticType: column.type === 'INTEGER' ? 'integer' : 'text' })),
      rows: rows.map(row => ({ cells: row.map(value => value === null ? { type: 'null' as const }
        : typeof value === 'bigint' ? { type: 'integer' as const, value: String(value) }
        : { type: 'text' as const, value: String(value) }) })), completeness: { complete: true },
    }] };
  },
  async close(database) { database.close(); },
};
const plugin = definePlugin({ id: '${pluginId}', version: '1.0.0',
  entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
  databaseEngines: { native: { declaration: { engineId: '${engineId}', scheme: 'dbwqa',
    capabilities: [{ operation: 'describe', available: true }, { operation: 'statement.run', available: true }] }, runtime } },
});
export const manifest = plugin.manifest;
export const activate = plugin.activate;
`;

it('F11-known-good-contributed-engine lists describes and reads a native SQLite file before unavailable recovery', async () => {
  const testDir = run.testDir('dbw-engine-f11');
  const fixture = await startDatabaseWorkbenchInsightsFixture({ testDir });
  try {
    const pluginRoot = join(fixture.machine.workspaceDir, 'qa-native-engine');
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: pluginId, version: '1.0.0', private: true,
      type: 'module', dependencies: { '@happier-dev/plugin-sdk': '0.0.0' } }));
    await writeFile(join(pluginRoot, 'index.ts'), engineSource);
    const filePath = join(fixture.machine.workspaceDir, 'contributed.sqlite');
    const sqlite = openSqliteDatabaseSync(filePath);
    try { sqlite.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, target TEXT NOT NULL); INSERT INTO sentinel VALUES (1, 'external-native-sqlite');"); }
    finally { sqlite.close(); }
    await applyTrustedLocalPluginFixture({ daemonPort: fixture.machine.daemon.state.httpPort,
      controlToken: fixture.machine.daemon.state.controlToken, pluginRoot, pluginId, interactionId: 'dbw-f11-engine' });
    const saved = await fixture.owner.execute('secrets.create', { name: 'F11 contributed SQLite', kind: 'other',
      value: `dbwqa:${pathToFileURL(filePath).href.slice('file:'.length)}` },
      { presentUserConfirmation: { actionId: 'secrets.create' } });
    if (!saved.ok) throw new Error(`F11 Saved Secret refused (${saved.errorCode})`);
    const secret = PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1['secrets.create'].parse(saved.result);
    const { source: _source, ...scope } = fixture.targets.selected;
    const connected = await fixture.executeDatabase(DATABASE_TARGETS_CONNECT_ACTION_ID_V1,
      { scope, savedSecretRef: secret.secretRef, label: 'Contributed native SQLite' });
    expect(connected.ok, JSON.stringify(connected)).toBe(true);
    if (!connected.ok) throw new Error(`F11 Connect refused (${connected.errorCode})`);
    const descriptor = DatabaseTargetsConnectResultV1Schema.parse(connected.result);
    expect(descriptor.engine).toBe(engineId);
    const listed = await fixture.executeDatabase(DATABASE_TARGETS_LIST_ACTION_ID_V1, { scope });
    expect(listed).toMatchObject({ ok: true, result: { targets: expect.arrayContaining([
      expect.objectContaining({ target: descriptor.target, engine: engineId }),
    ]) } });
    const described = await fixture.executeDatabase(DATABASE_DESCRIBE_ACTION_ID_V1,
      { operation: 'describe', target: descriptor.target });
    expect(described).toMatchObject({ ok: true, result: { ok: true, descriptor: { engine: engineId } } });
    const input = { operation: 'statement.run', mode: 'read', target: descriptor.target,
      statement: { sql: 'SELECT id, target FROM sentinel WHERE id = 1', parameters: [] } };
    async function readControl() {
      const read = await fixture.executeDatabase(DATABASE_STATEMENT_RUN_ACTION_ID_V1, input);
      expect(read.ok, JSON.stringify(read)).toBe(true);
      if (!read.ok) throw new Error(`F11 contributed read refused (${read.errorCode})`);
      expect(DatabaseOperationResultV1Schema.parse(read.result)).toMatchObject({ ok: true, operation: 'statement.run',
        results: [{ rows: [{ cells: [{ type: 'integer', value: '1' }, { type: 'text', value: 'external-native-sqlite' }] }] }] });
    }
    await readControl();
    console.info('F11-known-good-contributed-engine passed', { ...fixture.runtime, engineId, engineSource: pluginRoot });
    const lifecycle = { pluginId, machineId: fixture.machine.target.machineId, scope: 'machine' };
    const disabled = await fixture.owner.execute('plugins.disable', lifecycle,
      { presentUserConfirmation: { actionId: 'plugins.disable' } });
    expect(disabled).toMatchObject({ ok: true, result: { ok: true, change: { kind: 'committed' } } });
    expect(await fixture.executeDatabase(DATABASE_STATEMENT_RUN_ACTION_ID_V1, input))
      .toMatchObject({ ok: false, errorCode: 'plugin_service_unavailable' });
    const enabled = await fixture.owner.execute('plugins.enable', lifecycle,
      { presentUserConfirmation: { actionId: 'plugins.enable' } });
    expect(enabled).toMatchObject({ ok: true, result: { ok: true, change: { kind: 'committed' } } });
    await readControl();
  } finally { await fixture.stop(); }
}, 0);
