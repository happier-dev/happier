import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveYarnCommandInvocation } from '../../../scripts/workspaces/execYarnCommand.mjs';
import { buildStackStableScopeId } from './utils/auth/stable_scope_id.mjs';
import { runNodeCapture } from './testkit/auth_testkit.mjs';

function jwtForAccount(accountId) {
  const base64url = (value) =>
    Buffer.from(value, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url(JSON.stringify({ sub: accountId }))}.sig`;
}

async function createSqliteCopyFixture(t, prefix) {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const repoRoot = dirname(dirname(rootDir));
  const serverDir = join(repoRoot, 'apps', 'server');
  const tmp = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const homeDir = join(tmp, 'home');
  const storageDir = join(tmp, 'storage');
  const workspaceDir = join(tmp, 'workspace');
  const sourceStack = 'dev-auth';
  const targetStack = 'dev';
  const serverPort = 4577;
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const sourceBaseDir = join(storageDir, sourceStack);
  const targetBaseDir = join(storageDir, targetStack);
  const sourceDataDir = join(sourceBaseDir, 'server-light');
  const targetDataDir = join(targetBaseDir, 'server-light');
  const sourceCliHome = join(sourceBaseDir, 'cli');
  const targetCliHome = join(targetBaseDir, 'cli');

  await Promise.all([mkdir(homeDir, { recursive: true }), mkdir(storageDir, { recursive: true }), mkdir(workspaceDir, { recursive: true })]);

  const writeStackEnv = async ({ name, baseDir, cliHomeDir, dataDir }) => {
    await Promise.all([mkdir(baseDir, { recursive: true }), mkdir(cliHomeDir, { recursive: true }), mkdir(dataDir, { recursive: true })]);
    await writeFile(
      join(baseDir, 'env'),
      [
        `HAPPIER_STACK_STACK=${name}`,
        'HAPPIER_STACK_SERVER_COMPONENT=happier-server-light',
        'HAPPIER_DB_PROVIDER=sqlite',
        `HAPPIER_STACK_REPO_DIR=${repoRoot}`,
        `HAPPIER_STACK_CLI_HOME_DIR=${cliHomeDir}`,
        `HAPPIER_STACK_SERVER_PORT=${serverPort}`,
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${dataDir}`,
        `HAPPIER_SERVER_LIGHT_FILES_DIR=${join(dataDir, 'files')}`,
        `HAPPIER_SERVER_LIGHT_DB_DIR=${join(dataDir, 'pglite')}`,
        '',
      ].join('\n'),
      'utf-8'
    );
  };

  await writeStackEnv({ name: sourceStack, baseDir: sourceBaseDir, cliHomeDir: sourceCliHome, dataDir: sourceDataDir });
  await writeStackEnv({ name: targetStack, baseDir: targetBaseDir, cliHomeDir: targetCliHome, dataDir: targetDataDir });

  const migrateSqlite = (dataDir) => {
    const invocation = resolveYarnCommandInvocation(['-s', 'migrate:sqlite:deploy']);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: serverDir,
      env: {
        ...process.env,
        HAPPIER_SERVER_LIGHT_DATA_DIR: dataDir,
        HAPPIER_SERVER_LIGHT_FILES_DIR: join(dataDir, 'files'),
        HAPPIER_SERVER_LIGHT_DB_DIR: join(dataDir, 'pglite'),
        HAPPIER_DB_PROVIDER: 'sqlite',
      },
      encoding: 'utf-8',
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments } : {}),
    });
    assert.equal(result.status, 0, `expected sqlite migrations to succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  };

  const runSqliteClient = async ({ databaseUrl, code }) => {
    const result = await runNodeCapture(
      [
        '--input-type=module',
        '-e',
        `
const { PrismaClient } = await import(${JSON.stringify(join(serverDir, 'generated', 'sqlite-client', 'index.js'))});
const db = new PrismaClient();
try {
${code}
} finally {
  await db.$disconnect();
}
        `.trim(),
      ],
      {
        cwd: serverDir,
        env: { ...process.env, DATABASE_URL: databaseUrl },
      }
    );
    assert.equal(result.code, 0, `sqlite client failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return result.stdout.trim();
  };

  const sourceStableId = buildStackStableScopeId({ stackName: sourceStack, cliIdentity: 'default' });
  const targetStableId = buildStackStableScopeId({ stackName: targetStack, cliIdentity: 'default' });
  const sourceCredentialPath = join(sourceCliHome, 'servers', sourceStableId, 'access.key');
  const targetCredentialPath = join(targetCliHome, 'servers', targetStableId, 'access.key');
  const sourceDatabasePath = join(sourceDataDir, 'happier-server-light.sqlite');
  const targetDatabasePath = join(targetDataDir, 'happier-server-light.sqlite');

  const env = {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: repoRoot,
    HAPPIER_STACK_HOME_DIR: homeDir,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    HAPPIER_STACK_WORKSPACE_DIR: workspaceDir,
    HAPPIER_STACK_STACK: targetStack,
    HAPPIER_STACK_ENV_FILE: join(targetBaseDir, 'env'),
    HAPPIER_STACK_SERVER_PORT: String(serverPort),
    HAPPIER_SERVER_LIGHT_DATA_DIR: targetDataDir,
    HAPPIER_SERVER_LIGHT_FILES_DIR: join(targetDataDir, 'files'),
    HAPPIER_SERVER_LIGHT_DB_DIR: join(targetDataDir, 'pglite'),
    HAPPIER_DB_PROVIDER: 'sqlite',
    // This fixture uses the checkout's already-generated SQLite client. Do not contend
    // with an unrelated workspace dependency refresh while testing copy-from semantics.
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '1',
  };

  const writeSourceAuth = async ({ accountId, secret = 'source-master-secret', settings = '{"machineId":"source-machine"}\n' }) => {
    const credential = JSON.stringify({ token: jwtForAccount(accountId) }) + '\n';
    await mkdir(dirname(sourceCredentialPath), { recursive: true });
    await writeFile(sourceCredentialPath, credential, 'utf-8');
    await writeFile(join(sourceCliHome, 'access.key'), credential, 'utf-8');
    await writeFile(join(sourceCliHome, 'settings.json'), settings, 'utf-8');
    await writeFile(join(sourceDataDir, 'handy-master-secret.txt'), `${secret}\n`, 'utf-8');
  };

  const targetAuthPaths = {
    secret: join(targetDataDir, 'handy-master-secret.txt'),
    legacy: join(targetCliHome, 'access.key'),
    scoped: targetCredentialPath,
    settings: join(targetCliHome, 'settings.json'),
  };
  const sourceAuthPaths = {
    secret: join(sourceDataDir, 'handy-master-secret.txt'),
    legacy: join(sourceCliHome, 'access.key'),
    scoped: sourceCredentialPath,
    settings: join(sourceCliHome, 'settings.json'),
  };

  return {
    rootDir,
    sourceStack,
    targetStack,
    sourceDataDir,
    targetDataDir,
    sourceDatabaseUrl: `file:${sourceDatabasePath}`,
    targetDatabaseUrl: `file:${targetDatabasePath}`,
    sourceDatabasePath,
    targetDatabasePath,
    sourceAuthPaths,
    targetAuthPaths,
    env,
    migrateSqlite,
    runSqliteClient,
    writeSourceAuth,
  };
}

