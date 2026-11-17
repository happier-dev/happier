// @happier-test-preparation source-condition
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { checkCommitTypeCoherence } from './checkCommitTypeCoherence.mjs';
import * as coherence from './checkCommitTypeCoherence.mjs';
import * as diagnosticMessages from './commitTypeCoherenceDiagnostics.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { installUiTypecheckFixtureDependencies } from '../testing/lib/typecheckProjectFixture.mjs';
import { resolveHeavyweightMemoryFloorKiB } from '../../apps/stack/scripts/utils/dev_targets/remote_commands.mjs';
import { holdNativeAdmissionFixtureMemory, installNativeAdmissionControllerFixture, installWorkspaceAdmissionProcessFixture } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';
import { FIXTURE_MACHINE_SCHEMA, generateServerClients, installServerGeneratorFixture, writeServerSchemas } from '../../apps/stack/scripts/testkit/core/server_generator_fixture.mjs';

// A shared dirty checkout: the worktree holds both halves of a change, a commit takes only one.
async function checkout(t) {
  const repo = await mkdtemp(join(tmpdir(), 'happier-commit-coherence-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '--quiet');
  git('config', 'user.name', 'Coherence Test');
  git('config', 'user.email', 'coherence@example.invalid');
  const write = (path, content) => writeFile(join(repo, path), content);
  await write(
    'tsconfig.json',
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        types: [],
      },
      include: ['*.ts'],
    }),
  );
  await write('producer.ts', 'export const original = 1;\n');
  await write(
    'consumer.ts',
    "import { original } from './producer';\nexport const value: number = original;\n",
  );
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  const commitOnly = (...paths) => {
    git('add', '--', ...paths);
    git('commit', '--quiet', '-m', `commit ${paths.join(' ')}`);
    return git('rev-parse', 'HEAD').trim();
  };
  return { repo, write, commitOnly, git };
}

test('importer discovery handles changed target stems beyond the OS argument limit', async t => {
  const { repo, write, git } = await checkout(t);
  // Observe the real Git process boundary: regex compilation must stay constant-size.
  let grepCount = 0;
  const run = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    if (command === 'git' && args[0] === 'grep') {
      grepCount++;
      const patterns = args.includes('-f')
        ? String(options.input).trimEnd().split('\n')
        : args.filter(arg => arg === '-e');
      assert.equal(patterns.length, 1, 'Git must compile one import pattern regardless of changed-module count');
    }
    return run(command, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  // Exceed Linux's 128 KiB single-argument limit without passing the fixture through argv.
  const targets = Array.from({ length: 1500 }, (_, i) => `module${i}_${'x'.repeat(100)}.ts`);
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: repo, encoding: 'utf8', input: 'export const original = 1;\n',
  }).trim();
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: repo, input: targets.map(path => `100644 ${blob}\t${path}\n`).join(''),
  });
  await write('consumer.ts', `import { original } from './${targets.at(-1).slice(0, -3)}';\nexport const value: number = original;\n`);
  git('add', '--', 'consumer.ts');
  git('commit', '--quiet', '-m', 'many modules');
  const base = git('rev-parse', 'HEAD').trim();
  execFileSync('git', ['update-index', '--index-info'], {
    cwd: repo, input: targets.map(path => `0 ${'0'.repeat(40)}\t${path}\n`).join(''),
  });
  git('commit', '--quiet', '-m', 'remove modules');
  const tree = git('rev-parse', 'HEAD').trim();
  const result = checkCommitTypeCoherence({ repo, base, tree });
  assert.deepEqual(result.unowned, []);
  assert.ok(result.fresh.some(row => row.file === 'consumer.ts' && row.code === 2307),
    'the importer of the last removed target must report its missing module');
  assert.ok(grepCount > 0, 'the bounded-pattern contract must exercise Git importer discovery');
});

// P03-ADMISSION-PRIORITY: the compiler admission identity names the owner programs this
// packet compiles (its changed files and their importers), so the broker reserves the
// measured peak of that program set rather than one class-wide floor.
test('compiler admission names the owner programs the packet compiles, importers included', async t => {
  const { repo, write, git } = await checkout(t);
  await mkdir(join(repo, 'pkg'));
  await write('pkg/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'] }));
  await write('pkg/inner.ts', 'export const inner = 1;\n');
  await write('pkg/alone.ts', 'export const alone = 1;\n');
  await write('outer.ts', "import { inner } from './pkg/inner';\nexport const outer: number = inner;\n");
  git('add', '-A');
  git('commit', '--quiet', '-m', 'owners');
  const requested = target => {
    git('commit', '--quiet', '-m', `change ${target}`, '--', target);
    let projects;
    assert.throws(() => checkCommitTypeCoherence({ repo, base: 'HEAD^', tree: 'HEAD', beforeCompiler: value => {
      projects = value;
      throw new Error('admission requested');
    } }), /admission requested/u);
    return projects;
  };
  await write('pkg/alone.ts', 'export const alone = 2;\n');
  assert.deepEqual(requested('pkg/alone.ts'), ['pkg']);
  await write('pkg/inner.ts', 'export const inner = 2;\n');
  assert.deepEqual(requested('pkg/inner.ts'), ['.', 'pkg'], 'a root importer adds the root program');
});

test('verdict dependencies omit unrelated modules while retaining configured global and module augmentations', async t => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('ambient.d.ts', 'interface Error { ambientValue: number }\n');
  await write('globals.ts', 'export {}; declare global { interface Error { moduleValue: number } }\n');
  await write('augmentation.ts', "import './producer'; declare module './producer' { interface Shape { augmented: number } }\n");
  await write('producer.ts', 'export interface Shape {}\nexport const original = 1;\n');
  await mkdir(join(repo, 'types'));
  await write('types/indirect.d.ts', 'interface Error { importedValue: number }\n');
  await write('unrelated.ts', "import './types/indirect'; export { value } from './unrelatedDependency';\n");
  await write('unrelatedDependency.ts', 'export const value = 1;\n');
  const base = commitOnly('ambient.d.ts', 'globals.ts', 'augmentation.ts', 'producer.ts', 'unrelated.ts', 'unrelatedDependency.ts', 'types');
  await write('producer.ts', 'export interface Shape {}\ndeclare const shape: Shape; declare const error: Error;\nexport const original = shape.augmented + error.ambientValue + error.moduleValue + error.importedValue;\n');
  const tree = commitOnly('producer.ts');
  const result = checkCommitTypeCoherence({ repo, base, tree });
  assert.deepEqual(result.fresh, []);
  assert.deepEqual(result.unowned, []);
  const paths = new Set(result.groups.flatMap(group => group.paths));
  for (const path of ['producer.ts', 'consumer.ts', 'ambient.d.ts', 'globals.ts', 'augmentation.ts', 'types/indirect.d.ts']) {
    assert.ok(paths.has(path), `configured context or checked root missing: ${path}`);
  }
  for (const path of ['unrelated.ts', 'unrelatedDependency.ts']) {
    assert.ok(!paths.has(path), `unrelated module entered the slice program: ${path}`);
  }
});

