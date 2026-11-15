import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { resolveSourceRevision } from './source_revision.mjs';
import { prepareSourceTreeRuntimeComponents, prepareStackSourceRevisionTree, releaseStackSourceRevisionTree, releaseStackSourceTrees,
  resolveSourceTreeRevision, setSourceRevisionTreeWritable, sourceRevisionTreesRoot, writeSourceRevisionArchive } from './source_revision_tree.mjs';

const COMMITTED_MAIN = 'export { marker } from "@happier-dev/shared";';
const COMMITTED_SHARED = 'export const marker = "committed";';

async function createRevisionFixture(t) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-source-revision-tree-', registerCleanup: false });
  t.after(async () => { await setSourceRevisionTreeWritable(fixture.root); await fixture.cleanup(); });
  const repoDir = fixture.path('repo');
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await mkdir(repoDir);
  await gitIn('init', '--quiet');
  await gitIn('config', 'user.email', 'test@example.invalid');
  await gitIn('config', 'user.name', 'test');
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  await writeFile(join(repoDir, '.gitignore'), 'node_modules\n');
  for (const [directory, name] of [['apps/server', '@happier-dev/server'], ['packages/shared', '@happier-dev/shared']]) {
    await mkdir(join(repoDir, directory, 'src'), { recursive: true });
    await writeFile(join(repoDir, directory, 'package.json'), JSON.stringify({ name, type: 'module',
      exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  }
  const server = join(repoDir, 'apps/server');
  await mkdir(join(server, 'sources'));
  await mkdir(join(server, 'scripts'));
  await mkdir(join(server, 'node_modules/@happier-dev'), { recursive: true });
  await writeFile(join(server, 'tsconfig.json'), '{}');
  // A tracked runner file no bundle consumes: a source runtime still needs it.
  await writeFile(join(server, 'scripts/dev.light.ts'), 'export const runner = true;');
  await writeFile(join(server, 'scripts/migrate.sqlite.deploy.ts'), 'export async function runSqliteMigrationDeploy() {}');
  await symlink(dirname(createRequire(import.meta.url).resolve('esbuild/package.json')), join(server, 'node_modules/esbuild'),
    process.platform === 'win32' ? 'junction' : 'dir');
  // The checkout's installed workspace link, as pnpm writes it.
  await symlink('../../../../packages/shared', join(server, 'node_modules/@happier-dev/shared'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(server, 'sources/main.light.ts'), COMMITTED_MAIN);
  await writeFile(join(repoDir, 'packages/shared/src/index.ts'), COMMITTED_SHARED);
  // A tracked file outside every component's inputs (like apps/ui for a server/daemon base).
  await mkdir(join(repoDir, 'docs'));
  await writeFile(join(repoDir, 'docs/notes.md'), 'committed notes');
  await gitIn('add', '-A');
  await gitIn('commit', '--quiet', '-m', 'rev');
  // The shared checkout moves: another lane edits a committed file and adds an
  // untracked one; this lane edits the file it declares as its overlay.
  await writeFile(join(repoDir, 'packages/shared/src/index.ts'), 'export const marker = "other-lane";');
  await writeFile(join(repoDir, 'packages/shared/src/new.ts'), 'export const added = "other-lane";');
  await writeFile(join(server, 'sources/main.light.ts'), 'export const marker = "my-overlay";');
  return { fixture, repoDir };
}

// Owner 2026-11-14: one shared base per HEAD, each Stack's overlay applied at
// runtime from source. Stacks on one revision with different overlays must not
// rebuild anything shared; only their declared files differ.
test('stacks on one revision share one base tree; each runs only its own declared overlay', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const treesRoot = fixture.path('trees');
  const prepare = async (stack, overlay) => {
    const revision = await resolveSourceRevision({ repoDir, overlay, outputDir: fixture.path(`descriptors-${stack}`),
      components: ['server', 'daemon'], fullTree: true });
    return await prepareStackSourceRevisionTree({ repoDir, treesRoot, treeDir: fixture.path(`stacks/${stack}/tree`),
      descriptorPath: revision.descriptorPath });
  };
  const a = await prepare('a', []);
  const b = await prepare('b', ['apps/server/sources/main.light.ts']);
  const c = await prepare('c', []);
  assert.deepEqual([a.baseBuilt, b.baseBuilt, c.baseBuilt].filter(Boolean).length, 1, 'one base build for one revision');
  assert.equal(a.baseDir, b.baseDir);
  assert.deepEqual([a.overlaid, b.overlaid, c.overlaid], [0, 1, 0]);

  const read = (tree, path) => readFile(join(tree, path), 'utf8');
  assert.equal(await read(a.treeDir, 'apps/server/sources/main.light.ts'), COMMITTED_MAIN);
  assert.equal(await read(b.treeDir, 'apps/server/sources/main.light.ts'), 'export const marker = "my-overlay";');
  assert.equal(await read(a.baseDir, 'apps/server/sources/main.light.ts'), COMMITTED_MAIN, 'an overlay never writes through to the base');
  for (const tree of [a.treeDir, b.treeDir, a.baseDir]) {
    // Isolation: another lane's dirty and untracked files never enter a tree.
    assert.equal(await read(tree, 'packages/shared/src/index.ts'), COMMITTED_SHARED);
    assert.equal(await lstat(join(tree, 'packages/shared/src/new.ts')).catch(error => error.code), 'ENOENT');
    // A source runtime gets the whole tracked tree, not only bundle inputs.
    assert.equal(await read(tree, 'apps/server/scripts/dev.light.ts'), 'export const runner = true;');
    // Workspace imports resolve inside the tree; installed packages stay shared.
    assert.equal(await realpath(join(tree, 'apps/server/node_modules/@happier-dev/shared')), await realpath(join(tree, 'packages/shared')));
  }
  // Clones share the base's bytes instead of copying them.
  const [baseInfo, cloneInfo] = await Promise.all([lstat(join(a.baseDir, 'packages/shared/src/index.ts')),
    lstat(join(c.treeDir, 'packages/shared/src/index.ts'))]);
  assert.equal(cloneInfo.ino, baseInfo.ino);
});

test('a declared overlay that moved after its description refuses instead of running other bytes', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const revision = await resolveSourceRevision({ repoDir, overlay: ['apps/server/sources/main.light.ts'],
    outputDir: fixture.path('descriptors'), components: ['server', 'daemon'], fullTree: true });
  await writeFile(join(repoDir, 'apps/server/sources/main.light.ts'), 'export const marker = "edited-after";');
  await assert.rejects(prepareStackSourceRevisionTree({ repoDir, treesRoot: fixture.path('trees'),
    treeDir: fixture.path('stack/tree'), descriptorPath: revision.descriptorPath }), { code: 'BUILD_INPUTS_CHANGED' });
});

// HEAD moves every few minutes on the shared checkout. A reload at a newer commit
// runs the newest built base plus that commit's changes as overlay; only a change
// to the installed-dependency shape needs a new base.
test('reloads at later commits run the existing base plus the commit diff; a dependency change builds one new base', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  // Discard the moving-checkout edits from the shared fixture; this test moves HEAD.
  await gitIn('checkout', '--quiet', '--', '.');
  await gitIn('clean', '-fdq');
  const treesRoot = fixture.path('trees');
  let reloads = 0;
  const reload = async () => {
    const stack = `s${reloads += 1}`;
    const revision = await resolveSourceTreeRevision({ repoDir, treesRoot, rev: 'HEAD', overlay: [],
      outputDir: fixture.path(`descriptors-${stack}`) });
    return await prepareStackSourceRevisionTree({ repoDir, treesRoot, treeDir: fixture.path(`stacks/${stack}/tree`),
      descriptorPath: revision.descriptorPath });
  };
  const first = await reload();
  const commitEdit = async (path, text) => {
    await writeFile(join(repoDir, path), text);
    await gitIn('commit', '--quiet', '-am', path);
  };
  await commitEdit('packages/shared/src/index.ts', 'export const marker = "second-commit";');
  const second = await reload();
  await commitEdit('apps/server/sources/main.light.ts', 'export const marker = "third-commit";');
  const third = await reload();
  assert.deepEqual([first.baseBuilt, second.baseBuilt, third.baseBuilt], [true, false, false]);
  assert.equal(second.baseDir, first.baseDir);
  assert.equal(await readFile(join(second.treeDir, 'packages/shared/src/index.ts'), 'utf8'), 'export const marker = "second-commit";');
  assert.equal(await readFile(join(third.treeDir, 'apps/server/sources/main.light.ts'), 'utf8'), 'export const marker = "third-commit";');
  assert.equal(await readFile(join(first.baseDir, 'packages/shared/src/index.ts'), 'utf8'), COMMITTED_SHARED, 'the base keeps its own revision');
  // The installed dependency closure is part of the base: a manifest change rebases.
  await commitEdit('packages/shared/package.json', JSON.stringify({ name: '@happier-dev/shared', type: 'module', dependencies: { esbuild: '*' },
    exports: { '.': { 'happier-source': './src/index.ts', default: './dist/index.js' } } }));
  const fourth = await reload();
  assert.equal(fourth.baseBuilt, true);
  assert.notEqual(fourth.baseDir, first.baseDir);
});

