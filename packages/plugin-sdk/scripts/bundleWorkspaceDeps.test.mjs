import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS,
  resolveWorkspaceBundleLockPath,
} from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import {
  bundleWorkspaceDeps,
  preparePluginSdkWorkspacePrerequisites,
  resolvePluginSdkWorkspaceBundleLockPath,
} from './bundleWorkspaceDeps.mjs';

test('plugin-sdk workspace bundling uses the canonical repository bundle lock by default', () => {
  const repoRoot = '/repo';

  assert.equal(
    resolvePluginSdkWorkspaceBundleLockPath({ repoRoot }),
    resolveWorkspaceBundleLockPath(repoRoot),
  );
});

test('plugin-sdk workspace bundling preserves an explicit lock override', () => {
  assert.equal(
    resolvePluginSdkWorkspaceBundleLockPath({ repoRoot: '/repo', lockPath: '/tmp/explicit.lock' }),
    '/tmp/explicit.lock',
  );
});

test('plugin-sdk declaration preparation delegates to the canonical stale-only workspace owner', async () => {
  const calls = [];
  const pluginSdkDir = '/repo/packages/plugin-sdk';
  const env = { CI: '1' };

  const result = await preparePluginSdkWorkspacePrerequisites({
    pluginSdkDir,
    env,
    ensureWorkspacePackagesBuiltForComponent: async (...args) => {
      calls.push(args);
      return { ok: true, built: [], skipped: [] };
    },
  });

  assert.deepEqual(calls, [[pluginSdkDir, { env, quiet: true }]]);
  assert.deepEqual(result, { ok: true, built: [], skipped: [] });
});

test('plugin-sdk declaration preparation reuses prerequisites admitted by the canonical package build', async () => {
  const result = await preparePluginSdkWorkspacePrerequisites({
    pluginSdkDir: '/repo/packages/plugin-sdk',
    env: {
      HAPPIER_WORKSPACE_PACKAGE_PREREQUISITES_READY: '1',
    },
    ensureWorkspacePackagesBuiltForComponent: async () => {
      throw new Error('canonical package builds must not re-enter prerequisite admission');
    },
  });

  assert.deepEqual(result, {
    ok: true,
    built: [],
    skipped: ['canonical-package-build'],
  });
});

test('plugin-sdk keeps nonwriter source checks separate from declaration preparation', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.scripts['check:api-surface'], 'node ./scripts/apiSurfaceCli.mjs --check');
  assert.equal(
    packageJson.scripts['prepare:declarations'],
    'yarn -s check:action-type-map && node ./scripts/bundleWorkspaceDeps.mjs --declarations',
  );
  assert.equal(
    packageJson.scripts.prebuild,
    'yarn -s check:public-toolchain && yarn -s prepare:declarations',
  );
  assert.doesNotMatch(packageJson.scripts['test:local'], /prepare:declarations/u);
  assert.doesNotMatch(packageJson.scripts['typecheck:local'], /prepare:declarations/u);
  assert.match(packageJson.scripts['typecheck:local'], /^yarn -s check:api-surface && /u);
  assert.equal(packageJson.scripts['pretypecheck:source'], undefined);
  assert.equal(packageJson.scripts['pretypecheck:tests'], undefined);
  assert.equal(packageJson.scripts['test:source'], 'vitest run --config vitest.source.config.ts');
  assert.equal(
    packageJson.scripts['typecheck:source'],
    'node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.json',
  );
  assert.equal(
    packageJson.scripts['typecheck:tests'],
    'node ../../scripts/workspaces/runTypeScriptCli.mjs --noEmit -p tsconfig.tests.json',
  );
  assert.equal(
    packageJson.scripts.prepack,
    'yarn -s prepare:declarations && node ./scripts/bundleWorkspaceDeps.mjs --artifact && yarn -s check:api-surface && yarn -s check:public-toolchain:generated && yarn -s build:compiled',
  );
});

test('plugin-sdk runtime bundling admits the resolved artifact closure and publishes it once', async () => {
  const events = [];
  const repoRoot = '/repo';
  const pluginSdkDir = '/repo/packages/plugin-sdk';

  await bundleWorkspaceDeps({
    repoRoot,
    pluginSdkDir,
    publicationMode: 'artifact',
    ensureWorkspacePackagesBuiltForComponent: async () => {
      throw new Error('runtime bundling should admit exact resolved names instead of the host component');
    },
    ensureWorkspacePackagesBuiltByName: async (root, packageNames, options) => {
      assert.equal(root, repoRoot);
      assert.deepEqual(packageNames, ['@happier-dev/protocol']);
      assert.equal(options?.env?.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD, 'test-owner');
      events.push('admit-bundles');
      return { ok: true, built: [], skipped: packageNames };
    },
    withWorkspaceBundleLock: async (publish, options) => {
      assert.equal(options.lockPath, resolveWorkspaceBundleLockPath(repoRoot));
      assert.equal(options.timeoutMs, DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS);
      assert.equal(options.staleAfterMs, DEFAULT_WORKSPACE_BUNDLE_LOCK_TIMEOUT_MS);
      events.push('lock');
      return await publish({ heldLockValue: 'test-owner' });
    },
    loadCliCommonWorkspacesModule: async () => ({
      resolveWorkspaceBundlesFromPackageJson: () => {
        events.push('resolve-bundles');
        return [{ packageName: '@happier-dev/protocol' }];
      },
      bundleWorkspacePackagesWithRuntimeDependencies: ({ publicationMode }) => {
        events.push(`bundle:${publicationMode}`);
      },
    }),
  });

  assert.deepEqual(events, [
    'lock',
    'resolve-bundles',
    'admit-bundles',
    'bundle:artifact',
  ]);
});

