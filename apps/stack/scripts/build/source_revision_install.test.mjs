// @happier-test-preparation source
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { resolvePnpmCommandInvocation } from '../../../../scripts/workspaces/execPnpmCommand.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { inspectDependencyRefresh, resolveDependencyRefreshMarkerPath } from '../utils/proc/dependency_refresh.mjs';
import { moveInPlaceInstallationIntoGeneration } from '../utils/proc/dependency_generations.mjs';
import { mountRevisionWorkspaceDependencies, prepareRevisionInstall, readRevisionInstallWorkspaceLinks } from './source_revision_install.mjs';

const workspaceDirs = [join('apps', 'docs')];

async function createWorkspace(t) {
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
  await writeFile(join(repoDir, ...workspaceDirs, 'package.json'), JSON.stringify({ name: 'docs', version: '1.0.0' }));
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
