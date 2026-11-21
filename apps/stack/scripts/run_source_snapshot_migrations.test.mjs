import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { preflightSourceRuntimeMigrations } from './runtime/launch/preflightSourceRuntimeMigrations.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { pickNextFreeTcpPort } from './utils/net/ports.mjs';
import { killProcessTree } from './utils/proc/proc.mjs';
import { SOURCE_CONDITION, createWorkspaceSourceResolver, readWorkspacePackages } from '../../../packages/cli-common/sourceRuntimeEntries.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const runScript = join(repoRoot, 'apps/stack/scripts/run.mjs');
const canonicalServer = join(repoRoot, 'apps/server');
const requireServer = createRequire(join(canonicalServer, 'package.json'));

for (const shared of [false, true]) {
  test(`source-snapshot start ${shared ? 'refuses a shared database with pending consumer migrations' : 'applies a pending SQLite migration and serves the adopted export'}`,
    { timeout: 90_000 }, async t => {
      const fixture = await createTempFixture(t, { prefix: 'hstack-source-migration-' });
      const sourceRepo = fixture.path('repo');
      const baseDir = fixture.path('stacks/consumer');
      const output = fixture.path('stacks/source-bundles/bundle-selected');
      const serverDir = join(output, 'apps/server');
      const entrypoint = join(serverDir, 'sources/main.mjs');
      const migration = join(serverDir, 'scripts/migrate.mjs');
      const dataDir = fixture.path('data');
      const dbPath = join(dataDir, 'happier-server-light.sqlite');
      const migrationsDir = join(serverDir, 'prisma/sqlite/migrations');
      for (const directory of [join(sourceRepo, 'node_modules'), join(sourceRepo, 'apps/cli'),
        join(sourceRepo, 'apps/ui'), join(sourceRepo, 'apps/server'), join(baseDir, 'source-runtime'),
        dirname(entrypoint), dirname(migration), dataDir, join(migrationsDir, '20260101000000_base')]) {
        await mkdir(directory, { recursive: true });
      }
      await writeFile(join(sourceRepo, 'package.json'), JSON.stringify({ private: true }));
      await writeFile(join(sourceRepo, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
      for (const component of ['cli', 'ui', 'server']) {
        await writeFile(join(sourceRepo, 'apps', component, 'package.json'), JSON.stringify({ name: `fixture-${component}`, private: true }));
      }
      await writeFile(join(serverDir, 'package.json'), JSON.stringify({ type: 'module' }));
      await symlink(join(canonicalServer, 'node_modules'), join(serverDir, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir');
      // Source snapshots retain both package-local and hoisted dependencies.
      await symlink(join(repoRoot, 'node_modules'), join(output, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir');
      // Compile the real deploy owner as the source builder's SQLite sidecar does.
      // Only its repository-only schema generation is unnecessary for copied SQL.
      const { build } = requireServer('esbuild');
      await build({ stdin: {
        contents: `import { runSqliteMigrationDeploy } from ${JSON.stringify(join(canonicalServer, 'scripts/migrate.sqlite.deploy.ts'))};
import { fileURLToPath as fixtureDatabasePath } from 'node:url';
if (process.env.HAPPIER_SERVER_LIGHT_DATA_DIR !== ${JSON.stringify(dataDir)}) throw new Error('fixture database directory not admitted');
if (process.env.DATABASE_URL && fixtureDatabasePath(new URL(process.env.DATABASE_URL)) !== ${JSON.stringify(dbPath)}) throw new Error('fixture database target not admitted');
await runSqliteMigrationDeploy({serverRoot:${JSON.stringify(serverDir)},runSchemaSync:async()=>{}});`,
        resolveDir: canonicalServer,
      }, outfile: join(dirname(migration), 'migrate.js'), bundle: true, platform: 'node', format: 'esm',
      conditions: [SOURCE_CONDITION],
      plugins: [createWorkspaceSourceResolver({ workspacePackages: await readWorkspacePackages(repoRoot), requireFromProject: requireServer })],
      tsconfig: join(canonicalServer, 'tsconfig.json'), logLevel: 'silent',
      banner: { js: "import { createRequire as createMigrationRequire } from 'node:module'; const require = createMigrationRequire(import.meta.url);" } });
      // The real source builder uses this wrapper too. Running the bundled .js
      // directly would also trip the imported deploy script's CLI-only guard.
      await writeFile(migration, "export * from './migrate.js';\n");
      await writeFile(join(migrationsDir, 'migration_lock.toml'), 'provider = "sqlite"\n');
      await writeFile(join(migrationsDir, '20260101000000_base/migration.sql'),
        "CREATE TABLE MigrationProbe (id TEXT PRIMARY KEY); INSERT INTO MigrationProbe (id) VALUES ('retained');\n");
      const env = { ...process.env,
        HAPPIER_STACK_HOME_DIR: fixture.path('home'), HAPPIER_STACK_STORAGE_DIR: fixture.path('stacks'),
        HAPPIER_STACK_STACK: 'consumer', HAPPIER_STACK_REPO_DIR: sourceRepo,
        HAPPIER_STACK_ENV_FILE: join(baseDir, 'env'), HAPPIER_STACK_RUNTIME_STATE_PATH: join(baseDir, 'stack.runtime.json'),
        HAPPIER_STACK_CLI_HOME_DIR: join(baseDir, 'cli'), HAPPIER_STACK_DAEMON: '0',
        HAPPIER_STACK_RUNTIME_MODE: 'source', HAPPIER_DEV_TARGET_EXECUTION: '1',
        HAPPIER_STACK_SERVER_COMPONENT: 'happier-server-light', HAPPIER_DB_PROVIDER: 'sqlite',
        HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir, DATABASE_URL: '',
        HAPPIER_SQLITE_MIGRATIONS_DIR: migrationsDir, HAPPIER_SQLITE_AUTO_MIGRATE: '1',
        HAPPIER_STACK_TAILSCALE_SERVE: '0', HAPPIER_STACK_AUTO_AUTH_SEED: '0',
        HAPPIER_STACK_MIGRATE_CREDENTIALS: '0', HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
        HAPPIER_STACK_SYNC_BUNDLED_WORKSPACES: '0', RUN_MIGRATIONS: '1', HAPPIER_STACK_PRISMA_MIGRATE: '1',
        HAPPIER_STACK_SHARED_DB_SOURCE_STACK: '', HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: '',
        HAPPIER_STACK_SERVE_UI: '0', HAPPIER_STACK_LOG_TEE_DIR: '', HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      };
      const initial = await runNodeCapture([migration], { cwd: serverDir, env });
      assert.equal(initial.code, 0, `the real migration owner must initialize the disposable database: ${initial.stderr
        .split('\n').filter(line => /Error|code:/.test(line)).join('\n').replaceAll(repoRoot, '<repo>').replaceAll(output, '<fixture>')
        .replace(/(?:postgres(?:ql)?|mysql|https?|file):[^\s"']+/g, '[redacted-url]')}`);
      await mkdir(join(migrationsDir, '20260102000000_pending'));
      await writeFile(join(migrationsDir, '20260102000000_pending/migration.sql'),
        "ALTER TABLE MigrationProbe ADD COLUMN ready TEXT; UPDATE MigrationProbe SET ready = 'applied';\n");
      if (shared) {
        const sourceEnv = fixture.path('source.env');
        await writeFile(sourceEnv, `HAPPIER_DB_PROVIDER=sqlite\nHAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}\nHANDY_MASTER_SECRET=${randomBytes(32).toString('hex')}\n`);
        env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK = 'dev-source';
        env.HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE = sourceEnv;
      }
      await writeFile(entrypoint, `
        import { DatabaseSync } from 'node:sqlite';
        import { readFile } from 'node:fs/promises';
        import { createServer } from 'node:http';
        import { join } from 'node:path';
        const db = new DatabaseSync(${JSON.stringify(dbPath)}, {readOnly:true});
        const row = db.prepare(${JSON.stringify(shared ? 'SELECT id FROM MigrationProbe' : 'SELECT id, ready FROM MigrationProbe')}).get();
        if (row.id !== 'retained' ${shared ? '' : "|| row.ready !== 'applied'"}) throw new Error('schema unavailable before serve');
        db.close();
        createServer(async (req,res)=>{
          if(req.url==='/health') {res.setHeader('content-type','application/json');res.end(JSON.stringify({service:'happier-server',status:'ok'}));return;}
          const name = {'/':'index.html','/_expo/static/adopted.js':'_expo/static/adopted.js'}[req.url];
          if(!name || !process.env.HAPPIER_SERVER_UI_DIR) {res.statusCode=404;res.end();return;}
          try {res.setHeader('content-type', name.endsWith('.html') ? 'text/html' : 'text/javascript');
            res.end(await readFile(join(process.env.HAPPIER_SERVER_UI_DIR,name)));}
          catch {res.statusCode=404;res.end();}
        })
          .listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('MIGRATION_SERVER_READY'));
      `);
      const sourceRuntimeServer = {
        identity: 'selected-migration-source', entrypoint, runtimeDir: serverDir, serverDir,
        args: [], env: { HAPPIER_SQLITE_MIGRATIONS_DIR: migrationsDir },
        serverComponent: 'happier-server-light', dbProvider: 'sqlite',
        migration: { mode: 'external', command: migration, args: [], cwd: serverDir },
      };
      await writeFile(join(output, 'source-bundle.json'), JSON.stringify(sourceRuntimeServer));
      // Drive the reload preflight against the real disposable database, before
      // any replacement process or selected-pointer mutation can occur.
      if (shared) {
        await assert.rejects(preflightSourceRuntimeMigrations({ server: sourceRuntimeServer, env,
          stackBaseDir: baseDir }), error => error.code === 'ESHAREDDBMIGRATIONSMISSING'
            && error.sourceStack === 'dev-source'
            && JSON.stringify(error.missingMigrations) === JSON.stringify(['20260102000000_pending']));
        const refusal = JSON.parse(await readFile(join(baseDir, 'source-runtime/reload.json'), 'utf8'));
        assert.equal(refusal.code, 'ESHAREDDBMIGRATIONSMISSING');
        assert.equal(refusal.sourceStack, 'dev-source');
        assert.deepEqual(refusal.missingMigrations, ['20260102000000_pending']);
      } else {
        await preflightSourceRuntimeMigrations({ server: sourceRuntimeServer,
          env: { ...env, RUN_MIGRATIONS: '0', HAPPIER_STACK_PRISMA_MIGRATE: '0' }, stackBaseDir: baseDir });
        const preflightDb = new DatabaseSync(dbPath, { readOnly: true });
        try { assert.equal(preflightDb.prepare('SELECT ready FROM MigrationProbe').get().ready, 'applied'); }
        finally { preflightDb.close(); }
      }
      await writeFile(join(baseDir, 'source-runtime/selected-server.json'), JSON.stringify({ entrypoint }));
      const sharedUiDir = fixture.path('stacks/source-bundles/web-other-stack/web');
      const html = '<!doctype html><script src="/_expo/static/adopted.js"></script>';
      const script = 'globalThis.adoptedExport = true;';
      if (!shared) {
        await mkdir(join(sharedUiDir, '_expo/static'), { recursive: true });
        await writeFile(join(sharedUiDir, 'index.html'), html);
        await writeFile(join(sharedUiDir, '_expo/static/adopted.js'), script);
        // Remote reload activation writes this on the serving host. Its next
        // run receives reuse flags without a controller-local UI path.
        await writeFile(join(baseDir, 'source-runtime/selected-ui.json'), JSON.stringify({ uiDir: sharedUiDir }));
      }
      // Stack env is the database authority, including explicit empty values
      // that prevent repository defaults from selecting a different database.
      await writeFile(join(baseDir, 'env'), [
        'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
        'HAPPIER_DB_PROVIDER=sqlite',
        'DATABASE_URL=',
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
        'RUN_MIGRATIONS=1', 'HAPPIER_STACK_PRISMA_MIGRATE=1',
        `HAPPIER_STACK_SHARED_DB_SOURCE_STACK=${env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK}`,
        `HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE=${env.HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE}`,
        '',
      ].join('\n'));
      const port = await pickNextFreeTcpPort(40_000);
      env.HAPPIER_STACK_SERVER_PORT = String(port);
      const runner = spawn(process.execPath, [runScript, '--runtime=source', '--reuse-source-runtime', '--restart',
        '--no-dev-targets', '--no-daemon', ...(shared ? ['--no-ui'] : ['--prepared-source-reload']), '--no-browser'],
      { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', signal: t.signal });
      const completion = new Promise(resolve => runner.once('close', resolve));
      t.after(async () => { await killProcessTree(runner, 'SIGTERM'); await completion; });
      let observedOutput = '';
      await new Promise((resolve, reject) => {
        let output = '';
        const observe = chunk => {
          output += String(chunk);
          observedOutput = output;
          if (!shared && output.includes('MIGRATION_SERVER_READY')) resolve();
        };
        runner.stdout.on('data', observe);
        runner.stderr.on('data', observe);
        runner.once('error', reject);
        runner.once('close', code => { if (shared && code !== 0) resolve(); });
        runner.once('close', code => reject(new Error(`source start exited before serving (${code}): ${output.replace(/(?:postgres(?:ql)?|mysql|https?|file):[^\s"']+/g, '[redacted-url]').replace(/(?:Bearer\s+\S+|(?:token|secret|key)\s*[=:]\s*\S+)/gi, '[redacted]')}`)));
      });
      if (shared) {
        assert.ok(observedOutput.includes('20260102000000_pending'));
        assert.ok(observedOutput.includes('dev-source'));
        assert.ok(!observedOutput.includes('MIGRATION_SERVER_READY'));
      }
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL').get().count,
          shared ? 1 : 2);
        const columns = db.prepare('PRAGMA table_info(MigrationProbe)').all().map(row => row.name);
        assert.equal(columns.includes('ready'), !shared);
        assert.equal(db.prepare('SELECT id FROM MigrationProbe').get().id, 'retained');
      } finally { db.close(); }
      const state = JSON.parse(await readFile(join(baseDir, 'stack.runtime.json'), 'utf8'));
      assert.equal(state.sourceRuntimeIdentities.server.selected, 'selected-migration-source');
      if (!shared) {
        const origin = `http://127.0.0.1:${state.ports.server}`;
        const page = await fetch(`${origin}/`);
        assert.equal(page.status, 200, 'the restarted server must serve the adopted export');
        assert.equal(await page.text(), html);
        const asset = await fetch(`${origin}/_expo/static/adopted.js`);
        assert.equal(asset.status, 200);
        assert.equal(await asset.text(), script);
        assert.equal(state.sourceUi, 'export');
        assert.equal(state.sourceUiLaunch.exportDir, await realpath(sharedUiDir));
        const succeedsFirst = '20260103000000_succeeds';
        await mkdir(join(migrationsDir, succeedsFirst));
        await writeFile(join(migrationsDir, succeedsFirst, 'migration.sql'),
          "UPDATE MigrationProbe SET ready = 'still-retained';\n");
        const failedMigration = '20260104000000_invalid';
        await mkdir(join(migrationsDir, failedMigration));
        await writeFile(join(migrationsDir, failedMigration, 'migration.sql'), 'THIS IS INVALID SQL;\n');
        await assert.rejects(preflightSourceRuntimeMigrations({ server: sourceRuntimeServer, env,
          stackBaseDir: baseDir }), error => error.code === 'ERUNTIMESERVERMIGRATIONFAILED'
            && error.failedMigration === failedMigration);
        const refusal = JSON.parse(await readFile(join(baseDir, 'source-runtime/reload.json'), 'utf8'));
        assert.equal(refusal.code, 'ERUNTIMESERVERMIGRATIONFAILED');
        assert.equal(refusal.failedMigration, failedMigration);
        const retained = JSON.parse(await readFile(join(baseDir, 'stack.runtime.json'), 'utf8'));
        assert.equal(retained.sourceRuntimeIdentities.server.selected, state.sourceRuntimeIdentities.server.selected);
      }
    });
}
