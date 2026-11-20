import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { inspectDependencyRefresh, publishDependencyRefreshMarker } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
import { withWorkspaceBundleLock } from './workspaceBundleLock.mjs';
import { runCommitGate } from './commitGate.mjs';
import { attributeRollingRange, commitGateTypecheck, commitGateTypecheckPlan, reportCommitGateTypecheck, drainCommitGateReports, queueCommitGateReport, workerTreeRows, treeDependencyPreparer, treeTypechecker, commitPackageTypecheckRefuses, nextRollingScope, commitTypecheckApps, commitTypecheckPackages, packageTypecheckRows, rollingHeadTypecheckPass } from './commitPackageTypecheck.mjs';

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
  const options = { repo, env, compile: fakeCompiler(compiled), bootstrap: () => {}, remote: null, post: entry => posts.push(entry), boardPaths: [board], log: () => {} };
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

test('a red rolling pass bisects only the packages that carry a new error', async t => {
  // 2026-11-16 18:50Z-22:15Z: one packages pass spent 3.5 h recompiling all 23 packages at every
  // bisection probe (packages/tests alone 8-14 min each), so apps/* scopes were never reached.
  const { repo } = await workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const state = await mkdtemp(join(tmpdir(), 'happier-rolling-typecheck-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => { try { git('worktree', 'unlock', join(state, 'worktree')); git('worktree', 'remove', '--force', join(state, 'worktree')); } catch {} });
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const step = async (label, files) => {
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
    await writeFile(join(repo, '.tree-marker'), `${label}\n`);
    git('add', '-A');
    git('commit', '--quiet', '-m', label);
    return git('rev-parse', 'HEAD');
  };
  const compiled = [];
  const record = fakeCompiler([]);
  const compile = (worktree, dir, compileEnv) => {
    let label = 'base';
    try { label = readFileSync(join(worktree, '.tree-marker'), 'utf8').trim(); } catch {}
    compiled.push(`${label}:${dir}`);
    return record(worktree, dir, compileEnv);
  };
  const options = { repo, env, compile, bootstrap: () => {}, remote: null, post: () => {}, boardPaths: [], log: () => {} };
  await step('c0', { 'packages/protocol/src/index.ts': 'export const value = 0;\n' });
  await rollingHeadTypecheckPass(options);
  await step('c1', { 'packages/protocol/src/index.ts': 'export const value = 1;\n' });
  const c2 = await step('c2', { 'packages/leaf/src/index.ts': 'export const value: string = 2;\n', 'packages/leaf/errors.txt': '1:2322:Type number is not assignable to type string.\n' });
  await step('c3', { 'packages/protocol/src/index.ts': 'export const value = 3;\n' });
  await step('c4', { 'packages/protocol/src/index.ts': 'export const value = 4;\n' });
  compiled.length = 0;
  const red = await rollingHeadTypecheckPass(options);
  assert.deepEqual(red.attributions.map(entry => entry.commit), [c2]);
  assert.ok(red.packages.length > 1, `range selects several packages: ${red.packages}`);
  const probes = compiled.filter(entry => !/^c[04]:/u.test(entry));
  assert.ok(probes.length > 0, 'the pass bisected');
  assert.deepEqual(probes.filter(entry => !entry.endsWith(':packages/leaf')), [], `bisection recompiled green packages: ${probes}`);
});

test('a red range records its verdict before attribution compiles any intermediate commit', async t => {
  // 2026-11-16 09:33Z-11-17 01:25Z: no verdict for 16 h. Each loop restart spent hours bisecting the
  // packages range (packages/tests 8-25 min per probe) before recording anything, and apps/* waited.
  const { repo } = await workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const state = await mkdtemp(join(tmpdir(), 'happier-rolling-typecheck-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => { try { git('worktree', 'unlock', join(state, 'worktree')); git('worktree', 'remove', '--force', join(state, 'worktree')); } catch {} });
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const step = async (label, files) => {
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
    await writeFile(join(repo, '.tree-marker'), `${label}\n`);
    git('add', '-A');
    git('commit', '--quiet', '-m', label);
    return git('rev-parse', 'HEAD');
  };
  const compiled = [];
  const posts = [];
  const options = { repo, env, compile: fakeCompiler(compiled), bootstrap: () => {}, remote: null, post: entry => posts.push(entry), boardPaths: [], log: () => {} };
  await step('c0', { 'packages/leaf/src/index.ts': 'export const value = 0;\n' });
  await rollingHeadTypecheckPass({ ...options, attribute: false });
  await step('c1', { 'packages/leaf/src/index.ts': 'export const value = 1;\n' });
  const c2 = await step('c2', { 'packages/leaf/src/index.ts': 'export const value: string = 2;\n', 'packages/leaf/errors.txt': '1:2322:Type number is not assignable to type string.\n' });
  await step('c3', { 'packages/leaf/src/index.ts': '// a\nexport const value: string = 2;\n', 'packages/leaf/errors.txt': '2:2322:Type number is not assignable to type string.\n' });
  const c4 = await step('c4', { 'packages/leaf/src/index.ts': '// b\n// a\nexport const value: string = 2;\n', 'packages/leaf/errors.txt': '3:2322:Type number is not assignable to type string.\n' });
  compiled.length = 0;
  const verdict = await rollingHeadTypecheckPass({ ...options, attribute: false });
  assert.deepEqual(compiled, ['c4'], 'the verdict compiles only the new HEAD');
  assert.equal(readFileSync(join(state, 'rolling-head'), 'utf8').trim(), c4);
  assert.match(readFileSync(join(state, 'verdicts.log'), 'utf8'), new RegExp(`ROLLING-RED scope=packages base=\\w+ head=${c4} .* new=1 `, 'u'));
  assert.deepEqual(verdict.attributions, []);
  assert.equal(posts.length, 0);
  const attributed = await attributeRollingRange(options);
  assert.deepEqual(attributed.attributions.map(entry => entry.commit), [c2]);
  assert.equal(posts.length, 1);
  assert.equal(await attributeRollingRange(options), null, 'an attributed range is cleared');
});

// P03-GATE-TC 2026-11-18: touched apps are checked by the rolling owner after the commit lands. A red range of one commit
// needs no bisection (the verdict's own head compile names it), so its URGENT goes out with the verdict.
test('a red range of a single commit is attributed and posted with its verdict, compiling nothing more', async t => {
  const { repo } = await workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const state = await mkdtemp(join(tmpdir(), 'happier-rolling-typecheck-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => { try { git('worktree', 'unlock', join(state, 'worktree')); git('worktree', 'remove', '--force', join(state, 'worktree')); } catch {} });
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const step = async (label, files) => {
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
    await writeFile(join(repo, '.tree-marker'), `${label}\n`);
    git('add', '-A');
    git('commit', '--quiet', '-m', label);
    return git('rev-parse', 'HEAD');
  };
  const compiled = [];
  const posts = [];
  const options = { repo, env, scope: 'apps/cli', compile: fakeCompiler(compiled), bootstrap: () => {}, remote: null, post: entry => posts.push(entry), boardPaths: [], log: () => {} };
  await step('c0', { 'apps/cli/src/index.ts': 'export const a = 0;\n', 'apps/cli/errors.txt': '10:2322:old a\n' });
  await rollingHeadTypecheckPass({ ...options, attribute: false });
  const c1 = await step('c1', { 'apps/cli/src/index.ts': 'export const a = 1;\n', 'apps/cli/errors.txt': '10:2322:old a\n20:2322:new b\n' });
  compiled.length = 0;
  const verdict = await rollingHeadTypecheckPass({ ...options, attribute: false });
  assert.deepEqual(compiled, ['c1'], 'only the verdict compile');
  assert.deepEqual(verdict.attributions.map(entry => entry.commit), [c1]);
  assert.equal(posts.length, 1);
  assert.match(posts[0], new RegExp(`URGENT — new type errors from ${c1.slice(0, 11)}`, 'u'));
  assert.equal(await attributeRollingRange(options), null, 'nothing left to attribute');
});

test('a scope without a recorded baseline compiles its whole scope instead of recording an unchecked skip', async t => {
  // 2026-11-17 08:33Z: apps/server's first rolling pass compared HEAD^..HEAD, which didn't touch the app,
  // and recorded ROLLING-skipped as its baseline without ever compiling apps/server.
  const { repo, commit } = await workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const state = await mkdtemp(join(tmpdir(), 'happier-rolling-typecheck-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => { try { git('worktree', 'unlock', join(state, 'worktree')); git('worktree', 'remove', '--force', join(state, 'worktree')); } catch {} });
  await commit('docs/notes.md', 'unrelated\n');
  const compiled = [];
  const record = fakeCompiler([]);
  const compile = (worktree, dir, compileEnv) => { compiled.push(dir); return record(worktree, dir, compileEnv); };
  const result = await rollingHeadTypecheckPass({ repo, env: { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state }, scope: 'apps/cli',
    compile, bootstrap: () => {}, remote: null, post: () => {}, boardPaths: [], log: () => {} });
  assert.deepEqual(result.packages, ['apps/cli']);
  // The baseline is HEAD itself: with nothing recorded, comparing against HEAD^ costs a second full
  // compile (apps/cli 66 min on 2026-11-17) and can't attribute anything older anyway.
  assert.deepEqual(compiled, ['apps/cli']);
  assert.match(readFileSync(join(state, 'verdicts.log'), 'utf8'), /ROLLING-BASELINE scope=apps\/cli /u);
});

test('apps/server, apps/cli and apps/ui are selected when the range touches the app or a package it depends on', async t => {
  const { repo, commit } = await workspace(t);
  const appSha = await commit('apps/cli/src/index.ts', 'export const value = 4;\n');
  assert.deepEqual(commitTypecheckApps({ repo, base: `${appSha}^`, tree: appSha }), ['apps/cli']);
  const producerSha = await commit('packages/protocol/src/index.ts', 'export const value = 5;\n');
  assert.deepEqual(commitTypecheckApps({ repo, base: `${producerSha}^`, tree: producerSha }), ['apps/cli'], 'apps/cli depends on @x/protocol');
  const unrelatedSha = await commit('packages/leaf/src/index.ts', 'export const value = 6;\n');
  assert.deepEqual(commitTypecheckApps({ repo, base: `${unrelatedSha}^`, tree: unrelatedSha }), []);
});

test('an app scope keeps a per-file, per-code baseline: only a count increase is new, and it is attributed to the commit that raised it', async t => {
  const { repo } = await workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const state = await mkdtemp(join(tmpdir(), 'happier-rolling-app-typecheck-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => { try { git('worktree', 'unlock', join(state, 'worktree')); git('worktree', 'remove', '--force', join(state, 'worktree')); } catch {} });
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const step = async (label, files) => {
    for (const [path, content] of Object.entries(files)) await writeFile(join(repo, path), content);
    await writeFile(join(repo, '.tree-marker'), `${label}\n`);
    git('add', '-A');
    git('commit', '--quiet', '-m', label);
    return git('rev-parse', 'HEAD');
  };
  // The app already has errors at HEAD (apps/server: 3,520 at 2026-11-16); they are the baseline, never posted.
  await step('c0', { 'apps/cli/src/index.ts': 'export const a = 0;\n', 'apps/cli/errors.txt': '10:2322:old a\n20:2322:old b\n30:2339:old c\n' });
  // The first pass checks the newest commit against its parent, so start from a commit that adds nothing.
  const c0 = await step('c0b', { 'apps/cli/src/index.ts': 'export const a = 10;\n' });
  const compiled = [];
  const posts = [];
  const options = { repo, env, scope: 'apps/cli', compile: fakeCompiler(compiled), bootstrap: () => {}, remote: null, post: entry => posts.push(entry), boardPaths: [], log: () => {} };
  await rollingHeadTypecheckPass(options);
  assert.equal(posts.length, 0, 'existing app errors are the baseline');
  // c1 only shifts every line (an edit above them): the per-file, per-code counts are unchanged.
  const c1 = await step('c1', { 'apps/cli/src/index.ts': 'export const a = 1;\n', 'apps/cli/errors.txt': '15:2322:old a\n25:2322:old b\n35:2339:old c\n' });
  // c2 adds one TS2322 in the same file; c3 shifts again.
  const c2 = await step('c2', { 'apps/cli/src/index.ts': 'export const a = 2;\n', 'apps/cli/errors.txt': '15:2322:old a\n25:2322:old b\n35:2339:old c\n40:2322:new d\n' });
  await step('c3', { 'apps/cli/src/index.ts': 'export const a = 3;\n', 'apps/cli/errors.txt': '16:2322:old a\n26:2322:old b\n36:2339:old c\n41:2322:new d\n' });
  const red = await rollingHeadTypecheckPass(options);
  assert.equal(red.base, c0);
  assert.deepEqual(red.attributions.map(entry => [entry.commit, entry.rows.map(row => `${row.file}:TS${row.code}`)]),
    [[c2, ['apps/cli/src/index.ts:TS2322']]], `c1 (line shift only) is never blamed; got ${JSON.stringify(red.attributions)}`);
  assert.equal(posts.length, 1);
  assert.match(posts[0], new RegExp(c2.slice(0, 11)));
  void c1;
  // The packages scope keeps its own recorded HEAD: the app pass did not advance it.
  assert.equal(existsSync(join(state, 'rolling-head')), false);
});

// P03-INFRA-SWEEP 2026-11-17: the rolling packages compile held ~16.4 GiB and a core for 38 min on the controller
// (the agent host) while it was at load 1,500. The rolling owner gets its rows from a worker; it never compiles locally.
test('the rolling pass takes its rows from a worker and never compiles on the controller; an unreachable worker is INCOMPLETE', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-rolling-typecheck-remote-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const local = [];
  const requests = [];
  let reachable = true;
  // The worker boundary (SSH transport + the worker's own compile) returns rows per package, or null when it could not.
  const remote = (treeId, dirs) => {
    requests.push({ treeId, dirs });
    return new Map(dirs.map(dir => [dir, reachable ? [{ file: `${dir}/src/index.ts`, line: 1, column: 1, code: 2322, text: 'worker row' }] : null]));
  };
  const options = { repo, env, compile: fakeCompiler(local), bootstrap: () => {}, remote, post: () => {}, boardPaths: [], log: () => {} };
  await commit('packages/leaf/src/index.ts', 'export const value = 2;\n');
  const baseline = await rollingHeadTypecheckPass(options);
  assert.deepEqual(local, [], 'zero controller compiles');
  assert.ok(requests.length >= 1, 'the worker supplied the rows');
  assert.match(readFileSync(join(state, 'verdicts.log'), 'utf8'), /ROLLING-BASELINE scope=packages/u);
  assert.equal(existsSync(join(state, 'worktree')), false, 'no controller worktree for a rolling pass');
  void baseline;
  reachable = false;
  await commit('packages/leaf/src/index.ts', 'export const value = 3;\n');
  await rollingHeadTypecheckPass(options);
  assert.deepEqual(local, [], 'an unreachable worker never falls back to a controller compile');
  assert.match(readFileSync(join(state, 'verdicts.log'), 'utf8').trim().split('\n').at(-1), /ROLLING-INCOMPLETE scope=packages .*incomplete=packages\/leaf/u);
});

test('a git index lock left in the warm worktree by a killed check does not stop later passes', async t => {
  const { repo } = await workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const state = await mkdtemp(join(tmpdir(), 'happier-rolling-typecheck-lock-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => { try { git('worktree', 'unlock', join(state, 'worktree')); git('worktree', 'remove', '--force', join(state, 'worktree')); } catch {} });
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const step = async (label, path) => {
    await writeFile(join(repo, path), `export const value = '${label}';\n`);
    git('add', '-A');
    git('commit', '--quiet', '-m', label);
    return git('rev-parse', 'HEAD');
  };
  const options = { repo, env, compile: fakeCompiler([]), bootstrap: () => {}, remote: null, post: () => {}, boardPaths: [], log: () => {} };
  await step('c0', 'packages/leaf/src/index.ts');
  await rollingHeadTypecheckPass(options);
  // 2026-11-16 ~12:59Z: a check killed inside `git read-tree` left the worktree's index.lock behind, and
  // every later pass exited 2 for hours. Only the worktree-lock holder runs git there, so it is stale.
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: join(state, 'worktree'), encoding: 'utf8' }).trim();
  await writeFile(join(gitDir, 'index.lock'), '');
  const c1 = await step('c1', 'packages/leaf/src/index.ts');
  const next = await rollingHeadTypecheckPass(options);
  assert.equal(next.head, c1);
  assert.equal(readFileSync(join(state, 'rolling-head'), 'utf8').trim(), c1);
});

// P03-TYPECHECK-DEBT 2026-11-17: packages attribution waited ~1 h behind the apps/ui baseline compile. With HEAD moving
// during every pass, packages runs before each app pass, and the app scopes take turns so none is starved.
test('the rolling loop runs packages before every app pass and rotates the app scopes', () => {
  const order = [];
  let lastApp, lastScope;
  for (let pass = 0; pass < 8; pass++) {
    // HEAD moved during the previous pass, so every scope is behind again.
    const scope = nextRollingScope({ pending: ['packages', 'apps/server', 'apps/cli', 'apps/ui'], lastScope, lastApp });
    order.push(scope);
    lastScope = scope;
    if (scope !== 'packages') lastApp = scope;
  }
  assert.deepEqual(order, ['packages', 'apps/server', 'packages', 'apps/cli', 'packages', 'apps/ui', 'packages', 'apps/server']);
  assert.equal(nextRollingScope({ pending: ['apps/ui', 'apps/server'], lastScope: 'packages', lastApp: 'apps/server' }), 'apps/ui');
  assert.equal(nextRollingScope({ pending: ['packages'], lastScope: 'packages' }), 'packages');
  assert.equal(nextRollingScope({ pending: [], lastApp: 'apps/ui' }), undefined);
});

// P03-GATE-TC 2026-11-18: 5f6edbb072d (Protocol TS4104) and e3f191e6bc4 (scm-gitlab TS2322) passed the commit gate and
// broke their package's build for 3-4 h; the rolling HEAD typecheck never follows packages/plugins/* and reached
// Protocol hours later. The gate checks the touched workspaces themselves, plugins included, before the commit lands.
test('the commit gate checks every touched packages/* and packages/plugins/* workspace, without dependents; touched apps go after the commit lands', async t => {
  const { repo, commit } = await workspace(t);
  const plugin = await commit('packages/plugins/codex/src/index.ts', 'export const value = 7;\n');
  assert.deepEqual(commitGateTypecheckPlan({ repo, base: `${plugin}^`, tree: plugin }), { blocking: ['packages/plugins/codex'], detached: [] });
  const producer = await commit('packages/protocol/src/index.ts', 'export const value = 8;\n');
  assert.deepEqual(commitGateTypecheckPlan({ repo, base: `${producer}^`, tree: producer }), { blocking: ['packages/protocol'], detached: [] },
    'dependents (sdk, ui-kit, the codex plugin, apps/cli) stay with the rolling HEAD typecheck');
  const app = await commit('apps/cli/src/index.ts', 'export const value = 9;\n');
  assert.deepEqual(commitGateTypecheckPlan({ repo, base: `${app}^`, tree: app }), { blocking: [], detached: ['apps/cli'] });
  const untyped = await commit('packages/untyped/src/index.ts', 'export const value = 10;\n');
  assert.deepEqual(commitGateTypecheckPlan({ repo, base: `${untyped}^`, tree: untyped }), { blocking: [], detached: [] });
});

test('the commit gate refuses only diagnostics the packet adds over its parent; base errors are never blamed and an unjudged worker never refuses', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-commit-gate-typecheck-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  // The worker boundary (tree push + the worker's compile) returns rows per package for a tree; here a table per tree.
  const rowsByTree = new Map();
  const requests = [];
  let reachable = true;
  // Several trees travel in one request: the answer is then keyed by tree.
  const remote = (treeIds, dirs) => {
    requests.push(treeIds);
    return new Map(treeIds.map(treeId => [treeId, new Map(dirs.map(dir => [dir, reachable ? rowsByTree.get(treeId) ?? [] : undefined]))]));
  };
  const known = { file: 'packages/plugins/codex/src/index.ts', line: 1, column: 1, code: 2339, text: 'known at the base' };
  const base = await commit('packages/plugins/codex/src/index.ts', 'export const value = 11;\n');
  rowsByTree.set(git('rev-parse', `${base}^{tree}`), [known]);
  const broken = await commit('packages/plugins/codex/src/index.ts', 'export const value = 11;\nexport const broken: string = 1;\n');
  rowsByTree.set(git('rev-parse', `${broken}^{tree}`), [known, { file: 'packages/plugins/codex/src/index.ts', line: 2, column: 14, code: 2322, text: "Type 'number' is not assignable to type 'string'." }]);
  const refused = await commitGateTypecheck({ repo, base: `${broken}^`, tree: broken, env, remote, log: () => {} });
  assert.equal(commitPackageTypecheckRefuses(refused), true);
  assert.deepEqual(refused.fresh.map(row => `${row.file}:${row.line}:TS${row.code}`), ['packages/plugins/codex/src/index.ts:2:TS2322'], 'the known base error is not blamed');
  assert.match(readFileSync(join(state, 'verdicts.log'), 'utf8'), /GATE-REFUSED .*packages=packages\/plugins\/codex new=1 /u);
  // A packet that only moves the known error is accepted.
  const moved = await commit('packages/plugins/codex/src/index.ts', '// moved\nexport const value = 11;\n');
  rowsByTree.set(git('rev-parse', `${moved}^{tree}`), [{ ...known, line: 2 }]);
  assert.equal(commitPackageTypecheckRefuses(await commitGateTypecheck({ repo, base: `${moved}^`, tree: moved, env, remote, log: () => {} })), false);
  // The parent's rows come from the result cache when this host judged that tree before.
  assert.ok(requests.every(trees => trees.length >= 1), 'one worker request per check');
  assert.deepEqual(requests[0].length, 2, 'base and head travel in one request');
  assert.equal(requests.flat().filter(tree => tree === git('rev-parse', `${broken}^{tree}`)).length, 1, 'a tree is fetched from the worker once');
  // No worker could judge: unavailable, printed, not refused (the rolling owner still covers it).
  reachable = false;
  const later = await commit('packages/plugins/codex/src/index.ts', '// moved\nexport const value = 12;\n');
  const unjudged = await commitGateTypecheck({ repo, base: `${later}^`, tree: later, env, remote, log: () => {} });
  assert.deepEqual(unjudged.unavailable, ['packages/plugins/codex']);
  assert.equal(commitPackageTypecheckRefuses(unjudged), false);
});

// P03 ORCH 2026-11-18: before it blocks, the gate check runs after each packages/plugins commit lands and posts an URGENT
// naming the commit and the error to the lane that posted its SHA (report-and-URGENT mode), recording its wall time.
test('report mode checks a landed commit against its parent and posts one URGENT naming the commit and its new error', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-commit-gate-report-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const rowsByTree = new Map();
  const remote = (treeIds, dirs) => new Map(treeIds.map(treeId => [treeId, new Map(dirs.map(dir => [dir, rowsByTree.get(treeId) ?? []]))]));
  const broken = await commit('packages/plugins/codex/src/index.ts', 'export const broken: string = 1;\n');
  rowsByTree.set(git('rev-parse', `${broken}^{tree}`), [{ file: 'packages/plugins/codex/src/index.ts', line: 1, column: 14, code: 2322, text: "Type 'number' is not assignable to type 'string'." }]);
  const board = join(state, 'board.md');
  await writeFile(board, `### 2026-11-18 20:00 UTC — LANE-PLUGIN → P03 ORCH — RESULT — x\n- committed ${broken.slice(0, 11)}\n`);
  const posts = [];
  const options = { repo, env, remote, post: entry => posts.push(entry), boardPaths: [board], log: () => {} };
  const red = await reportCommitGateTypecheck({ ...options, commit: broken });
  assert.equal(red.fresh.length, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC — P03-COMMIT-CHECKS → LANE-PLUGIN, P03 ORCH — URGENT — new type errors from /mu);
  assert.match(posts[0], new RegExp(broken.slice(0, 11)));
  assert.match(posts[0], /index\.ts\(1,14\): TS2322/u);
  const clean = await commit('packages/plugins/codex/src/index.ts', 'export const fixed = 1;\n');
  await reportCommitGateTypecheck({ ...options, commit: clean });
  assert.equal(posts.length, 1, 'a clean commit posts nothing');
  const verdicts = readFileSync(join(state, 'verdicts.log'), 'utf8').trim().split('\n');
  assert.match(verdicts.at(-2), new RegExp(`GATE-REPORT-RED commit=${broken} .*new=1 .* wall=\\d+\\.\\ds`, 'u'));
  assert.match(verdicts.at(-1), new RegExp(`GATE-REPORT-ok commit=${clean} `, 'u'));
  const app = await commit('apps/cli/src/index.ts', 'export const value = 42;\n');
  assert.equal(await reportCommitGateTypecheck({ ...options, commit: app }), null, 'apps stay with the rolling owner');
});

test('report mode skips queued work only when a rolling verdict completed all its packages', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-report-coverage-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const sha = await commit('packages/leaf/src/index.ts', 'export const value = 42;');
  const head = await commit('packages/leaf/src/index.ts', 'export const value = 43;');
  const log = join(state, 'verdicts.log');
  const verdict = (head, unavailable) => `${new Date().toISOString()} ROLLING-ok scope=packages base=${base} head=${head} packages=packages/leaf new=0 incomplete=- unavailable=${unavailable} 1.0s\n`;
  await writeFile(log, verdict(base, '-') + verdict(head, 'packages/leaf'));
  let requests = 0;
  const options = { repo, env, log: () => {}, post: () => assert.fail('unexpected author notification'),
    remote: (trees, dirs) => {
      requests += 1;
      return new Map(trees.map(tree => [tree, new Map(dirs.map(dir => [dir, []]))]));
    } };
  await reportCommitGateTypecheck({ ...options, commit: sha });
  assert.equal(requests, 1, 'older or unavailable rolling results do not count');
  await appendFile(log, verdict(head, '-'));
  queueCommitGateReport({ repo, env, commit: head });
  await drainCommitGateReports({ ...options, workerCandidates: ['nl1'] });
  assert.equal(requests, 1);
  assert.match(readFileSync(log, 'utf8').trim().split('\n').at(-1), /GATE-REPORT-superseded .*packages=packages\/leaf/u);
});

test('report mode records failed declaration preparation as incomplete without notifying the author', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-report-preparation-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const sha = await commit('packages/leaf/src/index.ts', 'export const value = 42;');
  const failed = {
    status: 2, stdout: "src/index.ts(2,1): error TS2307: Cannot find module '@happier-dev/forge-ci/runtime'.",
    stderr: '[typecheck-declaration-failure] {"step":"declaration-emission","status":2}\n',
  };
  const remote = ([base, head]) => new Map([
    [base, new Map([['packages/leaf', []]])],
    [head, new Map([['packages/leaf', packageTypecheckRows(failed, join(repo, 'packages/leaf'), repo)]])],
  ]);
  const posts = [];
  const result = await reportCommitGateTypecheck({ repo, env, commit: sha, remote, log: () => {}, post: entry => posts.push(entry), boardPaths: [] });
  assert.deepEqual(result.fresh, []);
  assert.deepEqual(result.incomplete, ['packages/leaf']);
  assert.deepEqual(posts, []);
  assert.match(readFileSync(join(state, 'verdicts.log'), 'utf8'), /GATE-REPORT-incomplete .*new=0 incomplete=packages\/leaf/u);
  assert.equal(packageTypecheckRows({ ...failed, stderr: '' }, join(repo, 'packages/leaf'), repo)[0].code, 2307);
});

// P03 ORCH 2026-11-18: the worker's dependency install ran inside the admitted compile, so the gate identity recorded a
// 15.26 GiB kernel peak for a 1-6 GiB compile. The install is its own step, once per dependency generation.
test('dependencies are prepared once per dependency generation, outside the compile', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-commit-typecheck-deps-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => { try { git('worktree', 'unlock', join(state, 'worktree')); git('worktree', 'remove', '--force', join(state, 'worktree')); } catch {} });
  const installs = [];
  const bootstrap = () => { installs.push(readFileSync(join(state, 'worktree', 'packages/leaf/package.json'), 'utf8')); execFileSync('mkdir', ['-p', join(state, 'worktree', 'node_modules')]); };
  const compiled = [];
  const options = { repo, state, env: process.env, log: () => {}, compile: fakeCompiler(compiled), bootstrap };
  const first = await commit('packages/leaf/src/index.ts', 'export const value = 101;\n');
  const prepare = treeDependencyPreparer(options);
  const tree = rev => git('rev-parse', `${rev}^{tree}`);
  assert.equal(prepare(tree(first)), true, 'a new generation installs');
  assert.equal(prepare(tree(first)), false, 'the same generation does not');
  const sourceOnly = await commit('packages/leaf/src/index.ts', 'export const value = 102;\n');
  assert.equal(prepare(tree(sourceOnly)), false, 'a source change is the same dependency generation');
  const { rowsAt } = treeTypechecker(options);
  rowsAt(tree(sourceOnly), ['packages/leaf'], 'head');
  assert.equal(installs.length, 1, 'the compile step never installs a prepared generation');
  const manifest = await commit('packages/leaf/package.json', JSON.stringify({ name: '@x/leaf', scripts: { typecheck: 'tsc' }, version: '2.0.0' }));
  assert.equal(prepare(tree(manifest)), true, 'a manifest change is a new generation');
  assert.equal(installs.length, 2);
});

// Exact-tree worktrees do not inherit the normal command replica's ignored source inputs.
// The compiler boundary imports the real generated module; no TypeScript compiler is needed.
test('each selected tree prepares its own embedded policy before declaration imports', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-commit-typecheck-policy-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  t.after(() => rm(state, { recursive: true, force: true }));
  t.after(() => { try { git('worktree', 'unlock', join(state, 'worktree')); git('worktree', 'remove', '--force', join(state, 'worktree')); } catch {} });
  const generator = 'packages/protocol/scripts/generate-embedded-feature-policies.mjs';
  const generated = 'packages/protocol/src/features/embeddedFeaturePolicies.generated.ts';
  const write = async (path, content) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  };
  await write(generator, readFileSync(new URL('../../packages/protocol/scripts/generate-embedded-feature-policies.mjs', import.meta.url)));
  await write('.gitignore', `${generated}\nnode_modules/\n`);
  await write('.github/feature-policy/preview.json', JSON.stringify({ buildPolicy: { allow: ['first-policy'] } }));
  await write('.github/feature-policy/production.json', JSON.stringify({ buildPolicy: { deny: ['production-policy'] } }));
  const env = { ...process.env, HAPPIER_REQUIRE_FEATURE_POLICY: '1', HAPPIER_EMBEDDED_POLICY_ENV: 'preview' };
  const policyAt = worktree => JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    'const module = await import(process.argv[1]); process.stdout.write(JSON.stringify(module.EMBEDDED_FEATURE_BUILD_POLICY_RAW));',
    pathToFileURL(join(worktree, generated)).href], { cwd: worktree, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  // Known-good source generation/import proves that a missing-input RED is not fixture setup.
  execFileSync(process.execPath, [join(repo, generator)], { cwd: repo, env });
  assert.equal(policyAt(repo).preview.allowRaw, 'first-policy');
  const first = await commit('packages/sdk/src/index.ts', 'export const value = 2;\n');
  let installs = 0;
  const observed = [];
  const messages = [];
  const { rowsAt } = treeTypechecker({ repo, state, env, log: message => messages.push(message),
    bootstrap: () => { installs += 1; execFileSync(process.execPath, ['-e', 'require("node:fs").mkdirSync("node_modules")'], { cwd: join(state, 'worktree') }); },
    // The compiler process boundary reads the source input that declaration preparation imports.
    compile: (worktree, dir) => { observed.push({ dir, policy: policyAt(worktree) }); return { rows: [], ms: 0 }; },
  });
  const tree = rev => git('rev-parse', `${rev}^{tree}`);
  rowsAt(tree(first), ['packages/sdk'], 'base');
  assert.equal(observed[0].policy.preview.allowRaw, 'first-policy');
  const second = await commit('.github/feature-policy/preview.json', JSON.stringify({ buildPolicy: { allow: ['second-policy'] } }));
  rowsAt(tree(second), ['apps/cli'], 'head');
  assert.equal(observed[1].policy.preview.allowRaw, 'second-policy', 'a policy-only tree move replaces the previous ignored input');
  assert.equal(observed[1].policy.production.denyRaw, 'production-policy');
  assert.equal(installs, 1, 'source policy preparation does not reinstall unchanged dependencies');
  const malformed = await commit('.github/feature-policy/preview.json', '{');
  assert.equal(rowsAt(tree(malformed), ['packages/sdk'], 'invalid').get('packages/sdk'), null);
  assert.ok(messages.some(line => line.includes('incomplete generated-input-preparation')));
  assert.equal(observed.length, 2, 'failed generation never reaches the compiler');
});

// 2026-11-18 21:00-21:12Z: one detached report process per landed commit (10 in 12 min) piled up behind the gate lane's
// single worktree. One drainer takes the queued commits in landing order; a commit's parent tree is the previous
// commit's tree, so each commit after the first fetches only its own tree.
test('queued report-mode commits are drained in landing order by one drainer, each new tree fetched once', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-commit-gate-queue-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const fetched = [];
  const remote = (treeIds, dirs) => { fetched.push(...treeIds); return new Map(treeIds.map(treeId => [treeId, new Map(dirs.map(dir => [dir, []]))])); };
  const shas = [];
  for (const value of [21, 22, 23]) {
    shas.push(await commit('packages/plugins/codex/src/index.ts', `export const value = ${value};\n`));
    queueCommitGateReport({ repo, env, commit: shas.at(-1) });
  }
  const workerCandidates = ['nl1', 'nl3'];
  const drained = await drainCommitGateReports({ repo, env, workerCandidates, remote, post: () => {}, boardPaths: [], log: () => {} });
  assert.deepEqual(drained, shas, 'landing order, each once');
  assert.equal(fetched.length, 4, 'parent + 3 commits: every tree once');
  assert.deepEqual(await drainCommitGateReports({ repo, env, workerCandidates, remote, post: () => {}, boardPaths: [], log: () => {} }), [], 'the queue is empty');
  assert.equal(readFileSync(join(state, 'verdicts.log'), 'utf8').match(/GATE-REPORT-ok/gu).length, 3);
});

