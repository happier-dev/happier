import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createTempFixture } from '../../testkit/core/temp_fixture.mjs';
import { runCommandCapture } from '../../testkit/core/run_node_capture.mjs';

test('standby capacity inspection includes authored build and fixture source', async t => {
  const fixture = await createTempFixture(t);
  const home = fixture.path('home');
  let sourceBytes = 0;
  for (const directory of ['apps/stack/scripts/build', 'packages/triage-qa/src/coverage', 'packages/plugin-sdk/fixtures/external/dist']) {
    await mkdir(`${home}/workspace/dev/${directory}`, { recursive: true });
    const content = 'portable-source\n';
    await writeFile(`${home}/workspace/dev/${directory}/source.js`, content);
    sourceBytes += Buffer.byteLength(content);
  }
  const tool = fileURLToPath(new URL('./guest_backup.py', import.meta.url));
  const result = await runCommandCapture('python3', [tool, 'inspect-home'], { env: { ...process.env, HOME: home } });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).requiredBytes >= sourceBytes, 'capacity must include portable authored source');
});

test('agent-home standby capture uses online backup including committed WAL and excludes isolation homes', async t => {
  const fixture = await createTempFixture(t);
  const home = fixture.path('home');
  await mkdir(`${home}/.codex`, { recursive: true });
  for (const excluded of ['.codex/tmp', '.happier/connected-services/materialized', '.happier/connected-services/isolation', '.happier/stacks/proof/server-light']) {
    await mkdir(`${home}/${excluded}`, { recursive: true });
    // Deliberately invalid SQLite: entering any excluded tree must fail capture.
    await writeFile(`${home}/${excluded}/private.sqlite`, 'excluded fixture');
  }
  const writer = spawn('python3', ['-u', '-c',
    'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL"); c.execute("CREATE TABLE messages (body TEXT)"); c.execute("INSERT INTO messages VALUES (?)", ("committed-in-wal",)); c.commit(); print("READY",flush=True); sys.stdin.read()',
    `${home}/.codex/state.sqlite`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = new Promise(resolve => writer.once('close', resolve));
  t.after(async () => { writer.stdin.end(); await exit; });
  await new Promise((resolve, reject) => { writer.stdout.once('data', resolve); writer.once('error', reject); writer.once('close', code => reject(new Error(`writer exited ${code}`))); });
  const tool = fileURLToPath(new URL('./guest_backup.py', import.meta.url));
  const result = await runCommandCapture('python3', [tool, 'capture-agents', home], { env: process.env });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.paths, ['.codex/state.sqlite']);
  const snapshot = `${home}/.happier-stack/standby-sqlite/.codex/state.sqlite.snapshot`;
  const inspect = await runCommandCapture('python3', ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT body FROM messages").fetchone()[0])', snapshot]);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.equal(inspect.stdout.trim(), 'committed-in-wal');
  const metadata = JSON.parse(await readFile(`${home}/.happier-stack/standby-sqlite/manifest.json`, 'utf8'));
  assert.ok(metadata.capturedAt);
});

test('agent-home capture refuses symlinked database files outside the declared home', async t => {
  const fixture = await createTempFixture(t);
  const home = fixture.path('home');
  await mkdir(`${home}/.codex`, { recursive: true });
  await writeFile(fixture.path('outside.sqlite'), 'must not be opened');
  await symlink(fixture.path('outside.sqlite'), `${home}/.codex/state.sqlite`);
  const tool = fileURLToPath(new URL('./guest_backup.py', import.meta.url));
  const result = await runCommandCapture('python3', [tool, 'capture-agents', home]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /symlink/i);
});

test('agent capture rejects a staging ancestor symlink before creating directories outside the home', async t => {
  const fixture = await createTempFixture(t);
  const home = fixture.path('home');
  await mkdir(`${home}/.codex/nested`, { recursive: true });
  await mkdir(`${home}/.happier-stack/standby-sqlite`, { recursive: true });
  const outside = fixture.path('outside');
  await mkdir(outside);
  await symlink(outside, `${home}/.happier-stack/standby-sqlite/.codex`);
  const setup = await runCommandCapture('python3', ['-c', 'import sqlite3,sys; sqlite3.connect(sys.argv[1]).execute("CREATE TABLE proof (v TEXT)")', `${home}/.codex/nested/state.sqlite`]);
  assert.equal(setup.code, 0, setup.stderr);
  const tool = fileURLToPath(new URL('./guest_backup.py', import.meta.url));
  const result = await runCommandCapture('python3', [tool, 'capture-agents', home]);
  assert.notEqual(result.code, 0);
  await assert.rejects(access(`${outside}/nested`), { code: 'ENOENT' });
});