// Disk: a base is ~2 GB. Keep one only while a Stack tree, or the host's newest
// base, references it; release happens on Stack stop and on new-base creation.
test('a base is deleted when its last Stack reference goes, and the newest base is kept', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await gitIn('checkout', '--quiet', '--', '.');
  await gitIn('clean', '-fdq');
  const treesRoot = fixture.path('trees');
  const treeOf = stack => fixture.path(`stacks/${stack}/tree`);
  let described = 0;
  const reload = async stack => {
    const revision = await resolveSourceTreeRevision({ repoDir, treesRoot, rev: 'HEAD', overlay: [],
      outputDir: fixture.path(`descriptors-${described += 1}`) });
    return await prepareStackSourceRevisionTree({ repoDir, treesRoot, treeDir: treeOf(stack), descriptorPath: revision.descriptorPath });
  };
  const bases = async () => (await readdir(treesRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{40}$/.test(entry.name)).map(entry => entry.name).sort();
  const first = await reload('a');
  await reload('b');
  // A dependency-shape commit makes a new base; a and b still hold the first.
  await writeFile(join(repoDir, 'packages/shared/package.json'), JSON.stringify({ name: '@happier-dev/shared', type: 'module', version: '2.0.0' }));
  await gitIn('commit', '--quiet', '-am', 'manifest');
  const second = await reload('c');
  assert.equal(second.baseBuilt, true);
  assert.deepEqual((await bases()).length, 2);
  // Stack a moves to the new base; b still references the first.
  await reload('a');
  assert.deepEqual(await bases(), [first.baseDir, second.baseDir].map(dir => dir.split(/[\\/]/).pop()).sort());
  // The last reference stops: the first base goes, the newest stays.
  await releaseStackSourceRevisionTree({ treesRoot, treeDir: treeOf('b') });
  assert.deepEqual(await bases(), [second.baseDir.split(/[\\/]/).pop()]);
  assert.equal(await lstat(treeOf('b')).catch(error => error.code), 'ENOENT');
  // With no Stack left, the host's newest base is kept for the next reload.
  await releaseStackSourceRevisionTree({ treesRoot, treeDir: treeOf('a') });
  await releaseStackSourceRevisionTree({ treesRoot, treeDir: treeOf('c') });
  assert.deepEqual(await bases(), [second.baseDir.split(/[\\/]/).pop()]);
});

