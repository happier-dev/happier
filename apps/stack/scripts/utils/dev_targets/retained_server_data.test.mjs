import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { runNodeCapture } from '../../testkit/core/run_node_capture.mjs';
import { fingerprintRetainedServerData, moveRetainedServerData, ensureRemoteServerDataReady } from './retained_server_data.mjs';
import { resolveRemoteStackStatePaths } from './remote_commands.mjs';

async function setup(t) {
  const fixture = await createTempFixture(t, { prefix: 'retained-server-data-' });
  const stackBaseDir = fixture.path('source');
  const sourceDir = join(stackBaseDir, 'server-light');
  const target = { name: 'linux', platform: 'posix', repoDir: fileURLToPath(new URL('../../../../../', import.meta.url)), cliHomeDir: fixture.path('target'), ssh: 'test-ssh-boundary' };
  const paths = resolveRemoteStackStatePaths(target, { stackName: 'qa-retained', runtimeMode: 'controlled' });
  await mkdir(join(sourceDir, 'files', 'empty'), { recursive: true });
  await mkdir(join(sourceDir, 'private-files'), { recursive: true });
  const database = new DatabaseSync(join(sourceDir, 'happier-server-light.sqlite'));
  database.exec('CREATE TABLE Account (id TEXT PRIMARY KEY); INSERT INTO Account VALUES (\'retained-account\')');
  database.close();
  await writeFile(join(sourceDir, 'handy-master-secret.txt'), 'retained-signing-material', { mode: 0o600 });
  await writeFile(join(sourceDir, 'files', 'public.bin'), Buffer.from([0, 255, 13, 10]));
  await writeFile(join(sourceDir, 'private-files', 'private.bin'), Buffer.from([255, 0, 42]));
  const configPath = fixture.path('placement.json');
  const config = { runtimePlacement: { server: { mode: 'local' }, expo: { mode: 'prefer-target', target: 'metro' }, daemon: { mode: 'local' } } };
  await writeFile(configPath, JSON.stringify(config));
  const options = { target, stackName: 'qa-retained', stackBaseDir, config, env: {}, persistPlacement: async () => {
    config.runtimePlacement.server = { mode: 'prefer-target', target: target.name };
    await writeFile(configPath, JSON.stringify(config));
  } };
  // Replace only SSH command/file transport; worker, archives and SQLite stay real.
  const dependencies = { runCommand: async ({ commandArgs }) => {
    const result = await runNodeCapture(commandArgs.slice(1), { cwd: target.repoDir, env: { ...process.env, HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1' } });
    return { code: result.code, out: result.stdout, err: result.stderr };
  }, transferFile: async ({ localPath, remotePath }) => { await cp(localPath, remotePath); } };
  return { fixture, options, dependencies, sourceDir, paths, configPath };
}

test('shared database readiness accepts separate QA data state without requiring a consumer database', async t => {
  const fixture = await createTempFixture(t);
  const result = await ensureRemoteServerDataReady({
    target: { name: 'mac-host', platform: 'posix', repoDir: '/mirror', cliHomeDir: '/state/qa/cli' }, stackName: 'qa', stackBaseDir: fixture.root,
    config: { runtimePlacement: { server: { mode: 'prefer-target', target: 'mac-host' } } },
    env: { HAPPIER_STACK_SHARED_DB_SOURCE_STACK: 'dev', HAPPIER_STACK_SHARED_DB_SOURCE_ENV_FILE: '/state/dev/env' },
  }, { runCommand: async () => ({ code: 0, out: '{"retainedRemoteData":false}' }) });
  assert.equal(result.retainedRemoteData, true);
});

test('server handoff copies and verifies the entire retained tree, preserving the source and account', async t => {
  const { options, dependencies, sourceDir, paths, configPath } = await setup(t);
  const fingerprint = await fingerprintRetainedServerData(sourceDir);
  const result = await moveRetainedServerData(options, dependencies);
  assert.equal(result.sourceRetained, true);
  assert.equal(await fingerprintRetainedServerData(sourceDir), fingerprint);
  assert.equal(await fingerprintRetainedServerData(paths.serverLightDataDir), fingerprint);
  assert.equal((await stat(join(paths.serverLightDataDir, 'files/empty'))).isDirectory(), true);
  assert.equal((await stat(join(paths.serverLightDataDir, 'handy-master-secret.txt'))).mode & 0o777, 0o600);
  const database = new DatabaseSync(join(paths.serverLightDataDir, 'happier-server-light.sqlite'), { readOnly: true });
  try { assert.equal(database.prepare('SELECT id FROM Account').get().id, 'retained-account'); } finally { database.close(); }
  assert.equal(JSON.parse(await readFile(configPath)).runtimePlacement.expo.target, 'metro');
});

test('corrupt transport never activates placement or removes the source', async t => {
  const { options, dependencies, sourceDir, configPath } = await setup(t);
  const before = await readFile(configPath);
  dependencies.transferFile = async ({ localPath, remotePath }) => {
    const archive = await readFile(localPath);
    const signingPayload = archive.indexOf('retained-signing-material');
    assert.notEqual(signingPayload, -1);
    archive[signingPayload] ^= 1;
    await writeFile(remotePath, archive);
  };
  await assert.rejects(moveRetainedServerData(options, dependencies), /retained server data operation failed/);
  assert.deepEqual(await readFile(configPath), before);
  assert.equal(await readFile(join(sourceDir, 'handy-master-secret.txt'), 'utf8'), 'retained-signing-material');
});

test('a complete checksummed transfer rejects a corrupt SQLite database before placement', async t => {
  const { options, dependencies, sourceDir, configPath } = await setup(t);
  const before = await readFile(configPath);
  await writeFile(join(sourceDir, 'happier-server-light.sqlite'), 'invalid sqlite bytes');
  await assert.rejects(moveRetainedServerData(options, dependencies), /retained server data operation failed/);
  assert.deepEqual(await readFile(configPath), before);
});

test('source changes during the transfer retain local authority and the new source bytes', async t => {
  const { options, dependencies, sourceDir, configPath } = await setup(t);
  const before = await readFile(configPath);
  const upload = dependencies.transferFile;
  dependencies.transferFile = async args => {
    await upload(args);
    await writeFile(join(sourceDir, 'private-files/private.bin'), 'later source bytes');
  };
  await assert.rejects(moveRetainedServerData(options, dependencies), /source server data changed during transfer/);
  assert.deepEqual(await readFile(configPath), before);
  assert.equal(await readFile(join(sourceDir, 'private-files/private.bin'), 'utf8'), 'later source bytes');
});

test('different existing target data is never overwritten; an identical recovery copy is reusable', async t => {
  const { options, dependencies, sourceDir, paths, configPath } = await setup(t);
  await cp(sourceDir, paths.serverLightDataDir, { recursive: true });
  await writeFile(join(paths.serverLightDataDir, 'private-files/private.bin'), 'different target data');
  const before = await readFile(configPath);
  await assert.rejects(moveRetainedServerData(options, dependencies), /retained server data operation failed/);
  assert.deepEqual(await readFile(configPath), before);
  assert.equal(await readFile(join(paths.serverLightDataDir, 'private-files/private.bin'), 'utf8'), 'different target data');
  await cp(join(sourceDir, 'private-files/private.bin'), join(paths.serverLightDataDir, 'private-files/private.bin'));
  assert.equal((await moveRetainedServerData(options, dependencies)).moved, true);
});

test('running source cannot be captured, and missing remote retained data cannot initialize a fresh server', async t => {
  const { options, dependencies, sourceDir, paths, configPath } = await setup(t);
  const before = await readFile(configPath);
  await writeFile(join(options.stackBaseDir, 'stack.runtime.json'), JSON.stringify({ stackName: options.stackName, ownerPid: process.pid }));
  await assert.rejects(moveRetainedServerData(options, dependencies), /stop stack|live lifecycle owner/);
  assert.deepEqual(await readFile(configPath), before);
  await assert.rejects(ensureRemoteServerDataReady(options, dependencies), /retained data is still local|retained server data operation failed/);
  await mkdir(paths.serverLightDataDir, { recursive: true });
  await writeFile(join(paths.serverLightDataDir, 'orphan'), 'partial');
  options.config.runtimePlacement.server = { mode: 'prefer-target', target: options.target.name };
  await assert.rejects(ensureRemoteServerDataReady(options, dependencies), /missing happier-server-light.sqlite|retained server data operation failed/);
  assert.ok(await fingerprintRetainedServerData(sourceDir));
});

test('a remote database does not supersede local retained authority until explicit handoff records placement', async t => {
  const { options, dependencies, sourceDir, paths } = await setup(t);
  await cp(sourceDir, paths.serverLightDataDir, { recursive: true });
  await assert.rejects(ensureRemoteServerDataReady(options, dependencies), /move-server/);
  options.config.runtimePlacement.server = { mode: 'prefer-target', target: options.target.name };
  await ensureRemoteServerDataReady(options, dependencies);
});

test('handoff refuses storage overrides that the remote server cannot consume through its directory layout', async t => {
  const { fixture, options, dependencies, configPath } = await setup(t);
  const before = await readFile(configPath);
  options.env.HAPPIER_SERVER_LIGHT_FILES_DIR = fixture.path('external-public-files');
  await mkdir(options.env.HAPPIER_SERVER_LIGHT_FILES_DIR);
  await writeFile(join(options.env.HAPPIER_SERVER_LIGHT_FILES_DIR, 'retained.bin'), 'external retained file');
  await assert.rejects(moveRetainedServerData(options, dependencies), /storage overrides/);
  assert.deepEqual(await readFile(configPath), before);
});

test('persisted remote authority never initializes a missing replacement even after the source was removed', async t => {
  const { options, dependencies, sourceDir } = await setup(t);
  await rm(sourceDir, { recursive: true });
  options.config.runtimePlacement.server = { mode: 'prefer-target', target: options.target.name };
  await assert.rejects(ensureRemoteServerDataReady(options, dependencies), /retained server data operation failed/);
});

test('readiness observes existing target data so fresh placement cannot fall back across retained authority', async t => {
  const { options, dependencies, sourceDir, paths } = await setup(t);
  await cp(sourceDir, paths.serverLightDataDir, { recursive: true });
  await rm(sourceDir, { recursive: true });
  assert.deepEqual(await ensureRemoteServerDataReady(options, dependencies), { retainedRemoteData: true });
  await rm(paths.serverLightDataDir, { recursive: true });
  assert.deepEqual(await ensureRemoteServerDataReady(options, dependencies), { retainedRemoteData: false });
});

test('retained tree checksums distinguish file membership from metadata-shaped file contents', async t => {
  const fixture = await createTempFixture(t, { prefix: 'retained-tree-framing-' });
  const original = fixture.path('original');
  const folded = fixture.path('folded');
  await mkdir(original);
  await mkdir(folded);
  await writeFile(join(original, 'a'), 'payload');
  await writeFile(join(original, 'b'), 'tail');
  const mode = (await stat(join(original, 'b'))).mode & 0o777;
  await writeFile(join(folded, 'a'), `payload${JSON.stringify(['b', 'file', mode])}tail`);
  assert.notEqual(await fingerprintRetainedServerData(original), await fingerprintRetainedServerData(folded));
});
