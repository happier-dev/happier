import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTypecheckDiagnosticRun, typecheckDiagnosticFailureIdentifier } from './typecheckDiagnostics.mjs';

// Captured on windows2-linux, 2026-10-24, through the shared compiler selector:
// tsrs and @typescript/native both exited 2 for `const value: number = "wrong";`.
const compilerDiagnostic = "input.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'happier-typecheck-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'apps', 'sample');
  await mkdir(cwd, { recursive: true });
  await writeFile(join(root, '.gitignore'), 'node_modules/\n');
  await writeFile(join(cwd, 'package.json'), '{"name":"sample"}');
  await writeFile(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}');
  await writeFile(join(cwd, 'input.ts'), 'export const value = 1;\n');
  await writeFile(join(cwd, 'other.ts'), 'export const other = 1;\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const project = { project: 'tsconfig.json', authoredProject: 'tsconfig.json', authoredArgs: ['--noEmit', '-p', 'tsconfig.json'] };
  const options = { repoRoot: root, cwd, projects: [project] };
  const finish = async (stdout, status = 2, overrides = {}) => {
    const run = await createTypecheckDiagnosticRun({ ...options, ...overrides });
    run.record(project, { stdout, stderr: '', status, signal: null });
    return await run.publish();
  };
  return { root, cwd, project, options, git, finish };
}

test('diagnostics delta retains full verdict, then attributes staged, unstaged and untracked locations', async t => {
  const f = await fixture(t);
  const first = await f.finish(compilerDiagnostic);
  assert.equal(first.length, 1, 'a completed package run must publish a diagnostic snapshot');
  assert.equal(first[0].baseline, false);
  await writeFile(join(f.cwd, 'input.ts'), 'export const value = 2;\n');
  f.git('add', 'apps/sample/input.ts');
  await writeFile(join(f.cwd, 'other.ts'), 'export const other = 2;\n');
  await writeFile(join(f.cwd, 'new.ts'), 'export const created = 2;\n');
  const next = await f.finish(compilerDiagnostic
    + compilerDiagnostic.replace('input.ts(1,7)', 'input.ts(2,7)')
    + compilerDiagnostic.replace('input.ts', 'other.ts')
    + compilerDiagnostic.replace('input.ts', 'new.ts'));
  assert.equal(next[0].newInTouchedPaths, 3);
  assert.equal(next[0].baseline, true);
  assert.equal(next[0].total, 4);
  const saved = JSON.parse(await readFile(next[0].path, 'utf8'));
  assert.equal(saved.diagnosticsByPath['apps/sample/input.ts'].length, 2);
  const green = await f.finish('', 0);
  assert.equal(green[0].newInTouchedPaths, 0);
  assert.equal(green[0].total, 0);
  assert.equal((await f.finish(compilerDiagnostic))[0].newInTouchedPaths, 1);
});

test('incomplete and signalled runs preserve the previous full baseline', async t => {
  const f = await fixture(t);
  const initial = await f.finish(compilerDiagnostic);
  const before = await readFile(initial[0].path, 'utf8');
  const run = await createTypecheckDiagnosticRun(f.options);
  run.record(f.project, { stdout: '', stderr: '', status: null, signal: 'SIGTERM' });
  assert.deepEqual(await run.publish(), []);
  assert.equal(await readFile(initial[0].path, 'utf8'), before);
  assert.deepEqual(await f.finish('compiler crashed', 1), []);
  assert.equal(await readFile(initial[0].path, 'utf8'), before);
});

test('a UI-sized untracked inventory publishes without truncation', async t => {
  const f = await fixture(t);
  await f.finish(compilerDiagnostic);
  const directory = join(f.cwd, 'u'.repeat(190));
  await mkdir(directory);
  const names = Array.from({ length: 6000 }, (_, index) => `${index}.ts`);
  await Promise.all(names.map(name => writeFile(join(directory, name), '')));
  const diagnostic = compilerDiagnostic.replace('input.ts', `${'u'.repeat(190)}/${names.at(-1)}`);
  assert.ok(names.reduce((bytes, name) => bytes + Buffer.byteLength(`apps/sample/${'u'.repeat(190)}/${name}\0`), 0) > 1024 * 1024);
  const [report] = await f.finish(diagnostic);
  assert.equal(report.baseline, true);
  assert.equal(report.newInTouchedPaths, 1);
  assert.equal(report.total, 1);
  assert.ok(JSON.parse(await readFile(report.path, 'utf8')).diagnosticsByPath[`apps/sample/${'u'.repeat(190)}/${names.at(-1)}`]);
});

