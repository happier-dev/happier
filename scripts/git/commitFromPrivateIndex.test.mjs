import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { commitFromPrivateIndex } from './commitFromPrivateIndex.mjs';


// The commit lock is flock(1); hosts without it (native Windows, stock macOS) run no commit wrapper and take a plain CAS.
const hasFlock = process.platform !== 'win32' && spawnSync('flock', ['--version']).error?.code !== 'ENOENT';

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

test('refuses a packet whose committed imports miss their module or export in the tree, without advancing HEAD', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.cwd, 'src'));
  fs.mkdirSync(path.join(f.cwd, 'packages/widget/src'), { recursive: true });
  f.write('tsconfig.json', '{ /* JSONC */ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }');
  f.write('packages/widget/package.json', JSON.stringify({ name: '@fixture/widget', exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  f.write('packages/widget/src/index.ts', 'export const widget = 1;');
  f.write('src/present.ts', 'export const present = 1;');
  f.write('src/producer.mjs', 'export function shipped() {}');
  f.git('add', '--', 'tsconfig.json', 'src/present.ts', 'src/producer.mjs', 'packages/widget');
  f.git('commit', '-qm', 'test: import basis');
  const before = f.git('rev-parse', 'HEAD');
  // These uncommitted producers must never satisfy the tree-only closure check.
  f.write('src/absent.ts', 'export const absent = 1;');
  f.write('src/present.ts', 'export const present = 1;\nexport const addedLater = 2;');
  f.write('src/producer.mjs', 'export function shipped() {}\nexport function unshipped() {}');
  f.write('src/consumer.ts', `import { absent } from './absent.js';
import { present, addedLater } from '@/present';
import { widget } from '@fixture/widget';
export { missing } from '@fixture/widget/missing';
const lazy = import('@/missing');
// import 'comment-only';
export const value = [absent, present, addedLater, widget, lazy];`);
  f.write('src/script.mjs', "import { shipped, unshipped } from './producer.mjs';\nshipped(); unshipped();");
  await assert.rejects(commitFromPrivateIndex({ ...f, paths: ['src/consumer.ts', 'src/script.mjs'] }), (error) => {
    assert.match(error.message, /refused/);
    for (const expected of ['./absent.js', '@/missing', '@fixture/widget/missing', 'addedLater', 'unshipped']) {
      assert.ok(error.message.includes(expected), `refusal names ${expected}`);
    }
    for (const satisfied of ['comment-only', ' present ', ' shipped ', 'widget }']) assert.ok(!error.message.includes(satisfied), satisfied);
    return true;
  });
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.git('diff', '--cached', '--name-status'), '');
});

test('refuses a producer change that drops an export an unchanged importer still reads, even through a barrel', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.cwd, 'src'));
  f.write('src/producer.ts', 'export const kept = 1;\nexport function dropped() {}\nexport interface Shape { id: string }');
  f.write('src/index.ts', "export * from './producer';");
  f.write('src/direct.ts', "import { dropped, kept } from './producer';\nexport const a = [dropped, kept];");
  f.write('src/viaBarrel.ts', "import type { Shape } from './index';\nexport type B = Shape;");
  f.git('add', '--', 'src');
  f.git('commit', '-qm', 'test: producer basis');
  const before = f.git('rev-parse', 'HEAD');
  f.write('src/producer.ts', 'export const kept = 1;');
  await assert.rejects(commitFromPrivateIndex({ ...f, paths: ['src/producer.ts'] }), (error) => {
    assert.match(error.message, /src\/direct\.ts[^\n]*dropped/);
    assert.match(error.message, /src\/viaBarrel\.ts[^\n]*Shape/);
    assert.ok(!/\bkept\b/.test(error.message));
    return true;
  });
  assert.equal(f.git('rev-parse', 'HEAD'), before);
});

test('refuses a lockfile that names a workspace package whose package.json is untracked', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.cwd, 'packages/ghost'), { recursive: true });
  f.write('package.json', '{"name":"root"}');
  f.write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n\npackages: {}\n");
  f.git('add', '--', 'package.json', 'pnpm-lock.yaml');
  f.git('commit', '-qm', 'test: lockfile basis');
  const before = f.git('rev-parse', 'HEAD');
  // The importer's manifest exists on disk only, so a clean checkout cannot install the lockfile.
  f.write('packages/ghost/package.json', '{"name":"@fixture/ghost"}');
  f.write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n\n  packages/ghost:\n    dependencies: {}\n\npackages: {}\n");
  await assert.rejects(commitFromPrivateIndex({ ...f, paths: ['pnpm-lock.yaml'] }), /packages\/ghost/);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  // Carrying the producer manifest makes the same lockfile commit coherent.
  await commitFromPrivateIndex({ ...f, paths: ['pnpm-lock.yaml', 'packages/ghost/package.json'] });
  assert.match(f.git('show', 'HEAD:pnpm-lock.yaml'), /packages\/ghost/);
});

