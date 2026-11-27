// @happier-test-preparation source
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { resolvePnpmCommandInvocation } from '../../../../scripts/workspaces/execPnpmCommand.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { inspectDependencyRefresh, resolveDependencyRefreshMarkerPath } from '../utils/proc/dependency_refresh.mjs';
import { moveInPlaceInstallationIntoGeneration } from '../utils/proc/dependency_generations.mjs';
import { mountRevisionWorkspaceDependencies, prepareRevisionInstall, readRevisionInstallWorkspaceLinks } from './source_revision_install.mjs';
import { resolveExpoBin } from '../utils/expo/command.mjs';

const workspaceDirs = [join('apps', 'docs')];

async function createWorkspace(t, { dependencyBin = false } = {}) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-revision-install-links-' });
  const repoDir = fixture.path('checkout');
  const env = { ...process.env, HAPPIER_STACK_HOME_DIR: fixture.path('home') };
  await mkdir(join(repoDir, ...workspaceDirs), { recursive: true });
  await writeFile(join(repoDir, 'package.json'), JSON.stringify({ name: 'fixture', private: true,
    devDependencies: { docs: 'workspace:*' }, scripts: { postinstall: 'node ./link-workspace-bin.cjs' } }));
  // Reproduce the pnpm layout where binaries are symlinks, including on hosts
  // whose default pnpm configuration uses shell shims.
  await writeFile(join(repoDir, 'link-workspace-bin.cjs'), [
    "const fs = require('node:fs'); const path = require('node:path');",
    "const bin = path.resolve('node_modules/.bin');",
    "fs.mkdirSync(bin, { recursive: true });",
    "fs.rmSync(path.join(bin, 'docs'), { force: true });",
    "fs.symlinkSync(path.relative(bin, path.resolve('apps/docs/tool.cjs')), path.join(bin, 'docs'), 'file');",
  ].join('\n'));
  await writeFile(join(repoDir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\nnodeLinker: hoisted\n');
  let dependencies;
  if (dependencyBin) {
    const tool = fixture.path('tool/package');
    await mkdir(tool, { recursive: true });
    await writeFile(join(tool, 'package.json'), JSON.stringify({ name: 'fixture-tool', version: '1.0.0', bin: { expo: 'tool.cjs' } }));
    await writeFile(join(tool, 'tool.cjs'), '#!/usr/bin/env node\nconsole.log("workspace-bin-ready");\n', { mode: 0o755 });
    const archive = join(repoDir, 'vendor', 'tool.tgz');
    await mkdir(dirname(archive), { recursive: true });
    execFileSync('tar', ['-czf', archive, '-C', dirname(tool), 'package']);
    dependencies = { 'fixture-tool': 'file:../../vendor/tool.tgz' };
  }
  await writeFile(join(repoDir, ...workspaceDirs, 'package.json'), JSON.stringify({ name: 'docs', version: '1.0.0', dependencies }));
  await writeFile(join(repoDir, ...workspaceDirs, 'tool.cjs'), 'module.exports = 42;\n');
  const pnpm = resolvePnpmCommandInvocation(['install', '--offline'], { preferPath: true });
  execFileSync(pnpm.command, pnpm.args, { cwd: repoDir, env, windowsVerbatimArguments: pnpm.windowsVerbatimArguments });
  const { installIdentity } = await inspectDependencyRefresh({ installDir: repoDir, env });
  const publish = identity => writeFile(resolveDependencyRefreshMarkerPath(repoDir), JSON.stringify({ version: 7, identity }));
  await publish(installIdentity);
  const prepare = async (name, identity = installIdentity) => {
    const baseDir = fixture.path(`${name}/tree/base`);
    const treesRoot = fixture.path(`${name}/store`);
    await cp(repoDir, baseDir, { recursive: true, filter: source => !relative(repoDir, source).split(sep).includes('node_modules') });
    await publish(identity);
    const { dir } = await prepareRevisionInstall({ repoDir, baseDir, treesRoot, workspaceDirs, env });
    const workspaceLinks = await readRevisionInstallWorkspaceLinks(dir);
    return { dir, baseDir, workspaceLinks, mount: () => mountRevisionWorkspaceDependencies({ sourceDir: dir, captureDir: baseDir,
      workspaceDirs, workspaceLinks }) };
  };
  return { fixture, repoDir, env, installIdentity, prepare };
}

test('hoisted revision installs resolve app tools and rebuild incomplete publications', async t => {
  const { repoDir, prepare } = await createWorkspace(t, { dependencyBin: true });
  const bin = join('node_modules', '.bin', 'expo');
  assert.equal(existsSync(join(repoDir, 'apps/docs/node_modules/.bin/expo')), false);
  assert.equal(existsSync(join(repoDir, bin)), true);
  for (const identity of [undefined, 'different-checkout-install']) {
    const name = identity ? 'frozen-bin' : 'snapshot-bin';
    const first = await prepare(name, identity);
    assert.equal(existsSync(join(first.dir, 'apps/docs/node_modules/.bin/expo')), false);
    assert.equal(existsSync(join(first.dir, bin)), true, `${name} has the root bin`);
    const resolved = await resolveExpoBin(join(first.dir, 'apps/docs'), { dependencyRootDir: first.dir });
    assert.match(execFileSync(resolved, { encoding: 'utf8' }), /workspace-bin-ready/);
    const retained = join(first.dir, 'retained-install');
    await writeFile(retained, 'complete');
    await prepare(name, identity);
    assert.equal(existsSync(retained), true, 'complete publications are reused');
    await rm(join(first.dir, bin));
    const repaired = await prepare(name, identity);
    assert.equal(existsSync(join(repaired.dir, bin)), true, 'missing published bins are rebuilt');
    assert.equal(existsSync(retained), false);
    await rm(join(first.dir, '.happier-revision-tree.json'));
    await writeFile(join(first.dir, 'interrupted-install'), 'partial');
    const restarted = await prepare(name, identity);
    assert.equal(existsSync(join(restarted.dir, 'interrupted-install')), false);
    assert.equal(existsSync(join(restarted.dir, bin)), true);
  }
});

test('snapshot and frozen install mount the same workspace links for the same cut', async t => {
  const { prepare } = await createWorkspace(t);
  const resolved = async ({ baseDir, workspaceLinks, mount }) => {
    await mount();
    return Object.fromEntries(await Promise.all(Object.keys(workspaceLinks)
      .map(async link => [link, relative(baseDir, await realpath(join(baseDir, link)))])));
  };
  const snapshot = await resolved(await prepare('snapshot'));
  const frozen = await resolved(await prepare('frozen', 'different-checkout-install'));
  assert.deepEqual(snapshot, {
    [join('node_modules', 'docs')]: workspaceDirs[0],
    [join('node_modules', '.bin', 'docs')]: join(...workspaceDirs, 'tool.cjs'),
  });
  assert.deepEqual(frozen, snapshot);
});

test('generation snapshots remount workspace binaries at the selected depth and refuse missing targets',
  { skip: process.platform === 'win32' }, async t => {
    const { repoDir, prepare } = await createWorkspace(t);
    const { genRoot } = await moveInPlaceInstallationIntoGeneration(repoDir);
    const bin = join('node_modules', '.bin', 'docs');
    const stagedBin = join(genRoot, bin);
    const executable = join(...workspaceDirs, 'tool.cjs');
    await rm(stagedBin);
    await symlink(relative(dirname(stagedBin), join(repoDir, executable)), stagedBin);
    const first = await prepare('snapshot');
    const entries = await readdir(first.dir, { withFileTypes: true, recursive: true });
    assert.deepEqual(entries.filter(entry => entry.isSymbolicLink() && !existsSync(join(entry.parentPath, entry.name)))
      .map(entry => entry.name), []);
    await first.mount();
    assert.equal(await realpath(join(first.baseDir, bin)), join(await realpath(first.baseDir), executable));

    const second = await prepare('new/depth');
    await rm(join(second.baseDir, executable));
    await assert.rejects(second.mount(), error => error.message.includes(join(second.baseDir, executable)));
  });

test('a broken retained dependency prevents publication of the revision install', async t => {
  const { fixture, repoDir, env, installIdentity } = await createWorkspace(t);
  await symlink('./missing-dependency', join(repoDir, 'node_modules', 'broken-dependency'));
  const treesRoot = fixture.path('store');
  await assert.rejects(prepareRevisionInstall({ repoDir, baseDir: repoDir, treesRoot, workspaceDirs, env }), /broken-dependency/);
  assert.equal(existsSync(join(treesRoot, 'installs', installIdentity, '.happier-revision-tree.json')), false);
});


test('shared maintenance reclaims revision installs and bases with dry-run parity and live build pins',
  { skip: process.platform !== 'linux' }, async t => {
    const fixture = await createTempFixture(t, { prefix: 'hstack-revision-retention-' });
    const stacksRoot = fixture.path('stacks');
    const treesRoot = join(stacksRoot, 'source-revision-trees');
    const install = async (name, date) => {
      const dir = join(treesRoot, 'installs', name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '.happier-revision-tree.json'), JSON.stringify({ installIdentity: name }));
      await writeFile(join(dir, 'payload'), 'installed bytes');
      await utimes(dir, date, date);
      return dir;
    };
    const obsolete = await install('obsolete', 100);
    const bundled = await install('bundled', 200);
    const retiredBundleInstall = await install('retired-bundle', 180);
    const based = await install('based', 150);
    const building = await install('building', 300);
    const newest = await install('newest', 400);
    const oldBase = join(treesRoot, 'a'.repeat(40));
    const newBase = join(treesRoot, 'b'.repeat(40));
    for (const [dir, at] of [[oldBase, 100], [newBase, 200]]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '.happier-revision-tree.json'), JSON.stringify({ builtAt: new Date(at * 1000).toISOString() }));
    }
    const pinnedBase = join(treesRoot, 'c'.repeat(40));
    const treeDir = fixture.path('stacks/consumer/source-runtime/tree');
    await mkdir(pinnedBase, { recursive: true });
    await writeFile(join(pinnedBase, '.happier-revision-tree.json'), JSON.stringify({ builtAt: new Date(1000).toISOString(), installIdentity: 'based' }));
    await mkdir(`${pinnedBase}.refs`, { recursive: true });
    await writeFile(join(`${pinnedBase}.refs`, 'reader.json'), JSON.stringify({ treeDir, pid: process.pid }));
    await mkdir(treeDir, { recursive: true });
    await writeFile(join(treeDir, '.happier-revision-tree-ref.json'), JSON.stringify({ baseDir: pinnedBase }));
    const bundle = { directory: join(stacksRoot, 'source-bundles', 'runtime-newest') };
    await mkdir(bundle.directory, { recursive: true });
    await writeFile(join(bundle.directory, 'source-bundle.json'), JSON.stringify({ component: 'server' }));
    const recordPath = join(bundle.directory, 'source-bundle.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    await writeFile(recordPath, JSON.stringify({ ...record, dependencyRootDir: bundled }));
    const retiredBundle = join(stacksRoot, 'source-bundles', 'runtime-obsolete');
    await mkdir(retiredBundle, { recursive: true });
    await writeFile(join(retiredBundle, 'source-bundle.json'), JSON.stringify({ component: 'server', dependencyRootDir: retiredBundleInstall }));
    await utimes(join(retiredBundle, 'source-bundle.json'), 1, 1);
    const { withBaseLock } = await import('./source_revision_install.mjs');
    const { reclaimSourceBundles } = await import('./build_source_runtime.mjs');
    await withBaseLock(building, undefined, async () => {
      const preview = await reclaimSourceBundles({ stacksRoot });
      assert.equal(existsSync(obsolete), true, 'preview does not delete');
      assert.deepEqual(preview.revisions.installs.roots.sort(), [obsolete, retiredBundleInstall].sort());
      for (const dir of [obsolete, oldBase]) {
        assert.equal(existsSync(`${dir}.lock`), false, 'preview never acquires retirement locks');
        assert.equal(existsSync(`${dir}.lock.waiters`), false, 'preview never creates waiter records');
      }
      assert.ok(preview.revisions.installs.bytes > 0);
      assert.deepEqual(preview.revisions.bases, [oldBase]);
      const result = await reclaimSourceBundles({ stacksRoot, dryRun: false });
      assert.deepEqual(result.revisions.installs.roots.sort(), preview.revisions.installs.roots.sort());
      assert.equal(existsSync(obsolete), false);
      assert.equal(existsSync(oldBase), false);
      assert.equal(existsSync(retiredBundleInstall), false);
      for (const dir of [bundled, based, building, newest, newBase, pinnedBase]) assert.equal(existsSync(dir), true, dir);
    });
  });


