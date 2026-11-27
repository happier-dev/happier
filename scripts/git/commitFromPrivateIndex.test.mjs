import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { commitFromPrivateIndex } from './commitFromPrivateIndex.mjs';
import { runCommitGate } from '../workspaces/commitGate.mjs';
import { publishDependencyRefreshMarker } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';


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

test('a private ref publication realigns only untouched index entries for the whole group', async t => {
  const f = fixture(t);
  const { withCommitLock } = await import('../workspaces/commitGate.mjs');
  f.write('intent', '');
  f.git('add', '--', 'intent');
  f.git('commit', '-qm', 'test: empty prior file');
  const base = f.git('rev-parse', 'HEAD').trim();
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8',
    env: { ...process.env, GIT_INDEX_FILE: path.join(f.cwd, '.git', 'packet') } }).trim();
  const added = 'added [file]\tname';
  git('read-tree', base);
  f.write('changed', 'committed\n');
  f.write('unrelated', 'grouped\n');
  f.write('intent', 'committed content\n');
  f.write(added, 'new\n');
  fs.unlinkSync(path.join(f.cwd, 'deleted'));
  git('add', '--all', '--', 'changed', 'deleted', 'unrelated', 'intent', added);
  const commit = git('commit-tree', git('write-tree'), '-p', base, '-m', 'test: group');
  f.write('unrelated', 'foreign staging\n');
  f.git('add', '--', 'unrelated');
  f.write('changed', 'committed\nfollow-up disk edit\n');
  f.git('rm', '--cached', '--', 'intent');
  f.git('add', '-N', '--', 'intent');
  const foreign = f.git('ls-files', '--stage', '-z', '--', 'unrelated');
  await withCommitLock({ repo: f.cwd }, moveRef => moveRef({ head: base, commit, reason: 'test: private publication' }));
  assert.equal(f.git('rev-parse', 'HEAD').trim(), commit);
  assert.equal(f.git('ls-files', '--stage', '-z', '--', 'unrelated'), foreign);
  assert.equal(f.git('diff', '--cached', '--name-status', '--', 'intent'), 'D\tintent\n');
  assert.equal(f.git('diff', '--cached', '--name-status', '--', 'changed', 'deleted', added), '');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'changed'), 'utf8'), 'committed\nfollow-up disk edit\n');
});

test('the private-index CLI preserves foreign staging on a path it commits', async t => {
  const f = fixture(t);
  f.write('changed', 'foreign staging\n');
  f.git('add', '--', 'changed');
  const foreign = f.git('ls-files', '--stage', '-z', '--', 'changed');
  f.write('changed', 'selected\n');
  await commitFromPrivateIndex({ ...f, paths: ['changed'] });
  assert.equal(f.git('show', 'HEAD:changed'), 'selected\n');
  assert.equal(f.git('ls-files', '--stage', '-z', '--', 'changed'), foreign);
});

test('refuses missing local imports before landing and reports workspace imports in the exact post-commit tree', async (t) => {
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
  const paths = ['src/consumer.ts', 'src/script.mjs'];
  await assert.rejects(commitFromPrivateIndex({ ...f, paths }), error => {
    assert.match(error.message, /local import closure/);
    for (const expected of ['./absent.js', '@/missing', 'addedLater', 'unshipped']) {
      assert.ok(error.message.includes(expected), expected);
    }
    assert.ok(!error.message.includes('@fixture/widget/missing'));
    return true;
  });
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  assert.equal(f.git('diff', '--cached', '--name-status'), '');
  f.git('add', '--', ...paths);
  const tree = f.git('write-tree').trim();
  const report = await runCommitGate({ repo: f.cwd, base: before.trim(), tree, phase: 'post-commit' });
  assert.equal(report.check, 'producer closure');
  const findings = report.findings.join('\n');
  for (const expected of ['./absent.js', '@/missing', '@fixture/widget/missing', 'addedLater', 'unshipped']) {
    assert.ok(findings.includes(expected), `report names ${expected}`);
  }
  for (const satisfied of ['comment-only', ' present ', ' shipped ', 'widget }']) assert.ok(!findings.includes(satisfied), satisfied);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
});

test('reports when a landed producer drops an export an unchanged importer still reads, even through a barrel', async (t) => {
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
  const tree = await commitFromPrivateIndex({ ...f, paths: ['src/producer.ts'] });
  const report = await runCommitGate({ repo: f.cwd, base: before.trim(), tree, phase: 'post-commit' });
  const findings = report.findings.join('\n');
  assert.match(findings, /src\/direct\.ts[^\n]*dropped/);
  assert.match(findings, /src\/viaBarrel\.ts[^\n]*Shape/);
  assert.doesNotMatch(findings, /\bkept\b/);
});

