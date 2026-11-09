import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('hstack start routes every source-backed server spawn through the canonical declaration admission owner', async () => {
  const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');

  assert.equal(source.includes("from './utils/server/source_server_workspace_deps.mjs'"), true);
  assert.equal(source.includes('pmSpawnScript'), false, 'run.mjs must not bypass source-server admission');
  assert.equal(
    source.includes("spawnSourceServerScript({ label: 'server', serverDir, script: 'start', env: backendEnv })"),
    true,
  );
  assert.equal(
    source.includes("spawnSourceServerScript({ label: 'server', serverDir, script: serverStartScript, env })"),
    true,
  );
});
