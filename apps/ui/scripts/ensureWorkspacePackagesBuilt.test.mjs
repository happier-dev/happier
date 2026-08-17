import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('hasUsableUiWorkspaceLastGreen delegates availability to the canonical structural publication owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-ui-last-green-'));
  const uiPackageDir = join(root, 'apps', 'ui');
  try {
    await mkdir(uiPackageDir, { recursive: true });
    const { hasUsableUiWorkspaceLastGreen } = await import('./ensureWorkspacePackagesBuilt.mjs');
    const calls = [];
    const inspectUsableSourceDevSharedDepsLastGreen = async (repoRoot, options) => {
      calls.push([repoRoot, options]);
      return { usable: calls.length > 1, reason: 'fixture' };
    };

    assert.equal(await hasUsableUiWorkspaceLastGreen({
      uiPackageDir,
      inspectUsableSourceDevSharedDepsLastGreen,
    }), false);
    assert.equal(await hasUsableUiWorkspaceLastGreen({
      uiPackageDir,
      inspectUsableSourceDevSharedDepsLastGreen,
    }), true);
    assert.deepEqual(calls, [
      [root, { workspaceNames: ['plugin-sdk'] }],
      [root, { workspaceNames: ['plugin-sdk'] }],
    ]);
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

  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');

  const env = { CI: '1' };
  await ensureUiWorkspacePackagesBuilt({
    env,
    verifyPatchedDependencies,
    syncSharedDepsForSourceDev,
    ensureWorkspacePackagesBuiltForComponent,
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0][0], 'verify');
  assert.match(String(calls[0][1].uiPackageDir), /apps\/ui$/);
  assert.equal(calls[1][0], 'build');
  assert.match(String(calls[1][1]), /apps\/ui$/);
  assert.deepEqual(calls[1][2], { quiet: false, env });
  assert.equal(calls[2][0], 'publish');
  assert.equal(calls[2][1], resolve(String(calls[1][1]), '../..'));
  assert.deepEqual(calls[2][2], {
    env,
    includeRuntimeDependencies: true,
    quiet: false,
    workspaceNames: ['plugins-inspector'],
  });
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
  });

  assert.deepEqual(calls, ['verify', 'build']);
});

test('ensureUiWorkspacePackagesBuilt throws when apps/ui is not inside a Happier monorepo checkout', async () => {
  const ensureWorkspacePackagesBuiltForComponent = async () => ({ ok: true, built: [], skipped: ['not-monorepo'] });
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');

  await assert.rejects(
    () => ensureUiWorkspacePackagesBuilt({
      env: { CI: '1' },
      verifyPatchedDependencies: () => {},
      syncSharedDepsForSourceDev: async () => ({ synced: false, stamped: true }),
      ensureWorkspacePackagesBuiltForComponent,
    }),
    /\bnot-monorepo\b/i
  );
});
