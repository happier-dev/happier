import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readdir, rm, symlink, watch, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { inspectDependencyRefresh, publishDependencyRefreshMarker } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
import { withWorkspaceBundleLock } from './workspaceBundleLock.mjs';
import { runCommitGate } from './commitGate.mjs';
import { BOARD_PATH } from '../board/postBoardEntry.mjs';
import { attributeRollingRange, commitGateTypecheck, commitGateTypecheckPlan, reportCommitGateTypecheck, drainCommitGateReports, queueCommitGateReport, workerTreeRows, treeDependencyPreparer, treeTypechecker, commitPackageTypecheckRefuses, nextRollingScope, runRollingVerdictRound, commitTypecheckApps, commitTypecheckPackages, packageTypecheckRows, rollingHeadTypecheckPass } from './commitPackageTypecheck.mjs';

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
  const commit = async (path, content, message = `change ${path}`) => {
    await write(path, content);
    git('add', '-A');
    git('commit', '--quiet', '-m', message);
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
    git('commit', '--quiet', '-m', label === 'c2' ? 'c2\n\nLane: LANE-TRAILER' : label);
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
  assert.match(posts[0], /^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC — P03-COMMIT-CHECKS → LANE-TRAILER — URGENT — /mu);
  assert.match(posts[0], new RegExp(c2.slice(0, 11)));
  assert.match(posts[0], /Rolling typecheck.*packages\/leaf\/src\/index\.ts/u);
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

test('an unavailable rolling app comparison preserves its last checked checkpoint', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-rolling-typecheck-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const checkpoint = join(state, 'rolling-head-apps__cli');
  const base = await commit('apps/cli/src/index.ts', 'export const value = 2;');
  let available = true;
  const sides = [];
  const options = { repo, env: { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state },
    scope: 'apps/cli', remote: async (_tree, _dirs, side) => {
      sides.push(side);
      return new Map([['apps/cli', available ? [] : null]]);
    }, log: () => {} };
  await rollingHeadTypecheckPass(options);
  await commit('docs/notes.md', 'unrelated');
  await rollingHeadTypecheckPass(options);
  const head = await commit('apps/cli/src/index.ts', 'export const value = 3;');
  sides.length = 0;
  available = false;
  const failed = await rollingHeadTypecheckPass(options);
  assert.deepEqual(failed.unavailable, ['apps/cli']);
  assert.deepEqual(sides, ['head'], 'an unjudged HEAD needs no historical compile');
  assert.match(readFileSync(join(state, 'verdicts.log'), 'utf8'), /ROLLING-INCOMPLETE scope=apps\/cli .*failure=head:apps\/cli:worker-compile-incomplete/u);
  assert.equal(readFileSync(checkpoint, 'utf8').trim(), base);
  available = true;
  const recovered = await rollingHeadTypecheckPass(options);
  assert.deepEqual(recovered.unavailable, []);
  assert.equal(readFileSync(checkpoint, 'utf8').trim(), head);
  const verdict = readFileSync(join(state, 'verdicts.log'), 'utf8').trimEnd().split('\n').at(-1);
  assert.match(verdict, /ROLLING-ok .*headTree=[0-9a-f]+ diagnostics=0/u);
  assert.doesNotMatch(verdict, /unavailable=/u);
});

test('a legacy false green is replaced only by an exact compiler baseline', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-rolling-typecheck-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const scope = 'apps/cli';
  const checkpoint = join(state, 'rolling-head-apps__cli');
  const base = await commit('apps/cli/src/index.ts', 'export const value = 2;');
  await writeFile(checkpoint, base);
  const log = join(state, 'verdicts.log');
  await writeFile(log, `2026-11-23T10:47:28.490Z ROLLING-ok scope=${scope} base=- head=${base} packages=${scope} new=0 incomplete=- unavailable=${scope} 13742.2s\n`);
  const head = await commit('apps/cli/src/index.ts', 'export const value = 3;');
  const dirs = [];
  let available = false;
  const row = { file: 'apps/cli/src/index.ts', line: 1, column: 1, code: 2322, text: 'worker diagnostic' };
  const options = { repo, env: { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state }, scope, log: () => {},
    remote: (_tree, _dirs, side) => {
      dirs.push(side);
      return new Map([[scope, available && side === 'head' ? [row] : null]]);
    } };
  await rollingHeadTypecheckPass(options);
  assert.equal(readFileSync(checkpoint, 'utf8'), base, 'a second unavailable attempt does not replace the old pointer');
  available = true;
  await rollingHeadTypecheckPass(options);
  assert.deepEqual(dirs, ['head', 'head'], 'the unjudged historical tree cannot be used as a baseline');
  assert.equal(readFileSync(checkpoint, 'utf8'), head);
  assert.match(readFileSync(log, 'utf8'), new RegExp(`ROLLING-BASELINE .*invalidatedBaseline=${base} headTree=[0-9a-f]+ diagnostics=1`, 'u'));
});

test('a missing package baseline produces a typed failure and rebaselines without a historical compile', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-rolling-typecheck-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const checkpoint = join(state, 'rolling-head');
  const base = await commit('packages/leaf/src/index.ts', 'export const value = 2;');
  await writeFile(checkpoint, base);
  const head = await commit('packages/leaf/src/index.ts', 'export const value = 3;');
  const sides = [];
  const options = {
    repo, env: { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state }, log: () => {},
    remote: async (_tree, _dirs, side) => {
      sides.push(side);
      return new Map([['packages/leaf', []]]);
    },
  };
  const result = await rollingHeadTypecheckPass(options);
  assert.deepEqual(sides, ['head']);
  assert.deepEqual(result.unavailable, ['packages/leaf']);
  assert.match(readFileSync(join(state, 'verdicts.log'), 'utf8'), /ROLLING-INCOMPLETE .*failure=base:packages\/leaf:baseline-unavailable/u);
  assert.equal(readFileSync(checkpoint, 'utf8').trim(), head);
  await commit('packages/leaf/src/index.ts', 'export const value = 4;');
  assert.deepEqual((await rollingHeadTypecheckPass(options)).unavailable, []);
  assert.deepEqual(sides, ['head', 'head']);
});