// P03 ORCH 2026-11-18: one queue, two consumers (nl1 and nl3 gate lanes); ~50 package commits/h arrive against ~30/h
// for one serial lane.
test('two report consumers split one queue: every commit is checked exactly once, and both consumers take commits', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-commit-gate-split-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const shas = [];
  for (const value of [31, 32, 33, 34, 35, 36]) {
    shas.push(await commit('packages/plugins/codex/src/index.ts', `export const value = ${value};\n`));
    queueCommitGateReport({ repo, env, commit: shas.at(-1) });
  }
  const checkedBy = new Map();
  // The worker boundary: each consumer's remote answers after a tick, so the two drain concurrently.
  const consumer = worker => async () => drainCommitGateReports({ repo, env, worker, workerCandidates: ['nl1', 'nl3'], post: () => {}, boardPaths: [], log: () => {},
    remote: (treeIds, dirs) => {
      for (const treeId of treeIds) checkedBy.set(treeId, [...(checkedBy.get(treeId) ?? []), worker]);
      return new Map(treeIds.map(treeId => [treeId, new Map(dirs.map(dir => [dir, []]))]));
    } });
  const [nl1, nl3] = await Promise.all([consumer('nl1')(), consumer('nl3')()]);
  assert.deepEqual([...nl1, ...nl3].sort(), [...shas].sort(), 'every queued commit once, none twice');
  assert.ok(nl1.length > 0 && nl3.length > 0, `both consumers took commits: nl1=${nl1.length} nl3=${nl3.length}`);
  const verdicts = readFileSync(join(state, 'verdicts.log'), 'utf8').match(/GATE-REPORT-ok commit=\w+/gu);
  assert.equal(new Set(verdicts).size, 6);
  void git;
});