// nl3 2026-11-15 (P03-INFRA-OPS run 1): a mirror host has no Git objects. Its base
// copied the moving mirror and refused BUILD_INPUTS_CHANGED when another lane edited
// a tracked file the description shipped no bytes for. A base takes every tracked
// byte from the revision's Git objects: here, the controller's archive of it.
test('a mirror without Git objects builds its base from the revision archive, never from moving mirror bytes', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const revision = await resolveSourceRevision({ repoDir, overlay: ['apps/server/sources/main.light.ts'],
    outputDir: fixture.path('descriptors'), components: ['server', 'daemon'], fullTree: true });
  // The host's replica: the working tree (with its install) and a `.git` entry without objects.
  const mirror = fixture.path('mirror');
  await cp(repoDir, mirror, { recursive: true, verbatimSymlinks: true });
  await rm(join(mirror, '.git'), { recursive: true, force: true });
  await mkdir(join(mirror, '.git'));
  // Other lanes keep editing after the description: a tracked runner file and a committed input.
  await writeFile(join(mirror, 'apps/server/scripts/dev.light.ts'), 'export const runner = "edited-after";');
  await writeFile(join(mirror, 'packages/shared/src/index.ts'), 'export const marker = "edited-after";');
  await writeFile(join(mirror, 'docs/notes.md'), 'edited after the description');
  const archives = [];
  const requestBaseArchive = async ({ revision: requested, path }) => {
    archives.push(requested);
    await writeSourceRevisionArchive({ repoDir, revision: requested, outputPath: path });
  };
  const treesRoot = fixture.path('mirror-trees');
  const prepare = stack => prepareStackSourceRevisionTree({ repoDir: mirror, treesRoot, treeDir: fixture.path(`mirror-stacks/${stack}/tree`),
    descriptorPath: revision.descriptorPath, requestBaseArchive });
  const a = await prepare('a');
  const b = await prepare('b');
  assert.deepEqual([a.baseBuilt, b.baseBuilt], [true, false]);
  assert.deepEqual(archives, [revision.revision], 'one archive per base per host');
  const read = (tree, path) => readFile(join(tree, path), 'utf8');
  for (const tree of [a.baseDir, a.treeDir]) {
    assert.equal(await read(tree, 'apps/server/scripts/dev.light.ts'), 'export const runner = true;');
    assert.equal(await read(tree, 'packages/shared/src/index.ts'), COMMITTED_SHARED);
    assert.equal(await read(tree, 'docs/notes.md'), 'committed notes');
    assert.equal(await lstat(join(tree, 'packages/shared/src/new.ts')).catch(error => error.code), 'ENOENT');
  }
  assert.equal(await read(a.baseDir, 'apps/server/sources/main.light.ts'), COMMITTED_MAIN);
  // The declared overlay alone comes from the (mirror) checkout, verified against its recorded hash.
  assert.equal(await read(a.treeDir, 'apps/server/sources/main.light.ts'), 'export const marker = "my-overlay";');
  assert.deepEqual((await readdir(treesRoot)).filter(name => name.includes('.archive-')), [], 'the shipped archive is deleted after use');
});

