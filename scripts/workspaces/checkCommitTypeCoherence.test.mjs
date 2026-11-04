import * as diagnosticMessages from './commitTypeCoherenceDiagnostics.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';
import * as coherence from './checkCommitTypeCoherence.mjs';
import test from 'node:test';
import { checkCommitTypeCoherence } from './checkCommitTypeCoherence.mjs';
import { resolveTypeScriptCliInvocation } from './resolveTypeScriptCliInvocation.mjs';
import { installUiTypecheckFixtureDependencies } from '../testing/lib/typecheckProjectFixture.mjs';

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
  return { repo, write, commitOnly };
}

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

test('retains the nested cause in native compiler diagnostic messages', () => {
  const diagnostic = { text: 'Types are incompatible.', messageChain: [
    { text: 'The return value is incompatible.', messageChain: [{ text: 'Property revision is missing.' }] },
  ] };
  assert.equal(diagnosticMessages.diagnosticMessageText(diagnostic),
    'Types are incompatible.\n  The return value is incompatible.\n    Property revision is missing.');
});
