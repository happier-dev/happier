import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildNativeAdmissionFixtureEnv } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';

const buildScript = `node ${JSON.stringify(fileURLToPath(new URL('./buildTypeScriptPackageDist.mjs', import.meta.url)))} -p tsconfig.json`;

test('consumer diagnostics survive an upstream declaration emission error', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-declaration-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ private: true }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters: {}\n",
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
    'apps/ui/package.json': JSON.stringify({ name: '@fixture/ui' }),
    'apps/cli/package.json': JSON.stringify({ name: '@fixture/cli' }),
    'apps/server/package.json': JSON.stringify({ name: '@fixture/server', dependencies: { '@fixture/upstream': 'workspace:*' } }),
    'apps/server/tsconfig.json': JSON.stringify({ compilerOptions: { noEmit: true, strict: true,
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [] }, files: ['index.ts'] }),
    'apps/server/index.ts': 'export const ownError: number = "consumer";',
    'packages/upstream/package.json': JSON.stringify({ name: '@fixture/upstream', type: 'module', scripts: { build: buildScript },
      exports: { '.': { types: './dist/index.d.ts', 'happier-source': './src/index.ts' } } }),
    'packages/upstream/tsconfig.json': JSON.stringify({ compilerOptions: { declaration: true, strict: true,
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', types: [], rootDir: 'src', outDir: 'dist' }, files: ['src/index.ts'] }),
    // This requires a declaration diagnostic even with the emitter's noCheck.
    'packages/upstream/src/index.ts': 'export const value = new class { private hidden = true; }();',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: 'true', HAPPIER_TYPECHECK_DISPATCHED: '1',
    HAPPIER_TYPESCRIPT_COMPILER: 'microsoft' };
  // This fixture is a local subprocess inside the admitted test, not a placed worker.
  delete env.HAPPIER_DEV_TARGET_EXECUTION;
  delete env.HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED;
  const check = () => spawnSync(process.execPath, [fileURLToPath(new URL('./runTypeScriptCli.mjs', import.meta.url)),
    '-p', 'tsconfig.json', '--pretty', 'false'], { cwd: join(root, 'apps/server'), env, encoding: 'utf8' });
  const result = check();
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /TS4094/, 'the producer must really fail declaration emission');
  assert.match(result.stdout, /index\.ts\(1,\d+\): error TS2322:/, 'the consumer must still check its own source');
  assert.match(result.stderr, /typecheck-declaration-failure.*declaration-emission/);
  await writeFile(join(root, 'apps/server/index.ts'), 'export const ownValue: number = 1;');
  const upstreamOnly = check();
  assert.ifError(upstreamOnly.error);
  assert.notEqual(upstreamOnly.status, 0, 'a clean consumer cannot hide failed declaration preparation');
  assert.match(upstreamOnly.stdout, /TS4094/);
  assert.doesNotMatch(upstreamOnly.stdout, /TS2322/);
  await writeFile(join(root, 'packages/upstream/src/index.ts'), 'export const value = true;');
  const recovered = check();
  assert.ifError(recovered.error);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.doesNotMatch(recovered.stderr, /typecheck-declaration-failure/);
});