test('refuses removing the workspace lockfile from the exact candidate', async (t) => {
  const f = fixture(t);
  f.write('package.json', '{"name":"root"}');
  f.write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  f.git('add', '--', 'package.json', 'pnpm-lock.yaml');
  f.git('commit', '-qm', 'test: lockfile basis');
  const before = f.git('rev-parse', 'HEAD');
  fs.unlinkSync(path.join(f.cwd, 'pnpm-lock.yaml'));
  await assert.rejects(commitFromPrivateIndex({ ...f, paths: ['pnpm-lock.yaml'] }), /removed pnpm-lock.yaml/);
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

test('refuses a newly imported ignored producer and still lets unchanged imports through', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.cwd, 'src/generated'), { recursive: true });
  f.write('.gitignore', 'src/generated/\n');
  f.write('src/legacy.ts', "import { gone } from './nowhere';\nexport const legacy = gone;");
  f.write('src/legacy-generated.ts', "export { routes } from './generated/routes';");
  f.git('add', '--', '.gitignore', 'src/legacy.ts', 'src/legacy-generated.ts');
  f.git('commit', '-qm', 'test: pre-existing break');
  f.write('src/generated/routes.ts', 'export const routes = [];');
  f.write('src/producer.ts', 'export const made = 1;\nexport type Made = typeof made;');
  f.write('src/consumer.ts', "import { made, type Made } from './producer';\nimport { routes } from './generated/routes';\nexport const value: Made = made; export { routes };");
  f.write('src/legacy.ts', "import { gone } from './nowhere';\nexport const legacy = gone; // touched");
  const paths = ['src/consumer.ts', 'src/producer.ts', 'src/legacy.ts', 'src/legacy-generated.ts'];
  const before = f.git('rev-parse', 'HEAD');
  await assert.rejects(commitFromPrivateIndex({ ...f, paths }), /src\/consumer\.ts -> \.\/generated\/routes/);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
  f.write('src/consumer.ts', "import { made, type Made } from './producer';\nexport const value: Made = made;");
  f.write('src/legacy-generated.ts', "export { routes } from './generated/routes'; // touched");
  const commit = await commitFromPrivateIndex({ ...f, paths });
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

test('refuses an unresolved module-scope require and permits relocated createRequire calls', async t => {
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
  const base = f.git('rev-parse', 'HEAD').trim();
  await assert.rejects(commitFromPrivateIndex({ ...f, paths }), error => {
    assert.match(error.message, /src\/native\.cjs -> \.\/missing\.js/);
    assert.doesNotMatch(error.message, /outside-this-module|metro\.config/);
    return true;
  });
  assert.equal(f.git('rev-parse', 'HEAD').trim(), base);
  f.write('src/native.cjs', `function relocated() {
  const require = createRequire(new URL('../package.json', import.meta.url));
  require('./outside-this-module.js');
}`);
  await commitFromPrivateIndex({ ...f, paths });
});

test('waits for an existing index.lock without deleting it', async (t) => {
  const f = fixture(t);
  const index = path.join(f.cwd, '.git', 'index');
  const staged = path.join(f.cwd, '.git', 'foreign-index');
  fs.copyFileSync(index, staged);
  f.write('changed', 'foreign staging\n');
  const stageGit = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8',
    env: { ...process.env, GIT_INDEX_FILE: staged } });
  stageGit('add', '--', 'changed');
  const foreign = stageGit('ls-files', '--stage', '-z', '--', 'changed');
  f.write('changed', 'selected\n');
  f.write('unrelated', 'also selected\n');
  const lock = path.join(f.cwd, '.git', 'index.lock');
  fs.writeFileSync(lock, 'other writer');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./commitFromPrivateIndex.mjs', import.meta.url)), '--message-file', f.messageFile, '--', 'changed', 'unrelated'], { cwd: f.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // Finish the concurrent Git writer's already-locked update.
  fs.copyFileSync(staged, lock);
  fs.renameSync(lock, index);
  const [code] = await closed;
  assert.equal(code, 0, stderr);
  assert.equal(f.git('show', 'HEAD:changed'), 'selected\n');
  assert.equal(f.git('ls-files', '--stage', '-z', '--', 'changed'), foreign);
  assert.equal(f.git('diff', '--cached', '--name-status', '--', 'unrelated'), '');
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

test('lands a patch and applies its changes to a clean shared checkout', async t => {
  const f = fixture(t);
  f.write('changed', 'selected\n');
  f.write('added', 'new committed file\n');
  fs.unlinkSync(path.join(f.cwd, 'deleted'));
  const patchFile = path.join(f.cwd, 'selected.patch');
  const index = path.join(f.cwd, '.git/packet');
  const git = (...args) => execFileSync('git', args, { cwd: f.cwd, encoding: 'utf8',
    env: { ...process.env, GIT_INDEX_FILE: index } });
  git('read-tree', 'HEAD');
  git('add', '-A', '--', 'changed', 'added', 'deleted');
  f.write('selected.patch', git('diff', '--cached', '--binary', '--full-index'));
  f.write('changed', 'base\n');
  fs.unlinkSync(path.join(f.cwd, 'added'));
  f.write('deleted', 'base\n');

  const commit = await commitFromPrivateIndex({ ...f, patchFile });
  assert.equal(f.git('rev-parse', 'HEAD').trim(), commit);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'changed'), 'utf8'), 'selected\n');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'added'), 'utf8'), 'new committed file\n');
  assert.equal(fs.existsSync(path.join(f.cwd, 'deleted')), false);
  assert.equal(f.git('diff', 'HEAD', '--', 'changed', 'added', 'deleted'), '');
});

test('merges landed hunks with foreign disk and staging hunks on the same path', async t => {
  const f = fixture(t);
  const body = 'a\nb\nc\nd\ne\nf\ng\nh\n';
  f.write('changed', 'base\n' + body + 'tail\n');
  f.git('add', '--', 'changed');
  f.git('commit', '-qm', 'test: multi-hunk base');
  const patchFile = path.join(f.cwd, 'selected.patch');
  f.write('changed', 'selected\n' + body + 'tail\n');
  f.write('selected.patch', f.git('diff', '--full-index', '--', 'changed'));
  f.write('changed', 'base\n' + body + 'foreign staging\n');
  f.git('add', '--', 'changed');
  const staged = f.git('ls-files', '--stage', '-z', '--', 'changed');
  f.write('changed', 'base\n' + body + 'foreign disk\n');

  const commit = await commitFromPrivateIndex({ ...f, patchFile });
  assert.equal(f.git('show', commit + ':changed'), 'selected\n' + body + 'tail\n');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'changed'), 'utf8'), 'selected\n' + body + 'foreign disk\n');
  assert.equal(f.git('ls-files', '--stage', '-z', '--', 'changed'), staged);
});

