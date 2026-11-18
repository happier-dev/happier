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
