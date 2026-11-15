import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { commitPackageTypecheckRefuses, commitTypecheckPackages, packageTypecheckRows } from './commitPackageTypecheck.mjs';

async function workspace(t) {
  const repo = await mkdtemp(join(tmpdir(), 'happier-commit-package-typecheck-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Package Typecheck Test');
  git('config', 'user.email', 'package-typecheck@example.invalid');
  const write = async (path, content) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  };
  const pkg = async (dir, name, dependencies = {}, scripts = { typecheck: 'tsc' }) => {
    await write(`${dir}/package.json`, JSON.stringify({ name, scripts, dependencies }));
    await write(`${dir}/tsconfig.json`, '{}');
    await write(`${dir}/src/index.ts`, 'export const value = 1;\n');
  };
  await pkg('packages/protocol', '@x/protocol');
  await pkg('packages/sdk', '@x/sdk', { '@x/protocol': 'workspace:*' });
  await pkg('packages/ui-kit', '@x/ui-kit', { '@x/sdk': 'workspace:*' });
  await pkg('packages/leaf', '@x/leaf');
  await pkg('packages/untyped', '@x/untyped', {}, {});
  await pkg('packages/plugins/codex', '@x/plugin-codex', { '@x/protocol': 'workspace:*' });
  await pkg('apps/cli', '@x/cli', { '@x/protocol': 'workspace:*' });
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  const commit = async (path, content) => {
    await write(path, content);
    git('add', '-A');
    git('commit', '--quiet', '-m', `change ${path}`);
    return git('rev-parse', 'HEAD');
  };
  return { repo, commit };
}

test('a producer change selects the touched package and its transitive packages/* dependents, producers first', async t => {
  const { repo, commit } = await workspace(t);
  const sha = await commit('packages/protocol/src/index.ts', 'export const value = 2;\n');
  assert.deepEqual(commitTypecheckPackages({ repo, base: `${sha}^`, tree: sha }), {
    touched: ['packages/protocol'],
    packages: ['packages/protocol', 'packages/sdk', 'packages/ui-kit'],
  });
});

test('apps/*, packages/plugins/*, non-source and typecheck-less packages are not checked here', async t => {
  const { repo, commit } = await workspace(t);
  for (const path of ['apps/cli/src/index.ts', 'packages/plugins/codex/src/index.ts', 'packages/protocol/README.md', 'packages/untyped/src/index.ts']) {
    const sha = await commit(path, 'export const value = 3;\n');
    assert.deepEqual(commitTypecheckPackages({ repo, base: `${sha}^`, tree: sha }).packages, [], path);
  }
});

test('compiler output parses located and global errors; a failed compile without diagnostics is incomplete', () => {
  const root = '/repo';
  const cwd = '/repo/packages/sdk';
  const rows = packageTypecheckRows({ status: 2, signal: null, stdout: [
    "src/host.ts(1497,30): error TS2339: Property 'requestId' does not exist on type 'Options'.",
    '../protocol/src/a.ts(3,1): error TS2322: Type mismatch.',
    'error TS5083: Cannot read file \'/repo/tsconfig.base.json\'.',
    '  continuation line',
  ].join('\n'), stderr: '' }, cwd, root);
  assert.deepEqual(rows.map(row => `${row.file}:${row.line}:TS${row.code}`), [
    'packages/sdk/src/host.ts:1497:TS2339', 'packages/protocol/src/a.ts:3:TS2322', '<global>:0:TS5083']);
  assert.deepEqual(packageTypecheckRows({ status: 0, signal: null, stdout: '', stderr: '' }, cwd, root), []);
  assert.equal(packageTypecheckRows({ status: 1, signal: null, stdout: '', stderr: '[typecheck-failure] spawn' }, cwd, root), null);
  assert.equal(packageTypecheckRows({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }, cwd, root), null);
});

test('only new diagnostics or an incomplete candidate refuse; an unavailable check and a skip do not', () => {
  const base = { skipped: false, fresh: [], incomplete: [], unavailable: [] };
  assert.equal(commitPackageTypecheckRefuses({ ...base }), false);
  assert.equal(commitPackageTypecheckRefuses({ ...base, fresh: [{ file: 'a.ts' }] }), true);
  assert.equal(commitPackageTypecheckRefuses({ ...base, incomplete: ['packages/sdk'] }), true);
  assert.equal(commitPackageTypecheckRefuses({ ...base, unavailable: ['packages/sdk'] }), false);
  assert.equal(commitPackageTypecheckRefuses({ skipped: true }), false);
});
