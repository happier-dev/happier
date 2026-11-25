import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
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
    write('packages/cli-common/registerSourceRuntime.mjs', '');
    write('apps/stack/scripts/build/source_revision.mjs', 'export async function deriveRevisionGeneratedInputs() {}');
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

test('the gate refuses before materializing when its scratch volume is below the disk floor', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'p03-tree-disk-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const bin = join(scratch, 'bin');
  const cache = join(scratch, 'gate-cache');
  mkdirSync(bin);
  writeFileSync(join(bin, 'df'), '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/mock 67108864 57671680 9437184 86%% /\\n"\n', { mode: 0o755 });
  const git = (...args) => execFileSync('git', args, { cwd: scratch, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'base');
  const gate = fileURLToPath(new URL('./commitGate.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [gate, '--base=HEAD', '--tree=HEAD'], { cwd: scratch, encoding: 'utf8',
    env: { ...process.env, PATH: bin + ':' + process.env.PATH, TMPDIR: scratch, P03_GATE_CACHE: cache } });
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /COMMIT_GATE_DISK_LOW/u);
  assert.equal(existsSync(cache), false);
});

for (const changesSource of [false, true]) test(changesSource
  ? 'the entry check replaces a projection capture that changed another source file'
  : 'projection regeneration and its exact entry check share one disposable tree', async t => {
  const root = mkdtempSync(join(tmpdir(), 'p03-tree-reuse-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const output = join(root, 'projections');
  const projection = 'packages/plugin-sdk/src/actions/dtos/approvalsActionDtos.generated.ts';
  const marker = join(root, 'trees');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = (path, contents) => {
    const file = join(repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };
  git('init', '-q');
  git('config', 'user.name', 'P03 scratch test');
  git('config', 'user.email', 'p03@test.invalid');
  write('package.json', '{"name":"scratch","private":true}');
  write(projection, 'old');
  write('src/proof.txt', 'original');
  write('packages/cli-common/registerSourceRuntime.mjs', '');
  write('apps/stack/scripts/build/source_revision.mjs', 'export async function deriveRevisionGeneratedInputs() {}');
  write('packages/plugin-sdk/scripts/generateActionTypeMap.mjs', `
    import { appendFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    export async function prepareActionTypeMap() {
      appendFileSync(process.env.P03_TREE_TEST_MARKER, process.cwd() + '\\n');
      if (${changesSource}) writeFileSync('src/proof.txt', 'mutated');
      return { outputs: new Map([[join(process.cwd(), ${JSON.stringify(projection)}), 'new']]) };
    }
  `);
  write('apps/stack/scripts/perf/entry-load.mjs', `
    import { appendFileSync, readFileSync } from 'node:fs';
    export const ENTRY_GRAPHS = [{ id: 'fixture' }];
    export async function loadEntryGraph() {
      appendFileSync(process.env.P03_TREE_TEST_MARKER, process.cwd() + '\\n');
      if (readFileSync('src/proof.txt', 'utf8') !== 'original') throw new Error('dirty capture');
      if (readFileSync(${JSON.stringify(projection)}, 'utf8') !== 'new') throw new Error('stale projection');
      return { graph: 'fixture', status: 'passed', elapsedMs: 0 };
    }
  `);
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD^{tree}');
  const child = spawn(process.execPath, [owner, '--entry-load-commit-session'], {
    cwd: repo, env: { ...process.env, TMPDIR: root, P03_COMMIT_TREE_WORK_DIR: root, P03_TREE_TEST_MARKER: marker },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const done = once(child, 'close');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const receive = async request => {
    child.stdin.write(JSON.stringify(request) + '\n');
    const { value } = await lines.next();
    return JSON.parse(value.slice('HAPPIER_COMMIT_ENTRY_LOAD_RESULT '.length));
  };
  try {
    assert.equal((await lines.next()).value, 'HAPPIER_COMMIT_ENTRY_LOAD_READY');
    assert.deepEqual(await receive({ repo, tree: base, projectionOutput: output, projections: { approvals: true } }), {});
    write(projection, readFileSync(join(output, projection)));
    rmSync(output, { recursive: true });
    git('add', '--', projection);
    const tree = git('write-tree');
    const result = await receive({ repo, base, tree, installDir: repo, root, selected: ['fixture'], graphs: 1, phase: 'commit', waitForDependencies: false });
    assert.deepEqual(result.findings, []);
    const [generated, checked] = readFileSync(marker, 'utf8').trim().split('\n');
    if (changesSource) assert.notEqual(checked, generated);
    else assert.equal(checked, generated);
    child.stdin.end();
    assert.deepEqual(await done, [0, null]);
    assert.equal(existsSync(generated), false);
    assert.equal(existsSync(checked), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await done;
    }
  }
});