test('refuses a packet whose changed source does not parse, judged from the packet tree, without advancing HEAD', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.cwd, 'src'));
  // 5346aa3091c (11-17) landed a spec that failed to parse through this path; the wrapper's gate refuses the same packet.
  f.write('src/broken.spec.ts', "describe('x', () => {\n  it('y', () => {});\n  });\n});\n");
  f.write('src/fine.tsx', 'export const View = () => <div/>;');
  const before = f.git('rev-parse', 'HEAD');
  await assert.rejects(commitFromPrivateIndex({ ...f, paths: ['src/broken.spec.ts', 'src/fine.tsx'] }), (error) => {
    assert.match(error.message, /refused/);
    assert.match(error.message, /src\/broken\.spec\.ts:4:/);
    assert.ok(!error.message.includes('src/fine.tsx'));
    return true;
  });
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  await commitFromPrivateIndex({ ...f, paths: ['src/fine.tsx'] });
  assert.match(f.git('show', '--name-only', '--format=', 'HEAD'), /src\/fine\.tsx/);
});

// P03-SPLIT-AUDIT-A P1-1: the wrapper's gate refused an eager import cycle (a TDZ at load), this path committed it.
test('refuses a packet that closes an eager import cycle, the same commit gate as the wrapper, without advancing HEAD', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.cwd, 'packages/pkg/src'), { recursive: true });
  f.write('packages/pkg/package.json', JSON.stringify({ name: '@fixture/pkg', type: 'module' }));
  f.write('packages/pkg/src/provenance.ts', 'export const Provenance = { kind: "provenance" };\n');
  f.write('packages/pkg/src/profiles.ts', "import { Provenance } from './provenance.js';\n\nexport const Source = { provenance: Provenance };\n");
  f.git('add', '--', 'packages');
  f.git('commit', '-qm', 'test: cycle basis');
  const before = f.git('rev-parse', 'HEAD');
  f.write('packages/pkg/src/provenance.ts', "import { Source } from './profiles.js';\nexport const Provenance = { kind: \"provenance\" };\nexport function describe() { return Source; }\n");
  await assert.rejects(commitFromPrivateIndex({ ...f, paths: ['packages/pkg/src/provenance.ts'] }), (error) => {
    assert.match(error.message, /refused/);
    assert.match(error.message, /profiles\.ts:3 reads Provenance/);
    return true;
  });
  assert.equal(f.git('rev-parse', 'HEAD'), before);
});

test('commits a consumer with its producer while an unchanged pre-existing break and ignored generated output never block', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.cwd, 'src/generated'), { recursive: true });
  f.write('.gitignore', 'src/generated/\n');
  f.write('src/legacy.ts', "import { gone } from './nowhere';\nexport const legacy = gone;");
  f.git('add', '--', '.gitignore', 'src/legacy.ts');
  f.git('commit', '-qm', 'test: pre-existing break');
  f.write('src/generated/routes.ts', 'export const routes = [];');
  f.write('src/producer.ts', 'export const made = 1;\nexport type Made = typeof made;');
  f.write('src/consumer.ts', "import { made, type Made } from './producer';\nimport { routes } from './generated/routes';\nexport const value: Made = made; export { routes };");
  f.write('src/legacy.ts', "import { gone } from './nowhere';\nexport const legacy = gone; // touched");
  const commit = await commitFromPrivateIndex({ ...f, paths: ['src/consumer.ts', 'src/producer.ts', 'src/legacy.ts'] });
  assert.equal(f.git('rev-parse', 'HEAD').trim(), commit);
});

test('an @/ alias that no tsconfig maps (a test runner alias) is outside the closure and never refuses', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.cwd, 'packages/plugin/src'), { recursive: true });
  f.write('packages/plugin/tsconfig.json', '{ "compilerOptions": { "strict": true }, "exclude": ["src/**/*.test.ts"] }');
  f.write('packages/plugin/src/history.test.ts', "import { exec } from '@/plugins/runtime/exec';\nexport const value = exec;");
  const commit = await commitFromPrivateIndex({ ...f, paths: ['packages/plugin/tsconfig.json', 'packages/plugin/src/history.test.ts'] });
  assert.equal(f.git('rev-parse', 'HEAD').trim(), commit);
});

