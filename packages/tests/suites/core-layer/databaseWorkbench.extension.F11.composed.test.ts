import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/account/settings/personalSavedSecretActionsV1';
import { DATABASE_DESCRIBE_ACTION_ID_V1, DATABASE_STATEMENT_RUN_ACTION_ID_V1, DATABASE_TARGETS_CONNECT_ACTION_ID_V1,
  DATABASE_TARGETS_LIST_ACTION_ID_V1 } from '../../../database-protocol/src/actionIdsDatabaseV1';
import { DatabaseOperationResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { DatabaseDescriptorV1Schema as DatabaseTargetsConnectResultV1Schema } from '@happier-dev/plugin-sdk/database';
import { consumeDeferredCliApprovalResult } from '../../../../apps/cli/src/session/actions/approvals/deferredResult';
import { startDatabaseWorkbenchInsightsFixture } from '../../src/testkit/databaseWorkbench';
import { createRunDirs } from '../../src/testkit/runDir';
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

const run = createRunDirs({ runLabel: 'core' });
const pluginId = 'qa.dbw-native-engine';
const engineId = 'qa-native-sqlite';

// A third-party adapter uses only public SDK exports and the runtime's native
// SQLite file. It contributes no Action and never imports a first-party plugin.
const engineSource = `
import { definePlugin, type PluginDatabaseEngineRuntimeV1 } from '@happier-dev/plugin-sdk';
import { openSqliteDatabaseSync } from '@happier-dev/plugin-sdk/fs';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';
const observe = (event: string) => appendFileSync(__LIFECYCLE_JOURNAL__, event + '\\n');
observe('module');
const runtime: PluginDatabaseEngineRuntimeV1<ReturnType<typeof openSqliteDatabaseSync>> = {
  async open(input) {
    const fileUrl = 'file:' + input.connectionString.slice(input.connectionString.indexOf(':') + 1);
    observe('open');
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
  async close(database) { database.close(); observe('close'); },
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
    const journal = join(testDir, 'author-lifecycle.txt');
    await writeFile(join(pluginRoot, 'index.ts'), engineSource.replace('__LIFECYCLE_JOURNAL__', JSON.stringify(journal)));
    const filePath = join(fixture.machine.workspaceDir, 'contributed.sqlite');
    const sqlite = openSqliteDatabaseSync(filePath);
    try { sqlite.exec("CREATE TABLE sentinel (id INTEGER PRIMARY KEY, target TEXT NOT NULL); INSERT INTO sentinel VALUES (1, 'external-native-sqlite');"); }
    finally { sqlite.close(); }
    const installed = await runCliJson({
      testDir,
      cliHomeDir: fixture.machine.homeDir,
      serverUrl: fixture.actionServerApiUrl,
      webappUrl: fixture.server.baseUrl,
      env: { ...process.env, NODE_OPTIONS: fixture.sourceOptions },
      label: 'dbw-f11-author-install',
      launchOptions: { preferSourceEntrypoint: true, skipSharedDepsBuild: true },
      args: ['plugins', 'install', pluginRoot, '--dev', '--json'],
      // Dependency admission may wait for a shared workspace build. Observe the CLI result.
      timeoutMs: null,
      acceptedExitCodes: [1],
    });
    expect(installed).toMatchObject({ ok: true, kind: 'plugins_install' });
    const installResult = await consumeDeferredCliApprovalResult({ ok: true, result: installed.data }, {
      onApprovalRequested: (artifactId, signal) => fixture.owner.withPersonActionClient(
        execute => execute('approval.request.decide', { artifactId, decision: 'approve' }, { signal }),
        { surface: 'coreAction' }),
      execute: fixture.owner.execute,
      token: fixture.owner.credentials.token,
      serverHttpBaseUrl: fixture.actionServerApiUrl,
    });
    expect(installResult).toMatchObject({ ok: true,
      result: { outcome: 'applied', change: { kind: 'committed', pluginId } } });
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
    const active = await readFile(journal, 'utf8');
    expect(active).toContain('module\n');
    expect(active).toContain('open\n');
    expect(active).toContain('close\n');
    const lifecycle = { pluginId, machineId: fixture.machine.target.machineId, scope: 'machine' };
    const disabled = await fixture.owner.executeReviewed('plugins.disable', lifecycle);
    expect(disabled).toMatchObject({ ok: true, result: { ok: true, change: { kind: 'committed' } } });
    const retired = await readFile(journal, 'utf8');
    const oldPid = fixture.machine.daemon.state.pid;
    await fixture.machine.restart();
    const newPid = fixture.machine.daemon.state.pid;
    expect(newPid).not.toBe(oldPid);
    expect(await fixture.executeDatabase(DATABASE_STATEMENT_RUN_ACTION_ID_V1, input))
      .toMatchObject({ ok: false, errorCode: 'plugin_service_unavailable' });
    expect(await readFile(journal, 'utf8')).toBe(retired);
    const enabled = await fixture.owner.executeReviewed('plugins.enable', lifecycle);
    expect(enabled).toMatchObject({ ok: true, result: { ok: true, change: { kind: 'committed' } } });
    await readControl();
    const reactivated = (await readFile(journal, 'utf8')).slice(retired.length).trim().split('\n');
    expect(reactivated).toContain('module');
    expect(reactivated).toContain('open');
    expect(reactivated.at(-1)).toBe('close');
    console.info('F11 cold public install and daemon restart passed', { oldPid, newPid, reactivated });
  } finally { await fixture.stop(); }
}, 0);
