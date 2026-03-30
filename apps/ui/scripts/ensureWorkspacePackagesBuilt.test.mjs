import test from 'node:test';
import assert from 'node:assert/strict';

test('ensureUiWorkspacePackagesBuilt calls stack workspace build helper for apps/ui', async () => {
  const calls = [];
  const ensureWorkspacePackagesBuiltForComponent = async (componentDir, options) => {
    calls.push([componentDir, options]);
    return { ok: true, built: [], skipped: [] };
  };

  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');

  const env = { CI: '1' };
  await ensureUiWorkspacePackagesBuilt({ env, ensureWorkspacePackagesBuiltForComponent });

  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /apps\/ui$/);
  assert.deepEqual(calls[0][1], { quiet: false, env });
});

test('ensureUiWorkspacePackagesBuilt throws when apps/ui is not inside a Happier monorepo checkout', async () => {
  const ensureWorkspacePackagesBuiltForComponent = async () => ({ ok: true, built: [], skipped: ['not-monorepo'] });
  const { ensureUiWorkspacePackagesBuilt } = await import('./ensureWorkspacePackagesBuilt.mjs');

  await assert.rejects(
    () => ensureUiWorkspacePackagesBuilt({ env: { CI: '1' }, ensureWorkspacePackagesBuiltForComponent }),
    /\bnot-monorepo\b/i
  );
});