test('refuses an unresolved module-scope require but never resolves createRequire calls against the importing file', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.cwd, 'src'));
  f.write('package.json', '{"type":"module"}');
  f.write('metro.config.js', 'export default {};');
  f.write('src/relocated.mjs', `import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
require('./metro.config.js');`);
  f.write('src/native.cjs', `require('./missing.js');
function relocated() {
  const require = createRequire(new URL('../package.json', import.meta.url));
  require('./outside-this-module.js');
}`);
  const paths = ['package.json', 'metro.config.js', 'src/relocated.mjs', 'src/native.cjs'];
  await assert.rejects(commitFromPrivateIndex({ ...f, paths }), (error) => {
    assert.ok(error.message.includes('src/native.cjs -> ./missing.js'));
    assert.ok(!error.message.includes('outside-this-module') && !error.message.includes('metro.config'));
    return true;
  });
  f.write('src/native.cjs', `function relocated() {
  const require = createRequire(new URL('../package.json', import.meta.url));
  require('./outside-this-module.js');
}`);
  await commitFromPrivateIndex({ ...f, paths });
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

// P03-GATE-FIX 2026-11-17: this path moved HEAD without the commit wrapper's lock, so DBW-SPINE's packet lost its
// final compare-and-swap after passing under that lock. Every committer serializes its ref update on the same lock.
test('waits for the commit wrapper lock before moving HEAD', { skip: !hasFlock }, async (t) => {
  const f = fixture(t);
  const lock = path.join(f.cwd, '.git', 'p03-commit-partial.lock');
  const released = path.join(f.cwd, 'released');
  // The holder records when it lets go; the commit's ref update is synchronous, so the test reads order, not timers.
  const holder = spawn('flock', ['-x', lock, 'sh', '-c', `sleep 1.5; : > '${released}'`], { stdio: 'ignore' });
  t.after(() => holder.kill());
  while (!fs.existsSync(lock)) await new Promise(resolve => setTimeout(resolve, 20));
  await new Promise(resolve => setTimeout(resolve, 200));
  f.write('changed', 'selected\n');
  const commit = await commitFromPrivateIndex({ ...f, paths: ['changed'] });
  assert.equal(fs.existsSync(released), true, 'HEAD moved while the wrapper held its lock');
  assert.equal(f.git('rev-parse', 'HEAD').trim(), commit);
  assert.match(f.git('reflog', '-1', '--format=%gs', 'HEAD'), /^commitFromPrivateIndex: pid \d+/);
});

