import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createTempFixture } from '../../apps/stack/scripts/testkit/core/temp_fixture.mjs';
import { buildNativeAdmissionFixtureEnv } from '../../apps/stack/scripts/testkit/core/native_admission_fixture.mjs';
import { withDependencyRefresh } from '../../apps/stack/scripts/utils/proc/dependency_refresh.mjs';
import { tryWorkspaceBuildResources } from '../../apps/stack/scripts/utils/proc/workspace_build_admission.mjs';
import { prepareWorkspaceTypecheckDeclarations } from './prepareReferencedTypecheckDeclarations.mjs';
import { resolveWorkspacePackageBuildLockPath } from './workspacePackageBuildLock.mjs';

const buildScript = `node ${JSON.stringify(fileURLToPath(new URL('./buildTypeScriptPackageDist.mjs', import.meta.url)))} -p tsconfig.json`;

// nl1 2026-11-17: declaration passes took the publication lock of every package in
// the consumer's closure for the whole emission, so the protocol package-dist
// publishers starved for 3.5 h behind passes that never wrote protocol's dist.
test('a declaration pass takes the publication locks of only the packages it emits', async t => {
  const fixture = await createTempFixture(t, { prefix: 'happier-declaration-locks-' });
  const root = fixture.root;
  mkdirSync(fixture.path('node_modules'), { recursive: true });
  writeFileSync(fixture.path('package.json'), '{"private":true}');
  writeFileSync(fixture.path('pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters: {}\n");
  writeFileSync(fixture.path('pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  for (const name of ['cli', 'server', 'ui']) {
    mkdirSync(fixture.path('apps', name), { recursive: true });
    writeFileSync(fixture.path('apps', name, 'package.json'), JSON.stringify({ name: `@fixture/${name}`,
      ...(name === 'cli' ? { dependencies: { '@happier-dev/leaf': 'workspace:*' } } : {}) }));
  }
  const packages = { base: null, leaf: 'base' };
  for (const [name, dependency] of Object.entries(packages)) {
    const dir = fixture.path('packages', name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@happier-dev/${name}`, types: './dist/index.d.ts',
      scripts: { build: buildScript },
      ...(dependency ? { dependencies: { [`@happier-dev/${dependency}`]: 'workspace:*' } } : {}) }));
    writeFileSync(join(dir, 'src/index.ts'), `export const ${name} = ${JSON.stringify(name)};\n`);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { declaration: true, rootDir: 'src',
      outDir: 'dist', module: 'esnext', moduleResolution: 'bundler', types: [] }, include: ['src/**/*.ts'] }));
  }
  const env = { ...buildNativeAdmissionFixtureEnv(), CI: '1', HAPPIER_DEV_TARGET_EXECUTION: '',
    HAPPIER_HSTACK_LOCAL_ADMISSION_REQUIRED: '', HAPPIER_STACK_HOME_DIR: root, HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_SKIP_REFRESH_DEPS: '', HAPPIER_STACK_DISABLE_REFRESH_DEPS: '' };
  await withDependencyRefresh({ installDir: root, env }, async () => {});
  const prepare = signal => prepareWorkspaceTypecheckDeclarations(fixture.path('apps', 'cli'),
    { env, withinTypecheckAdmission: true, signal });
  assert.deepEqual([...(await prepare(t.signal)).declarations].sort(), ['@happier-dev/base', '@happier-dev/leaf']);

  // A publisher holds the current base package's lock while only leaf changed.
  const baseDir = fixture.path('packages', 'base');
  const baseLock = resolveWorkspacePackageBuildLockPath(baseDir, JSON.parse(readFileSync(join(baseDir, 'package.json'), 'utf8')));
  const publisher = await tryWorkspaceBuildResources({ locks: [{ path: baseLock }], env });
  assert.equal(publisher.acquired, true);
  try {
    writeFileSync(fixture.path('packages/leaf/src/index.ts'), 'export const leaf = "changed";\n');
    const result = await prepare(AbortSignal.any([t.signal, AbortSignal.timeout(20_000)]));
    assert.deepEqual(result.declarations, ['@happier-dev/leaf'], 'the pass emits leaf without waiting for the base publisher');
  } finally { await publisher.release(); }
});
