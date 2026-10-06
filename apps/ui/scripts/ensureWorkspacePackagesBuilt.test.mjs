import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { computeSourceDevSharedDepsSignature } from '../../cli/scripts/buildSharedDeps.mjs';
import { resolveBundledPluginUiArtifactsOutputPath } from './generateBundledPluginUiArtifacts.mjs';

test('hasUsableUiWorkspaceLastGreen requires both recorded workspace outputs and target-owned UI artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-last-green-'));
  const uiPackageDir = join(root, 'apps', 'ui');
  try {
    await mkdir(uiPackageDir, { recursive: true });
    const { hasUsableUiWorkspaceLastGreen } = await import('./ensureWorkspacePackagesBuilt.mjs');
    await mkdir(join(root, 'apps', 'cli', 'scripts'), { recursive: true });
    await writeFile(join(root, 'apps', 'cli', 'scripts', 'buildSharedDeps.mjs'),
      `export { inspectUsableSourceDevSharedDepsLastGreen } from ${JSON.stringify(new URL('../../cli/scripts/buildSharedDeps.mjs', import.meta.url).href)};\n`);
    const sdkDir = join(root, 'packages', 'plugin-sdk');
    await mkdir(join(sdkDir, 'dist'), { recursive: true });
    await writeFile(join(sdkDir, 'package.json'), JSON.stringify({
      name: '@happier-dev/plugin-sdk', type: 'module', exports: { '.': './dist/index.js' },
    }));
    await writeFile(join(sdkDir, 'dist', 'index.js'), 'export {};\n');
    const signature = computeSourceDevSharedDepsSignature({ repoRoot: root, workspaceNames: ['plugin-sdk'] });
    await mkdir(join(root, '.project', 'tmp'), { recursive: true });
    await writeFile(join(root, '.project', 'tmp', 'cli-source-dev-shared-deps-sync.json'), JSON.stringify({
      version: signature.version, entries: { sdk: { signature, syncedAtMs: 1 } },
    }));
    assert.equal(await hasUsableUiWorkspaceLastGreen({ uiPackageDir }), false);
    const outputPath = resolveBundledPluginUiArtifactsOutputPath(root);
    await mkdir(join(outputPath, '..'), { recursive: true });
    await writeFile(outputPath, 'export const BUNDLED_PLUGIN_UI_APP_ARTIFACTS = [];\n');
    assert.equal(await hasUsableUiWorkspaceLastGreen({ uiPackageDir }), true);
    await rm(join(sdkDir, 'dist', 'index.js'));
    assert.equal(await hasUsableUiWorkspaceLastGreen({ uiPackageDir }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ensureUiWorkspacePackagesBuilt publishes rebuilt plugin artifacts before Expo can adopt their bytes', async () => {
  const calls = [];
  const verifyPatchedDependencies = (options) => {
    calls.push(['verify', options]);
  };
  const ensureWorkspacePackagesBuiltForComponent = async (componentDir, options) => {
    calls.push(['build', componentDir, options]);
    return { ok: true, built: ['@happier-dev/plugins-inspector'], skipped: [] };
  };
  const syncSharedDepsForSourceDev = async (repoRoot, options) => {
    calls.push(['publish', repoRoot, options]);
    return { synced: true, stamped: true };
  };
  const generateBundledPluginUiArtifacts = async (options) => {
    calls.push(['preseed', options]);
  };

  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');

  const env = { CI: '1' };
  await ensureUiWorkspacePackagesBuilt({
    env,
    verifyPatchedDependencies,
    syncSharedDepsForSourceDev,
    generateBundledPluginUiArtifacts,
    ensureWorkspacePackagesBuiltForComponent,
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[0][0], 'verify');
  assert.match(String(calls[0][1].uiPackageDir), /apps\/ui$/);
  assert.equal(calls[1][0], 'build');
  assert.match(String(calls[1][1]), /apps\/ui$/);
  assert.deepEqual(calls[1][2], {
    quiet: false,
    env: { ...env, HAPPIER_WORKSPACE_BUILD_MODE: 'qa-runtime' },
    publicationMode: 'live',
    isolatePluginFailures: true,
  });
  assert.equal(calls[2][0], 'publish');
  assert.equal(calls[2][1], resolve(String(calls[1][1]), '../..'));
  assert.deepEqual(calls[2][2], {
    env: { ...env, HAPPIER_WORKSPACE_BUILD_MODE: 'qa-runtime' },
    includeRuntimeDependencies: true,
    quiet: false,
    workspaceNames: ['plugins-inspector'],
  });
  assert.deepEqual(calls[3], ['preseed', {
    repoRoot: resolve(String(calls[1][1]), '../..'),
    mode: 'write',
    publicationMode: 'live',
  }]);
});

test('UI artifact preflight keeps plugin builds strict and rejects a missing UI bundle', async () => {
  const failure = Object.freeze({
    packageName: '@happier-dev/plugins-broken',
    pluginId: 'happier.broken',
    diagnostic: Object.freeze({ code: 'plugin_ui_artifact_invalid', message: 'missing UI bundle' }),
  });
  const calls = [];
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');
  await assert.rejects(() => ensureUiWorkspacePackagesBuilt({
    publicationMode: 'artifact',
    verifyPatchedDependencies: () => {},
    ensureWorkspacePackagesBuiltForComponent: async (_dir, options) => {
      calls.push(options);
      return { ok: true, built: [], pluginFailures: [], skipped: [] };
    },
    syncSharedDepsForSourceDev: async () => { throw new Error('release must not invoke live source sync'); },
    generateBundledPluginUiArtifacts: async () => ({ pluginFailures: [failure] }),
  }), /UI artifact publication failed.*plugins-broken/u);
  assert.equal(calls[0].publicationMode, 'artifact');
  assert.equal(calls[0].isolatePluginFailures, false);
});

test('ensureUiWorkspacePackagesBuilt leaves complete remote publication policy with the canonical publisher', async () => {
  const calls = [];
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');
  const env = { HAPPIER_DEV_TARGET_EXECUTION: '1' };

  await ensureUiWorkspacePackagesBuilt({
    env,
    verifyPatchedDependencies: () => {},
    ensureWorkspacePackagesBuiltForComponent: async () => ({
      ok: true,
      built: ['@happier-dev/plugins-inspector'],
      skipped: [],
    }),
    syncSharedDepsForSourceDev: async (_repoRoot, options) => {
      calls.push(options);
      return { synced: true, stamped: true };
    },
    generateBundledPluginUiArtifacts: async () => {},
  });

  assert.deepEqual(calls, [{
    env: { ...env, HAPPIER_WORKSPACE_BUILD_MODE: 'qa-runtime' },
    includeRuntimeDependencies: true,
    quiet: false,
    workspaceNames: ['plugins-inspector'],
  }]);
});

test('ensureUiWorkspacePackagesBuilt does not republish a plugin projection when the UI build rebuilt no plugin package', async () => {
  const calls = [];
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');

  await ensureUiWorkspacePackagesBuilt({
    env: { CI: '1' },
    verifyPatchedDependencies: () => calls.push('verify'),
    ensureWorkspacePackagesBuiltForComponent: async () => {
      calls.push('build');
      return { ok: true, built: ['@happier-dev/plugin-sdk'], skipped: [] };
    },
    syncSharedDepsForSourceDev: async () => calls.push('publish'),
    generateBundledPluginUiArtifacts: async (options) => calls.push(['preseed', options.mode]),
  });

  assert.deepEqual(calls, ['verify', 'build', ['preseed', 'write']]);
});

test('UI preflight carries a failed plugin into byte publication while keeping a healthy rebuilt plugin', async () => {
  const failure = Object.freeze({
    packageName: '@happier-dev/plugins-broken',
    pluginId: 'happier.broken',
    diagnostic: Object.freeze({ code: 'plugin_package_build_failed', message: 'missing staged export' }),
  });
  const calls = [];
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');
  await ensureUiWorkspacePackagesBuilt({
    verifyPatchedDependencies: () => {},
    ensureWorkspacePackagesBuiltForComponent: async () => ({
      ok: true, built: ['@happier-dev/plugins-healthy'], pluginFailures: [failure], skipped: [],
    }),
    syncSharedDepsForSourceDev: async (_root, options) => { calls.push(['publish', options]); },
    generateBundledPluginUiArtifacts: async (options) => { calls.push(['preseed', options]); },
  });
  assert.equal(calls[0][0], 'publish');
  assert.deepEqual(calls[0][1].workspaceNames, ['plugins-healthy']);
  assert.equal(calls[1][0], 'preseed');
  assert.equal(calls[1][1].pluginFailures[0], failure);
});

test('UI artifact failure republishes the catalog projection without the failed plugin', async () => {
  const failure = Object.freeze({
    packageName: '@happier-dev/plugins-broken',
    pluginId: 'happier.broken',
    diagnostic: Object.freeze({ code: 'plugin_ui_artifact_invalid', message: 'missing UI bundle' }),
  });
  const published = [];
  const reprojected = [];
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');
  await ensureUiWorkspacePackagesBuilt({
    verifyPatchedDependencies: () => {},
    ensureWorkspacePackagesBuiltForComponent: async () => ({
      ok: true, built: ['@happier-dev/plugins-healthy'], pluginFailures: [], skipped: [],
    }),
    syncSharedDepsForSourceDev: async (_root, options) => { published.push(options); },
    generateBundledPluginUiArtifacts: async () => ({ pluginFailures: [failure] }),
    publishBundledPluginProjectionWithFailuresImpl: async (options) => { reprojected.push(options); },
  });
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].workspaceNames, ['plugins-healthy']);
  assert.equal(reprojected.length, 1);
  assert.equal(reprojected[0].pluginFailures[0], failure);
});

test('ensureUiWorkspacePackagesBuilt throws when apps/ui is not inside a Happier monorepo checkout', async () => {
  const ensureWorkspacePackagesBuiltForComponent = async () => ({ ok: true, built: [], skipped: ['not-monorepo'] });
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');

  await assert.rejects(
    () => ensureUiWorkspacePackagesBuilt({
      env: { CI: '1' },
      verifyPatchedDependencies: () => {},
      syncSharedDepsForSourceDev: async () => ({ synced: false, stamped: true }),
      generateBundledPluginUiArtifacts: async () => {},
      ensureWorkspacePackagesBuiltForComponent,
    }),
    /\bnot-monorepo\b/i
  );
});