test('a failed Git inventory reports its step and preserves the completed baseline', async t => {
  const f = await fixture(t);
  const [initial] = await f.finish(compilerDiagnostic);
  const before = await readFile(initial.path, 'utf8');
  const run = await createTypecheckDiagnosticRun(f.options);
  run.record(f.project, { stdout: compilerDiagnostic, status: 2 });
  await rename(join(f.root, '.git'), join(f.root, 'saved-git'));
  const failedGit = spawnSync('git', ['diff', '--name-only', '-z', 'HEAD'], { cwd: f.root, stdio: 'ignore' });
  assert.ok(failedGit.status > 0);
  await assert.rejects(run.publish(), error => {
    assert.equal(typecheckDiagnosticFailureIdentifier(error, 'snapshot'), `git-diff:EXIT_${failedGit.status}`);
    return true;
  });
  assert.equal(await readFile(initial.path, 'utf8'), before);
});

for (const local of ['missing', 'malformed', 'different projects', 'matching']) {
  test(`reference baseline fallback with ${local} local snapshot`, async t => {
    const f = await fixture(t);
    const referencePath = '.project/plans/2026-10-17-coordination/qa/baselines/sample.json';
    const reference = join(f.root, referencePath);
    const localPath = join(f.cwd, 'node_modules/.cache/typecheck/diagnostics.json');
    const snapshot = {
      projects: ['apps/sample/tsconfig.json'],
      diagnosticsByPath: { 'apps/sample/input.ts': [{ line: 1, column: 7, code: 2322 }] },
      globalDiagnostics: 0,
    };
    await mkdir(join(f.root, '.project/plans/2026-10-17-coordination/qa/baselines'), { recursive: true });
    await writeFile(reference, JSON.stringify(snapshot));
    if (local !== 'missing') {
      await mkdir(join(f.cwd, 'node_modules/.cache/typecheck'), { recursive: true });
      await writeFile(localPath, local === 'malformed' ? '{' : JSON.stringify({
        ...snapshot,
        projects: local === 'different projects' ? ['apps/sample/other.json'] : snapshot.projects,
        diagnosticsByPath: {},
      }));
    }
    await writeFile(join(f.cwd, 'input.ts'), 'export const value = 2;\n');
    const [report] = await f.finish(compilerDiagnostic);
    assert.equal(report.baseline, true);
    assert.equal(report.baselineSource, local === 'matching' ? 'local' : `reference ${referencePath}`);
    assert.equal(report.newInTouchedPaths, local === 'matching' ? 1 : 0);
    assert.equal(await readFile(reference, 'utf8'), JSON.stringify(snapshot), 'reference is read-only');
    assert.deepEqual(JSON.parse(await readFile(localPath, 'utf8')), snapshot);
  });
}

test('a reference with a mismatched project set cannot supply a baseline', async t => {
  const f = await fixture(t);
  const directory = join(f.root, '.project/plans/2026-10-17-coordination/qa/baselines');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'sample.json'), JSON.stringify({
    projects: ['apps/sample/other.json'], diagnosticsByPath: {}, globalDiagnostics: 0,
  }));
  const [report] = await f.finish(compilerDiagnostic);
  assert.equal(report.baseline, false);
  assert.equal(report.newInTouchedPaths, null);
});

test('multiple compiler projects publish one full snapshot and deduplicate shared diagnostics', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'tsconfig.tests.json'), '{"compilerOptions":{"noEmit":true}}');
  const second = { project: 'tsconfig.tests.json', authoredProject: 'tsconfig.tests.json', authoredArgs: ['--noEmit', '-p', 'tsconfig.tests.json'] };
  const options = { ...f.options, projects: [f.project, second] };
  const incomplete = await createTypecheckDiagnosticRun(options);
  incomplete.record(f.project, { stdout: compilerDiagnostic, status: 2 });
  assert.deepEqual(await incomplete.publish(), []);
  const complete = await createTypecheckDiagnosticRun(options);
  for (const project of options.projects) complete.record(project, { stdout: compilerDiagnostic, status: 2 });
  const reports = await complete.publish();
  assert.equal(reports.length, 1);
  assert.equal(reports[0].total, 1);
});

test('global diagnostics remain visible; non-typecheck commands cannot replace a baseline', async t => {
  const f = await fixture(t);
  assert.equal((await f.finish('error TS18003: No inputs were found.\n'))[0].globalDiagnostics, 1);
  for (const args of [['--watch', '--noEmit'], ['--version'], ['--noEmit', 'input.ts'], ['--noEmit', 'false', '-p', 'tsconfig.json']]) {
    const project = { project: 'tsconfig.json', authoredArgs: args };
    const run = await createTypecheckDiagnosticRun({ ...f.options, projects: [project] });
    run.record(project, { stdout: compilerDiagnostic, status: 2 });
    assert.deepEqual(await run.publish(), []);
  }
});