test('reports a conflicting checkout hunk without overwriting it or failing the committed packet', async t => {
  const f = fixture(t);
  const patchFile = path.join(f.cwd, 'selected.patch');
  f.write('changed', 'selected\n');
  f.write('selected.patch', f.git('diff', '--full-index', '--', 'changed'));
  f.write('changed', 'conflicting foreign edit\n');

  const child = spawn(process.execPath, [fileURLToPath(new URL('./commitFromPrivateIndex.mjs', import.meta.url)),
    '--message-file', f.messageFile, '--patch-file', patchFile], { cwd: f.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), f.git('rev-parse', 'HEAD').trim());
  assert.equal(f.git('show', 'HEAD:changed'), 'selected\n');
  assert.match(stderr, /HSTACK_COMMITTED_CHECKOUT_DRIFT "changed".*1: missing landed hunk selected/);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'changed'), 'utf8'), 'conflicting foreign edit\n');
});

test('refuses stale paths before staging and names the landed hunk they would remove', async t => {
  const f = fixture(t);
  const laneBase = f.git('rev-parse', 'HEAD').trim();
  f.write('changed', 'base\nlanded by another lane\n');
  f.git('add', '--', 'changed');
  f.git('commit', '-qm', 'test: land shared hunk');
  const head = f.git('rev-parse', 'HEAD').trim();
  f.write('changed', 'my own edit to the base\n');

  await assert.rejects(commitFromPrivateIndex({ ...f, paths: ['changed'], laneBase }), /changed:2:.*landed by another lane/);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), head);
  assert.equal(f.git('diff', '--cached', '--', 'changed'), '');
  assert.equal(fs.readFileSync(path.join(f.cwd, 'changed'), 'utf8'), 'my own edit to the base\n');
  f.write('changed', 'my own edit to the base\nlanded by another lane\n');
  await commitFromPrivateIndex({ ...f, paths: ['changed'], laneBase });
  assert.equal(f.git('show', 'HEAD:changed'), 'my own edit to the base\nlanded by another lane\n');
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

function runWithCommitLockContender(f, winner, name, { treeGateMode, additionalWinners = [], refuseFinalAdmission = false } = {}) {
  const base = f.git('rev-parse', 'HEAD').trim();
  const lock = path.join(f.cwd, '.git', 'p03-commit-partial.lock');
  const bin = path.join(f.cwd, 'bin');
  const acquisitions = path.join(f.cwd, 'acquisitions');
  const treeGateLocks = path.join(f.cwd, 'tree-gate-locks');
  const finalGrants = path.join(f.cwd, 'final-grants');
  const finalActive = path.join(f.cwd, 'final-active');
  const flock = execFileSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(bin);
  // Advance the real ref under the real lock immediately before the writer's first acquisition.
  fs.writeFileSync(path.join(bin, 'flock'), `#!/bin/sh
set -eu
if [ "$#" -ne 2 ] || [ "$1" != -x ] || [ "$2" != 3 ]; then
  exec "$TEST_FLOCK" "$@"
fi
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
  if [ "$head" = "$TEST_FINAL_HEAD" ]; then
    [ -f "$TEST_FINAL_ACTIVE" ] || { echo 'Final CAS ran outside the entry grant' >&2; exit 94; }
  fi
fi
exec "$real_git" "$@"
`, { mode: 0o755 });
  }
  const inheritedEnv = { ...process.env };
  delete inheritedEnv.HAPPIER_COMMIT_TREE_GATE;
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./commitFromPrivateIndex.mjs', import.meta.url)), '--message-file', f.messageFile, '--', ...[name].flat(),
  ], {
    cwd: f.cwd, encoding: 'utf8',
    env: { ...inheritedEnv, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      ...(treeGateMode ? { HAPPIER_COMMIT_TREE_GATE: treeGateMode } : {}), HAPPIER_COMMIT_TYPECHECK_GATE: 'report',
      HAPPIER_COMMIT_TYPECHECK_DIR: path.join(f.cwd, '.git', 'typecheck-state'),
      TEST_TREE_GATE_LOCKS: treeGateLocks, TEST_FINAL_GRANTS: finalGrants, TEST_FINAL_ACTIVE: finalActive,
      TEST_FINAL_DENY: refuseFinalAdmission ? '1' : '0', TEST_FINAL_HEAD: base, TEST_ACQUISITIONS: acquisitions, TEST_BASE: base, TEST_FLOCK: flock, TEST_LOCK: lock, TEST_WINNER: winner },
  });
  assert(!fs.existsSync(finalActive), 'the final entry grant was released');
  return { result, acquisitions: fs.existsSync(acquisitions) ? fs.readFileSync(acquisitions, 'utf8').trim().split('\n') : [], flock, lock,
    finalGrants: fs.existsSync(finalGrants) ? fs.readFileSync(finalGrants, 'utf8').trim().split('\n') : [],
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
  assert.deepEqual(acquisitions, [base, winner]);
});

