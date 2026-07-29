import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

async function collectProductionModules(root) {
  const modules = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) modules.push(...await collectProductionModules(path));
    else if (entry.name.endsWith('.mjs') && !entry.name.includes('.test.')) modules.push(path);
  }
  return modules;
}

test('every production runtime CLI launch-spec consumer preserves canonical provenance', async () => {
  const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const ownerPath = join(scriptsDir, 'runtime', 'launch', 'resolveCliRuntimeLaunchSpec.mjs');
  const omissions = [];
  for (const path of await collectProductionModules(scriptsDir)) {
    if (path === ownerPath) continue;
    const source = await readFile(path, 'utf8');
    if (!source.includes('resolveCliRuntimeLaunchSpec(')) continue;
    if (!source.includes('resolveCliRuntimeLaunchProvenance(') && !source.includes('applyCliRuntimeLaunchProvenanceEnv(')) {
      omissions.push(relative(scriptsDir, path));
    }
  }
  assert.deepEqual(omissions, []);
});
