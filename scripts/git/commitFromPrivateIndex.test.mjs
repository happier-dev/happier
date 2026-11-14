import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { commitFromPrivateIndex } from './commitFromPrivateIndex.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'private-index-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.GIT_INDEX_FILE;
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  const write = (name, value) => fs.writeFileSync(path.join(cwd, name), value);
  git('init', '-q');
  git('config', 'user.name', 'Fixture Author');
  git('config', 'user.email', 'fixture@example.invalid');
  for (const name of ['changed', 'deleted', 'unrelated']) write(name, 'base\n');
  git('add', '--all');
  git('commit', '-qm', 'test: base');
  write('message', 'fix: selected packet\n');
  return { cwd, git, write, messageFile: path.join(cwd, 'message') };
}

test('syncs additions, deletions and unusual filenames without changing other staging or disk', async (t) => {
  const f = fixture(t);
  f.write('unrelated', 'foreign staging\n');
  f.git('add', '--', 'unrelated');
  f.write('unrelated', 'foreign disk\n');
  const before = f.git('ls-files', '--stage', '-z', '--', 'unrelated');
  f.write('changed', 'selected\n');
  f.write('new [file]\tname', 'added\n');
  fs.unlinkSync(path.join(f.cwd, 'deleted'));
  const paths = ['changed', 'deleted', 'new [file]\tname'];
  await commitFromPrivateIndex({ ...f, paths });
  assert.equal(f.git('diff', '--cached', '--name-status', '--', ...paths), '');
  assert.equal(f.git('ls-files', '--stage', '-z', '--', 'unrelated'), before);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'unrelated'), 'utf8'), 'foreign disk\n');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'changed'), 'utf8'), 'selected\n');
  assert.equal(fs.existsSync(path.join(f.cwd, 'deleted')), false);
});

test('waits for an existing index.lock without deleting it', async (t) => {
  const f = fixture(t);
  f.write('changed', 'selected\n');
  const lock = path.join(f.cwd, '.git', 'index.lock');
  fs.writeFileSync(lock, 'other writer');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./commitFromPrivateIndex.mjs', import.meta.url)), '--message-file', f.messageFile, '--', 'changed'], { cwd: f.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const closed = once(child, 'close');
  // A notification from the real script makes the assertion independent of CPU speed.
  await Promise.race([
    new Promise((resolve) => child.stderr.on('data', () => { if (stderr.includes('Waiting for shared index lock')) resolve(); })),
    closed.then(() => assert.fail('commit exited before waiting for the shared lock')),
  ]);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other writer');
  assert.equal(child.exitCode, null);
  fs.unlinkSync(lock); // Only the fixture's owner releases its own lock.
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  assert.equal(f.git('diff', '--cached', '--name-status', '--', 'changed'), '');
});

test('partial patches preserve excluded work and recovery synchronizes without a second commit', async (t) => {
  const f = fixture(t);
  f.write('changed', 'selected\n');
  const patchFile = path.join(f.cwd, 'selected.patch');
  fs.writeFileSync(patchFile, f.git('diff', '--', 'changed'));
  f.write('changed', 'selected\nexcluded\n');
  const commit = await commitFromPrivateIndex({ ...f, paths: [], patchFile });
  assert.equal(f.git('show', 'HEAD:changed'), 'selected\n');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'changed'), 'utf8'), 'selected\nexcluded\n');
  assert.equal(f.git('diff', '--cached', '--name-status', '--', 'changed'), '');
  f.git('update-index', '--cacheinfo', `100644,${f.git('rev-parse', 'HEAD^:changed').trim()},changed`);
  await commitFromPrivateIndex({ cwd: f.cwd, syncCommit: commit });
  assert.equal(f.git('rev-parse', 'HEAD').trim(), commit);
  assert.equal(f.git('diff', '--cached', '--name-status', '--', 'changed'), '');
});

test('refuses directories and empty packets without advancing HEAD', async (t) => {
  const f = fixture(t);
  const before = f.git('rev-parse', 'HEAD');
  await assert.rejects(commitFromPrivateIndex({ ...f, paths: ['changed'] }), /empty commit/);
  await assert.rejects(commitFromPrivateIndex({ ...f, paths: ['.'] }), /exact files/);
  await assert.rejects(commitFromPrivateIndex({ ...f, paths: ['.project/report.md'] }), /outside .project/);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
});

test('concurrent CLI packets preserve both commits and synchronize their exact paths', async (t) => {
  const f = fixture(t);
  const base = f.git('rev-parse', 'HEAD').trim();
  const names = ['changed', ' parallel\nfile'];
  for (const name of names) f.write(name, `${name}\n`);
  await Promise.all(names.map(async (name) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./commitFromPrivateIndex.mjs', import.meta.url)), '--message-file', f.messageFile, '--', name], { cwd: f.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    const [code] = await once(child, 'close');
    assert.equal(code, 0, stderr);
  }));
  assert.equal(f.git('rev-list', '--count', `${base}..HEAD`).trim(), '2');
  for (const name of names) assert.equal(f.git('show', `HEAD:${name}`), `${name}\n`);
  assert.equal(f.git('diff', '--cached', '--name-status', '--', ...names), '');
});

test('recovery never stages descendants when a later commit replaced a selected file with a directory', async (t) => {
  const f = fixture(t);
  f.write('changed', 'selected\n');
  const commit = await commitFromPrivateIndex({ ...f, paths: ['changed'] });
  fs.unlinkSync(path.join(f.cwd, 'changed'));
  fs.mkdirSync(path.join(f.cwd, 'changed'));
  f.write('changed/child', 'later commit\n');
  f.git('add', '--', 'changed');
  f.git('commit', '-qm', 'test: replace with directory');
  f.write('changed/child', 'other staging\n');
  f.git('add', '--', 'changed/child');
  const before = f.git('ls-files', '--stage', '-z', '--', 'changed/child');
  await commitFromPrivateIndex({ cwd: f.cwd, syncCommit: commit });
  assert.equal(f.git('ls-files', '--stage', '-z', '--', 'changed/child'), before);
});