test('plugin-sdk artifact bundling rebuilds newer stale workspace output from current source', async () => {
  const repoRoot = await mkdtemp(resolve(tmpdir(), 'happy-plugin-sdk-artifact-admission-'));
  const pluginSdkDir = resolve(repoRoot, 'packages', 'plugin-sdk');
  const protocolDir = resolve(repoRoot, 'packages', 'protocol');
  const protocolSourcePath = resolve(protocolDir, 'src', 'index.ts');
  const protocolDistPath = resolve(protocolDir, 'dist', 'index.js');
  const admissionCalls = [];
  let bundledProtocolContents = null;

  try {
    await mkdir(resolve(protocolDir, 'src'), { recursive: true });
    await mkdir(resolve(protocolDir, 'dist'), { recursive: true });
    await writeFile(protocolSourcePath, 'export const generation = "current";\n', 'utf8');
    await writeFile(protocolDistPath, 'export const generation = "stale";\n', 'utf8');
    const now = Date.now();
    await utimes(protocolSourcePath, new Date(now), new Date(now));
    await utimes(protocolDistPath, new Date(now + 10_000), new Date(now + 10_000));

    await bundleWorkspaceDeps({
      repoRoot,
      pluginSdkDir,
      publicationMode: 'artifact',
      withWorkspaceBundleLock: async (publish) => await publish({ heldLockValue: 'test-owner' }),
      ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
        admissionCalls.push({ packageNames, force: options?.force });
        if (options?.force === true && packageNames.includes('@happier-dev/protocol')) {
          await writeFile(protocolDistPath, 'export const generation = "current";\n', 'utf8');
        }
        return { ok: true, built: options?.force === true ? packageNames : [], skipped: [] };
      },
      loadCliCommonWorkspacesModule: async (
        root,
        _env,
        ensureWorkspacePackagesBuiltByName,
        options,
      ) => {
        await ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/cli-common'], options);
        return {
          resolveWorkspaceBundlesFromPackageJson: () => [{
            packageName: '@happier-dev/protocol',
            srcDir: protocolDir,
            destDir: resolve(pluginSdkDir, 'node_modules', '@happier-dev', 'protocol'),
          }],
          bundleWorkspacePackagesWithRuntimeDependencies: ({ bundles }) => {
            assert.equal(bundles.length, 1);
            bundledProtocolContents = readFileSync(protocolDistPath, 'utf8');
          },
        };
      },
    });

    assert.equal(bundledProtocolContents, 'export const generation = "current";\n');
    assert.deepEqual(admissionCalls, [
      { packageNames: ['@happier-dev/cli-common'], force: true },
      { packageNames: ['@happier-dev/protocol'], force: true },
    ]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('plugin-sdk live bundling keeps workspace admission incremental', async () => {
  const admissionCalls = [];

  await bundleWorkspaceDeps({
    repoRoot: '/repo',
    pluginSdkDir: '/repo/packages/plugin-sdk',
    publicationMode: 'live',
    withWorkspaceBundleLock: async (publish) => await publish({ heldLockValue: 'test-owner' }),
    ensureWorkspacePackagesBuiltByName: async (_root, packageNames, options) => {
      admissionCalls.push({ packageNames, force: options?.force });
      return { ok: true, built: [], skipped: packageNames };
    },
    loadCliCommonWorkspacesModule: async (
      root,
      _env,
      ensureWorkspacePackagesBuiltByName,
      options,
    ) => {
      await ensureWorkspacePackagesBuiltByName(root, ['@happier-dev/cli-common'], options);
      return {
        resolveWorkspaceBundlesFromPackageJson: () => [{ packageName: '@happier-dev/protocol' }],
        bundleWorkspacePackagesWithRuntimeDependencies: () => {},
      };
    },
  });

  assert.deepEqual(admissionCalls, [
    { packageNames: ['@happier-dev/cli-common'], force: false },
    { packageNames: ['@happier-dev/protocol'], force: undefined },
  ]);
});