test('queued revision consumption pins an existing install until the consumer releases it', async t => {
  const { fixture, repoDir, env, prepare } = await createWorkspace(t);
  const first = await prepare('queued');
  const treesRoot = dirname(dirname(first.dir));
  const pins = [];
  const pinPath = fixture.path('capture');
  await prepareRevisionInstall({ repoDir, baseDir: first.baseDir, treesRoot, workspaceDirs, env, pins, pinPath });
  const newest = join(treesRoot, 'installs', 'newest');
  await mkdir(newest, { recursive: true });
  await writeFile(join(newest, '.happier-revision-tree.json'), '{}');
  await utimes(first.dir, 100, 100);
  const { sweepUnreferencedInstalls } = await import('./source_revision_install.mjs');
  await sweepUnreferencedInstalls({ treesRoot, keep: new Set() });
  assert.equal(existsSync(first.dir), true, 'queued consumer survives before a build lock exists');
  await mkdir(pinPath);
  await Promise.all(pins.map(release => release()));
  await sweepUnreferencedInstalls({ treesRoot });
  assert.equal(existsSync(first.dir), true, 'the returned capture still mounts its installation');
  await rm(pinPath, { recursive: true });
  await sweepUnreferencedInstalls({ treesRoot, keep: new Set() });
  assert.equal(existsSync(first.dir), false, 'settled consumers do not keep old installs pinned');
});


test('successful publication reclaims older unmounted revision installations', async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-publication-install-retention-' });
  const stacksRoot = fixture.path('stacks');
  const root = join(stacksRoot, 'source-revision-trees', 'installs');
  for (const [name, at] of [['old', 1], ['new', 2]]) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.happier-revision-tree.json'), '{}');
    await utimes(dir, at, at);
  }
  const outputDir = join(stacksRoot, 'source-bundles', 'runtime-published');
  await mkdir(outputDir, { recursive: true });
  const { withSourceBundlePublication } = await import('./build_source_runtime.mjs');
  const result = await withSourceBundlePublication({ stackBaseDir: join(stacksRoot, 'producer'), outputDir,
    record: { component: 'server' } }, async () => 'published');
  assert.equal(result, 'published');
  assert.equal(existsSync(join(root, 'old')), false);
  assert.equal(existsSync(join(root, 'new')), true);
});