test('a current app result remains usable after its historical comparison was incomplete', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-rolling-typecheck-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const scope = 'apps/cli';
  const base = await commit('apps/cli/src/index.ts', 'export const value = 2;');
  await writeFile(join(state, 'rolling-head-apps__cli'), base);
  await commit('apps/cli/src/index.ts', 'export const value = 3;');
  const options = {
    repo, env: { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state }, scope, log: () => {},
    remote: async () => new Map([[scope, []]]),
  };
  assert.deepEqual((await rollingHeadTypecheckPass(options)).unavailable, [scope]);
  await commit('apps/cli/src/index.ts', 'export const value = 4;');
  assert.deepEqual((await rollingHeadTypecheckPass(options)).unavailable, []);
  const verdict = readFileSync(join(state, 'verdicts.log'), 'utf8').trimEnd().split('\n').at(-1);
  assert.match(verdict, /ROLLING-ok scope=apps\/cli /u);
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

test('a failed app pass yields the next app turn even as HEAD keeps moving', async () => {
  const scopes = ['packages', 'apps/server', 'apps/cli', 'apps/ui'];
  const checkpoints = new Map();
  const order = [];
  let revision = 0;
  await runRollingVerdictRound({
    scopes, head: () => String(revision), recorded: scope => checkpoints.get(scope),
    log: () => {},
    run: (scope, _before, head) => {
      order.push(scope);
      if (order.length === 6) for (const dir of scopes) checkpoints.set(dir, head);
      else {
        if (scope === 'packages') checkpoints.set(scope, head);
        revision += 1;
      }
      return scope === 'packages' ? 0 : 2;
    },
  });
  assert.deepEqual(order, ['packages', 'apps/server', 'packages', 'apps/cli', 'packages', 'apps/ui']);
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
  const broken = await commit('packages/plugins/codex/src/index.ts', 'export const broken: string = 1;\n', 'Introduce type error\n\nLane: OWNER-LANE');
  rowsByTree.set(git('rev-parse', `${broken}^{tree}`), [{ file: 'packages/plugins/codex/src/index.ts', line: 1, column: 14, code: 2322, text: "Type 'number' is not assignable to type 'string'." }]);
  const board = join(state, 'board.md');
  await writeFile(board, `### 2026-11-18 20:00 UTC — LANE-PLUGIN → P03 ORCH — RESULT — x\n- committed ${broken.slice(0, 11)}\n`);
  const posts = [];
  const options = { repo, env, remote, post: entry => posts.push(entry), boardPaths: [board], log: () => {} };
  const red = await reportCommitGateTypecheck({ ...options, commit: broken });
  assert.equal(red.fresh.length, 1);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /^### \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC — P03-COMMIT-CHECKS → OWNER-LANE — URGENT — new type errors from /mu);
  assert.match(posts[0], new RegExp(broken.slice(0, 11)));
  assert.match(posts[0], /Package typecheck.*packages\/plugins\/codex\/src\/index\.ts/u);
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

test('report mode alerts only on pre-cut diagnostics still present in a checked HEAD', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-report-head-diagnostics-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const dir = 'packages/plugins/codex';
  const file = `${dir}/src/index.ts`;
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const treeOf = sha => git('rev-parse', `${sha}^{tree}`);
  const row = (line, code, text) => ({ file, line, column: 1, code, text });
  const introduced = await commit(file, 'export const first = 1;\nexport const second = 2;\n');
  const cut = await commit(file, 'export const first = 3;\nexport const second = 2;\n');
  const checked = await commit(file, 'export const first = 4;\nexport const second = 2;\n');
  const board = join(repo, BOARD_PATH);
  await mkdir(dirname(board), { recursive: true });
  await writeFile(board, `### 2026-11-27 06:01 UTC — Systemic → ALL leads — RULING — cut 54 is NAMED: ${cut.slice(0, 11)} (HEAD at 06:00:00Z)\n`);
  const verdicts = join(state, 'verdicts.log');
  await writeFile(verdicts, `2026-11-27T06:20:00.000Z GATE-REPORT-ok commit=${checked} packages=${dir} new=0 incomplete=- unavailable=- wall=1.0s\n`);
  const headCache = join(state, 'results', treeOf(checked), 'packages__plugins__codex.prepared-declarations.json');
  await mkdir(dirname(headCache), { recursive: true });
  await writeFile(headCache, JSON.stringify({ tree: treeOf(checked), package: dir, rows: [row(2, 2769, 'Current diagnostic text')] }));
  // The latest exact package rows can be from a checked ancestor of the moving HEAD.
  await commit('README.md', 'The live branch advanced again.\n');
  const introducedRows = [row(1, 2322, 'Already fixed'), row(2, 2769, 'Still present')];
  const remote = (trees, dirs) => new Map(trees.map(tree => [
    tree, new Map(dirs.map(pkg => [pkg, tree === treeOf(introduced) ? introducedRows : []])),
  ]));
  const posts = [];
  const options = { repo, env, remote, post: entry => posts.push(entry), log: () => {} };
  await reportCommitGateTypecheck({ ...options, commit: introduced });
  assert.equal(posts.length, 1);
  assert.match(posts[0], /TS2769/u);
  assert.doesNotMatch(posts[0], /TS2322/u);
  assert.match(readFileSync(verdicts, 'utf8'), new RegExp(`introduced at ${introduced}, fixed by HEAD ${checked}.*TS2322`, 'u'));

  await writeFile(headCache, JSON.stringify({ tree: treeOf(checked), package: dir, rows: [] }));
  await reportCommitGateTypecheck({ ...options, commit: introduced });
  assert.equal(posts.length, 1, 'a fully fixed historical diagnostic produces no URGENT');
  await rm(headCache);
  await reportCommitGateTypecheck({ ...options, commit: introduced });
  assert.equal(posts.length, 1, 'missing HEAD rows cannot confirm a current error');
  assert.match(readFileSync(verdicts, 'utf8'), /HEAD unverified.*TS2769/u);

  const recent = await commit(file, 'export const recent = 5;\n');
  const recentRemote = (trees, dirs) => new Map(trees.map(tree => [
    tree, new Map(dirs.map(pkg => [pkg, tree === treeOf(recent) ? [row(1, 2304, 'New since cut')] : []])),
  ]));
  await reportCommitGateTypecheck({ ...options, commit: recent, remote: recentRemote });
  assert.equal(posts.length, 2, 'a post-cut introduction keeps its ordinary alert');
  assert.match(posts[1], /TS2304/u);
});

test('post-commit alerts use the exact Lane trailer and fall back only without one', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-commit-gate-routing-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const path = 'packages/plugins/codex/src/index.ts';
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const withLane = await commit(path, 'export const first: string = 1;\n',
    'Draw the tab row while its detail reads\n\nThe row is visible from first paint.\n\nLane: TRIAGE-ACCEPT-FIX-UI-253');
  const withoutLane = await commit(path, 'export const second: number = false;\n',
    'Change the tab row\n\nMention Lane: ANOTHER-LANE in the body.');
  const diagnostics = new Map([
    [git('rev-parse', `${withLane}^{tree}`), [{ file: path, line: 1, column: 14, code: 2322, text: 'First type error' }]],
    [git('rev-parse', `${withoutLane}^{tree}`), [{ file: path, line: 1, column: 14, code: 2322, text: 'Second type error' }]],
  ]);
  const remote = (trees, dirs) => new Map(trees.map(tree => [tree, new Map(dirs.map(dir => [dir, diagnostics.get(tree) ?? []]))]));
  const posts = [];
  for (const sha of [withLane, withoutLane]) {
    await reportCommitGateTypecheck({ repo, env, commit: sha, remote, log: () => {}, post: entry => posts.push(entry) });
  }
  assert.deepEqual(posts.map(entry => entry.split('\n')[0].split(' — ')[1]), [
    'P03-COMMIT-CHECKS → TRIAGE-ACCEPT-FIX-UI-253',
    'P03-COMMIT-CHECKS → P03 ORCH',
  ]);
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
  await appendFile(log, verdict(head, '-').replace(' incomplete=- unavailable=-', ''));
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

test('warm exact-tree compilation pins declaration imports to the selected tree', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-commit-typecheck-pin-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const input = 'packages/leaf/src/toolingInput.mjs';
  const first = await commit(input, "export default 'old';\n");
  const pinModule = new URL('../../apps/stack/bin/localToolingPackagePin.mjs', import.meta.url).href;
  const observed = [];
  const env = { ...process.env, HAPPIER_STACK_TOOLING_PACKAGES: 'pinned' };
  const { rowsAt } = treeTypechecker({ repo, state, env, log: () => {}, bootstrap: () => {},
    compile: worktree => {
      const pinned = execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { registerToolingPackagePin } = await import(process.argv[1]);
        registerToolingPackagePin({ repoDir: process.cwd() });
        console.log((await import(process.argv[2])).default);
      `, pinModule, pathToFileURL(join(worktree, input)).href], { cwd: worktree, env, encoding: 'utf8' }).trim();
      observed.push(pinned);
      return { rows: [], ms: 0 };
    },
  });
  rowsAt(git(repo, 'rev-parse', `${first}^{tree}`), ['packages/leaf'], 'base');

  // A packet can supply a tree before it has a commit.
  await writeFile(join(repo, input), "export default 'selected';\n");
  git(repo, 'add', '--', input);
  const candidate = git(repo, 'write-tree');
  rowsAt(candidate, ['packages/leaf'], 'head');
  assert.deepEqual(observed, ['old', 'selected']);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), first);
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

test('a rolling attempt publishes a typed failure after one worker dispatch without rows', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-commit-gate-fallback-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  await commit('apps/cli/src/index.ts', 'export const value = 41;\n');
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
      return { status: 0, signal: null, stdout: `HAPPIER_ROLLING_ROWS ${JSON.stringify({ [tree]: { 'apps/cli': [] } })}\n` };
    },
  };
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const scope = 'apps/cli';
  const remote = workerTreeRows({ repo, state, env, scope, workers: ['nl3', 'nl1'], transport, log: () => {} });
  await rollingHeadTypecheckPass({ repo, env, scope, remote, log: () => {} });
  assert.deepEqual(dispatched, ['nl3']);
  assert.match(readFileSync(join(state, 'verdicts.log'), 'utf8'),
    /ROLLING-INCOMPLETE .*failure=head:apps\/cli:worker-no-rows/u);
});

test('a rolling worker declaration failure retains its typed stage in the verdict', async t => {
  const { repo, commit } = await workspace(t);
  const state = await mkdtemp(join(tmpdir(), 'happier-commit-typed-failure-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  await commit('apps/cli/src/index.ts', 'export const value = 41;');
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const transport = {
    ssh: worker => ({ alias: worker, config: '/dev/null' }),
    push: () => ({ status: 0 }),
    listRefs: () => '',
    dispatch: (_worker, args) => {
      const tree = args.find(arg => arg.startsWith('--tree=')).slice(7);
      const envelope = { [tree]: { 'apps/cli': { failure: 'declaration-preparation:UNKNOWN' } } };
      return { status: 0, stdout: `HAPPIER_ROLLING_ROWS ${JSON.stringify(envelope)}\n` };
    },
  };
  const scope = 'apps/cli';
  const remote = workerTreeRows({ repo, state, env, scope, workers: ['nl1'], transport, log: () => {} });
  await rollingHeadTypecheckPass({ repo, env, scope, remote, log: () => {} });
  assert.match(readFileSync(join(state, 'verdicts.log'), 'utf8'),
    /ROLLING-INCOMPLETE .*failure=head:apps\/cli:declaration-preparation:UNKNOWN/u);
});

async function exactTreeWorkerFixture(t) {
  const { repo, commit } = await workspace(t);
  const source = fileURLToPath(new URL('../../', import.meta.url));
  const workerHome = join(repo, 'worker-home');
  const state = join(repo, '.git/typecheck-state');
  const bin = join(repo, 'bin');
  const config = join(repo, 'ssh.conf');
  const mirrorLog = join(repo, 'mirror.log');
  const admissionLog = join(repo, 'worker-admission.log');
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
    'apps/stack/scripts/utils/fs/fs.mjs',
    'apps/stack/scripts/utils/dev_targets/native_execution_signals.sh',
    'apps/stack/scripts/utils/proc/admission_memory.mjs',
    'apps/stack/scripts/utils/proc/native_process_identity.sh',
    'apps/stack/scripts/utils/proc/runtimeImportProbe.mjs',
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
if [ "$1" = --execution-workers-with-memory-floor=gate-package-typecheck ] || [ "$1" = --execution-workers-with-memory-floor=compilation ]; then
  printf '%s\\0' test-worker configured-worker ${JSON.stringify(config)} ${JSON.stringify(workerHome)} '' 31457280
  exit 0
fi
if [ "$1" = --heavyweight-admission ]; then
  [ "\${HAPPIER_ADMISSION_AUTO_HOST_MEMORY_FLOOR_KIB-}" = 31457280 ] || exit 93
  case "$2" in --class=dependency-install|--class=gate-package-typecheck|--class=compilation|--class=compilation-ui-tsrs|--class=compilation-ui|--class=compilation-cli|--class=compilation-server) ;; *) exit 94;; esac
  export FIXTURE_WORKER_CLASS="\${2#--class=}"
  printf 'admit %s\\n' "$FIXTURE_WORKER_CLASS" >> ${JSON.stringify(admissionLog)}
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
import { appendFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
appendFileSync(${JSON.stringify(admissionLog)}, 'prepare ' + process.env.FIXTURE_WORKER_CLASS + '\\n');
mkdirSync('node_modules', { recursive: true });
if (!existsSync('node_modules/typescript')) symlinkSync(${JSON.stringify(dirname(createRequire(import.meta.url).resolve('typescript/package.json')))}, 'node_modules/typescript', 'dir');
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

  return { repo, state, workerHome, bin, sha, treeId, write, git, source, admissionLog, script, result };
}

test('an exact-tree worker reads the Git payload even when the source mirror cannot flush', { skip: process.platform === 'win32' }, async t => {
  const { repo, state, workerHome, bin, sha, treeId, write, git, source, admissionLog } = await exactTreeWorkerFixture(t);
  // Keep the authored sources fixed and change their dependency generation between two jobs.
  await write('scripts/workspaces/commitGateTypecheck.mjs', readFileSync(join(source, 'scripts/workspaces/commitGateTypecheck.mjs')));
  await write('packages/protocol/src/index.ts', 'export const value = 41;\n');
  await write('packages/protocol/package.json', JSON.stringify({ name: '@x/protocol', version: '2.0.0', scripts: { typecheck: 'tsc' } }));
  git('add', '--', 'packages/protocol');
  git('commit', '--quiet', '-m', 'different dependency generation');
  const nextTree = git('rev-parse', 'HEAD^{tree}');
  await writeFile(admissionLog, '');
  const multiScript = `
    import { workerTreeRows } from ${JSON.stringify(new URL('./commitPackageTypecheck.mjs', import.meta.url).href)};
    const rows = await workerTreeRows({ repo: process.cwd(), state: ${JSON.stringify(state)}, lane: 'gate',
      entry: 'scripts/workspaces/commitGateTypecheck.mjs' })(${JSON.stringify([treeId, nextTree])},
      ['packages/protocol'], ['base', 'head']);
    console.log(JSON.stringify([...rows].map(([tree, byPackage]) => [tree, byPackage.get('packages/protocol')])));
  `;
  const multi = spawnSync(process.execPath, ['--input-type=module', '-e', multiScript], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_SSH_VARIANT: 'ssh', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(multi.status, 0, multi.stderr);
  assert.deepEqual(JSON.parse(multi.stdout).map(([tree, rows]) => [tree, rows?.map(row => row.code)]),
    [[treeId, [9007]], [nextTree, [9007]]], multi.stderr);
  assert.deepEqual(readFileSync(admissionLog, 'utf8').trim().split('\n'), [
    'admit gate-package-typecheck',
    'admit dependency-install',
    'prepare dependency-install',
    'admit gate-package-typecheck',
  ]);
});

test('dependency-free archived app workers use prepared compiler admission classes while gates retain their class', { skip: process.platform === 'win32' }, async t => {
  const { repo, state, bin, write, git, admissionLog } = await exactTreeWorkerFixture(t);
  assert.match(readFileSync(admissionLog, 'utf8'), /admit gate-package-typecheck/u);
  // Ship the real selector and its relative module closure. Dependencies exist
  // only in the prepared judged worktree, never in the archived tooling root.
  const source = fileURLToPath(new URL('../../', import.meta.url));
  const { preProcessFile } = createRequire(import.meta.url)('typescript');
  const copied = new Set();
  const copyModule = async path => {
    if (copied.has(path)) return;
    copied.add(path);
    const contents = readFileSync(join(source, path), 'utf8');
    await write(path, contents);
    for (const { fileName } of preProcessFile(contents).importedFiles) {
      if (fileName.startsWith('.') && existsSync(join(source, dirname(path), fileName))) {
        await copyModule(join(dirname(path), fileName));
      }
    }
  };
  await copyModule('scripts/workspaces/resolveTypeScriptCliInvocation.mjs');
  await write('apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs', `
import { symlinkSync } from 'node:fs';
symlinkSync(${JSON.stringify(join(source, 'node_modules'))}, 'node_modules', 'dir');
`);
  git('add', '--', ...copied, 'apps/stack/scripts/utils/dev_targets/remote_dependency_bootstrap.mjs');
  for (const app of ['ui', 'cli', 'server']) {
    await write(`apps/${app}/package.json`, JSON.stringify({ name: `@fixture/${app}`, scripts: {
      'typecheck:source:finite': 'node ../../scripts/workspaces/runTypeScriptCli.mjs -p tsconfig.json',
    } }));
    await write(`apps/${app}/tsconfig.json`, JSON.stringify({ compilerOptions: { noEmit: true } }));
    await write(`apps/${app}/src/index.ts`, 'export const value = 41;');
  }
  git('add', '--', 'apps', 'scripts/workspaces/resolveTypeScriptCliInvocation.mjs');
  git('commit', '--quiet', '-m', 'app compiler inputs');
  const tree = git('rev-parse', 'HEAD^{tree}');
  for (const [scope, compiler, expected] of [
    ['apps/ui', 'tsrs', 'compilation-ui-tsrs'],
    ['apps/ui', 'microsoft', 'compilation-ui'],
    ['apps/cli', 'tsrs', 'compilation-cli'],
    ['apps/server', 'tsrs', 'compilation-server'],
  ]) {
    await writeFile(admissionLog, '');
    const script = `
      import { workerTreeRows } from ${JSON.stringify(new URL('./commitPackageTypecheck.mjs', import.meta.url).href)};
      const rows = await workerTreeRows({ repo: process.cwd(), state: ${JSON.stringify(state)}, lane: 'named',
        scope: ${JSON.stringify(scope)}, entry: 'scripts/workspaces/commitGateTypecheck.mjs' })(${JSON.stringify(tree)}, [${JSON.stringify(scope)}], 'head');
      console.log(JSON.stringify([...rows]));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_SSH_VARIANT: 'ssh', PATH: `${bin}:${process.env.PATH}`,
        HAPPIER_TYPESCRIPT_COMPILER: compiler },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [[scope, []]], result.stderr);
    const admissions = readFileSync(admissionLog, 'utf8').trim().split('\n').filter(line => line.startsWith('admit ') && line !== 'admit dependency-install');
    assert.deepEqual(admissions, [`admit ${expected}`], `${scope} ${compiler}`);
  }
});

test('a one-shot exact-tree worker retires its outputs after returning rows', { skip: process.platform === 'win32' }, async t => {
  const { repo, workerHome, bin, script, result } = await exactTreeWorkerFixture(t);
  const ephemeralScript = script.replace("lane: 'gate'", "lane: 'adhoc'");
  const ephemeral = spawnSync(process.execPath, ['--input-type=module', '-e', ephemeralScript], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_SSH_VARIANT: 'ssh', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(ephemeral.status, 0, ephemeral.stderr);
  assert.deepEqual(JSON.parse(ephemeral.stdout), JSON.parse(result.stdout));
  const workerState = join(workerHome, '.happier-stack/cache/commit-typecheck-worker/typecheck-state');
  for (const name of ['worktree', 'declarations', 'results']) {
    assert.equal(existsSync(join(workerState, 'lane-adhoc', name)), false, name);
  }
  assert.equal(existsSync(join(workerState, 'lane-gate', 'worktree')), true);
});

async function controllerDeclarationFixture(t, { lockfile } = {}) {
  const { repo, commit } = await workspace(t);
  const state = join(repo, '.git/controller-typecheck');
  const tsDir = dirname(createRequire(import.meta.url).resolve('typescript/package.json'));
  const write = async (name, contents, mode) => {
    const path = join(repo, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { mode });
  };
  await write('package.json', JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }));
  await write('apps/stack/scripts/perf/entry-graphs.mjs',
    "export const ENTRY_GRAPHS = [{ id: 'cli', entry: 'apps/cli/src/index.ts' }];\n");
  await write('packages/protocol/tsconfig.json', JSON.stringify({ compilerOptions: { declaration: true } }));
  if (lockfile) {
    await write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
    await write('pnpm-lock.yaml', lockfile);
  }
  const entry = fileURLToPath(new URL('./commitGateTypecheck.mjs', import.meta.url));
  await write('apps/stack/bin/hstack-exec', `#!/bin/sh
case "$1" in --execution-workers*) exit 0;; esac
[ "$1" = --heavyweight-admission ] && [ "$2" = --class=gate-declaration-comparison ] || exit 95
printf '%s\n' "$@" > "${repo}/admissions"
while [ "$1" != -- ]; do shift; done
shift
[ "$2" = scripts/workspaces/commitGateTypecheck.mjs ] || exit 96
shift 2
exec "${process.execPath}" "${entry}" "$@"
`, 0o755);
  await write('scripts/workspaces/runTypeScriptCli.mjs', `
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shouldRouteTypeScriptCliThroughHstack } from ${JSON.stringify(new URL('./resolveTypeScriptCliInvocation.mjs', import.meta.url).href)};
if (shouldRouteTypeScriptCliThroughHstack({ args: process.argv.slice(2), env: process.env })) process.exit(98);
const source = readFileSync('src/index.ts', 'utf8');
if (process.env.TEST_DECLARATION_COMPILER === 'fail') process.exit(99);
if (process.env.TEST_DECLARATION_COMPILER === 'wait') {
  writeFileSync(process.env.TEST_DECLARATION_READY, String(process.pid));
  await new Promise(done => setTimeout(done, 8000));
}
const comparison = resolve(process.cwd(), '../../../..');
if (readdirSync(comparison).length !== 1) throw new Error('parent and candidate trees occupy disk at the same time');
if (source.includes('= 99')) process.exit(97);
if (source.includes('from-new-workspace')) {
  const selected = readFileSync('node_modules/@happier-dev/new-package/src/index.ts', 'utf8');
  if (!selected.includes('= 41')) process.exit(94);
}
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
  if (lockfile) await write('node_modules/.pnpm/lock.yaml', lockfile);
  const { installIdentity } = await inspectDependencyRefresh({ installDir: repo });
  await publishDependencyRefreshMarker({ installDir: repo, identity: installIdentity });
  const scratch = join(repo, 'comparison-scratch');
  await mkdir(scratch);
  const env = { ...process.env, TMPDIR: scratch, P03_GATE_CACHE: join(repo, '.git', 'gate'),
    HAPPIER_COMMIT_TYPECHECK_DIR: state, HAPPIER_COMMIT_TYPECHECK_WORKERS: ' ' };
  // This gate starts directly, outside the routed test runner's placement.
  for (const marker of ['HAPPIER_HSTACK_EXECUTION', 'HAPPIER_DEV_TARGET_EXECUTION', 'HAPPIER_TYPECHECK_DISPATCHED', 'HAPPIER_HEAVYWEIGHT_ADMISSION_TOKEN']) delete env[marker];
  const request = {
    repo, trees: [git('rev-parse', `${candidate}^^{tree}`), git('rev-parse', `${candidate}^{tree}`)],
    packages: ['packages/protocol'], sides: ['base', 'head'],
  };
  return { repo, candidate, scratch, env, git, write, request };
}

test('the controller declaration gate admits and judges both Git trees with its installed toolchain', { skip: process.platform === 'win32' }, async t => {
  const { repo, candidate, scratch, env, request } = await controllerDeclarationFixture(t);
  const result = await commitGateTypecheck({ repo, base: `${candidate}^`, tree: candidate,
    env, packages: request.packages });
  assert.deepEqual([result.incomplete, result.unavailable], [[], []]);
  assert.deepEqual(result.fresh.map(row => [row.package, row.code]), [['packages/protocol', 9007]]);
  assert.ok(readFileSync(join(repo, 'admissions'), 'utf8').includes(`--judged-trees=${request.trees.join(',')}`));
  assert.deepEqual(await readdir(scratch), []);
});

test('the synchronous gate loads the CLI without admitting a declaration comparison', { skip: process.platform === 'win32' }, async t => {
  const { repo, candidate, scratch, env } = await controllerDeclarationFixture(t);
  const checked = [];
  const result = await runCommitGate({ repo, base: `${candidate}^`, tree: candidate, env, label: 'commit-partial',
    // Stub the admitted entry-load process. The real gate selects it from the candidate registry.
    compareAdmittedEntryLoads: async ({ selected }) => {
      checked.push(...selected);
      return { findings: [], preexisting: [], results: selected.map(graph => ({ graph, status: 'passed' })), timings: {} };
    },
  });
  assert.equal(result.verdict, 'pass', JSON.stringify(result));
  assert.deepEqual(checked, ['cli']);
  assert.equal(existsSync(join(repo, 'admissions')), false);
  assert.deepEqual(await readdir(scratch), []);
});

test('the declaration gate links a newly added workspace and counts its diagnostics against an empty parent', { skip: process.platform === 'win32' }, async t => {
  const lock = "lockfileVersion: '9.0'\nimporters:\n  .: {}\n";
  const { candidate: base, repo, env, git, write } = await controllerDeclarationFixture(t, { lockfile: lock });
  await write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n  - packages/new-package\n');
  await write('pnpm-lock.yaml', lock + "  packages/protocol:\n    dependencies:\n      '@happier-dev/new-package':\n        specifier: workspace:*\n        version: link:../new-package\n  packages/new-package: {}\n");
  await write('packages/protocol/package.json', JSON.stringify({
    name: '@x/protocol', scripts: { typecheck: 'tsc' }, dependencies: { '@happier-dev/new-package': 'workspace:*' },
  }));
  await write('packages/protocol/src/index.ts', 'export const probe = "from-new-workspace";\n');
  await write('packages/new-package/package.json', JSON.stringify({ name: '@happier-dev/new-package', scripts: { typecheck: 'tsc' } }));
  await write('packages/new-package/tsconfig.json', JSON.stringify({ compilerOptions: { declaration: true } }));
  await write('packages/new-package/src/index.ts', 'export const added = 41;\n');
  git('add', '-A');
  git('commit', '-qm', 'add workspace');
  const tree = git('rev-parse', 'HEAD');
  await write('packages/new-package/src/index.ts', 'export const added = 99;\n');
  const result = await commitGateTypecheck({ repo, base, tree, env, packages: ['packages/protocol', 'packages/new-package'] });
  assert.deepEqual(result.incomplete, []);
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.fresh.map(row => [row.package, row.code]), [['packages/new-package', 9007]]);
});

test('the declaration gate reuses only the published external dependency closure', { skip: process.platform === 'win32' }, async t => {
  const lock = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      probe:
        specifier: 1.0.0
        version: 1.0.0
packages:
  probe@1.0.0:
    resolution: {integrity: fixture-probe}
  child@1.0.0:
    resolution: {integrity: fixture-child}
  unrelated@1.0.0:
    resolution: {integrity: fixture-unrelated}
snapshots:
  probe@1.0.0:
    dependencies:
      child: 1.0.0
  child@1.0.0: {}
  unrelated@1.0.0: {}
`;
  const { candidate: base, repo, env, git, write } = await controllerDeclarationFixture(t, { lockfile: lock });
  await write('pnpm-lock.yaml', lock.replace('fixture-unrelated', 'changed-unrelated'));
  git('add', 'pnpm-lock.yaml');
  git('commit', '-qm', 'unrelated resolution');
  const unrelatedTree = git('rev-parse', 'HEAD');
  const unaffected = await commitGateTypecheck({ repo, base, tree: unrelatedTree, env, packages: ['packages/protocol'] });
  assert.deepEqual([unaffected.incomplete, unaffected.unavailable], [[], []]);
  assert.deepEqual(unaffected.fresh, []);

  await write('pnpm-lock.yaml', lock.replace('fixture-child', 'changed-child'));
  git('add', 'pnpm-lock.yaml');
  git('commit', '-qm', 'changed transitive resolution');
  const changedTree = git('rev-parse', 'HEAD');
  const changed = await commitGateTypecheck({ repo, base, tree: changedTree, env, packages: ['packages/protocol'] });
  assert.deepEqual(changed.unavailable, ['packages/protocol']);
});

test('the controller compiler accepts a queued request without a scratch path and removes its own scratch', { skip: process.platform === 'win32' }, async t => {
  const { repo, scratch, env, request } = await controllerDeclarationFixture(t);
  const entry = fileURLToPath(new URL('./commitGateTypecheck.mjs', import.meta.url));
  const stdout = execFileSync(process.execPath, [entry, '--compiler-admitted'], {
    cwd: repo, encoding: 'utf8',
    env: { ...env, HAPPIER_COMMIT_TYPECHECK_CONTROLLER_REQUEST: JSON.stringify(request) },
  });
  assert.match(stdout, /9007/u);
  assert.deepEqual(await readdir(scratch), []);
});

test('controller declaration scratch is removed on failure and after cancellation', { skip: process.platform === 'win32', timeout: 20_000 }, async t => {
  const { repo, scratch, env, request } = await controllerDeclarationFixture(t);
  const command = [fileURLToPath(new URL('./commitGateTypecheck.mjs', import.meta.url)), '--compiler-admitted'];
  const childEnv = { ...env, HAPPIER_COMMIT_TYPECHECK_CONTROLLER_REQUEST: JSON.stringify(request) };
  const failed = spawnSync(process.execPath, command, { cwd: repo, encoding: 'utf8', timeout: 8_000,
    env: { ...childEnv, TEST_DECLARATION_COMPILER: 'fail' } });
  assert.equal(failed.status, 2, failed.stderr + failed.stdout);
  assert.deepEqual(await readdir(scratch), []);

  const ready = join(repo, 'comparison-started');
  const events = watch(repo, { signal: t.signal });
  const started = (async () => {
    for await (const event of events) {
      if (event.filename === 'comparison-started' && existsSync(ready)) return;
    }
  })();
  const child = spawn(process.execPath, command, { cwd: repo, stdio: 'ignore',
    env: { ...childEnv, TEST_DECLARATION_COMPILER: 'wait', TEST_DECLARATION_READY: ready } });
  const ended = once(child, 'close');
  t.after(() => child.kill());
  try {
    const running = await Promise.race([started.then(() => true), ended.then(() => false)]);
    assert(running && existsSync(ready), 'the compiler reached an active exact scratch tree');
    child.kill('SIGTERM');
    await ended;
    assert.deepEqual(await readdir(scratch), [], 'cancelled comparison removed its exact-tree scratch before returning');
  } finally {
    await events.return();
    // Also retire the fixture leaf when this test runs against the pre-fix process owner.
    if (existsSync(ready)) {
      try { process.kill(Number(readFileSync(ready, 'utf8')), 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  }
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


test('a failed broader check reports the exact landed SHA for a fix forward', { skip: process.platform === 'win32' }, async t => {
  const { repo, commit } = await workspace(t);
  const runner = join(repo, 'scripts/workspaces/runCommitPostChecks.sh');
  await mkdir(dirname(runner), { recursive: true });
  // The shell check is a process boundary. Exercise the real post-commit queue and reporter.
  await writeFile(runner, 'printf "%s\\n" "$1" "$2" > replayed\nprintf "HAPPIER_POST_COMMIT_FAILURE\\tExport scan\\tpackages/leaf/src/index.ts\\n"\nexit 10\n');
  const sha = await commit('packages/leaf/src/index.ts', 'export const value = 42;\n');
  const base = execFileSync('git', ['rev-parse', `${sha}^`], { cwd: repo, encoding: 'utf8' }).trim();
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: join(repo, '.git/typecheck-state') };
  const posts = [];
  queueCommitGateReport({ repo, env, commit: sha });
  const remote = (trees, dirs) => new Map(trees.map(tree => [tree, new Map(dirs.map(dir => [dir, []]))]));
  const drained = await drainCommitGateReports({
    repo, env, workerCandidates: ['nl1'], remote, post: entry => posts.push(entry), boardPaths: [],
  });
  assert.deepEqual(drained, [sha]);
  assert.equal(readFileSync(join(repo, 'replayed'), 'utf8'), `${base}\n${sha}\n`);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /→ P03 ORCH — URGENT/u);
  assert.match(posts[0], /Package Typecheck Test for a fix forward/u);
  assert.match(posts[0], /Export scan.*packages\/leaf\/src\/index\.ts/u);
  assert.ok(posts[0].includes(sha));
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), sha);
});

test('broad replay alerts for a pre-cut failure only when the latest checked HEAD still has it', { skip: process.platform === 'win32' }, async t => {
  const { repo, commit } = await workspace(t);
  const file = 'apps/cli/src/index.ts';
  const historical = await commit(file, 'export const old = 1;\n');
  const cut = await commit(file, 'export const cut = 2;\n');
  const checkedHead = await commit(file, 'export const head = 3;\n');
  await commit('README.md', 'Live HEAD advances beyond the checked revision.\n');
  const board = join(repo, BOARD_PATH);
  await mkdir(dirname(board), { recursive: true });
  await writeFile(board, `### 2026-11-27 06:01 UTC — Systemic → ALL leads — RULING — cut 54 is NAMED: ${cut.slice(0, 11)}\n`);
  const runner = join(repo, 'scripts/workspaces/runCommitPostChecks.sh');
  await mkdir(dirname(runner), { recursive: true });
  await writeFile(runner, `if [ "$2" = "${checkedHead}" ]; then
  cat head-report
  exit 0
fi
cat failure
exit 10
`);
  const state = join(repo, '.git/typecheck-state');
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  const posts = [];
  const verdicts = () => readFileSync(join(state, 'verdicts.log'), 'utf8');
  const replay = async sha => {
    queueCommitGateReport({ repo, env, commit: sha });
    assert.deepEqual(await drainCommitGateReports({
      repo, env, workerCandidates: ['nl1'], post: entry => posts.push(entry), log: () => {},
    }), [sha]);
  };

  await writeFile(join(repo, 'failure'), `HAPPIER_POST_COMMIT_FAILURE\tExport scan\t${file}\t${file}\tmissingExport\n`);
  await replay(historical);
  assert.deepEqual(posts, [], 'an unchecked HEAD cannot confirm the historical failure');
  assert.match(verdicts(), new RegExp(`introduced at ${historical}, HEAD unverified`, 'u'));
  await writeFile(join(repo, 'head-report'), `HAPPIER_POST_COMMIT_CHECK\tExport scan\nHAPPIER_POST_COMMIT_CHECK\tExport scan\t${file}\tunrelatedExport\n`);
  await replay(checkedHead);
  await replay(historical);
  assert.deepEqual(posts, [], 'an unrelated failure in the same check does not keep the old alert alive');
  assert.match(verdicts(), new RegExp(`introduced at ${historical}, fixed by HEAD ${checkedHead}.*Export scan`, 'u'));

  await writeFile(join(repo, 'head-report'), `HAPPIER_POST_COMMIT_CHECK\tExport scan\nHAPPIER_POST_COMMIT_CHECK\tExport scan\t${file}\tmissingExport\n`);
  await replay(checkedHead);
  await replay(historical);
  assert.equal(posts.length, 1, 'an inherited failure still present at HEAD justifies an alert');
  assert.ok(posts[0].includes(historical));
  assert.ok(posts[0].includes(checkedHead));
  await replay(cut);
  assert.equal(posts.length, 2, 'reports at the cut retain immediate alerts');
  assert.ok(posts[1].includes(cut));

  await writeFile(join(repo, 'failure'), `HAPPIER_POST_COMMIT_FAILURE\tEntry load (catalog)\t${file}\n`);
  await writeFile(join(repo, 'head-report'), 'HAPPIER_POST_COMMIT_CHECK\tEntry load (daemon)\n');
  await replay(checkedHead);
  await replay(historical);
  assert.equal(posts.length, 2, 'the latest report skipped the failing graph');
  assert.match(verdicts().trim().split('\n').at(-1), /HEAD unverified.*Entry load \(catalog\)/u);
  await writeFile(join(repo, 'head-report'), 'HAPPIER_POST_COMMIT_CHECK\tEntry load (catalog)\n');
  await replay(checkedHead);
  await replay(historical);
  assert.equal(posts.length, 2, 'the same graph passed at the checked HEAD');
  assert.match(verdicts().trim().split('\n').at(-1), /fixed by HEAD.*Entry load \(catalog\)/u);
});

test('Protocol and SDK declaration diagnostics are fix-forward reports after landing, regardless of a legacy block setting', async t => {
  const { repo, commit } = await workspace(t);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('rm', '-r', '--quiet', '--', 'apps/cli');
  git('commit', '--quiet', '-m', 'remove fixture CLI for declaration-only check');
  const state = join(repo, '.git/typecheck-state');
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state,
    HAPPIER_COMMIT_TYPECHECK_GATE: 'block', HAPPIER_COMMIT_TYPECHECK_WORKERS: ' ' };
  await commit('packages/plugin-sdk/package.json', JSON.stringify({ name: '@x/plugin-sdk', scripts: { typecheck: 'tsc' } }));
  await commit('packages/plugin-sdk/src/index.ts', 'export function api(): number { return 0; }\n');
  for (const dir of ['packages/protocol', 'packages/plugin-sdk']) {
    await commit(`${dir}/tsconfig.json`, JSON.stringify({ compilerOptions: { declaration: true, isolatedDeclarations: true } }));
    const file = `${dir}/src/index.ts`;
    const base = await commit(file, 'export function api(): number { return 1; }\n');
    const tree = await commit(file, 'export function api() { return 1; }\n');
    const diagnostic = { file, line: 1, column: 17, code: 9007, text: 'Function must have an explicit return type annotation.' };
    for (const [rev, rows] of [[base, []], [tree, [diagnostic]]]) {
      const resultDir = join(state, 'results', git('rev-parse', `${rev}^{tree}`));
      await mkdir(resultDir, { recursive: true });
      await writeFile(join(resultDir, `${dir.replaceAll('/', '__')}.prepared-declarations.json`), JSON.stringify({ rows }));
    }
    await writeFile(join(state, 'verdicts.log'), `2026-11-21T00:00:00.000Z ROLLING-ok scope=packages base=${base} head=${tree} packages=${dir} new=0 incomplete=- unavailable=- 1.0s\n`, { flag: 'a' });
    const verdict = await runCommitGate({ repo, base, tree, env, label: 'commit-partial' });
    assert.equal(verdict.verdict, 'pass', dir);
    const posts = [];
    const report = await reportCommitGateTypecheck({ repo, commit: tree, env, post: entry => posts.push(entry) });
    assert.equal(report.fresh[0]?.code, 9007, dir);
    assert.equal(posts.length, 1);
    assert.match(posts[0], /TS9007/u);
    assert.equal(git('rev-parse', 'HEAD'), tree);
  }
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

test('a declared workspace TS2307 with a missing build output is an environment verdict', async t => {
  const { repo, commit } = await workspace(t);
  const state = join(repo, '.fixture-state');
  const env = { ...process.env, HAPPIER_COMMIT_TYPECHECK_DIR: state };
  await commit('packages/protocol/package.json', JSON.stringify({ name: '@x/protocol',
    exports: { '.': { 'happier-source': './src/index.ts', types: './dist/index.d.ts' } } }));
  const sha = await commit('packages/sdk/src/index.ts', "import { value } from '@x/protocol';\nexport { value };\n");
  const head = execFileSync('git', ['rev-parse', `${sha}^{tree}`], { cwd: repo, encoding: 'utf8' }).trim();
  const row = specifier => ({ file: 'packages/sdk/src/index.ts', line: 1, column: 23, code: 2307,
    text: `Cannot find module '${specifier}' or its corresponding type declarations.` });
  const posts = [];
  const check = async specifier => {
    // The compiler is the system boundary. The exact trees, publication files,
    // cache and report are handled by their owners.
    const checker = treeTypechecker({ repo, state, env, capturedWorktree: repo, log: () => {},
      compile: () => ({ rows: [row(specifier)], ms: 0 }) });
    return reportCommitGateTypecheck({ repo, commit: sha, env, log: () => {}, post: entry => posts.push(entry),
      remote: trees => new Map(trees.map(tree => [tree,
        tree === head ? checker.rowsAt(tree, ['packages/sdk']) : new Map([['packages/sdk', []]])])) });
  };

  const result = await check('@x/protocol');
  assert.deepEqual(result.fresh, []);
  assert.deepEqual(result.unavailable, ['packages/sdk']);
  assert.deepEqual(posts, []);
  assert.match(readFileSync(join(state, 'verdicts.log'), 'utf8'), /GATE-REPORT-environment .*environment: missing workspace build output/u);
  const output = join(repo, 'packages', 'protocol', 'dist');
  await mkdir(output);
  await writeFile(join(output, 'index.d.ts'), 'export declare const value: number;\n');
  assert.equal((await check('@x/protocol')).fresh[0]?.code, 2307, 'a present export requires investigation');
  assert.equal(posts.length, 1);
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