async function readAuthBytes(paths) {
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, 'utf-8')])));
}

async function readAccountData(runSqliteClient, databaseUrl) {
  return JSON.parse(
    await runSqliteClient({
      databaseUrl,
      code: `
const [accounts, cascadeRows, restrictRows] = await Promise.all([
  db.account.findMany({ select: { id: true, publicKey: true, updatedAt: true }, orderBy: { id: 'asc' } }),
  db.accountSettingsSnapshot.findMany({ select: { id: true, accountId: true, version: true, encryptionMode: true, contentKind: true }, orderBy: { id: 'asc' } }),
  db.accountPushToken.findMany({ select: { id: true, accountId: true, token: true, clientServerUrl: true }, orderBy: { id: 'asc' } }),
]);
console.log(JSON.stringify({ accounts, cascadeRows, restrictRows }));
      `,
    })
  );
}

function withoutAccountTimestamps(data) {
  return {
    ...data,
    accounts: data.accounts.map(({ updatedAt, ...account }) => account),
  };
}

test('hstack stack auth copy-from --force rejects a conflicting populated sqlite target before replacing any target auth or account data', async (t) => {
  const fixture = await createSqliteCopyFixture(t, 'hstack-auth-copy-from-force-atomicity-');
  fixture.migrateSqlite(fixture.sourceDataDir);
  fixture.migrateSqlite(fixture.targetDataDir);

  const sourceAccountId = 'z-source-conflict';
  const additionalSourceAccountId = 'a-source-new-account';
  const targetAccountId = 'target-account';
  const sharedPublicKey = 'conflicting-public-key';
  await fixture.runSqliteClient({
    databaseUrl: fixture.sourceDatabaseUrl,
    code: `
await db.account.create({ data: { id: ${JSON.stringify(additionalSourceAccountId)}, publicKey: 'additional-source-public-key' } });
await db.account.create({ data: { id: ${JSON.stringify(sourceAccountId)}, publicKey: ${JSON.stringify(sharedPublicKey)} } });
console.log('ok');
    `,
  });
  await fixture.runSqliteClient({
    databaseUrl: fixture.targetDatabaseUrl,
    code: `
await db.account.create({ data: { id: ${JSON.stringify(targetAccountId)}, publicKey: ${JSON.stringify(sharedPublicKey)} } });
await db.accountSettingsSnapshot.create({
  data: { id: 'cascade-owned-row', accountId: ${JSON.stringify(targetAccountId)}, version: 1, encryptionMode: 'e2ee', contentKind: 'settings' },
});
await db.accountPushToken.create({
  data: { id: 'restrict-owned-row', accountId: ${JSON.stringify(targetAccountId)}, token: 'restrict-token', clientServerUrl: 'http://target.invalid' },
});
console.log('ok');
    `,
  });
  await fixture.writeSourceAuth({ accountId: sourceAccountId, secret: 'source-secret-do-not-print' });
  await mkdir(dirname(fixture.targetAuthPaths.scoped), { recursive: true });
  await writeFile(fixture.targetAuthPaths.secret, 'target-secret-do-not-replace\n', 'utf-8');
  await writeFile(fixture.targetAuthPaths.legacy, 'target-legacy-token\n', 'utf-8');
  await writeFile(fixture.targetAuthPaths.scoped, 'target-scoped-token\n', 'utf-8');
  await writeFile(fixture.targetAuthPaths.settings, '{"machineId":"target-machine"}\n', 'utf-8');

  const targetRowsBefore = await readAccountData(fixture.runSqliteClient, fixture.targetDatabaseUrl);
  const targetAuthBefore = await readAuthBytes(fixture.targetAuthPaths);
  const sourceRowsBefore = await readAccountData(fixture.runSqliteClient, fixture.sourceDatabaseUrl);
  const sourceAuthBefore = await readAuthBytes(fixture.sourceAuthPaths);
  const sourceDatabaseBytesBefore = await readFile(fixture.sourceDatabasePath);

  const result = await runNodeCapture(
    [join(fixture.rootDir, 'scripts', 'stack.mjs'), 'auth', fixture.targetStack, '--', 'copy-from', fixture.sourceStack, '--force', '--offline-ok', '--json'],
    { cwd: fixture.rootDir, env: fixture.env }
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.code, 0, `expected conflicting force copy to fail\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(output, /account.*conflict/i, `expected account conflict failure\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.doesNotMatch(output, /source-secret-do-not-print|target-secret-do-not-replace|target-legacy-token|target-scoped-token/, 'must not disclose credentials or secrets');
  assert.deepEqual(await readAccountData(fixture.runSqliteClient, fixture.targetDatabaseUrl), targetRowsBefore, 'target account and owned rows must remain unchanged');
  assert.deepEqual(await readAuthBytes(fixture.targetAuthPaths), targetAuthBefore, 'target secret, credentials, and settings must remain byte-identical');
  assert.deepEqual(await readAccountData(fixture.runSqliteClient, fixture.sourceDatabaseUrl), sourceRowsBefore, 'source account data must remain unchanged');
  assert.deepEqual(await readAuthBytes(fixture.sourceAuthPaths), sourceAuthBefore, 'source auth files must remain unchanged');
  assert.deepEqual(await readFile(fixture.sourceDatabasePath), sourceDatabaseBytesBefore, 'source sqlite bytes must remain unchanged');
});

test('hstack stack auth copy-from --force still seeds a fresh compatible sqlite target', async (t) => {
  const fixture = await createSqliteCopyFixture(t, 'hstack-auth-copy-from-force-compatible-');
  fixture.migrateSqlite(fixture.sourceDataDir);

  const sourceAccountId = 'source-compatible-account';
  await fixture.runSqliteClient({
    databaseUrl: fixture.sourceDatabaseUrl,
    code: `
await db.account.create({ data: { id: ${JSON.stringify(sourceAccountId)}, publicKey: 'source-compatible-public-key' } });
console.log('ok');
    `,
  });
  await fixture.writeSourceAuth({ accountId: sourceAccountId });
  const sourceRowsBefore = await readAccountData(fixture.runSqliteClient, fixture.sourceDatabaseUrl);
  const sourceAuthBefore = await readAuthBytes(fixture.sourceAuthPaths);
  const sourceDatabaseBytesBefore = await readFile(fixture.sourceDatabasePath);

  const result = await runNodeCapture(
    [join(fixture.rootDir, 'scripts', 'stack.mjs'), 'auth', fixture.targetStack, '--', 'copy-from', fixture.sourceStack, '--force', '--offline-ok', '--json'],
    { cwd: fixture.rootDir, env: fixture.env }
  );
  assert.equal(result.code, 0, `expected compatible force copy to succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true, `expected successful copy result\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.equal(parsed.copied?.db, true, `expected the compatible target Account seed to succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(
    withoutAccountTimestamps(await readAccountData(fixture.runSqliteClient, fixture.targetDatabaseUrl)),
    withoutAccountTimestamps(sourceRowsBefore),
    'target must contain the copied source Account without extra rows'
  );
  const sourceAuthAfter = await readAuthBytes(fixture.sourceAuthPaths);
  assert.deepEqual(
    await readAuthBytes(fixture.targetAuthPaths),
    { ...sourceAuthAfter, secret: sourceAuthAfter.secret.trim() },
    'target must receive the approved credential/settings bytes and normalized master secret'
  );
  assert.deepEqual(await readAccountData(fixture.runSqliteClient, fixture.sourceDatabaseUrl), sourceRowsBefore, 'source account data must remain unchanged');
  assert.deepEqual(sourceAuthAfter, sourceAuthBefore, 'source auth files must remain unchanged');
  assert.deepEqual(await readFile(fixture.sourceDatabasePath), sourceDatabaseBytesBefore, 'source sqlite bytes must remain unchanged');
});

test('hstack stack auth copy-from --force leaves an identical existing Account and its owned data untouched', async (t) => {
  const fixture = await createSqliteCopyFixture(t, 'hstack-auth-copy-from-force-idempotent-');
  fixture.migrateSqlite(fixture.sourceDataDir);
  fixture.migrateSqlite(fixture.targetDataDir);

  const accountId = 'shared-account';
  const publicKey = 'shared-public-key';
  const timestamp = '2020-01-01T00:00:00.000Z';
  await fixture.runSqliteClient({
    databaseUrl: fixture.sourceDatabaseUrl,
    code: `
await db.account.create({ data: { id: ${JSON.stringify(accountId)}, publicKey: ${JSON.stringify(publicKey)}, updatedAt: new Date(${JSON.stringify(timestamp)}) } });
console.log('ok');
    `,
  });
  await fixture.runSqliteClient({
    databaseUrl: fixture.targetDatabaseUrl,
    code: `
await db.account.create({ data: { id: ${JSON.stringify(accountId)}, publicKey: ${JSON.stringify(publicKey)}, updatedAt: new Date(${JSON.stringify(timestamp)}) } });
await db.accountSettingsSnapshot.create({
  data: { id: 'idempotent-cascade-row', accountId: ${JSON.stringify(accountId)}, version: 1, encryptionMode: 'e2ee', contentKind: 'settings' },
});
await db.accountPushToken.create({
  data: { id: 'idempotent-restrict-row', accountId: ${JSON.stringify(accountId)}, token: 'idempotent-restrict-token', clientServerUrl: 'http://target.invalid' },
});
console.log('ok');
    `,
  });
  await fixture.writeSourceAuth({ accountId });
  const targetRowsBefore = await readAccountData(fixture.runSqliteClient, fixture.targetDatabaseUrl);

  const result = await runNodeCapture(
    [join(fixture.rootDir, 'scripts', 'stack.mjs'), 'auth', fixture.targetStack, '--', 'copy-from', fixture.sourceStack, '--force', '--offline-ok', '--json'],
    { cwd: fixture.rootDir, env: fixture.env }
  );
  assert.equal(result.code, 0, `expected same-key copy to succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.copied?.db, true, `expected same-key DB seed to succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(await readAccountData(fixture.runSqliteClient, fixture.targetDatabaseUrl), targetRowsBefore, 'same-key copy must not rewrite the existing Account or owned rows');
});

test('hstack auth copy-from --all --force fails the aggregate command when a scoped target Account conflicts', async (t) => {
  const fixture = await createSqliteCopyFixture(t, 'hstack-auth-copy-from-force-all-');
  fixture.migrateSqlite(fixture.sourceDataDir);
  fixture.migrateSqlite(fixture.targetDataDir);

  const sourceAccountId = 'source-all-conflict';
  const targetAccountId = 'target-all-conflict';
  const sharedPublicKey = 'all-conflicting-public-key';
  await fixture.runSqliteClient({
    databaseUrl: fixture.sourceDatabaseUrl,
    code: `
await db.account.create({ data: { id: ${JSON.stringify(sourceAccountId)}, publicKey: ${JSON.stringify(sharedPublicKey)} } });
console.log('ok');
    `,
  });
  await fixture.runSqliteClient({
    databaseUrl: fixture.targetDatabaseUrl,
    code: `
await db.account.create({ data: { id: ${JSON.stringify(targetAccountId)}, publicKey: ${JSON.stringify(sharedPublicKey)} } });
await db.accountSettingsSnapshot.create({
  data: { id: 'all-cascade-owned-row', accountId: ${JSON.stringify(targetAccountId)}, version: 1, encryptionMode: 'e2ee', contentKind: 'settings' },
});
await db.accountPushToken.create({
  data: { id: 'all-restrict-owned-row', accountId: ${JSON.stringify(targetAccountId)}, token: 'all-restrict-token', clientServerUrl: 'http://target.invalid' },
});
console.log('ok');
    `,
  });
  await fixture.writeSourceAuth({ accountId: sourceAccountId });
  await mkdir(dirname(fixture.targetAuthPaths.scoped), { recursive: true });
  await writeFile(fixture.targetAuthPaths.secret, 'all-target-secret\n', 'utf-8');
  await writeFile(fixture.targetAuthPaths.legacy, 'all-target-legacy\n', 'utf-8');
  await writeFile(fixture.targetAuthPaths.scoped, 'all-target-scoped\n', 'utf-8');
  await writeFile(fixture.targetAuthPaths.settings, '{"machineId":"all-target-machine"}\n', 'utf-8');

  const targetRowsBefore = await readAccountData(fixture.runSqliteClient, fixture.targetDatabaseUrl);
  const targetAuthBefore = await readAuthBytes(fixture.targetAuthPaths);
  const result = await runNodeCapture(
    [join(fixture.rootDir, 'scripts', 'auth.mjs'), 'copy-from', fixture.sourceStack, '--all', '--except=main', '--force', '--offline-ok', '--json'],
    { cwd: fixture.rootDir, env: fixture.env }
  );

  assert.notEqual(result.code, 0, `expected failed aggregate copy to exit nonzero\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false, `expected aggregate copy result to report failure\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /account.*conflict/i, `expected Account conflict to reach the aggregate result\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.deepEqual(await readAccountData(fixture.runSqliteClient, fixture.targetDatabaseUrl), targetRowsBefore, 'aggregate failure must preserve target Account and owned rows');
  assert.deepEqual(await readAuthBytes(fixture.targetAuthPaths), targetAuthBefore, 'aggregate failure must preserve target auth bytes');
});