// agent-qa-perf 2026-11-15 (P03-INFRA-OPS run 2): the restart's stop released the
// tree the reload had just selected, so the runner refused source_bundle_unavailable.
test('a restart onto a new tree keeps the tree it selected; stop releases only the incumbent', async t => {
  const { fixture, repoDir } = await createRevisionFixture(t);
  const gitIn = (...args) => promisify(execFile)('git', ['-C', repoDir, ...args]);
  await gitIn('checkout', '--quiet', '--', '.');
  await gitIn('clean', '-fdq');
  const stackBaseDir = fixture.path('stacks-root/qa');
  const selection = join(stackBaseDir, 'source-runtime/selected-server.json');
  let described = 0;
  const reload = async () => {
    const revision = await resolveSourceTreeRevision({ repoDir, treesRoot: sourceRevisionTreesRoot(stackBaseDir), rev: 'HEAD', overlay: [],
      outputDir: fixture.path(`descriptors-${described += 1}`) });
    const { server } = await prepareSourceTreeRuntimeComponents({ repoDir, stackBaseDir, descriptorPath: revision.descriptorPath,
      components: [{ component: 'server' }], logger: { error() {} } });
    return server;
  };
  const select = async record => { await mkdir(dirname(selection), { recursive: true }); await writeFile(selection, JSON.stringify({ entrypoint: record.entrypoint })); };
  const incumbent = await reload();
  await select(incumbent);
  await writeFile(join(repoDir, 'apps/server/sources/main.light.ts'), 'export const marker = "next-commit";');
  await gitIn('commit', '--quiet', '-am', 'next');
  const replacement = await reload();
  // The incumbent keeps running from its own tree while the replacement prepares.
  assert.equal(await lstat(incumbent.entrypoint).then(() => true, () => false), true, 'preparing never deletes the running tree');
  assert.notEqual(replacement.serverDir, incumbent.serverDir);
  // Restart order: select the replacement, then stop the incumbent.
  await select(replacement);
  await releaseStackSourceTrees({ stackBaseDir, components: ['server'] });
  assert.equal(await lstat(replacement.entrypoint).then(() => true, () => false), true, 'the selected tree stays');
  assert.equal(await readFile(join(replacement.serverDir, 'sources/main.light.ts'), 'utf8'), 'export const marker = "next-commit";');
  assert.equal(JSON.parse(await readFile(selection, 'utf8')).entrypoint, replacement.entrypoint, 'the selection stays');
  assert.equal(await lstat(incumbent.serverDir).catch(error => error.code), 'ENOENT', 'the incumbent tree is released');
  // A later plain stop keeps the selected tree for the next start.
  await releaseStackSourceTrees({ stackBaseDir, components: ['server'] });
  assert.equal(await lstat(replacement.entrypoint).then(() => true, () => false), true);
});