function runWithCommitLockContender(f, winner, name, { observeTreeGate = false, additionalWinners = [] } = {}) {
  const base = f.git('rev-parse', 'HEAD').trim();
  const lock = path.join(f.cwd, '.git', 'p03-commit-partial.lock');
  const bin = path.join(f.cwd, 'bin');
  const acquisitions = path.join(f.cwd, 'acquisitions');
  const treeGateLocks = path.join(f.cwd, 'tree-gate-locks');
  const flock = execFileSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(bin);
  // Advance the real ref under the real lock immediately before the writer's first acquisition.
  fs.writeFileSync(path.join(bin, 'flock'), `#!/bin/sh
set -eu
head=$(git rev-parse HEAD)
printf '%s\\n' "$head" >> "$TEST_ACQUISITIONS"
if [ "$head" = "$TEST_BASE" ]; then
  "$TEST_FLOCK" -x "$TEST_LOCK" git update-ref HEAD "$TEST_WINNER" "$head"
fi
exec "$TEST_FLOCK" "$@"
`, { mode: 0o755 });
  if (additionalWinners.length) {
    const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const moves = additionalWinners.map((next, index) =>
      `${[winner, ...additionalWinners][index]}) "$real_git" update-ref HEAD ${next} "$head" ;;`).join('\n');
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
set -eu
real_git='${git}'
if [ "$1" = update-ref ] && [ "${'$'}{2-}" = -m ]; then
  head=$("$real_git" rev-parse HEAD)
  case "$head" in
  ${moves}
  esac
fi
exec "$real_git" "$@"
`, { mode: 0o755 });
  }
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./commitFromPrivateIndex.mjs', import.meta.url)), '--message-file', f.messageFile, '--', name,
  ], {
    cwd: f.cwd, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HAPPIER_COMMIT_TREE_GATE: observeTreeGate ? 'block' : 'report', HAPPIER_COMMIT_TYPECHECK_GATE: 'report',
      HAPPIER_COMMIT_TYPECHECK_DIR: path.join(f.cwd, '.git', 'typecheck-state'),
      TEST_TREE_GATE_LOCKS: treeGateLocks, TEST_ACQUISITIONS: acquisitions, TEST_BASE: base, TEST_FLOCK: flock, TEST_LOCK: lock, TEST_WINNER: winner },
  });
  return { result, acquisitions: fs.existsSync(acquisitions) ? fs.readFileSync(acquisitions, 'utf8').trim().split('\n') : [], flock, lock,
    treeGateLocks: fs.existsSync(treeGateLocks) ? fs.readFileSync(treeGateLocks, 'utf8').trim().split('\n') : [] };
}

test('replays onto a competing commit and lands without rejoining the commit lock queue', { skip: !hasFlock }, (t) => {
  const f = fixture(t);
  const base = f.git('rev-parse', 'HEAD').trim();
  f.write('unrelated', 'competitor\n');
  f.git('add', '--', 'unrelated');
  const winner = f.git('commit-tree', f.git('write-tree').trim(), '-p', base, '-m', 'test: competing writer').trim();
  f.git('read-tree', base);
  f.write('changed', 'selected\n');

  const { result, acquisitions } = runWithCommitLockContender(f, winner, 'changed');

  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.git('rev-parse', 'HEAD^').trim(), winner);
  assert.equal(f.git('show', 'HEAD:changed'), 'selected\n');
  assert.equal(f.git('show', 'HEAD:unrelated'), 'competitor\n');
  assert.deepEqual(acquisitions, [base]);
});

function treeGraphReplayFixture(t, { uiGraph = false } = {}) {
  const f = fixture(t);
  for (const app of ['cli', 'ui']) {
    fs.mkdirSync(path.join(f.cwd, 'apps', app, 'src'), { recursive: true });
    f.write(`apps/${app}/package.json`, JSON.stringify({ name: `@fixture/${app}`,
      ...(app === 'cli' && uiGraph ? { dependencies: { '@fixture/ui': 'workspace:*' } } : {}) }));
    f.write(`apps/${app}/src/index.mjs`, 'export const value = 0;\n');
  }
  fs.mkdirSync(path.join(f.cwd, 'apps/stack/scripts/perf'), { recursive: true });
  fs.mkdirSync(path.join(f.cwd, 'apps/stack/scripts/build'), { recursive: true });
  f.write('apps/stack/scripts/build/source_revision.mjs', 'export async function deriveRevisionGeneratedInputs() {}');
  fs.mkdirSync(path.join(f.cwd, 'packages/cli-common'), { recursive: true });
  f.write('packages/cli-common/registerSourceRuntime.mjs', 'export {};');
  const graphs = (uiGraph ? ['cli', 'ui'] : ['cli']).map(id => ({ id, entry: `apps/${id}/src/index.mjs` }));
  f.write('apps/stack/scripts/perf/entry-graphs.mjs', `export const ENTRY_GRAPHS = ${JSON.stringify(graphs)};`);
  f.write('apps/stack/scripts/perf/entry-load.mjs', `
import { ENTRY_GRAPHS } from './entry-graphs.mjs';
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export { ENTRY_GRAPHS };
export async function loadEntryGraph(graph) {
  const { status } = spawnSync(process.env.TEST_FLOCK, ['-n', process.env.TEST_LOCK, 'true']);
  appendFileSync(process.env.TEST_TREE_GATE_LOCKS, graph.id + ':' + status + String.fromCharCode(10));
  await import(pathToFileURL(resolve(graph.entry)).href);
  return { graph: graph.id, status: 'passed', elapsedMs: 0 };
}
`);
  f.git('add', '--', 'apps', 'packages/cli-common');
  f.git('commit', '-qm', 'test: graph inputs');
  const base = f.git('rev-parse', 'HEAD').trim();
  f.write('apps/cli/src/index.mjs', 'export const value = 1;\n');
  f.git('add', '--', 'apps/cli/src/index.mjs');
  const winner = f.git('commit-tree', f.git('write-tree').trim(), '-p', base, '-m', 'test: competing CLI writer').trim();
  f.git('read-tree', base);
  const packet = 'apps/ui/src/index.mjs';
  f.write(packet, 'export const value = 2;\n');
  return { f, base, winner, packet };
}

test('lands a selected-zero UI packet on moving HEAD without an unlocked entry recheck', { skip: !hasFlock }, t => {
  const { f, base, winner, packet } = treeGraphReplayFixture(t);
  const { result, acquisitions, treeGateLocks } = runWithCommitLockContender(f, winner, packet, { observeTreeGate: true });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Released the commit lock for the full gate/);
  assert.deepEqual(acquisitions, [base]);
  assert.deepEqual(treeGateLocks, []);
  assert.equal(f.git('rev-parse', 'HEAD^').trim(), winner);
  assert.equal(f.git('show', `HEAD:${packet}`), 'export const value = 2;\n');
});

test('releases the lock and reruns only entry graphs whose inputs changed since the accepted base', { skip: !hasFlock }, t => {
  const { f, base, winner, packet } = treeGraphReplayFixture(t, { uiGraph: true });
  const { result, acquisitions, treeGateLocks } = runWithCommitLockContender(f, winner, packet, { observeTreeGate: true });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(treeGateLocks, ['cli:0', 'ui:0', 'cli:0'], 'only the CLI graph reloads, outside the lock');
  assert.deepEqual(acquisitions, [base, winner]);
  assert.equal(f.git('rev-parse', 'HEAD^').trim(), winner);
  assert.equal(f.git('show', `HEAD:${packet}`), 'export const value = 2;\n');
});

test('finishes a second CAS loss without preparing an entry graph under the commit lock', { skip: !hasFlock }, t => {
  const { f, base, winner, packet } = treeGraphReplayFixture(t, { uiGraph: true });
  const additionalWinners = [];
  for (const value of [3, 4]) {
    f.write('apps/cli/src/index.mjs', `export const value = ${value};\n`);
    f.git('add', '--', 'apps/cli/src/index.mjs');
    additionalWinners.push(f.git('commit-tree', f.git('write-tree').trim(), '-p',
      additionalWinners.at(-1) ?? winner, '-m', 'test: another qualifying writer').trim());
  }
  f.git('read-tree', base);

  const { result, treeGateLocks, flock, lock } = runWithCommitLockContender(f, winner, packet, { observeTreeGate: true, additionalWinners });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(treeGateLocks, ['cli:0', 'ui:0', 'cli:0', 'cli:0', 'cli:0']);
  assert.equal(f.git('rev-parse', 'HEAD^').trim(), additionalWinners.at(-1));
  assert.equal(spawnSync(flock, ['-n', lock, 'true']).status, 0);
});

test('refuses a replay when the winning commit removed its producer and releases the commit lock', { skip: !hasFlock }, (t) => {
  const f = fixture(t);
  f.write('producer.mjs', 'export const producer = true;\n');
  f.git('add', '--', 'producer.mjs');
  f.git('commit', '-qm', 'test: producer');
  const base = f.git('rev-parse', 'HEAD').trim();
  f.git('update-index', '--force-remove', '--', 'producer.mjs');
  const winner = f.git('commit-tree', f.git('write-tree').trim(), '-p', base, '-m', 'test: remove producer').trim();
  f.git('read-tree', base);
  f.write('consumer.mjs', "export { producer } from './producer.mjs';\n");

  const { result, acquisitions, flock, lock } = runWithCommitLockContender(f, winner, 'consumer.mjs');

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /refused by the commit gate \(producer closure\)[\s\S]*consumer\.mjs -> \.\/producer\.mjs/);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), winner);
  assert.deepEqual(acquisitions, [base]);
  assert.equal(spawnSync(flock, ['-n', lock, 'true']).status, 0);
});

test('uses compare-and-swap when the host has no flock', { skip: process.platform === 'win32' }, (t) => {
  const f = fixture(t);
  const base = f.git('rev-parse', 'HEAD').trim();
  const bin = path.join(f.cwd, 'bin');
  const git = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(bin);
  fs.symlinkSync(git, path.join(bin, 'git'));
  f.write('changed', 'selected\n');

  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./commitFromPrivateIndex.mjs', import.meta.url)), '--message-file', f.messageFile, '--', 'changed',
  ], { cwd: f.cwd, encoding: 'utf8', env: { ...process.env, PATH: bin } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no flock on this host/);
  assert.equal(f.git('rev-parse', 'HEAD^').trim(), base);
  assert.equal(f.git('show', 'HEAD:changed'), 'selected\n');
});

test('the commit lock stays held across awaits and another writer in the same process can acquire it', { skip: !hasFlock }, async (t) => {
  const f = fixture(t);
  const { commitGateLockPath, withCommitLock } = await import('../workspaces/commitGate.mjs');
  const repo = f.cwd;
  const lock = commitGateLockPath(repo);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const order = [];
  const holder = withCommitLock({ repo }, async () => {
    entered.resolve();
    await release.promise;
    order.push('holder');
  });
  await Promise.race([entered.promise, holder]);
  const contender = withCommitLock({ repo }, () => { order.push('contender'); });
  try {
    assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 1);
  } finally {
    release.resolve();
    await Promise.all([holder, contender]);
  }
  assert.deepEqual(order, ['holder', 'contender']);
});
