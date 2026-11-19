import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const owner = process.env.P03_TREE_TEST_OWNER || fileURLToPath(new URL('./commitTreeEntryLoads.mjs', import.meta.url));

test('a report canceled during an entry load removes its extracted tree', { timeout: 15_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'p03-tree-retention-'));
  const repo = join(scratch, 'repo');
  const hostTmp = join(scratch, 'host-tmp');
  mkdirSync(repo);
  mkdirSync(hostTmp);
  const marker = join(scratch, 'reader.json');
  const env = { ...process.env, TMPDIR: hostTmp, P03_TREE_TEST_MARKER: marker };
  delete env.GIT_INDEX_FILE;
  delete env.P03_COMMIT_TREE_WORK_DIR;
  delete env.P03_COMMIT_TREE_HOST_TMP;
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
  const write = (name, bytes) => {
    const path = join(repo, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  };
  let report;
  let reader;
  try {
    git('init', '-q');
    git('config', 'user.name', 'P03 scratch test');
    git('config', 'user.email', 'p03@test.invalid');
    write('package.json', '{"name":"scratch","private":true}');
    write('apps/stack/scripts/perf/entry-graphs.mjs', "export const ENTRY_GRAPHS = [{ id: 'fixture', entry: 'input.mjs' }];");
    write('apps/stack/scripts/perf/entry-load.mjs', `
      import { writeFileSync } from 'node:fs';
      export { ENTRY_GRAPHS } from './entry-graphs.mjs';
      export async function loadEntryGraph() {
        writeFileSync(process.env.P03_TREE_TEST_MARKER, JSON.stringify({ pid: process.pid, tree: process.cwd() }));
        await new Promise(resolve => setTimeout(resolve, 30_000));
      }
    `);
    write('input.mjs', 'export const value = 1;');
    git('add', '.');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    write('input.mjs', 'export const value = 2;');
    git('commit', '-qam', 'candidate');
    const ledger = join(scratch, 'report.jsonl');
    report = spawn(process.execPath, [resolve(owner), '--report', '--repo', repo, '--base', base, '--tree', 'HEAD', '--ledger', ledger],
      { cwd: repo, env, stdio: ['ignore', 'ignore', 'pipe'] });
    const closed = once(report, 'close');
    let stderr = '';
    report.stderr.on('data', bytes => { stderr += bytes; });
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && report.exitCode === null && Date.now() < deadline) await delay(15);
    assert.ok(existsSync(marker), stderr || 'the fixture never read its extracted tree');
    reader = JSON.parse(readFileSync(marker, 'utf8'));
    assert.ok(existsSync(reader.tree), 'the live reader needs its tree');
    report.kill('SIGTERM');
    await closed;
    assert.equal(existsSync(reader.tree), false, 'the canceled report left an extracted tree');
    assert.equal(existsSync(join(hostTmp, 'happier-commit-tree', 'report.lock')), false, 'the canceled report left its lock');
  } finally {
    if (report?.exitCode === null && report?.signalCode === null) report.kill('SIGTERM');
    if (reader && report?.signalCode === 'SIGTERM') {
      try { process.kill(reader.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
