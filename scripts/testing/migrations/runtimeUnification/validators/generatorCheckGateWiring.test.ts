import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT_DIR = join(import.meta.dirname, '../../../../..');
const ROOT_SCRIPT_NAME = 'test:migration:bundled-plugin-projections';
const GENERATOR_CHECK_COMMAND =
  'node apps/cli/scripts/withNodeHeapLimit.mjs node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts --mode check';

function readRootScripts(): Record<string, string | undefined> {
  const packageJson = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string | undefined>;
  };
  return packageJson.scripts ?? {};
}

test('root scripts expose a non-writing bundled plugin projection drift check', () => {
  const scripts = readRootScripts();

  assert.equal(scripts[ROOT_SCRIPT_NAME], GENERATOR_CHECK_COMMAND);
  assert.doesNotMatch(scripts[ROOT_SCRIPT_NAME] ?? '', /--mode\s+write/);
});

test('runtime-unification gate enforces bundled plugin projection drift through the root script', () => {
  const scripts = readRootScripts();
  const gateText = readFileSync(
    join(ROOT_DIR, '.project/plans/runtime-unification-v2/_validation/verify-gate.sh'),
    'utf8',
  );

  assert.match(scripts['test:migration:governance'] ?? '', /test:migration:bundled-plugin-projections/);
  assert.match(gateText, /yarn -s test:migration:bundled-plugin-projections/);
  assert.doesNotMatch(gateText, /generateBundledPluginEntries\.ts[^'"]*--mode\s+write/);
});