test('the private-index writer refuses an unnamed post-base line removal', { skip: !hasFlock }, t => {
  const f = fixture(t);
  const field = '  workspaceWrites: z.optional(z.enum(["allow", "deny"])),';
  const context = 'attribution\npermissions\nconstraints\n' + field + '\nsession\ncreation\ndefaults\n';
  f.write('changed', 'base marker\n' + context + 'original requester\n');
  f.git('add', '--', 'changed');
  f.git('commit', '-qm', 'test: packet base');
  const base = f.git('rev-parse', 'HEAD').trim();
  f.write('changed', 'new marker\n' + context + 'new requester\nbase marker\n' + context + 'original requester\n');
  f.git('add', '--', 'changed');
  const winner = f.git('commit-tree', f.git('write-tree').trim(), '-p', base, '-m', 'test: add requester').trim();
  f.git('read-tree', base);
  f.write('changed', 'base marker\n' + context.replace(field + '\n', '') + 'original requester\n');

  const { result } = runWithCommitLockContender(f, winner, 'changed');

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /post-base line removal/);
  assert.ok(result.stderr.includes(field.trim()));
  assert.equal(f.git('rev-parse', 'HEAD').trim(), winner);
});

test('a conflicting generated Action output stays with its author for reconciliation', { skip: !hasFlock }, t => {
  const f = fixture(t);
  const projection = 'apps/cli/action-help.mjs';
  fs.mkdirSync(path.dirname(path.join(f.cwd, projection)), { recursive: true });
  const output = actions => `/** GENERATED by generateBundledPluginEntries.ts; canonical help declarations. */
export const actions = ${JSON.stringify(actions)};
`;
  f.write(projection, output([]));
  f.git('add', '--', projection);
  f.git('commit', '-qm', 'test: Action projection basis');
  const base = f.git('rev-parse', 'HEAD').trim();
  f.write('unrelated', 'first Action\n');
  f.write(projection, output(['first Action']));
  f.git('add', '--', 'unrelated', projection);
  const winner = f.git('commit-tree', f.git('write-tree').trim(), '-p', base, '-m', 'fix: first Action packet').trim();
  f.git('read-tree', base);
  f.write('unrelated', 'foreign checkout bytes\n');
  f.write('changed', 'second Action\n');
  f.write(projection, output(['second Action']));

  const { result } = runWithCommitLockContender(f, winner, ['changed', projection]);

  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), winner);
  assert.match(result.stderr, /patch conflicts in: apps\/cli\/action-help\.mjs/u);
  assert.equal(f.git('show', `HEAD:${projection}`), output(['first Action']));
  assert.equal(fs.readFileSync(path.join(f.cwd, 'unrelated'), 'utf8'), 'foreign checkout bytes\n');
  assert.equal(fs.readFileSync(path.join(f.cwd, projection), 'utf8'), output(['second Action']));
});

test('an approval schema packet lands without materializing its Action DTO projection', { skip: !hasFlock }, async t => {
  const f = fixture(t);
  const source = 'packages/protocol/src/approvals/fixture.ts';
  const projection = 'packages/plugin-sdk/src/actions/dtos/approvalsActionDtos.generated.ts';
  const generator = 'packages/plugin-sdk/scripts/generateActionTypeMap.mjs';
  for (const name of [source, projection, generator]) fs.mkdirSync(path.dirname(path.join(f.cwd, name)), { recursive: true });
  f.write(source, 'export const version = 1;\n');
  f.write(projection, 'export const version = 1;\n');
  f.write(generator, `
    import { resolve } from 'node:path';
    export async function prepareActionTypeMap() {
      return { outputs: new Map([[resolve('${projection}'), 'export const version = 2;\\n']]) };
    }
  `);
  f.git('add', '--', source, projection, generator);
  f.git('commit', '-qm', 'test: paired Action source and projection');
  f.write(source, 'export const version = 2;\n');

  const commit = await commitFromPrivateIndex({ ...f, paths: [source] });

  assert.equal(f.git('show', `${commit}:${source}`), 'export const version = 2;\n');
  assert.equal(f.git('show', `${commit}:${projection}`), 'export const version = 1;\n');
});

