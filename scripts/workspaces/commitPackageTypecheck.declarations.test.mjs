import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildNativeAdmissionFixtureEnv } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';
import { rollingHeadTypecheckPass } from './commitPackageTypecheck.mjs';

// Real compiler, real rolling pass: an exported value whose inferred type names a type its
// dependency does not export (TS2883) fails only declaration emit. The package also carries an
// older semantic error, as packages/protocol does at HEAD, which hides declaration diagnostics
// from a `--noEmit` check (TS2883 escaped twice on 2026-11-17: ab829503f95, 79d87f49afe).
test('the rolling HEAD typecheck attributes a declaration-emit error (TS2883) to the commit that introduced it', async t => {
  const repo = await mkdtemp(join(tmpdir(), 'happier-declaration-emit-'));
  const state = await mkdtemp(join(tmpdir(), 'happier-declaration-emit-state-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  t.after(() => rm(state, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  t.after(() => { try { git('worktree', 'unlock', join(state, 'worktree')); git('worktree', 'remove', '--force', join(state, 'worktree')); } catch {} });
  const write = async files => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), content);
    }
  };
  const commit = async (label, files) => {
    await write(files);
    git('add', '-A');
    git('commit', '--quiet', '-m', label);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Declaration Emit Test');
  git('config', 'user.email', 'declaration-emit@example.invalid');
  const dep = 'packages/protocol/node_modules/dep';
  // The first rolling pass reads HEAD's parent.
  await commit('root', { 'package.json': JSON.stringify({ private: true }) });
  await commit('base', {
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    // The warm worktree runs its own tree's compiler owner; this fixture forwards to the real one.
    'scripts/workspaces/runTypeScriptCli.mjs': `await import(${JSON.stringify(new URL('./runTypeScriptCli.mjs', import.meta.url).href)});\n`,
    'packages/protocol/package.json': JSON.stringify({ name: '@fixture/protocol', type: 'module', scripts: { typecheck: 'x' },
      exports: { '.': { types: './dist/index.d.ts', 'happier-source': './src/index.ts' } } }),
    'packages/protocol/tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
      rootDir: 'src', outDir: 'dist', incremental: true, tsBuildInfoFile: 'dist/.tsbuildinfo', declaration: true, declarationMap: true,
      strict: true, skipLibCheck: true, types: [] }, include: ['src/**/*.ts'] }),
    'packages/protocol/src/index.ts': 'export const known: number = "an older semantic error";\n',
    [`${dep}/package.json`]: JSON.stringify({ name: 'dep', version: '1.0.0', type: 'module',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } } }),
    [`${dep}/dist/index.d.ts`]: "import type { Hidden } from './hidden.js';\nexport declare function make(): { value: Hidden };\n",
    [`${dep}/dist/hidden.d.ts`]: 'export interface Hidden { a: number }\n',
  });
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: 'true', HAPPIER_TYPECHECK_DISPATCHED: '1',
    HAPPIER_TYPESCRIPT_COMPILER: 'microsoft', HAPPIER_COMMIT_TYPECHECK_DIR: state };
  // A local subprocess inside the admitted test, not a placed worker.
  delete env.HAPPIER_DEV_TARGET_EXECUTION;
  delete env.HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED;
  const posts = [];
  const logs = [];
  const options = { repo, env, bootstrap: () => {}, remote: null, post: entry => posts.push(entry), boardPaths: [], log: line => logs.push(line) };
  const baseline = await rollingHeadTypecheckPass(options);
  assert.deepEqual(baseline.incomplete, [], logs.join('\n'));
  const introducing = await commit('export a non-portable inferred type', {
    'packages/protocol/src/thing.ts': "import { make } from 'dep';\nexport const thing = make().value;\n",
  });
  const red = await rollingHeadTypecheckPass(options);
  assert.deepEqual(red.incomplete, [], logs.join('\n'));
  assert.deepEqual(red.attributions.map(entry => [entry.commit, entry.rows.map(row => `${row.file}:${row.line}:TS${row.code}`)]),
    [[introducing, ['packages/protocol/src/thing.ts:2:TS2883']]], logs.join('\n'));
  assert.equal(posts.length, 1);
  assert.match(posts[0], /URGENT — new type errors from/u);
});
