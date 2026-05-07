import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

async function readJson(relativePath) {
  const raw = await readFile(resolve(repoRoot, relativePath), 'utf8');
  return JSON.parse(raw);
}

test('cli-common build scripts resolve TypeScript through the package-manager path instead of a hardcoded repo-root binary', async () => {
  const pkg = await readJson('packages/cli-common/package.json');
  const buildScript = await readFile(resolve(repoRoot, 'packages/cli-common/scripts/build.mjs'), 'utf8');

  assert.equal(String(pkg?.scripts?.build ?? ''), 'node scripts/build.mjs');
  assert.match(String(pkg?.scripts?.typecheck ?? ''), /\btsc --noEmit -p tsconfig\.json\b/);
  assert.match(buildScript, /\btsc\b/);
  assert.match(buildScript, /\bnpm_execpath\b/);
  assert.doesNotMatch(
    `${String(pkg?.scripts?.build ?? '')}\n${buildScript}`,
    /node_modules\/typescript\/bin\/tsc/,
    'cli-common build should not hardcode a repo-root TypeScript binary path'
  );
  assert.doesNotMatch(
    String(pkg?.scripts?.typecheck ?? ''),
    /node_modules\/typescript\/bin\/tsc/,
    'cli-common typecheck should not hardcode a repo-root TypeScript binary path'
  );
});
