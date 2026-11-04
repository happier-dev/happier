import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as touched from './typecheckTouched.mjs';
import { compareTouchedTypecheckLocations } from './typecheckDiagnostics.mjs';

test('explicit touched delta distinguishes new, removed and foreign locations without column churn', () => {
  const result = compareTouchedTypecheckLocations({
    baseline: ['apps/ui/sources/a.ts:1:TS2322', 'apps/ui/sources/a.ts:4:TS2345'],
    current: ['apps/ui/sources/a.ts:1:TS2322', 'apps/ui/sources/a.ts:8:TS2322',
      'apps/ui/sources/b.ts:3:TS2322'],
    paths: ['apps/ui/sources/a.ts'],
  });
  assert.deepEqual(result, {
    added: ['apps/ui/sources/a.ts:8:TS2322'],
    removed: ['apps/ui/sources/a.ts:4:TS2345'],
    unattributed: ['apps/ui/sources/b.ts:3:TS2322'],
  });
});

test('shared baseline selects the newest complete inventory, normalizing both recorded formats', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-touched-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '.project/tmp/systemic-orch');
  await mkdir(directory, { recursive: true });
  const files = [
    ['ui-old.locs', 'sources/old.ts:1:TS2322\n'],
    ['ui-current.locs', 'sources/a.ts:7:TS2322\n../cli/src/b.ts(3,8): error TS2345\n'],
    ['ui-current-new-vs-old.locs', 'sources/not-a-baseline.ts:1:TS2322\n'],
    ['ui-partial.locs', 'sources/incomplete.ts:1:TS2322\n'],
  ];
  for (const [index, [name, body]] of files.entries()) {
    const file = join(directory, name);
    await writeFile(file, body);
    await utimes(file, index + 1, index + 1);
  }
  const result = await touched.readSharedTypecheckBaseline(root, 'apps/ui');
  assert.equal(result.path, join(directory, 'ui-current.locs'));
  assert.deepEqual(result.locations, ['apps/cli/src/b.ts:3:TS2345', 'apps/ui/sources/a.ts:7:TS2322']);
  await writeFile(join(directory, 'ui-invalid.locs'), 'compiler did not launch\n');
  await assert.rejects(touched.readSharedTypecheckBaseline(root, 'apps/ui'), /invalid.*baseline/i);
});

test('missing baseline is unavailable, whereas an empty completed baseline is a real zero', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-touched-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(touched.readSharedTypecheckBaseline(root, 'apps/ui'), /baseline.*unavailable/i);
  const directory = join(root, '.project/tmp/systemic-orch');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'ui-green.locs'), '');
  assert.deepEqual((await touched.readSharedTypecheckBaseline(root, 'apps/ui')).locations, []);
});

test('directory selection respects the separator boundary and normalizes Windows separators', () => {
  assert.deepEqual(compareTouchedTypecheckLocations({ baseline: [],
    current: ['apps/ui/sources/one/a.ts:1:TS2322', 'apps/ui/sources/one-more/b.ts:1:TS2322'],
    paths: ['apps\\ui\\sources\\one'],
  }), { added: ['apps/ui/sources/one/a.ts:1:TS2322'], removed: [],
    unattributed: ['apps/ui/sources/one-more/b.ts:1:TS2322'] });
});

test('public touched entry reports real compiler errors only against the explicit paths', async t => {
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const temporary = join(repoRoot, '.project/tmp');
  await mkdir(temporary, { recursive: true });
  const cwd = await mkdtemp(join(temporary, 'touched-compiler-probe-'));
  const packagePath = relative(repoRoot, cwd).replaceAll('\\', '/');
  const baselineDirectory = join(temporary, 'systemic-orch');
  await mkdir(baselineDirectory, { recursive: true });
  const baseline = join(baselineDirectory, `${basename(cwd)}-baseline.locs`);
  t.after(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(baseline, { force: true });
  });
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: basename(cwd), private: true,
    scripts: { typecheck: 'node ../../../scripts/workspaces/runTypeScriptCli.mjs --noEmit --project tsconfig.json' } }));
  await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, target: 'ESNext', module: 'ESNext', types: [], skipLibCheck: true,
  }, include: ['*.ts'] }));
  await writeFile(join(cwd, 'touched.ts'), "export const okay = 1;\nexport const broken: number = 'wrong';\n");
  await writeFile(join(cwd, 'foreign.ts'), 'export const other: boolean = 1;\n');
  await writeFile(baseline, 'touched.ts:1:TS2322\n');
  const invoke = async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./typecheckTouched.mjs', import.meta.url)),
      packagePath, `${packagePath}/touched.ts`], { cwd: repoRoot,
      // A controller's absolute package-manager path is not a worker tool path.
      env: { ...process.env, npm_execpath: join(repoRoot, 'controller-only', 'pnpm') },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const status = await new Promise((resolveResult, reject) => {
      child.once('error', reject);
      child.once('close', resolveResult);
    });
    return { status, stdout, stderr };
  };
  const { status, stdout, stderr } = await invoke();
  assert.equal(status, 1, stderr);
  assert.match(stdout, /package typecheck: exit=2 signal=none wallMs=\d+/u);
  assert.match(stdout, /added: 1\n/u);
  assert.ok(stdout.includes(`${packagePath}/touched.ts:2:TS2322`));
  assert.match(stdout, /removed: 1\n/u);
  assert.ok(stdout.includes(`${packagePath}/touched.ts:1:TS2322`));
  assert.match(stdout, /unattributed: 1\n/u);
  assert.ok(stdout.includes(`${packagePath}/foreign.ts:1:TS2322`));
  assert.ok(!stdout.includes('not assignable'), 'source/diagnostic prose must not be disclosed');
  await writeFile(join(cwd, 'touched.ts'), 'export const okay = 1;\n');
  const foreignOnly = await invoke();
  assert.equal(foreignOnly.status, 0, foreignOnly.stderr);
  assert.match(foreignOnly.stdout, /added: 0\n/u);
  assert.match(foreignOnly.stdout, /unattributed: 1\n/u);
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: basename(cwd), private: true,
    scripts: { typecheck: 'node ../../../scripts/workspaces/runTypeScriptCli.mjs --noEmit --project missing.json' } }));
  const incomplete = await invoke();
  assert.equal(incomplete.status, 2);
  assert.match(incomplete.stderr, /no complete package diagnostic result/u);
  assert.ok(!incomplete.stdout.includes('added: 0'), 'a failed launch must never become a zero delta');
});
