import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

async function readProductionModules(rootDir) {
  const modules = [];
  const visit = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (
        entry.isFile()
        && entry.name.endsWith('.mjs')
        && !entry.name.endsWith('.test.mjs')
      ) {
        modules.push({
          path: relative(rootDir, path),
          source: await readFile(path, 'utf8'),
        });
      }
    }
  };
  await visit(rootDir);
  return modules;
}

test('removed overlapping server reload authorities do not return', async () => {
  const production = await readProductionModules(scriptsDir);
  const forbidden = /blueGreen|restartWithBlueGreenProxy|resolveDevServerOverlapCapability|overlapCapability|cutoverUpstream|cutoverStatus|cutoverCommitUnknown|createCutoverOperationJournal/;
  const offenders = production
    .filter(({ source }) => forbidden.test(source))
    .map(({ path }) => path);

  assert.deepEqual(offenders, []);
});