function treeGraphReplayFixture(t, { uiGraph = false, winnerInput = 'apps/cli/src/index.mjs' } = {}) {
  const f = fixture(t);
  for (const app of ['cli', 'ui']) {
    fs.mkdirSync(path.join(f.cwd, 'apps', app, 'src'), { recursive: true });
    f.write(`apps/${app}/package.json`, JSON.stringify({ name: `@fixture/${app}`,
      ...(app === 'cli' && uiGraph ? { dependencies: { '@fixture/ui': 'workspace:*' } } : {}) }));
    f.write(`apps/${app}/src/index.mjs`, 'export const value = 0;\n');
  }
  fs.mkdirSync(path.join(f.cwd, 'apps/stack/scripts/perf'), { recursive: true });
  fs.mkdirSync(path.join(f.cwd, 'apps/stack/scripts/build'), { recursive: true });
  fs.mkdirSync(path.join(f.cwd, 'apps/stack/bin'), { recursive: true });
  fs.writeFileSync(path.join(f.cwd, 'apps/stack/bin/hstack-exec'), `#!/bin/sh
case "$1" in --execution-workers-with-memory-floor=*) exit 0;; esac
[ "$1" = --heavyweight-admission ] && [ "$2" = --class=gate-entry-loads ] || exit 91
while [ "$1" != -- ]; do
  case "$1" in --projects=*) export TEST_ENTRY_PROJECTS="\${1#--projects=}" ;; esac
  shift
done
shift
if [ -n "\${TEST_IDLE_GRANT:-}" ]; then
  touch "$TEST_IDLE_GRANT"
  trap 'rm -f -- "$TEST_IDLE_GRANT"' EXIT
  export TEST_ENTRY_ADMITTED=1
  "$@"
  exit "$?"
fi
if [ "$TEST_GROUP_QUEUE" != 1 ] && ! "$TEST_FLOCK" -n "$TEST_LOCK" true; then
  printf 'Entry load requested admission while the commit lock was held\n' >&2
  exit 92
fi
if [ "$(git rev-parse HEAD)" = "$TEST_FINAL_HEAD" ]; then
  if [ "$TEST_FINAL_DENY" = 1 ]; then exit 93; fi
  printf '%s\n' "$(git rev-parse HEAD)" >> "$TEST_FINAL_GRANTS"
  touch "$TEST_FINAL_ACTIVE"
  trap 'rm -f -- "$TEST_FINAL_ACTIVE"' EXIT
  export TEST_ENTRY_ADMITTED=1
  "$@"
  exit "$?"
fi
export TEST_ENTRY_ADMITTED=1
exec "$@"
`, { mode: 0o755 });
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
  if (process.env.TEST_ENTRY_ADMITTED !== '1') throw new Error('Selected graph reached the harness before admission');
  if (!process.env.TEST_ENTRY_PROJECTS?.split(String.fromCharCode(10)).includes(graph.id)) {
    throw new Error('Selected graph is missing from the broker project set: ' + graph.id);
  }
  const { status } = spawnSync(process.env.TEST_FLOCK, ['-n', process.env.TEST_LOCK, 'true']);
  appendFileSync(process.env.TEST_TREE_GATE_LOCKS, graph.id + ':' + status + String.fromCharCode(10));
  try {
    await import(pathToFileURL(resolve(graph.entry)).href);
    return { graph: graph.id, entry: graph.entry, status: 'passed', elapsedMs: 0 };
  } catch (error) {
    return { graph: graph.id, entry: graph.entry, status: 'failed', elapsedMs: 0, loadError: { message: error.message } };
  }
}
`);
  f.git('add', '--', 'apps', 'packages/cli-common');
  f.git('commit', '-qm', 'test: graph inputs');
  const base = f.git('rev-parse', 'HEAD').trim();
  f.write(winnerInput, 'export const value = 1;\n');
  f.git('add', '--', winnerInput);
  const winner = f.git('commit-tree', f.git('write-tree').trim(), '-p', base, '-m', 'test: competing writer').trim();
  f.git('read-tree', base);
  const packet = 'apps/ui/src/index.mjs';
  f.write(packet, 'export const value = 2;\n');
  return { f, base, winner, packet };
}

test('three idle ordered writers hold zero entry-load cores', { skip: !hasFlock }, async t => {
  const { f, base } = treeGraphReplayFixture(t);
  const lock = path.join(f.cwd, '.git', 'p03-commit-partial.lock');
  const bin = path.join(f.cwd, 'bin');
  const flock = execFileSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'flock'), `#!/bin/sh