// A worker whose SSH session closes before returning rows hands the request to the next worker.
test('a worker dispatch that returns no rows falls back to the next worker', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-commit-gate-fallback-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const sha = await commit('packages/plugins/codex/src/index.ts', 'export const value = 41;\n');
  const treeId = execFileSync('git', ['rev-parse', `${sha}^{tree}`], { cwd: repo, encoding: 'utf8' }).trim();
  const dispatched = [];
  // The SSH/process boundary: tree push and the routed worker command.
  const transport = {
    ssh: worker => ({ alias: worker, config: '/dev/null' }),
    push: () => ({ status: 0, stderr: '' }),
    listRefs: () => '',
    dispatch: (worker, args) => {
      dispatched.push(worker);
      if (worker === 'nl3') return { status: 255, signal: null, stdout: '' };
      const tree = args.find(arg => arg.startsWith('--tree=')).slice(7);
      return { status: 0, signal: null, stdout: `HAPPIER_ROLLING_ROWS ${JSON.stringify({ [tree]: { 'packages/plugins/codex': [] } })}\n` };
    },
  };
  const rows = await workerTreeRows({ repo, state, log: () => {}, workers: ['nl3', 'nl1'], lane: 'gate', transport })(treeId, ['packages/plugins/codex'], 'head');
  assert.deepEqual(dispatched, ['nl3', 'nl1']);
  assert.deepEqual(rows.get('packages/plugins/codex'), []);
});

