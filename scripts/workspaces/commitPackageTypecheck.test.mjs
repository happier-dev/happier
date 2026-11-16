import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { commitPackageTypecheckRefuses, commitTypecheckPackages, packageTypecheckRows, rollingHeadTypecheckPass } from './commitPackageTypecheck.mjs';

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

// The compiler is a process boundary: the fake reads the diagnostics a tree declares in
// `<package>/errors.txt` (`line:code:text` per row) from the warm worktree it was moved to.
const fakeCompiler = compiled => (worktree, dir) => {
  let label = 'base';
  try { label = readFileSync(join(worktree, '.tree-marker'), 'utf8').trim(); } catch {}
  compiled.push(label);
  let text = '';
  try { text = readFileSync(join(worktree, dir, 'errors.txt'), 'utf8'); } catch {}
  const rows = text.split('\n').filter(Boolean).map(entry => {
    const [line, code, ...message] = entry.split(':');
    return { file: `${dir}/src/index.ts`, line: Number(line), column: 1, code: Number(code), text: message.join(':') };
  });
  return { rows, ms: 0 };
};

test('the rolling HEAD typecheck coalesces commits, bisects only when red, and attributes a new error to the commit that introduced it', async t => {
  const { repo } = await workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const state = await mkdtemp(join(tmpdir(), 'happier-rolling-typecheck-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => { try { git('worktree', 'unlock', join(state, 'worktree')); git('worktree', 'remove', '--force', join(state, 'worktree')); } catch {} });
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  // Each tree marks itself so the fake compiler records which tree it compiled.
  const step = async (label, files) => {
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
    await writeFile(join(repo, '.tree-marker'), `${label}\n`);
    git('add', '-A');
    git('commit', '--quiet', '-m', label);
    return git('rev-parse', 'HEAD');
  };
  const c0 = await step('c0', { 'packages/leaf/src/index.ts': 'export const value = 0;\n' });
  const compiled = [];
  const posts = [];
  const board = join(state, 'board.md');
  const options = { repo, env, compile: fakeCompiler(compiled), bootstrap: () => {}, post: entry => posts.push(entry), boardPaths: [board], log: () => {} };
  // First pass: no recorded HEAD yet, so it checks the latest commit against its parent and records it.
  const first = await rollingHeadTypecheckPass(options);
  assert.equal(first.head, c0);
  assert.equal(posts.length, 0);
  const c1 = await step('c1', { 'packages/leaf/src/index.ts': 'export const value = 1;\n' });
  const c2 = await step('c2', { 'packages/leaf/src/index.ts': 'export const value: string = 2;\n', 'packages/leaf/errors.txt': '1:2322:Type number is not assignable to type string.\n' });
  const c3 = await step('c3', { 'packages/leaf/src/index.ts': '// moved\nexport const value: string = 2;\n', 'packages/leaf/errors.txt': '2:2322:Type number is not assignable to type string.\n' });
  const c4 = await step('c4', { 'packages/leaf/src/index.ts': '// moved again\n// moved\nexport const value: string = 2;\n', 'packages/leaf/errors.txt': '3:2322:Type number is not assignable to type string.\n' });
  await writeFile(board, `### 2026-11-16 08:00 UTC — LANE-OTHER → P03 ORCH — RESULT — x\n- committed ${c1.slice(0, 11)}\n### 2026-11-16 07:59 UTC — LANE-TWO → P03 ORCH — RESULT — y\n- SHA ${c2.slice(0, 11)} landed\n`);
  compiled.length = 0;
  const red = await rollingHeadTypecheckPass(options);
  assert.equal(red.base, c0);
  assert.equal(red.head, c4);
  assert.deepEqual(red.attributions.map(entry => [entry.commit, entry.rows.map(row => `${row.file}:${row.line}:TS${row.code}`)]),
    [[c2, ['packages/leaf/src/index.ts:3:TS2322']]]);
  assert.equal(posts.length, 1, 'one URGENT for the introducing commit');
  assert.match(posts[0], /^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC — P03-COMMIT-CHECKS → LANE-TWO, P03 ORCH — URGENT — /mu);
  assert.match(posts[0], new RegExp(c2.slice(0, 11)));
  assert.match(posts[0], /TS2322 Type number is not assignable to type string\./u);
  // Coalesced: c0 (cached from the first pass) is not recompiled; c4 once; the bisect probes c2 (and c1 or c3), never every commit.
  assert.ok(!compiled.includes('c0'), `baseline recompiled: ${compiled}`);
  assert.equal(compiled.filter(label => label === 'c4').length, 1);
  assert.ok(compiled.length <= 3, `compiled ${compiled}`);
  // HEAD did not move: nothing to compile, nothing to post; the known error is the new baseline.
  compiled.length = 0;
  const idle = await rollingHeadTypecheckPass(options);
  assert.equal(idle.head, c4);
  assert.deepEqual(compiled, []);
  assert.equal(posts.length, 1);
  // A green move compiles the new HEAD only and posts nothing.
  const c5 = await step('c5', { 'packages/leaf/src/index.ts': '// moved again\n// moved\nexport const value: string = 2;\nexport const other = 1;\n' });
  const green = await rollingHeadTypecheckPass(options);
  assert.equal(green.head, c5);
  assert.deepEqual(green.attributions, []);
  assert.deepEqual(compiled, ['c5']);
  assert.equal(posts.length, 1);
});