if [ "$1" = -s ]; then : > "$TEST_QUEUE_WAIT"; fi
exec "$TEST_FLOCK" "$@"
`, { mode: 0o755 });
  fs.mkdirSync(path.join(f.cwd, 'node_modules'));
  await publishDependencyRefreshMarker({ installDir: f.cwd, identity: 'fixture-install' });

  const blocker = spawn(flock, ['-x', lock, 'sh', '-c', 'printf "ready\\n"; cat >/dev/null'],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  const blockerDone = once(blocker, 'close');
  t.after(() => blocker.stdin.end());
  await once(blocker.stdout, 'data');

  const startWriter = (lane, file) => {
    const messageFile = path.join(f.cwd, `msg-${lane}`);
    const wait = path.join(f.cwd, `waiting-${lane}`);
    const grant = path.join(f.cwd, `grant-${lane}`);
    f.write(`msg-${lane}`, `test: writer ${lane}\n`);
    f.write(file, 'export const changed = true;\n');
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('./commitFromPrivateIndex.mjs', import.meta.url)), '--message-file', messageFile, '--', file,
    ], { cwd: f.cwd, stdio: ['ignore', 'ignore', 'pipe'], env: {
      ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HAPPIER_COMMIT_GATE_ARRIVED_AT: String(lane + 1), HAPPIER_COMMIT_TYPECHECK_GATE: 'report',
      HAPPIER_COMMIT_TYPECHECK_DIR: path.join(f.cwd, '.git', 'typecheck-state'),
      TEST_FLOCK: flock, TEST_LOCK: lock, TEST_QUEUE_WAIT: wait, TEST_IDLE_GRANT: grant,
      TEST_TREE_GATE_LOCKS: path.join(f.cwd, `graphs-${lane}`),
    } });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    return { wait, grant, closed: once(child, 'close'), stderr: () => stderr };
  };

  const writers = [startWriter(0, 'changed')];
  const until = async (predicate, writer) => {
    const deadline = performance.now() + 15000;
    while (!predicate()) {
      assert.ok(performance.now() < deadline, writer.stderr());
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    await until(() => fs.existsSync(lock + '.writers')
      && fs.readdirSync(lock + '.writers').some(name => /^\d/u.test(name)), writers[0]);
    for (const lane of [1, 2, 3]) {
      const writer = startWriter(lane, `apps/cli/src/queued-${lane}.mjs`);
      writers.push(writer);
      await until(() => fs.existsSync(writer.wait), writer);
    }
    const idle = writers.slice(1);
    assert.equal(idle.filter(writer => fs.existsSync(writer.grant)).length * 2, 0,
      'three blocked graph-bearing writers booked cores while waiting');
    assert.equal(f.git('rev-parse', 'HEAD').trim(), base);
  } finally {
    blocker.stdin.end();
    await blockerDone;
    await Promise.all(writers.map(writer => writer.closed));
  }
  for (const writer of writers) assert.equal((await writer.closed)[0], 0, writer.stderr());
  assert.equal(f.git('rev-parse', 'HEAD~4').trim(), base);
  for (const writer of writers) assert.ok(!fs.existsSync(writer.grant));
});

test('only a packet that clears a fleet preflight input drift runs ahead of waiting writers', { skip: !hasFlock }, async t => {
  const f = fixture(t);
  f.write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
  f.git('add', '--', 'pnpm-lock.yaml');
  f.git('commit', '-qm', 'test: lockfile basis');
  const base = f.git('rev-parse', 'HEAD').trim();
  const queue = path.join(f.cwd, '.git', 'p03-commit-partial.lock.writers');
  const predecessor = path.join(queue, '0000000000000001-oldest');
  fs.mkdirSync(predecessor, { recursive: true });
  fs.writeFileSync(path.join(predecessor, 'writer'), '{}');
  const blocker = spawn('flock', ['-x', path.join(predecessor, 'writer'), 'sh', '-c', 'printf "ready\n"; cat >/dev/null'],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  const blockerDone = once(blocker, 'close');
  t.after(() => blocker.stdin.end());
  await once(blocker.stdout, 'data');

  const submit = (name, contents, arrival) => {
    f.write('pnpm-lock.yaml', contents);
    f.git('add', '--', 'pnpm-lock.yaml');
    const candidate = f.git('commit-tree', f.git('write-tree').trim(), '-p', base, '-m', name).trim();
    f.git('read-tree', base);
    f.write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n# current\n");
    f.write('message', name + '\n');
    const child = spawn(process.execPath, [
      fileURLToPath(new URL('../workspaces/commitGate.mjs', import.meta.url)),
      '--candidate=' + candidate, '--ref=HEAD', '--packet=' + path.join(f.cwd, 'packet'), '--message=' + f.messageFile,
    ], { cwd: f.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HAPPIER_COMMIT_GATE_ARRIVED_AT: String(arrival) } });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    return { closed: once(child, 'close'), stderr: () => stderr };
  };
  const wrongBytes = submit('test: stale lockfile bytes', "lockfileVersion: '9.0'\n# stale\n", 2);
  f.write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n# current\n");
  let repairFinished = false;
  const waitForTicket = async arrival => {
    const deadline = performance.now() + 10000;
    while (!repairFinished) {
      const record = fs.readdirSync(queue).find(name => name.startsWith(String(arrival).padStart(16, '0') + '-'));
      if (record) return;
      assert.ok(performance.now() < deadline, wrongBytes.stderr());
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  await waitForTicket(2);
  const repaired = submit('test: restore input agreement', "lockfileVersion: '9.0'\n# current\n", 3);
  const [code] = await Promise.race([repaired.closed.then(result => { repairFinished = true; return result; }),
    waitForTicket(3).then(() => ['ordinary queue'])]);
  assert.equal(code, 0, repaired.stderr());
  assert.equal(f.git('show', 'HEAD:pnpm-lock.yaml'), fs.readFileSync(path.join(f.cwd, 'pnpm-lock.yaml'), 'utf8'));
  assert.equal(fs.existsSync(predecessor), true);
  blocker.stdin.end();
  await blockerDone;
  await wrongBytes.closed;
});

for (const scenario of ['one combined check', 'bisected refusal', 'known missing import', 'refused writer retires', 'arrival during the check']) {
  test(`checks queued CLI packets as one exact tree (${scenario})`, { skip: !hasFlock }, async t => {
    const badEntry = scenario === 'bisected refusal';
    const retired = scenario === 'refused writer retires';
    const badImport = scenario === 'known missing import' || retired;
    const bad = badEntry || badImport;
    const late = scenario === 'arrival during the check';
    const { f } = treeGraphReplayFixture(t);
    const probeLog = path.join(f.cwd, 'group-probes');
    const lateReady = path.join(f.cwd, 'late-writer-ready');
    f.write('apps/stack/scripts/perf/entry-load.mjs', `
      import { appendFileSync, existsSync, readdirSync } from 'node:fs';
      export { ENTRY_GRAPHS } from './entry-graphs.mjs';
      export async function loadEntryGraph({ id, entry }) {
        const files = readdirSync('apps/cli/src').filter(name => /^group-[1-5][.]mjs$/.test(name)).sort();
        appendFileSync(process.env.TEST_PROBE_LOG, JSON.stringify(files) + String.fromCharCode(10));
        if (process.env.TEST_LATE_READY && files.length === Number(process.env.TEST_WAIT_GROUP_SIZE)) {
          for (let attempt = 0; !existsSync(process.env.TEST_LATE_READY) && attempt < 500; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          if (!existsSync(process.env.TEST_LATE_READY)) throw new Error('Late writer never reached the queue');
        }
        try {
          for (const file of files) await import(new URL('../../../cli/src/' + file, import.meta.url));
          return { graph: id, entry, status: 'passed', elapsedMs: 1 };
        } catch (error) {
          return { graph: id, entry, status: 'failed', elapsedMs: 1, loadError: { message: error.message } };
        }
      }
    `);
    f.git('add', '--', 'apps/stack/scripts/perf/entry-load.mjs');
    f.git('commit', '-qm', 'test: record exact probe trees');
    const head = f.git('rev-parse', 'HEAD').trim();
    const tickets = path.join(f.cwd, '.git', 'p03-commit-partial.lock.writers');
    const predecessor = path.join(tickets, '0000000000000000-blocker');
    fs.mkdirSync(predecessor, { recursive: true });
    fs.writeFileSync(path.join(predecessor, 'writer'), JSON.stringify({ repo: f.cwd, ref: 'refs/heads/main' }));
    const flock = execFileSync('sh', ['-c', 'command -v flock'], { encoding: 'utf8' }).trim();
    const blocker = spawn(flock, ['-x', path.join(predecessor, 'writer'), 'sh', '-c', 'printf "ready\n"; cat >/dev/null'],
      { stdio: ['pipe', 'pipe', 'inherit'] });
    const blockerDone = once(blocker, 'close');
    t.after(() => blocker.stdin.end());
    await once(blocker.stdout, 'data');

    const writers = [];
    const startWriter = async id => {
      const file = `apps/cli/src/group-${id}.mjs`;
      let source = 'export const value = 1;\n';
      if (id === 2 && badEntry) source = 'throw new Error("bad group packet");\n';
      if (id === 2 && badImport) source = 'import "./missing-group-producer.mjs";\n';
      f.write(file, source);
      const message = `group-message-${id}`;
      f.write(message, `test: group packet ${id}\n`);
      const child = spawn(process.execPath, [
        fileURLToPath(new URL('./commitFromPrivateIndex.mjs', import.meta.url)), '--message-file', path.join(f.cwd, message), '--', file,
      ], { cwd: f.cwd, stdio: ['ignore', 'ignore', 'pipe'], env: {
        ...process.env, HAPPIER_COMMIT_GATE_ARRIVED_AT: String(id),
        HAPPIER_COMMIT_TYPECHECK_GATE: 'report', HAPPIER_COMMIT_TYPECHECK_DIR: path.join(f.cwd, '.git', 'typecheck-state'),
        TEST_GROUP_QUEUE: '1', TEST_PROBE_LOG: probeLog,
        TEST_LATE_READY: late || retired ? lateReady : '', TEST_WAIT_GROUP_SIZE: retired ? '3' : '4',
      } });
      t.after(() => { if (child.exitCode === null) child.kill(); });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      writers.push({ child, closed: once(child, 'close'), stderr: () => stderr });
      const deadline = performance.now() + 15000;
      const prefix = String(id).padStart(16, '0') + '-';
      while (!fs.readdirSync(tickets).some(name => name.startsWith(prefix))) {
        assert.ok(performance.now() < deadline, stderr);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    for (const id of [1, 2, 3, 4]) await startWriter(id);
    const probeStarted = late || retired ? new Promise((resolve, reject) => {
      const watcher = fs.watch(f.cwd, (_, file) => {
        if (file !== path.basename(probeLog)) return;
        watcher.close();
        resolve(true);
      });
      watcher.once('error', reject);
      t.after(() => watcher.close());
    }) : undefined;
    blocker.stdin.end();
    const [, started] = await Promise.all([blockerDone, probeStarted && Promise.race([
      probeStarted, writers[0].closed.then(() => false),
    ])]);
    if (probeStarted) {
      assert.ok(started, writers[0].stderr());
      if (retired) {
        const refused = writers[1];
        const exited = once(refused.child, 'exit');
        refused.child.kill('SIGTERM');
        await exited;
        const ticket = fs.readdirSync(tickets).find(name => name.startsWith('0000000000000002-'));
        if (ticket) fs.rmSync(path.join(tickets, ticket), { recursive: true });
      } else {
        await startWriter(5);
      }
      f.write('late-writer-ready', '');
    }
    const expectedStatuses = bad ? [0, 1, 0, 0] : late ? [0, 0, 0, 0, 0] : [0, 0, 0, 0];
    for (const [i, writer] of writers.entries()) {
      const [code, signal] = await writer.closed;
      if (retired && i === 1) assert.equal(signal, 'SIGTERM');
      else assert.equal(code, expectedStatuses[i], writer.stderr());
    }
    const probes = fs.readFileSync(probeLog, 'utf8').trim().split('\n').map(line => JSON.parse(line).map(name => Number(name[6])));
    const all = [1, 2, 3, 4];
    const expectedProbes = badEntry ? [all, [1, 2], [1], [1, 2], [1, 3, 4]]
      : badImport ? [[1, 3, 4]] : late ? [all, [...all, 5]] : [all];
    assert.deepEqual(probes, expectedProbes);
    assert.equal(Number(f.git('rev-list', '--count', `${head}..HEAD`)), bad ? 3 : late ? 5 : 4);
    const reflog = f.git('reflog', '-3', '--format=%H', 'HEAD').split('\n');
    assert.equal(reflog[late ? 2 : 1], head);
    if (late) assert.equal(f.git('rev-parse', 'HEAD^').trim(), reflog[1]);
    if (badEntry) assert.match(writers[1].stderr(), /bad group packet/u);
    if (badImport && !retired) assert.match(writers[1].stderr(), /missing-group-producer/u);
  });
}

test('refuses a duplicate TypeScript import in the committed CLI entry closure before moving HEAD by default', { skip: !hasFlock }, t => {
  const { f } = treeGraphReplayFixture(t);
  f.write('apps/cli/src/index.mjs', "await import('./action.ts');\n");
  const producer = 'apps/cli/src/actionProducer.mjs';
  f.write(producer, 'export const open = () => 42;\n');
  const name = 'apps/cli/src/action.ts';
  const binding = "import { open } from './actionProducer.mjs';\n";
  f.write(name, binding + 'export const value = open();\n');
  f.git('add', '--', 'apps/cli/src');
  f.git('commit', '-qm', 'test: loadable CLI dependency');
  const head = f.git('rev-parse', 'HEAD').trim();
  f.write(name, binding + binding + 'export const value = open();\n');

  const { result } = runWithCommitLockContender(f, head, name);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /action\.ts:2:\d+: Duplicate import binding: open/);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), head);
});

test('refuses an unloadable CLI entry even when its parent is broken and the legacy mode is off', { skip: !hasFlock }, t => {
  const { f } = treeGraphReplayFixture(t);
  const entry = 'apps/cli/src/index.mjs';
  f.write(entry, 'throw new Error("Cannot load this CLI");\n');
  f.git('add', '--', entry);
  f.git('commit', '-qm', 'test: broken CLI parent');
  const head = f.git('rev-parse', 'HEAD').trim();
  f.write(entry, 'throw new Error("Cannot load this CLI");\nexport const value = 1;\n');

  const { result } = runWithCommitLockContender(f, head, entry, { treeGateMode: 'off' });

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /cli: .*Cannot load this CLI/);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), head);
});

test('refuses an unloadable daemon entry even when its parent is broken', { skip: !hasFlock }, t => {
  const { f } = treeGraphReplayFixture(t);
  const entry = 'apps/cli/src/daemon/startDaemon.ts';
  fs.mkdirSync(path.join(f.cwd, 'apps/cli/src/daemon'));
  f.write(entry, 'throw new Error("Cannot load this daemon");\n');
  f.write('apps/stack/scripts/perf/entry-graphs.mjs', `export const ENTRY_GRAPHS = ${JSON.stringify([
    { id: 'cli', entry: 'apps/cli/src/index.mjs' }, { id: 'daemon', entry },
  ])};`);
  f.git('add', '--', 'apps');
  f.git('commit', '-qm', 'test: broken daemon parent');
  const head = f.git('rev-parse', 'HEAD').trim();
  f.write(entry, 'throw new Error("Cannot load this daemon");\nexport const value = 1;\n');

  const { result } = runWithCommitLockContender(f, head, entry);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /daemon: .*Cannot load this daemon/);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), head);
});

test('leaves HEAD unchanged if the selected CLI entry does not return a result', { skip: !hasFlock }, t => {
  const { f, base } = treeGraphReplayFixture(t);
  const harness = 'apps/stack/scripts/perf/entry-load.mjs';
  f.write(harness, 'export const ENTRY_GRAPHS = [];\nexport async function loadEntryGraph() {}\n');

  const { result } = runWithCommitLockContender(f, base, harness);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /0\/1 results/);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), base);
});

test('checks each exact parent before taking the ref lock', { skip: !hasFlock }, t => {
  const { f, base, winner, packet } = treeGraphReplayFixture(t, { uiGraph: true });
  const { result, acquisitions, treeGateLocks, finalGrants } = runWithCommitLockContender(f, winner, packet);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(treeGateLocks.length >= 2 && treeGateLocks.every(probe => probe.endsWith(':0')), treeGateLocks.join(', '));
  assert.deepEqual(acquisitions, [base, winner]);
  assert.deepEqual(finalGrants, [base]);
  assert.equal(f.git('rev-parse', 'HEAD^').trim(), winner);
});

test('a refused entry admission leaves the commit lock and HEAD untouched', { skip: !hasFlock }, t => {
  const { f, base, winner, packet } = treeGraphReplayFixture(t, { uiGraph: true });
  const { result, acquisitions, treeGateLocks } = runWithCommitLockContender(f, winner, packet, { refuseFinalAdmission: true });
  assert.equal(result.status, 11, result.stderr);
  assert.match(result.stderr, /entry-load-admission-unavailable/);
  assert.deepEqual(acquisitions, []);
  assert.deepEqual(treeGateLocks, []);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), base);
});

test('a foreign CAS winner is preserved without replaying the gate', { skip: !hasFlock }, t => {
  const { f, base, winner } = treeGraphReplayFixture(t, { winnerInput: 'notes.md' });
  const packet = 'apps/cli/src/index.mjs';
  f.write('notes.txt', 'another writer\n');
  f.git('add', '--', 'notes.txt');
  const casWinner = f.git('commit-tree', f.git('write-tree').trim(), '-p', winner, '-m', 'test: wins CAS').trim();
  f.git('read-tree', base);
  f.write(packet, 'export const packet = true;\n');
  const { result, acquisitions, treeGateLocks } = runWithCommitLockContender(f, winner, packet, { additionalWinners: [casWinner] });
  assert.notEqual(result.status, 0, result.stderr);
  assert.deepEqual(acquisitions, [base, winner]);
  assert.ok(treeGateLocks.length > 0 && treeGateLocks.every(probe => probe === 'cli:0'), treeGateLocks.join(', '));
  assert.equal(f.git('rev-parse', 'HEAD').trim(), casWinner);
});

test('refuses a replay whose exact parent removed its producer and releases the commit lock', { skip: !hasFlock }, async (t) => {
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

  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(f.git('rev-parse', 'HEAD').trim(), winner);
  assert.match(result.stderr, /local import closure/);
  assert.match(result.stderr, /consumer\.mjs -> \.\/producer\.mjs/);
  assert.deepEqual(acquisitions, [base, winner]);
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

test('a prepared group retries once after a real ref move and stops if the ref moves again', { skip: !hasFlock }, async t => {
  const f = fixture(t);
  const { withCommitLock } = await import('../workspaces/commitWriterLock.mjs');
  const preparations = [];
  await assert.rejects(withCommitLock({ repo: f.cwd, plan: async head => {
    preparations.push(head);
    if (preparations.length <= 2) {
      const tree = f.git('rev-parse', `${head}^{tree}`).trim();
      const competing = f.git('commit-tree', tree, '-p', head, '-m', `test: competitor ${preparations.length}`).trim();
      f.git('update-ref', 'HEAD', competing, head);
    }
    return { head };
  } }, () => assert.fail('a stale prepared group must not publish')), /ref moved again/u);
  assert.equal(preparations.length, 2);
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