test('unrelated same-project HEAD moves finalize with zero compiler admissions', async t => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('unrelatedDependency.ts', 'export const value = 1;\n');
  await write('unrelated.ts', "import { value } from './unrelatedDependency'; export const unrelated = value;\n");
  const base = commitOnly('unrelated.ts', 'unrelatedDependency.ts');
  await write('producer.ts', 'export const original = 2;\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('add', '--', 'producer.ts');
  const tree = git('write-tree');
  git('read-tree', base);
  const checked = checkCommitTypeCoherence({ repo, base, tree });
  await write('unrelated.ts', "import { value } from './unrelatedDependency'; export const unrelated = String(value);\n");
  const parent = commitOnly('unrelated.ts');
  const bin = await mkdtemp(join(tmpdir(), 'happier-coherence-no-readmission-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const marker = join(bin, 'compiler-launch');
  const previousPath = process.env.PATH;
  if (process.platform !== 'win32') {
    // Observe the genuine executable boundary; keep the compiler/admission path real.
    const shim = join(bin, 'node');
    await writeFile(shim, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nwriteFileSync(${JSON.stringify(marker)}, 'launched');\nconst result = spawnSync(${JSON.stringify(process.execPath)}, process.argv.slice(2), { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);\n`);
    await chmod(shim, 0o755);
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
  }
  let result;
  try {
    result = coherence.finalizeCommitTypeCoherence({ repo, checked, message: 'fix: independent packet\n' });
  } finally { process.env.PATH = previousPath; }
  assert.ok(result.commit);
  assert.deepEqual(result.recheckedGroups, []);
  assert.equal(existsSync(marker), false, 'non-intersecting HEAD movement must not launch another compiler admission');
  assert.equal(git('rev-parse', 'HEAD^'), parent);
});

test('an unrelated configured module introducing a global augmentation invalidates the verdict', async t => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('ambient.d.ts', 'interface CoherenceContext { original: number }\n');
  await write('unrelated.ts', 'export {};\n');
  const base = commitOnly('ambient.d.ts', 'unrelated.ts');
  await write('producer.ts', 'export const original: keyof CoherenceContext extends "original" ? number : string = 1;\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('add', '--', 'producer.ts');
  const tree = git('write-tree');
  git('read-tree', base);
  const checked = checkCommitTypeCoherence({ repo, base, tree });
  assert.deepEqual(checked.fresh, []);
  await write('unrelated.ts', 'export {}; declare global { interface CoherenceContext { added: number } }\n');
  const parent = commitOnly('unrelated.ts');
  const result = coherence.finalizeCommitTypeCoherence({ repo, checked, message: 'fix: dependent packet\n' });
  assert.deepEqual(result.recheckedGroups, ['.']);
  assert.equal(result.commit, undefined);
  assert.ok(result.checked.fresh.some(row => row.file === 'producer.ts' && row.code === 2322));
  assert.equal(git('rev-parse', 'HEAD'), parent);
});

test('changed imports outside the verdict closure recheck newly reachable global declarations', async t => {
  const { repo, write, commitOnly } = await checkout(t);
  await mkdir(join(repo, 'types'));
  await write('ambient.d.ts', 'interface CoherenceContext { original: number }\n');
  await write('types/global.d.ts', 'interface CoherenceContext { added: number }\n');
  await write('unrelated.ts', 'export {};\n');
  const base = commitOnly('ambient.d.ts', 'types', 'unrelated.ts');
  await write('producer.ts', 'export const original: keyof CoherenceContext extends "original" ? number : string = 1;\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('add', '--', 'producer.ts');
  const tree = git('write-tree');
  git('read-tree', base);
  const checked = checkCommitTypeCoherence({ repo, base, tree });
  assert.deepEqual(checked.fresh, []);
  await write('unrelated.ts', "import './types/global'; export {};\n");
  const parent = commitOnly('unrelated.ts');
  const result = coherence.finalizeCommitTypeCoherence({ repo, checked, message: 'fix: dependent packet\n' });
  assert.deepEqual(result.recheckedGroups, ['.']);
  assert.equal(result.commit, undefined);
  assert.ok(result.checked.fresh.some(row => row.file === 'producer.ts' && row.code === 2322));
  assert.equal(git('rev-parse', 'HEAD'), parent);
});

test('testing scripts have a strict compiler owner that reports new validator errors', async t => {
  const { repo, write, commitOnly } = await checkout(t);
  await mkdir(join(repo, 'scripts/testing'), { recursive: true });
  await rm(join(repo, 'tsconfig.json'));
  const config = await readFile(new URL('../testing/tsconfig.json', import.meta.url), 'utf8').catch(() => null);
  if (config) await write('scripts/testing/tsconfig.json', config);
  await write('scripts/testing/validateUiActionParity.ts', 'export const value: number = 1;\n');
  const base = commitOnly('scripts', 'tsconfig.json');
  await write('scripts/testing/validateUiActionParity.ts', 'export const value: number = "wrong";\n');
  const tree = commitOnly('scripts');
  const result = checkCommitTypeCoherence({ repo, base, tree });
  assert.deepEqual(result.unowned, []);
  assert.deepEqual(result.fresh.map(({ file, code }) => ({ file, code })), [
    { file: 'scripts/testing/validateUiActionParity.ts', code: 2322 },
  ]);
});

test('UI coherence prepares typed routes from each Git tree despite empty live Expo declarations', async t => {
  const { repo, write, commitOnly } = await checkout(t);
  const ui = join(repo, 'apps/ui');
  await mkdir(ui, { recursive: true });
  await installUiTypecheckFixtureDependencies(t, ui);
  const put = async (path, content) => {
    await mkdir(join(ui, path, '..'), { recursive: true });
    await write(`apps/ui/${path}`, content);
  };
  await put('.gitignore', 'node_modules/\n.expo/\n');
  await put('package.json', JSON.stringify({ name: 'coherence-ui-fixture' }));
  await put('app.json', JSON.stringify({ expo: { name: 'Coherence routes', slug: 'coherence-routes',
    experiments: { typedRoutes: true }, extra: { router: { root: './src/routes' } } } }));
  await put('metro.config.js', 'module.exports = { resolver: { blockList: [] } };\n');
  await put('tsconfig.json', JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, skipLibCheck: true, types: [],
    module: 'esnext', moduleResolution: 'bundler', target: 'es2022',
  }, include: ['src/**/*.ts', '.expo/types/**/*.ts'] }));
  await put('src/routes/index.ts', 'export default function Route() { return null; }\n');
  await put('src/consumer.ts', "import type { Href } from 'expo-router';\nexport const link: Href = '/';\n");
  const require = createRequire(new URL('../../apps/ui/package.json', import.meta.url));
  const { inMemoryContext } = require('expo-router/internal/testing');
  const { getTypedRoutesDeclarationFile } = require('@expo/router-server/build/typed-routes/generate');
  const emptyRoutes = getTypedRoutesDeclarationFile(inMemoryContext({}));
  await put('.expo/types/router.d.ts', emptyRoutes);
  const base = commitOnly('apps/ui');
  await put('src/routes/plugins/index.ts', 'export default function Route() { return null; }\n');
  await put('src/consumer.ts', "import type { Href } from 'expo-router';\nexport const link: Href = '/plugins';\n");
  const tree = commitOnly('apps/ui');
  await rm(join(ui, 'src/routes/plugins'), { recursive: true });
  await put('src/routes/worktree-only.ts', 'export default function Route() { return null; }\n');
  const result = checkCommitTypeCoherence({ repo, base, tree });
  assert.deepEqual(result.fresh, [], 'the committed route is valid even when absent from disk');
  assert.equal(await readFile(join(ui, '.expo/types/router.d.ts'), 'utf8'), emptyRoutes, 'live Expo output stays untouched');
  await put('src/consumer.ts', "import type { Href } from 'expo-router';\nexport const link: Href = '/worktree-only';\n");
  const invalid = commitOnly('apps/ui/src/consumer.ts');
  const rejected = checkCommitTypeCoherence({ repo, base: tree, tree: invalid });
  assert.deepEqual(rejected.fresh.map(({ file, code }) => ({ file, code })), [
    { file: 'apps/ui/src/consumer.ts', code: 2322 },
  ], 'uncommitted routes cannot authorize a committed navigation target');
});

async function checkedPacket(t) {
  const fixture = await checkout(t);
  const { repo, write, commitOnly } = fixture;
  for (const dir of ['a', 'b']) {
    await mkdir(join(repo, dir));
    await write(`${dir}/tsconfig.json`, JSON.stringify({ extends: '../tsconfig.json', include: ['*.ts'], exclude: ['excluded.ts'] }));
    await write(`${dir}/producer.ts`, 'export const value = 1;\n');
    await write(`${dir}/consumer.ts`, "import { value } from './producer';\nexport const prior = value;\n");
    await write(`${dir}/excluded.ts`, "import { prior } from './consumer';\nexport const excluded = prior;\n");
  }
  const base = commitOnly('a', 'b');
  for (const dir of ['a', 'b'])
    await write(`${dir}/consumer.ts`, "import { value } from './producer';\nexport const prior = value;\nexport const added: number = value;\n");
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('add', '--', 'a/consumer.ts', 'b/consumer.ts');
  const tree = git('write-tree');
  git('read-tree', base);
  const checked = checkCommitTypeCoherence({ repo, base, tree });
  assert.deepEqual(checked.fresh, []);
  return { ...fixture, git, checked };
}

test('moved HEAD with disjoint commits carries over the checked packet and preserves concurrent history', async (t) => {
  const { repo, write, commitOnly, git, checked } = await checkedPacket(t);
  await write('unrelated.md', 'concurrent work\n');
  const parent = commitOnly('unrelated.md');
  const index = git('write-tree');
  assert.equal(typeof coherence.finalizeCommitTypeCoherence, 'function');
  const result = coherence.finalizeCommitTypeCoherence({ repo, checked, message: 'fix: checked packet\n' });
  assert.deepEqual(result.recheckedGroups, []);
  assert.deepEqual(result.reusedGroups, ['a', 'b']);
  assert.equal(git('rev-parse', 'HEAD^'), parent);
  assert.equal(git('rev-parse', 'HEAD'), result.commit);
  assert.equal(git('show', 'HEAD:unrelated.md'), 'concurrent work');
  assert.match(git('show', 'HEAD:a/consumer.ts'), /added: number/);
  assert.equal(git('write-tree'), index, 'finalization leaves shared staging to its caller');
  assert.match(await readFile(join(repo, 'a/consumer.ts'), 'utf8'), /added: number/);
});

test('moved HEAD rechecks only the intersecting program and refuses its newly broken packet', async (t) => {
  const { repo, write, commitOnly, git, checked } = await checkedPacket(t);
  await write('a/producer.ts', "export const value = 'changed';\n");
  const parent = commitOnly('a/producer.ts');
  assert.equal(typeof coherence.finalizeCommitTypeCoherence, 'function');
  const result = coherence.finalizeCommitTypeCoherence({ repo, checked, message: 'fix: checked packet\n' });
  assert.deepEqual(result.recheckedGroups, ['a']);
  assert.deepEqual(result.reusedGroups, ['b']);
  assert.equal(result.commit, undefined);
  assert.deepEqual(result.checked.fresh.map(({ file, code }) => [file, code]), [['a/consumer.ts', 2322]]);
  assert.equal(git('rev-parse', 'HEAD'), parent);
});

test('moved HEAD replays compatible same-file hunks and rechecks even changes later reverted', async (t) => {
  const { repo, write, commitOnly, git, checked } = await checkedPacket(t);
  await write('a/producer.ts', 'export const value = 2;\n');
  commitOnly('a/producer.ts');
  await write('a/producer.ts', 'export const value = 1;\n');
  commitOnly('a/producer.ts');
  await write('a/consumer.ts', "// concurrent comment\nimport { value } from './producer';\nexport const prior = value;\n");
  const parent = commitOnly('a/consumer.ts');
  assert.equal(typeof coherence.finalizeCommitTypeCoherence, 'function');
  const result = coherence.finalizeCommitTypeCoherence({ repo, checked, message: 'fix: checked packet\n' });
  assert.deepEqual(result.recheckedGroups, ['a']);
  assert.deepEqual(result.reusedGroups, ['b']);
  assert.equal(git('rev-parse', 'HEAD^'), parent);
  assert.match(git('show', 'HEAD:a/consumer.ts'), /^\/\/ concurrent comment[\s\S]*added: number/);
});

test('moved HEAD discovers a new importer group without rechecking disjoint existing groups', async (t) => {
  const { repo, write, commitOnly, checked } = await checkedPacket(t);
  await mkdir(join(repo, 'c'));
  await write('c/tsconfig.json', JSON.stringify({ extends: '../tsconfig.json', include: ['*.ts'] }));
  await write('c/consumer.ts', "import { prior } from '../a/consumer';\nexport const value = prior;\n");
  commitOnly('c');
  const result = coherence.finalizeCommitTypeCoherence({ repo, checked, message: 'fix: checked packet\n' });
  assert.ok(result.commit);
  assert.deepEqual(result.recheckedGroups, ['c']);
  assert.deepEqual(result.reusedGroups, ['a', 'b']);
});

test('a packet already committed by another writer never creates an empty duplicate commit', async (t) => {
  const { repo, git, checked } = await checkedPacket(t);
  const other = execFileSync('git', ['commit-tree', checked.tree, '-p', checked.base], {
    cwd: repo, input: 'fix: packet already landed\n', encoding: 'utf8',
  }).trim();
  git('update-ref', 'HEAD', other, checked.base);
  assert.throws(() => coherence.finalizeCommitTypeCoherence({ repo, checked, message: 'fix: checked packet\n' }), /already present/u);
  assert.equal(git('rev-parse', 'HEAD'), other);
});

test('conflicting concurrent packet edits leave HEAD, shared staging and worktree untouched', async (t) => {
  const { repo, write, commitOnly, git, checked } = await checkedPacket(t);
  await write('a/consumer.ts', "import { value } from './producer';\nexport const prior = value;\nexport const added = 'other writer';\n");
  const parent = commitOnly('a/consumer.ts');
  const index = git('write-tree');
  const before = await readFile(join(repo, 'a/consumer.ts'), 'utf8');
  assert.throws(() => coherence.finalizeCommitTypeCoherence({ repo, checked, message: 'fix: checked packet\n' }));
  assert.equal(git('rev-parse', 'HEAD'), parent);
  assert.equal(git('write-tree'), index);
  assert.equal(await readFile(join(repo, 'a/consumer.ts'), 'utf8'), before);
});

test('moved HEAD reuses the verdict when intervening program changes were reverted', async (t) => {
  const { repo, write, commitOnly, checked } = await checkedPacket(t);
  await write('a/producer.ts', 'export const value = 2;\n');
  commitOnly('a/producer.ts');
  await write('a/producer.ts', 'export const value = 1;\n');
  commitOnly('a/producer.ts');
  const result = coherence.finalizeCommitTypeCoherence({ repo, checked, message: 'fix: checked packet\n' });
  assert.ok(result.commit);
  assert.deepEqual(result.recheckedGroups, []);
  assert.deepEqual(result.reusedGroups, ['a', 'b']);
});

test('a competing writer wins CAS during finalization and its disjoint commit is preserved on retry', { skip: process.platform === 'win32' }, async (t) => {
  const { repo, write, git, checked } = await checkedPacket(t);
  const ref = git('symbolic-ref', 'HEAD');
  await write('concurrent.md', 'another writer\n');
  git('add', '--', 'concurrent.md');
  const otherTree = git('write-tree');
  git('read-tree', checked.base);
  const otherCommit = execFileSync('git', ['commit-tree', otherTree, '-p', checked.base], {
    cwd: repo, input: 'fix: competing writer\n', encoding: 'utf8',
  }).trim();
  const bin = await mkdtemp(join(tmpdir(), 'happier-coherence-git-boundary-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const previousPath = process.env.PATH;
  const realGit = previousPath.split(delimiter).map(dir => join(dir, 'git')).find(existsSync);
  assert.ok(realGit);
  // Mock only the OS process boundary: all Git object, replay and CAS operations remain real.
  const shim = join(bin, 'git');
  await writeFile(shim, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const marker = ${JSON.stringify(join(bin, 'raced'))};
if (args[0] === 'update-ref' && (args[1] !== ${JSON.stringify(ref)} || args.length !== 4)) {
  process.stderr.write('Finalization must CAS the explicit branch with its observed old value');
  process.exit(1);
}
if (args[0] === 'update-ref' && !existsSync(marker)) {
  writeFileSync(marker, 'raced');
  const raced = spawnSync(${JSON.stringify(realGit)}, ['update-ref', 'HEAD', ${JSON.stringify(otherCommit)}, ${JSON.stringify(checked.base)}], { stdio: 'inherit' });
  if (raced.status !== 0) process.exit(raced.status ?? 1);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
  await chmod(shim, 0o755);
  let result;
  try {
    process.env.PATH = `${bin}${delimiter}${previousPath}`;
    result = coherence.finalizeCommitTypeCoherence({ repo, checked, message: 'fix: checked packet\n', ref });
  } finally {
    process.env.PATH = previousPath;
  }
  assert.equal(git('rev-parse', 'HEAD^'), otherCommit);
  assert.equal(git('show', 'HEAD:concurrent.md'), 'another writer');
  assert.deepEqual(result.recheckedGroups, []);
  assert.deepEqual(result.reusedGroups, ['a', 'b']);
});

test('the public checker CLI checks and finalizes a private packet with its message file', async (t) => {
  const { repo, git, checked } = await checkedPacket(t);
  const messageFile = join(repo, 'message.txt');
  await writeFile(messageFile, 'fix: public checker finalization\n');
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./checkCommitTypeCoherence.mjs', import.meta.url)),
    `--base=${checked.base}`, `--tree=${checked.tree}`, `--message-file=${messageFile}`, `--ref=${git('symbolic-ref', 'HEAD')}`,
  ], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const committed = /^committed ([a-f0-9]+):/mu.exec(result.stdout)?.[1];
  assert.equal(committed, git('rev-parse', 'HEAD'));
  assert.equal(git('show', '-s', '--format=%s', 'HEAD'), 'fix: public checker finalization');
  assert.equal(git('rev-parse', 'HEAD^'), checked.base);
});

test('a consumer committed without its uncommitted producer is incoherent at the commit', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write(
    'producer.ts',
    'export const original = 1;\nexport const added = 2;\n',
  );
  await write(
    'consumer.ts',
    "import { added } from './producer';\nexport const value: number = added;\n",
  );
  const commit = commitOnly('consumer.ts');

  const result = checkCommitTypeCoherence({
    repo,
    base: `${commit}^`,
    tree: commit,
  });

  assert.deepEqual(
    result.fresh.map((row) => [row.file, row.code]),
    [['consumer.ts', 2305]],
  );
});

test('a committed producer change breaks an importer whose adaptation stayed uncommitted', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('producer.ts', 'export const renamed = 1;\n');
  await write(
    'consumer.ts',
    "import { renamed } from './producer';\nexport const value: number = renamed;\n",
  );
  const commit = commitOnly('producer.ts');

  const result = checkCommitTypeCoherence({
    repo,
    base: `${commit}^`,
    tree: commit,
  });

  assert.deepEqual(
    result.fresh.map((row) => [row.file, row.code]),
    [['consumer.ts', 2305]],
  );
});

test('a slice that carries its producer is coherent although the worktree differs', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write(
    'producer.ts',
    'export const original = 1;\nexport const added = 2;\n',
  );
  await write(
    'consumer.ts',
    "import { added } from './producer';\nexport const value: number = added;\n",
  );
  const commit = commitOnly('producer.ts', 'consumer.ts');
  await write('producer.ts', 'export const unrelatedLaterWork = 3;\n');

  assert.deepEqual(
    checkCommitTypeCoherence({ repo, base: `${commit}^`, tree: commit }).fresh,
    [],
  );
});

test('importer discovery ignores fixture text and comments while retaining real imports', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('fixture.ts', "export const source = `import { original } from './producer';`;\n// import { original } from './producer';\n/* require('./producer') */\n");
  await write('dynamic.ts', "export const load = () => import('./producer');\n");
  await write('reexport.ts', "export { original } from './producer';\n");
  await write('type.ts', "export type Module = typeof import('./producer');\n");
  await write('equals.ts', "import producer = require('./producer');\nexport const value = producer.original;\n");
  await write('require.ts', "declare function require(id: string): unknown;\nexport const value = require('./producer');\n");
  await write('mock.ts', "declare const vi: { mock(id: string): void };\nvi.mock('./producer');\n");
  const base = commitOnly('fixture.ts', 'dynamic.ts', 'reexport.ts', 'require.ts', 'mock.ts', 'type.ts', 'equals.ts');
  await write('producer.ts', 'export const original = 2;\n');
  const tree = commitOnly('producer.ts');
  const result = checkCommitTypeCoherence({ repo, base, tree });
  assert.deepEqual(result.fresh, []);
  assert.equal(result.roots, 8, 'producer plus seven real importers; fixture text has no importer root');
});

test('diagnostics already present at the base are not attributed to the slice', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write(
    'consumer.ts',
    "import { original } from './producer';\nexport const value: string = original;\n",
  );
  const broken = commitOnly('consumer.ts');
  await write(
    'consumer.ts',
    "import { original } from './producer';\nexport const value: string = original;\nexport const more = 1;\n",
  );
  const commit = commitOnly('consumer.ts');

  assert.equal(
    checkCommitTypeCoherence({ repo, base: broken, tree: commit }).fresh.length,
    0,
  );
  assert.deepEqual(
    checkCommitTypeCoherence({
      repo,
      base: `${broken}^`,
      tree: broken,
    }).fresh.map((row) => row.code),
    [2322],
  );
});

test('inserted lines move inherited diagnostics without hiding a new changed-line error', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  const inherited = "export const inherited: string = 1;\n";
  await write('consumer.ts', inherited);
  const base = commitOnly('consumer.ts');
  await write('consumer.ts', '// inserted\n// inserted again\n' + inherited + "export const fresh: boolean = 1;\n");
  const tree = commitOnly('consumer.ts');
  assert.deepEqual(checkCommitTypeCoherence({ repo, base, tree }).fresh.map(({ file, line, code }) => [file, line, code]),
    [['consumer.ts', 4, 2322]]);
});

test('changed-line matching consumes inherited messages once and preserves new messages at the same position', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('consumer.ts', 'export const inherited: string = 1;\n');
  const base = commitOnly('consumer.ts');
  await write('consumer.ts', 'export const inherited: boolean = 1;\n');
  const changed = commitOnly('consumer.ts');
  assert.deepEqual(checkCommitTypeCoherence({ repo, base, tree: changed }).fresh.map(({ code }) => code), [2322]);
  // One replaced hunk retains an identical diagnostic; its duplicate is still new.
  await write('consumer.ts', 'export const renamed: string = 1; export const duplicate: string = 1;\n');
  const duplicated = commitOnly('consumer.ts');
  assert.equal(checkCommitTypeCoherence({ repo, base, tree: duplicated }).fresh.length, 1);
});

test('the checker CLI identifies and refuses source files without a compiler owner', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await rm(join(repo, 'tsconfig.json'));
  const base = commitOnly('tsconfig.json');
  await write('consumer.ts', 'export const changed = 1;\n');
  const tree = commitOnly('consumer.ts');
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./checkCommitTypeCoherence.mjs', import.meta.url)),
    `--base=${base}`, `--tree=${tree}`], { cwd: repo, encoding: 'utf8' });
  assert.match(result.stdout, /unowned[^\n]*consumer\.ts/u);
  assert.equal(result.status, 1, result.stderr);
});

test('an exact same-directory rename retains its diagnostic baseline without hiding new importer failures', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('producer.ts', 'export const original: string = 1;\n');
  const base = commitOnly('producer.ts');
  execFileSync('git', ['mv', 'producer.ts', 'producer.composed.ts'], { cwd: repo });
  const renamed = commitOnly('producer.composed.ts');
  const result = checkCommitTypeCoherence({ repo, base, tree: renamed });
  assert.deepEqual(result.fresh.map(({ file, code }) => [file, code]), [['consumer.ts', 2307]]);
});

test('excluded unmodified importers do not inject globals into the owner, while included importers are checked', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'], exclude: ['*.composed.ts'] }));
  await write('excluded.composed.ts', "import { original } from './producer';\ndeclare global { interface Error { rendererOnly: true } }\n");
  const base = commitOnly('tsconfig.json', 'excluded.composed.ts');
  await write('producer.ts', "export const original = 'changed';\nexport const error: Error = { name: 'Error', message: 'fixture' };\n");
  const tree = commitOnly('producer.ts');
  assert.deepEqual(checkCommitTypeCoherence({ repo, base, tree }).fresh.map(({ file, code }) => [file, code]), [['consumer.ts', 2322]]);
  await write('excluded.composed.ts', "import { original } from './producer';\ndeclare global { interface Error { rendererOnly: true } }\nexport const invalid: number = 'invalid';\n");
  const changedExcluded = commitOnly('excluded.composed.ts');
  assert.deepEqual(checkCommitTypeCoherence({ repo, base: tree, tree: changedExcluded }).fresh, []);
});

test('an aggregate with a renamed excluded renderer importer uses the package compiler context', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'], exclude: ['*.composed.ts'] }));
  await write('renderer.test.ts', "import { original } from './producer';\ndeclare global { interface Error { rendererOnly: true } }\n");
  const base = commitOnly('tsconfig.json', 'renderer.test.ts');
  execFileSync('git', ['mv', 'renderer.test.ts', 'renderer.composed.ts'], { cwd: repo });
  commitOnly('renderer.composed.ts');
  await write('producer.ts', "export const original = 1;\nexport const error: Error = { name: 'Error', message: 'fixture' };\n");
  const tree = commitOnly('producer.ts');

  const args = ['--showConfig', '-p', join(repo, 'tsconfig.json')];
  // --showConfig only reads configuration; this boundary fixture needs no compiler admission.
  const compiler = resolveTypeScriptCliInvocation({ args, workspaceDir: repo, env: { CI: 'true' } });
  const configured = JSON.parse(execFileSync(compiler.command, [...compiler.argsPrefix, ...args], { cwd: repo, encoding: 'utf8' }));
  assert.deepEqual(configured.files.sort(), ['./consumer.ts', './producer.ts']);
  // Later worktree configuration must not change the committed package's membership.
  await write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'] }));
  assert.deepEqual(checkCommitTypeCoherence({ repo, base, tree }).fresh, []);
});

test('a new diagnostic location is not hidden by an identical message elsewhere in the base', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write(
    'consumer.ts',
    "import { original } from './producer';\nexport const value: string = original;\n",
  );
  const base = commitOnly('consumer.ts');
  await write(
    'consumer.ts',
    "import { original } from './producer';\nexport const value: string = original;\nexport const another: string = original;\n",
  );
  const tree = commitOnly('consumer.ts');

  assert.deepEqual(
    checkCommitTypeCoherence({ repo, base, tree }).fresh.map(
      ({ file, line, code }) => ({ file, line, code }),
    ),
    [{ file: 'consumer.ts', line: 3, code: 2322 }],
  );
});

test('a pre-existing error in an unchanged file stays attributed to the base when its printed types change', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('producer.ts', "export const original = { a: '' };\n");
  const broken = commitOnly('producer.ts');
  // The slice reshapes the producer; the untouched consumer's existing TS2322 now prints `{ b: string; }`.
  await write('producer.ts', "export const original = { b: '' };\n");
  const commit = commitOnly('producer.ts');

  assert.equal(
    checkCommitTypeCoherence({ repo, base: broken, tree: commit }).fresh.length,
    0,
  );
});

test('direct CLI and imported coherence checks queue together before starting compiler APIs',
  { skip: process.platform !== 'linux', timeout: 30000 }, async t => {
    const { repo, write, git } = await checkout(t);
    const base = git('rev-parse', 'HEAD').trim();
    await write('producer.ts', 'export const original = 2;\n');
    git('add', '--', 'producer.ts');
    const tree = git('write-tree').trim();
    // Two dependency changes arrive during successive compiler phases. Keep the
    // packet and compiler real, and advance only this fixture's Git ref.
    git('read-tree', base);
    const parents = [];
    for (const version of [1, 2]) {
      await write('consumer.ts', `import { original } from './producer';\nexport const value: number = original;\n// concurrent ${version}\n`);
      git('add', '--', 'consumer.ts');
      parents.push(execFileSync('git', ['commit-tree', git('write-tree').trim(), '-p', parents.at(-1) ?? base], {
        cwd: repo, input: 'fix: concurrent dependency\n', encoding: 'utf8',
      }).trim());
    }
    git('read-tree', base);
    const native = await installNativeAdmissionControllerFixture(t, repo);
    const floor = resolveHeavyweightMemoryFloorKiB('compilation');
    const holder = await holdNativeAdmissionFixtureMemory(t, native,
      { totalKiB: floor * 3, availableKiB: floor - 1 });
    const entry = new URL('./checkCommitTypeCoherence.mjs', import.meta.url);
    const message = join(repo, 'queued-message.txt');
    await writeFile(message, 'fix: finalize admitted TypeScript packet\n');
    const trace = join(repo, 'queued-work.jsonl');
    const preload = join(repo, 'observe-queued-work.mjs');
    // Observe real module and Git process boundaries before the broker admits the CLI.
    await writeFile(preload, `
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const record = kind => appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ pid: process.pid, kind }) + '\\n');
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'typescript' || specifier === '@typescript/native/sync') record('compiler');
  return next(specifier, context);
} });
const cp = createRequire(import.meta.url)('node:child_process');
const net = createRequire(import.meta.url)('node:net');
const spawn = cp.spawn;
const parents = ${JSON.stringify(parents)};
let compilerPhases = 0;
cp.spawn = (command, args, options) => {
  if (process.argv.some(arg => arg.startsWith('--message-file='))
    && command.endsWith('/runCommitTypeCoherenceApi.mjs')) {
    record('compiler-phase');
    const parent = parents[compilerPhases++];
    if (parent) cp.execFileSync('git', ['update-ref', 'HEAD', parent, compilerPhases === 1 ? ${JSON.stringify(base)} : parents[compilerPhases - 2]]);
  }
  return spawn(command, args, options);
};
const write = net.Socket.prototype.write;
net.Socket.prototype.write = function(data, ...args) {
  if (typeof data === 'string' && data.startsWith('{')) {
    try { if (JSON.parse(data).kind === 'acquire') record('admission'); } catch {}
  }
  return write.call(this, data, ...args);
};
const exec = cp.execFileSync;
cp.execFileSync = (command, args, options) => {
  if (command === 'git' && args[0] === 'cat-file') record('blob');
  return exec(command, args, options);
};
syncBuiltinESMExports();
`);
    const commands = [
      [fileURLToPath(entry), `--base=${base}`, `--tree=${tree}`, `--message-file=${message}`],
      ['--input-type=module', '-e', `import { checkCommitTypeCoherence } from ${JSON.stringify(entry.href)};
        const result = checkCommitTypeCoherence({ repo: process.cwd(), base: ${JSON.stringify(base)}, tree: ${JSON.stringify(tree)} });
        if (result.fresh.length || result.unowned.length) process.exitCode = 1;`],
    ];
    const jobs = commands.map(args => {
      const child = spawn(process.execPath, args, { cwd: repo,
        env: { ...native.env, CI: '', NODE_OPTIONS: `${native.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}` } });
      const closed = once(child, 'close');
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      return { child, closed, output: () => output };
    });
    t.after(async () => {
      for (const job of jobs) {
        if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGTERM');
        await job.closed;
      }
    });
    let status;
    while (true) {
      t.signal.throwIfAborted();
      status = await native.brokerStatus();
      if (status.waitingCount === 2) break;
      for (const job of jobs) assert.equal(job.child.exitCode, null,
        `a direct caller completed instead of waiting for compiler admission: ${job.output()}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.activeCount, 1, 'only the physical-memory holder is admitted');
    assert.equal(status.queuedMemoryKiB, floor * 2, 'both API invocations reserve the canonical compiler floor');
    const cliPid = jobs[0].child.pid;
    const rss = (await readFile(`/proc/${cliPid}/status`, 'utf8')).match(/^VmRSS:\s+(\d+) kB$/mu)?.[1];
    t.diagnostic(`queued TS CLI pid=${cliPid} RSS=${rss} KiB`);
    const queued = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(queued.filter(event => event.pid === cliPid && event.kind !== 'admission').length, 0,
      'plain TS CLI does zero compiler module loads and zero Git blob reads before admission');
    assert.equal(queued.filter(event => event.kind === 'admission').length, 2, 'one reservation request per caller');
    await holder.release();
    for (const job of jobs) assert.deepEqual(await job.closed, [0, null], job.output());
    assert.match(jobs[0].output(), /^committed [0-9a-f]+:/mu, 'the admitted TS packet reaches finalization');
    const completed = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(completed.filter(event => event.kind === 'admission').length, 2, 'the admitted API never reserves a second slot');
    assert.equal(completed.filter(event => event.kind === 'compiler-phase').length, 3,
      'the CLI checks once and rechecks both overlapping HEAD moves');
    assert.equal(git('rev-parse', 'HEAD^').trim(), parents[1], 'CAS preserves both concurrent commits');
    assert.match(git('show', 'HEAD:consumer.ts'), /concurrent 2/u);
    assert.match(git('show', 'HEAD:producer.ts'), /original = 2/u);
    const replayStarts = jobs[0].output().match(/^\[commit-coherence\] replay .* reused=none rechecked=\. phase=start$/gmu) ?? [];
    const replayEnds = jobs[0].output().match(/^\[commit-coherence\] replay .* phase=complete ms=\d+$/gmu) ?? [];
    assert.equal(replayStarts.length, 2, 'each replay reports the reused and rechecked groups before compiler work');
    assert.equal(replayEnds.length, 2, 'each completed replay reports its wall duration');
    t.diagnostic(jobs[0].output().split('\n').filter(line => line.startsWith('[commit-coherence]')).join('\n'));
    assert.ok(completed.some(event => event.kind === 'compiler'), 'admitted work loads the compiler');
    assert.ok(completed.some(event => event.kind === 'blob'), 'admitted work reads the Git tree');
  });

test('zero-source packets finalize with zero compiler loads and zero admission requests', { skip: process.platform !== 'linux' }, async t => {
  const { repo, write, commitOnly } = await checkout(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const base = git('rev-parse', 'HEAD');
  await write('tool.mjs', 'export const tool = true;\n');
  await write('notes.md', 'No compiler inputs changed.\n');
  const packetEnv = { ...process.env, GIT_INDEX_FILE: join(repo, 'packet.index') };
  const packetGit = (...args) => execFileSync('git', args, { cwd: repo, env: packetEnv, encoding: 'utf8' }).trim();
  packetGit('read-tree', base);
  packetGit('add', '--', 'tool.mjs', 'notes.md');
  const tree = packetGit('write-tree');
  const native = await installWorkspaceAdmissionProcessFixture(t, repo);
  const floor = resolveHeavyweightMemoryFloorKiB('compilation', { machine: 'local' });
  await native.setMemoryObservation({ availableMemoryKiB: floor - 1, totalMemoryKiB: floor - 1 });
  const sourceEntry = new URL('./checkCommitTypeCoherence.mjs', import.meta.url);
  const trace = join(repo, 'compiler-work.jsonl');
  const preload = join(repo, 'observe-compiler-work.mjs');
  // Observe module loading and the real admission process boundary; no internal decisions are mocked.
  await writeFile(preload, `
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  // The TypeScript 5.9 parser serves the compiler-free producer-closure scan (owner 2026-11-15);
  // only the native compiler API and admission are compiler work.
  const kind = specifier === '@typescript/native/sync' ? 'compiler'
    : result.url.endsWith('/admission_client.mjs') ? 'admission' : undefined;
  if (kind) appendFileSync(${JSON.stringify(trace)}, kind + '\\n');
  return result;
} });
`);
  native.env.NODE_OPTIONS += ` --import=${pathToFileURL(preload).href}`;
  const message = join(repo, 'message.txt');
  await writeFile(message, 'fix: compiler-free finalization\n');
  // HEAD moves after the packet: the same fast path must still reach replay and CAS.
  await write('later.md', 'Concurrent independent change.\n');
  const parent = commitOnly('later.md');
  for (const finalize of [false, true]) {
    const result = spawnSync(process.execPath, [fileURLToPath(sourceEntry), `--base=${base}`, `--tree=${tree}`,
      ...(finalize ? [`--message-file=${message}`] : [])], {
      cwd: repo, env: { ...native.env, CI: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /coherent .*changed=0 roots=0 new=0 unowned=0/u);
  }
  const events = existsSync(trace) ? (await readFile(trace, 'utf8')).trim().split('\n') : [];
  assert.equal(events.filter(value => value === 'compiler').length, 0, 'zero compiler module loads');
  assert.equal(events.filter(value => value === 'admission').length, 0, 'zero compiler admission requests');
  assert.equal(git('rev-parse', 'HEAD^'), parent);
  assert.equal(git('show', 'HEAD:later.md'), 'Concurrent independent change.');
  assert.equal(git('show', 'HEAD:tool.mjs'), 'export const tool = true;');

  // The same observer must see real compiler work for a TS/config packet.
  const compileBase = git('rev-parse', 'HEAD');
  await write('producer.ts', 'export const original = 2;\n');
  const config = JSON.parse(await readFile(join(repo, 'tsconfig.json'), 'utf8'));
  config.compilerOptions.noUncheckedIndexedAccess = true;
  await write('tsconfig.json', JSON.stringify(config));
  packetGit('read-tree', compileBase);
  packetGit('add', '--', 'producer.ts', 'tsconfig.json');
  const compileTree = packetGit('write-tree');
  const refused = spawnSync(process.execPath, [fileURLToPath(sourceEntry), `--base=${compileBase}`, `--tree=${compileTree}`], {
    cwd: repo, env: { ...native.env, CI: '' }, encoding: 'utf8',
  });
  assert.notEqual(refused.status, 0, 'the relevant packet must reach real capacity admission');
  assert.match(refused.stderr, /HSTACK_MEMORY_CAPACITY/u);
  assert.doesNotMatch(refused.stdout, /coherent/u, 'refused compilation cannot publish a verdict');
  const refusedEvents = (await readFile(trace, 'utf8')).trim().split('\n');
  assert.ok(!refusedEvents.includes('compiler'), 'capacity refusal precedes compiler loading');
  assert.ok(refusedEvents.includes('admission'), 'the TS packet reaches real admission');
  await native.setMemoryObservation({ availableMemoryKiB: floor * 2, totalMemoryKiB: floor * 2 });
  const admitted = spawnSync(process.execPath, [fileURLToPath(sourceEntry), `--base=${compileBase}`, `--tree=${compileTree}`], {
    cwd: repo, env: { ...native.env, CI: '' }, encoding: 'utf8',
  });
  assert.equal(admitted.status, 0, admitted.stderr + admitted.stdout);
  const observed = (await readFile(trace, 'utf8')).trim().split('\n');
  assert.ok(observed.includes('compiler'), 'positive control observes compiler loading');
  assert.ok(observed.includes('admission'), 'positive control observes a real admission request');
});

test('the source-local CLI refuses compiler capacity before checking a private Git tree', { skip: process.platform !== 'linux' }, async (t) => {
  const { repo, write } = await checkout(t);
  await write('producer.ts', 'export const original = 1;\nexport const added = 2;\n');
  await write('consumer.ts', "import { added } from './producer';\nexport const value: number = added;\n");
  const git = (...args) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: join(repo, 'slice.index') },
  }).trim();
  const base = git('rev-parse', 'HEAD');
  git('read-tree', base);
  git('add', '--', 'consumer.ts');
  const tree = git('write-tree');
  const native = await installWorkspaceAdmissionProcessFixture(t, repo);
  const floor = resolveHeavyweightMemoryFloorKiB('compilation', { machine: 'local' });
  const sourceEntry = new URL('./checkCommitTypeCoherence.mjs', import.meta.url);
  const entry = join(repo, 'native-owner/scripts/workspaces/checkCommitTypeCoherence.mjs');
  await mkdir(join(repo, 'native-owner/scripts/workspaces'), { recursive: true });
  // Preserve the isolated worker's repository-relative command identity while
  // loading the actual CLI, as the canonical native fixture's forwarders do.
  await writeFile(entry, `process.argv[1] = ${JSON.stringify(fileURLToPath(sourceEntry))}; await import(${JSON.stringify(sourceEntry.href)});\n`);
  const trace = join(repo, 'api-processes.jsonl');
  const preload = join(repo, 'observe-api-process.mjs');
  // Observe the real OS child launch, admission slot and inherited cgroup;
  // the compiler, Git trees and admission lifecycle remain real.
  await writeFile(preload, `
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { readSlotAddress } from ${JSON.stringify(new URL('../../apps/stack/scripts/utils/proc/admission_socket.mjs', import.meta.url).href)};
const cp = createRequire(import.meta.url)('node:child_process');
const spawn = cp.spawn;
cp.spawn = (command, args, options) => {
  const child = spawn(command, args, options);
  if (args?.[0] === '--api') {
    const root = process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_ROOT;
    const slot = root && readdirSync(root).map(name => readSlotAddress(root, name))
      .find(value => value?.pid === Number(process.env.HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT));
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ pid: child.pid, floorKiB: slot?.floorKiB,
      cgroup: readFileSync('/proc/' + child.pid + '/cgroup', 'utf8'),
      parentCgroup: readFileSync('/proc/self/cgroup', 'utf8') }) + '\\n');
  }
  return child;
};
syncBuiltinESMExports();
`);
  native.env.NODE_OPTIONS += ` --import=${pathToFileURL(preload).href}`;
  const run = () => spawnSync(native.launcher, ['--local', '--', process.execPath,
    entry,
    `--base=${base}`, `--tree=${tree}`], {
    cwd: repo, env: { ...native.env, CI: '' }, encoding: 'utf8',
  });

  // Physical capacity, rather than current pressure, settles as a refusal:
  // there is no reason to queue a compiler that can never fit this worker.
  await native.setMemoryObservation({ availableMemoryKiB: floor - 1, totalMemoryKiB: floor - 1 });
  const refused = run();
  assert.equal(refused.status, 75, refused.stderr + refused.stdout);
  assert.match(refused.stderr, /HSTACK_MEMORY_CAPACITY/u);
  await assert.rejects(readFile(trace, 'utf8'), { code: 'ENOENT' }, 'refusal happens before the native API child starts');
  assert.doesNotMatch(refused.stdout, /INCOHERENT|coherent/u, 'a refused compiler must not publish a verdict');

  await native.setMemoryObservation({ availableMemoryKiB: floor * 2, totalMemoryKiB: floor * 2 });
  const checked = run();
  t.diagnostic(`admitted CLI status=${checked.status}; stderr=${JSON.stringify(checked.stderr)}`);
  assert.equal(checked.status, 1, checked.stderr + checked.stdout);
  assert.match(checked.stdout, /INCOHERENT/u, checked.stderr);
  assert.match(checked.stdout, /consumer\.ts.*TS2305/u, 'the admitted compiler reads the private tree, not the adapted worktree');
  const processes = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(processes.length > 0, 'the admitted check starts a real native API child');
  for (const child of processes) {
    assert.equal(child.floorKiB, floor, 'the native compiler inherits the canonical compilation reservation');
    assert.equal(child.cgroup, child.parentCgroup, 'the API child stays in its admitted parent cgroup');
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' }, 'the API child is gone when the CLI settles');
  }
  const status = await native.brokerStatus();
  assert.equal(status.activeCount, 0, 'the terminal CLI releases its compiler reservation');
  assert.equal(status.waitingCount, 0);
});

test('retains the nested cause in native compiler diagnostic messages', () => {
  const diagnostic = { text: 'Types are incompatible.', messageChain: [
    { text: 'The return value is incompatible.', messageChain: [{ text: 'Property revision is missing.' }] },
  ] };
  assert.equal(diagnosticMessages.diagnosticMessageText(diagnostic),
    'Types are incompatible.\n  The return value is incompatible.\n    Property revision is missing.');
});

test('the checker CLI refuses a script packet that imports an export its tree lacks, before any compiler', async (t) => {
  const { repo, write, commitOnly } = await checkout(t);
  await write('producer.mjs', 'export function shipped() {}\n');
  await write('consumer.mjs', "import { shipped } from './producer.mjs';\nshipped();\n");
  const base = commitOnly('producer.mjs', 'consumer.mjs');
  await write('producer.mjs', 'export function shipped() {}\nexport function unshipped() {}\n');
  await write('consumer.mjs', "import { shipped, unshipped } from './producer.mjs';\nshipped(); unshipped();\n");
  const broken = commitOnly('consumer.mjs');
  const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./checkCommitTypeCoherence.mjs', import.meta.url)), ...args],
    { cwd: repo, encoding: 'utf8' });
  const refused = cli(broken);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stdout, /INCOHERENT[^\n]*closure=1[\s\S]*consumer\.mjs imports \{ unshipped \}/u);
  const fixed = commitOnly('producer.mjs');
  const accepted = cli(`--base=${base}`, `--tree=${fixed}`);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
});

test('finalization refuses a checked script packet once a landed commit drops the export it newly reads', async (t) => {
  const { repo, write, commitOnly, git } = await checkout(t);
  await write('producer.mjs', 'export function shipped() {}\nexport function extra() {}\n');
  await write('consumer.mjs', "import { shipped } from './producer.mjs';\nshipped();\n");
  const base = commitOnly('producer.mjs', 'consumer.mjs');
  await write('consumer.mjs', "import { shipped, extra } from './producer.mjs';\nshipped(); extra();\n");
  git('add', '--', 'consumer.mjs');
  const tree = git('write-tree').trim();
  git('read-tree', base);
  const checked = checkCommitTypeCoherence({ repo, base, tree });
  // The landed commit leaves HEAD coherent; only the packet's new import loses its producer.
  await write('producer.mjs', 'export function shipped() {}\n');
  const parent = commitOnly('producer.mjs');
  const result = coherence.finalizeCommitTypeCoherence({ repo, checked, message: 'fix: checked packet\n' });
  assert.equal(result.commit, undefined);
  assert.ok(result.checked.closure.some(finding => finding.includes('consumer.mjs imports { extra }')), result.checked.closure.join('\n'));
  assert.equal(git('rev-parse', 'HEAD').trim(), parent);
});

test('the checker CLI refuses a plugin packet that adds an extension import-boundary violation in its tree', async (t) => {
  const { repo, write, commitOnly, git } = await checkout(t);
  await mkdir(join(repo, 'packages/plugins/demo/src'), { recursive: true });
  await write('packages/plugins/demo/package.json', JSON.stringify({ name: '@happier-dev/plugins-demo', private: true }));
  // A violation already at the base stays reported by the canonical validator, never by this packet.
  await write('packages/plugins/demo/src/legacy.mjs', "import { old } from '@/legacy';\nexport const legacy = old;\n");
  await write('packages/plugins/demo/src/index.mjs', 'export const value = 1;\n');
  const base = commitOnly('packages/plugins/demo/package.json', 'packages/plugins/demo/src/legacy.mjs', 'packages/plugins/demo/src/index.mjs');
  await write('packages/plugins/demo/src/legacy.mjs', "// touched\nimport { old } from '@/legacy';\nexport const legacy = old;\n");
  await write('packages/plugins/demo/src/index.mjs', "import { host } from '@/host';\nexport const value = host;\n");
  const broken = commitOnly('packages/plugins/demo/src/legacy.mjs', 'packages/plugins/demo/src/index.mjs');
  // The worktree no longer holds the violation: the verdict must come from the packet's tree.
  await write('packages/plugins/demo/src/index.mjs', 'export const value = 1;\n');
  const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./checkCommitTypeCoherence.mjs', import.meta.url)), ...args],
    { cwd: repo, encoding: 'utf8' });
  const refused = cli(`--base=${base}`, `--tree=${broken}`);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /INCOHERENT[^\n]*boundary=1[\s\S]*packages\/plugins\/demo\/src\/index\.mjs: forbidden import "@\/host"/u);
  assert.doesNotMatch(refused.stdout, /legacy\.mjs: forbidden/u);
  const fixed = commitOnly('packages/plugins/demo/src/index.mjs');
  const accepted = cli(`--base=${broken}`, `--tree=${fixed}`);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
});

// Generated Prisma clients are git-ignored: the shared checkout's copy can come from
// another schema. Each judged tree must read the clients generated from its own schema.
async function prismaCheckout(t) {
  const fixture = await checkout(t);
  const { repo, write, git } = fixture;
  await write('.gitignore', 'node_modules/\napps/server/generated/\n');
  await mkdir(join(repo, 'apps/server'), { recursive: true });
  await write('apps/server/package.json', JSON.stringify({ name: '@happier-dev/server', type: 'module' }));
  await installServerGeneratorFixture(repo);
  await write('machine.ts', "import type { Machine } from './apps/server/generated/default-client';\nexport const id = (machine: Machine): string => machine.id;\n");
  git('add', '-A');
  git('commit', '--quiet', '-m', 'schema');
  await generateServerClients(repo);
  const withColumn = FIXTURE_MACHINE_SCHEMA.replace('  id String\n', '  id String\n  metadataBytes Bytes\n');
  return { ...fixture, withColumn };
}

const usesColumn = "import type { Machine } from './apps/server/generated/default-client';\nexport const id = (machine: Machine): string => machine.metadataBytes;\n";

test('a packet that adds a Prisma column and uses it is coherent while the checkout clients predate the column', async (t) => {
  const { repo, write, commitOnly, withColumn } = await prismaCheckout(t);
  await writeServerSchemas(repo, withColumn);
  await write('machine.ts', usesColumn);
  const commit = commitOnly('apps/server/prisma', 'machine.ts');
  assert.deepEqual(checkCommitTypeCoherence({ repo, base: `${commit}^`, tree: commit }).fresh, []);
});

test('a packet that uses a column its schema lacks is incoherent although the checkout clients have it', async (t) => {
  const { repo, write, commitOnly, withColumn } = await prismaCheckout(t);
  // Another lane's uncommitted schema edit, generated into the shared checkout.
  await writeServerSchemas(repo, withColumn);
  await generateServerClients(repo);
  await write('machine.ts', usesColumn);
  const commit = commitOnly('machine.ts');
  assert.deepEqual(checkCommitTypeCoherence({ repo, base: `${commit}^`, tree: commit }).fresh
    .map(row => [row.file, row.code]), [['machine.ts', 2339]]);
});
