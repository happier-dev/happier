import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const { scripts } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('protocol-backed website source commands prepare their canonical workspace dependencies on cold checkouts', () => {
  // Script lifecycle configuration is the public entry boundary. Inspect it
  // without invoking preparation, which publishes shared workspace outputs.
  assert.equal(
    scripts['prepare:workspace-deps'],
    'node ../../scripts/workspaces/ensureWorkspacePackagesBuiltCli.mjs --for-component=apps/website',
  );
  for (const command of ['generate:plugin-manifest-schema', 'generate:marketplace-catalog', 'test:local', 'typecheck:local']) {
    assert.equal(scripts[`pre${command}`], 'pnpm --silent run prepare:workspace-deps', command);
  }
});