test('an exact-tree worker reads the Git payload even when the source mirror cannot flush', { skip: process.platform === 'win32' }, async t => {
  const { repo, commit } = await workspace(t);
  const source = fileURLToPath(new URL('../../', import.meta.url));
  const workerHome = join(repo, 'worker-home');
  const state = join(repo, '.git/typecheck-state');
  const bin = join(repo, 'bin');
  const config = join(repo, 'ssh.conf');
  const mirrorLog = join(repo, 'mirror.log');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  await Promise.all([mkdir(workerHome), mkdir(state), mkdir(bin)]);
  const write = async (name, contents, mode) => {
    const path = join(repo, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { mode });
  };
  await write('ssh.conf', '');
  await write('bin/ssh', `#!/bin/sh
while [ "$#" -gt 2 ]; do
  case "$1" in -F|-o) shift 2;; -T) shift;; *) exit 91;; esac
done
[ "$1" = configured-worker ] || exit 90
export HOME=${JSON.stringify(workerHome)}
unset HAPPIER_WORKSPACE_DIST_BUILD_LOCK_WAIT_ALLOWED
cd "$HOME" || exit
exec /bin/bash -c "$2"
`, 0o755);
  for (const name of [
    'apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh',
    'apps/stack/scripts/utils/dev_targets/historical_temp_roots.mjs',
    'apps/stack/scripts/utils/dev_targets/native_execution_signals.sh',
    'apps/stack/scripts/utils/proc/native_process_identity.sh',
    'apps/stack/scripts/utils/proc/native_process_priority.sh',
    'scripts/testing/lib/compilerBaseline.mjs',
    'scripts/board/postBoardEntry.mjs',
    'packages/cli-common/packageExportMatch.cjs',
    'scripts/workspaces/commitPackageTypecheck.mjs',
    'scripts/workspaces/commitTypeCoherenceDiagnostics.mjs',
    'scripts/workspaces/commitTreeEntryLoads.mjs',
    'scripts/workspaces/workspaceBundleLock.mjs',
    'packages/cli-common/packageBuildOutputTargets.mjs',
    'packages/cli-common/sourceRuntimeEntries.mjs',
    'packages/cli-common/cliRuntimeSidecars.mjs',
    'packages/cli-common/sourceRuntimeDependencies.mjs',
    'packages/cli-common/workspaceBundleLock.mjs',
    'packages/cli-common/fileChangeObserver.mjs',
    'packages/cli-common/workspaceBundleLockPriority.mjs',
    'packages/cli-common/workspaceLockLease.mjs',
    'packages/cli-common/processInstance.mjs',
    'packages/cli-common/tempDirOwnership.mjs',
  ]) await write(name, readFileSync(join(source, name)));
  await write('apps/stack/bin/hstack-exec', `#!/bin/sh
if [ "$1" = --execution-workers ]; then
  printf '%s\\0' test-worker configured-worker ${JSON.stringify(config)} ${JSON.stringify(workerHome)} ''
  exit 0
fi
if [ "$1" = --heavyweight-admission ]; then
  while [ "$1" != -- ]; do shift; done
  shift
  [ "$2" = scripts/workspaces/commitGateTypecheck.mjs ] || { printf 'unstable admission entry: %s\\n' "$2" >&2; exit 95; }
  exec "$@"
fi
printf 'attempted mirror dispatch\\n' >> ${JSON.stringify(mirrorLog)}
exit 98
`, 0o755);
  await write('scripts/workspaces/commitGateTypecheck.mjs', readFileSync(join(source, 'scripts/workspaces/commitGateTypecheck.mjs')));
  await write('apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs', `
import { mkdirSync, symlinkSync } from 'node:fs';
mkdirSync('node_modules', { recursive: true });
symlinkSync(${JSON.stringify(dirname(createRequire(import.meta.url).resolve('typescript/package.json')))}, 'node_modules/typescript', 'dir');
`);
  // The compiler executable is the external boundary. Its declaration run
  // yields a diagnostic only when checking the committed source.
  await write('scripts/workspaces/runTypeScriptCli.mjs', `
import { readFileSync } from 'node:fs';
const project = process.argv[process.argv.indexOf('-p') + 1];
if (!readFileSync('src/index.ts', 'utf8').includes('= 41')) process.exit(97);
if (project !== 'tsconfig.json') {
  console.log('src/index.ts(1,14): error TS9007: Fixture declaration diagnostic');
  process.exitCode = 2;
}
`);
  await write('packages/protocol/tsconfig.json', JSON.stringify({ compilerOptions: { declaration: true } }));
  git('add', '--', 'apps/stack', 'scripts', 'packages/cli-common');
  git('commit', '--quiet', '-m', 'trusted launch scripts');
  const sha = await commit('packages/protocol/src/index.ts', 'export const value = 41;\n');
  const treeId = git('rev-parse', `${sha}^{tree}`);
  await write('packages/protocol/src/index.ts', 'export const value = 99;\n');
  await write('scripts/workspaces/commitGateTypecheck.mjs', 'process.exit(96);\n');
  const script = `
    import { workerTreeRows } from ${JSON.stringify(new URL('./commitPackageTypecheck.mjs', import.meta.url).href)};
    const rows = await workerTreeRows({ repo: process.cwd(), state: ${JSON.stringify(state)}, lane: 'gate',
      entry: 'scripts/workspaces/commitGateTypecheck.mjs' })(${JSON.stringify(treeId)}, ['packages/protocol'], 'head');
    console.log(JSON.stringify([...rows]));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_SSH_VARIANT: 'ssh', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [['packages/protocol', [{
    file: 'packages/protocol/src/index.ts', line: 1, column: 14, code: 9007, text: 'Fixture declaration diagnostic',
  }]]], result.stderr);
  assert.equal(existsSync(mirrorLog), false);

  const lockPath = join(workerHome, '.happier-stack/cache/commit-typecheck-worker/typecheck-state/lane-gate/worktree.lock');
  await withWorkspaceBundleLock(async () => {
    const stalled = spawnSync(process.execPath, [
      fileURLToPath(new URL('./commitGate.mjs', import.meta.url)),
      '--label=commit-partial', `--base=${sha}^`, `--tree=${sha}`,
    ], {
      cwd: repo, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, GIT_SSH_VARIANT: 'ssh', PATH: `${bin}:${process.env.PATH}`,
        HAPPIER_COMMIT_TREE_GATE: 'off', HAPPIER_COMMIT_TYPECHECK_GATE: 'report', HAPPIER_COMMIT_TYPECHECK_DIR: state },
    });
    assert.equal(stalled.status, 11, stalled.error?.message ?? stalled.stderr + stalled.stdout);
    assert.match(stalled.stderr, /exact-tree worker worktree busy/u);
    assert.match(stalled.stdout, /"code":"declaration-comparison-incomplete"/u);
  }, { lockPath });
});

test('the controller declaration gate admits and judges both Git trees with its installed toolchain', { skip: process.platform === 'win32' }, async t => {
  const { repo, commit } = await workspace(t);
  const state = join(repo, '.git/controller-typecheck');
  const tsDir = dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
  const write = async (name, contents, mode) => {
    const path = join(repo, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { mode });
  };
  await write('package.json', JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }));
  await write('packages/protocol/tsconfig.json', JSON.stringify({ compilerOptions: { declaration: true } }));
  const entry = fileURLToPath(new URL('./commitGateTypecheck.mjs', import.meta.url));
  await write('apps/stack/bin/hstack-exec', `#!/bin/sh
[ "$1" = --heavyweight-admission ] || exit 95
printf '%s\n' "$@" > "${repo}/admissions"
while [ "$1" != -- ]; do shift; done
shift
[ "$2" = scripts/workspaces/commitGateTypecheck.mjs ] || exit 96
shift 2
exec "${process.execPath}" "${entry}" "$@"
`, 0o755);
  await write('scripts/workspaces/runTypeScriptCli.mjs', `
import { readFileSync } from 'node:fs';
import { shouldRouteTypeScriptCliThroughHstack } from ${JSON.stringify(new URL('./resolveTypeScriptCliInvocation.mjs', import.meta.url).href)};
if (shouldRouteTypeScriptCliThroughHstack({ args: process.argv.slice(2), env: process.env })) process.exit(98);
const source = readFileSync('src/index.ts', 'utf8');
if (source.includes('= 99')) process.exit(97);
if (source.includes('= 41') && process.argv[process.argv.indexOf('-p') + 1] !== 'tsconfig.json') {
  console.log('src/index.ts(1,14): error TS9007: Fixture declaration diagnostic');
  process.exitCode = 2;
}
`);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('add', '-A');
  git('commit', '-qm', 'fixture toolchain');
  const candidate = await commit('packages/protocol/src/index.ts', 'export const value = 41;\n');
  await write('packages/protocol/src/index.ts', 'export const value = 99;\n');
  await mkdir(join(repo, 'node_modules'));
  await symlink(tsDir, join(repo, 'node_modules/typescript'), 'dir');
  const { installIdentity } = await inspectDependencyRefresh({ installDir: repo });
  await publishDependencyRefreshMarker({ installDir: repo, identity: installIdentity });
  const env = { ...process.env, HAPPIER_COMMIT_TREE_GATE: 'off', HAPPIER_COMMIT_TYPECHECK_GATE: 'report',
    HAPPIER_COMMIT_TYPECHECK_DIR: state, HAPPIER_COMMIT_TYPECHECK_WORKERS: ' ' };
  // This gate starts directly, outside the routed test runner's placement.
  for (const marker of ['HAPPIER_HSTACK_EXECUTION', 'HAPPIER_DEV_TARGET_EXECUTION', 'HAPPIER_TYPECHECK_DISPATCHED', 'HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN']) delete env[marker];
  const result = await runCommitGate({ repo, base: `${candidate}^`, tree: candidate, env, label: 'commit-partial' });
  assert.equal(result.verdict, 'refused', JSON.stringify(result));
  assert.ok(result.findings.some(finding => finding.includes('TS9007')));
  const trees = [git('rev-parse', `${candidate}^^{tree}`), git('rev-parse', `${candidate}^{tree}`)];
  assert.ok(readFileSync(join(repo, 'admissions'), 'utf8').includes(`--judged-trees=${trees.join(',')}`));
});

test('an excluded fallback worker is never contacted for Git preparation', { skip: process.platform === 'win32' }, async t => {
  const { repo, commit } = await workspace(t);
  const state = join(repo, '.git/typecheck-state');
  await mkdir(state);
  const sha = await commit('packages/protocol/src/index.ts', 'export const value = 19;\n');
  const treeId = execFileSync('git', ['rev-parse', `${sha}^{tree}`], { cwd: repo, encoding: 'utf8' }).trim();
  const preparation = [];
  const transport = {
    ssh: worker => ({ alias: worker, config: '/dev/null' }),
    listRefs: ssh => { preparation.push(ssh.alias); return ''; },
    push: () => ({ status: 0, stderr: '' }),
    dispatch: () => ({ status: 255, stdout: '' }),
  };
  const env = { ...process.env, HSTACK_EXEC_PRE_DISPATCH_EXCLUDED_TARGETS: 'nl3' };
  const rows = await workerTreeRows({ repo, state, env, workers: ['nl1', 'nl3'], lane: 'gate', transport, log: () => {} })(
    treeId, ['packages/protocol'], 'head');
  assert.deepEqual(preparation, ['nl1']);
  assert.equal(rows.get('packages/protocol'), undefined);
});


test('the P03 gate refuses a declaration regression in Protocol or Plugin SDK using the rolling cache', async t => {
  const { repo, commit } = await workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const state = join(repo, '.git/typecheck-state');
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state,
    HAPPIER_COMMIT_TYPECHECK_GATE: 'report', HAPPIER_COMMIT_TREE_GATE: 'off',
    HAPPIER_COMMIT_TYPECHECK_WORKERS: ' ' };
  await commit('packages/plugin-sdk/package.json', JSON.stringify({ name: '@x/plugin-sdk', scripts: { typecheck: 'tsc' } }));
  await commit('packages/plugin-sdk/src/index.ts', 'export function api(): number { return 0; }\n');
  const judge = (base, tree, options) => runCommitGate({ repo, base, tree, env, label: 'commit-partial', ...options });
  // Seed the existing worker-result boundary, keeping the Git comparison and gate real.
  const cache = async (rev, dir, rows) => {
    const tree = git('rev-parse', `${rev}^{tree}`);
    const results = join(state, 'results', tree);
    await mkdir(results, { recursive: true });
    await writeFile(join(results, `${dir.replaceAll('/', '__')}.prepared-declarations.json`), JSON.stringify({ rows }));
  };
  for (const dir of ['packages/protocol', 'packages/plugin-sdk']) {
    await commit(`${dir}/tsconfig.json`, JSON.stringify({ compilerOptions: { declaration: true, isolatedDeclarations: true } }));
    const file = `${dir}/src/index.ts`;
    const clean = await commit(file, 'export function api(): number { return 1; }\n');
    const broken = await commit(file, 'export function api() { return 1; }\n');
    const diagnostic = { file, line: 1, column: 17, code: 9007,
      text: 'Function must have an explicit return type annotation with --isolatedDeclarations.' };
    await cache(clean, dir, []);
    await cache(broken, dir, [diagnostic]);
    const verdict = await judge(clean, broken);
    assert.equal(verdict.verdict, 'refused', dir);
    assert.match(verdict.findings.join('\n'), /TS9007/u);
    const replay = await judge(clean, broken, { prior: clean, cheapOnly: true });
    assert.equal(replay.verdict, 'refused', dir);
    assert.match(replay.findings.join('\n'), /TS9007/u);
    assert.equal((await judge(clean, broken, { prior: clean })).verdict, 'refused', dir);

    const inherited = await commit(file, 'export function api() { return 2; }\n');
    await cache(inherited, dir, [diagnostic]);
    assert.equal((await judge(broken, inherited)).verdict, 'pass', dir);
  }
  const other = await commit('packages/leaf/src/index.ts', 'export const value = 3;\n');
  const verdict = await judge(`${other}^`, other);
  assert.equal(verdict.verdict, 'pass');
  assert.ok(verdict.notes.every(note => !note.includes('package typecheck')));
});


test('the scoped declaration gate reports a typed incomplete result when no worker can judge', async t => {
  const { repo, commit } = await workspace(t);
  const tree = await commit('packages/protocol/src/index.ts', 'export const value = 2;\n');
  const env = { ...process.env, HAPPIER_COMMIT_TREE_GATE: 'off', HAPPIER_COMMIT_TYPECHECK_GATE: 'report',
    HAPPIER_COMMIT_TYPECHECK_DIR: join(repo, 'empty-cache'), HAPPIER_COMMIT_TYPECHECK_WORKERS: ' ' };
  const gate = await runCommitGate({ repo, base: `${tree}^`, tree, env, label: 'commit-partial' });
  assert.equal(gate.verdict, 'incomplete');
  assert.deepEqual(gate.reason, { code: 'declaration-comparison-incomplete', packages: ['packages/protocol'] });
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('./commitGate.mjs', import.meta.url)),
    '--label=commit-partial', `--base=${tree}^`, `--tree=${tree}`], { cwd: repo, env, encoding: 'utf8' });
  assert.equal(cli.status, 11, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /"code":"declaration-comparison-incomplete"/u);
});

test('the scoped declaration replay reuses Protocol across unrelated commits and rechecks SDK dependencies', async t => {
  const { repo, commit } = await workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const env = { ...process.env, HAPPIER_COMMIT_TREE_GATE: 'off', HAPPIER_COMMIT_TYPECHECK_GATE: 'report',
    HAPPIER_COMMIT_TYPECHECK_DIR: join(repo, 'empty-cache'), HAPPIER_COMMIT_TYPECHECK_WORKERS: ' ' };
  await commit('packages/plugin-sdk/package.json', JSON.stringify({
    name: '@x/plugin-sdk', dependencies: { '@x/sdk': 'workspace:*' },
  }));
  await commit('packages/plugin-sdk/src/index.ts', 'export const sdk = 1;\n');
  const protocol = 'packages/protocol/src/index.ts';
  const sdk = 'packages/plugin-sdk/src/index.ts';
  const history = async (packetPath, packet, landedPath, landed) => {
    const base = git('rev-parse', 'HEAD');
    const prior = await commit(packetPath, packet);
    await commit(packetPath, git('show', `${base}:${packetPath}`) + '\n');
    const nextBase = await commit(landedPath, landed);
    const tree = await commit(packetPath, packet);
    return { base: nextBase, tree, prior, priorBase: base };
  };
  const run = options => runCommitGate({ repo, env, label: 'commit-partial', cheapOnly: true, ...options });
  const unrelated = await run(await history(protocol, 'export const value = 2;\n',
    'packages/leaf/src/index.ts', 'export const value = 3;\n'));
  assert.equal(unrelated.verdict, 'pass');
  assert.ok(unrelated.notes.every(note => !note.includes('package typecheck')));

  const relevant = await run(await history(sdk, 'export const sdk = 2;\n', protocol, 'export const value = 5;\n'));
  assert.equal(relevant.verdict, 'needs-full', 'SDK reads Protocol through its workspace dependency closure');
  assert.equal(relevant.check, 'package declarations');
  assert.match(relevant.notes.join('\n'), /package typecheck: packages\/plugin-sdk /u);
});

test('the gate reports missing published workspace declarations as incomplete instead of attributing them', async t => {
  const { repo, commit } = await workspace(t);
  await commit('packages/protocol/package.json', JSON.stringify({ name: '@x/protocol', scripts: { typecheck: 'tsc' },
    exports: { './*': { 'happier-source': './src/*.ts', types: './dist/*.d.ts', default: './dist/*.js' } } }));
  const base = await commit('packages/sdk/src/index.ts', 'export const value = 2;\n');
  const tree = await commit('packages/sdk/src/index.ts', 'export const value = 3;\n');
  const head = execFileSync('git', ['rev-parse', `${tree}^{tree}`], { cwd: repo, encoding: 'utf8' }).trim();
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: join(repo, 'declaration-cache') };
  const row = { file: 'packages/sdk/src/index.ts', line: 1, column: 1, code: 7016,
    text: "Could not find a declaration file for module '@x/protocol/index'. '/worker/packages/protocol/dist/index.js' implicitly has an 'any' type." };
  const compare = (text = row.text) => commitGateTypecheck({ repo, base, tree, env, record: false,
    remote: (revisions, dirs) => new Map(revisions.map(id => [id,
      new Map(dirs.map(dir => [dir, id === head ? [{ ...row, text }] : []]))])) });
  const incomplete = await compare();
  assert.deepEqual(incomplete.incomplete, ['packages/sdk']);
  assert.deepEqual(incomplete.fresh, []);
  const sourceError = await compare(row.text.replace('@x/protocol/index', '@x/protocol/missing'));
  assert.equal(sourceError.fresh[0]?.code, 7016, 'an export whose TypeScript source is absent can still be a real regression');
});

test('report mode withholds a verdict when the worker cannot load a declared ambient dependency', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-report-ambient-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  await commit('packages/leaf/package.json', JSON.stringify({ name: '@x/leaf', scripts: { typecheck: 'tsc' },
    devDependencies: { '@types/node': '24.0.0' } }));
  const sha = await commit('packages/leaf/src/index.ts', 'export const value = 42;');
  const source = { file: 'packages/leaf/src/index.ts', line: 1, column: 1, code: 2741,
    text: "Property 'NODE_ENV' is missing in type 'Record<string, string>' but required in type 'ProcessEnv'." };
  const missing = { file: '<global>', line: 0, column: 0, code: 2688,
    text: "Cannot find type definition file for 'node'." };
  const posts = [];
  const options = { repo, env, commit: sha, log: () => {}, post: entry => posts.push(entry), boardPaths: [] };
  const head = execFileSync('git', ['rev-parse', `${sha}^{tree}`], { cwd: repo, encoding: 'utf8' }).trim();
  const compare = diagnose => reportCommitGateTypecheck({ ...options,
    remote: trees => new Map(trees.map(tree => [tree, new Map([['packages/leaf', tree === head ? [source, diagnose] : []]])])) });
  const partial = await compare(missing);
  assert.deepEqual(partial.fresh, []);
  assert.deepEqual(partial.incomplete, ['packages/leaf']);
  assert.deepEqual(posts, []);
  assert.match(readFileSync(join(state, 'verdicts.log'), 'utf8'), /GATE-REPORT-incomplete .*new=0 incomplete=packages\/leaf/u);
  const authored = await compare({ ...missing, text: missing.text.replace('node', 'typo') });
  assert.ok(authored.fresh.some(row => row.code === 2688));
  assert.equal(posts.length, 1);
});
