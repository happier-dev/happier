import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT_DIR = join(import.meta.dirname, '../../../../..');
const ROOT_SCRIPT_NAME = 'test:migration:bundled-plugin-projections';
const GENERATOR_CHECK_COMMAND =
  'node apps/cli/scripts/withNodeHeapLimit.mjs node --experimental-strip-types apps/cli/scripts/build-owned/generateBundledPluginEntries.ts --mode check --scope projections';
const RUNTIME_UNIFICATION_VALIDATOR_COMMAND =
  'node --experimental-strip-types scripts/testing/migrations/runtimeUnification/validateReleaseContract.ts';
const FINAL_UNIFICATION_CHECK_COMMAND =
  'node --experimental-strip-types scripts/testing/migrations/runtimeUnification/checkFullyUnified.ts --final';
const STRIPPED_PATH_SMOKE_COMMAND =
  'node --experimental-strip-types --test scripts/testing/smoke/strippedPathBinarySmoke.test.ts';

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

test('root migration governance runs tracked product validators without ignored plan-ledger closure', () => {
  const scripts = readRootScripts();
  const governanceScript = scripts['test:migration:governance'] ?? '';

  assert.match(governanceScript, /test:migration:bundled-plugin-projections/);
  assert.ok(governanceScript.includes(RUNTIME_UNIFICATION_VALIDATOR_COMMAND));
  assert.ok(!governanceScript.includes(FINAL_UNIFICATION_CHECK_COMMAND));
  assert.doesNotMatch(governanceScript, /(?:^|\s)\.project\//);
  assert.doesNotMatch(governanceScript, /runAllValidators\.ts\b/);
  assert.doesNotMatch(governanceScript, /validateReleaseContract\.ts\s+--(?:list|json)\b/);
});

test('root policy self-checks include the composed runtime-unification validator tests', () => {
  const scripts = readRootScripts();

  assert.match(scripts['test:policy:self'] ?? '', /scripts\/testing\/migrations\/runtimeUnification\/validators\/\*\.test\.ts/);
  assert.match(scripts['test:policy:self'] ?? '', /scripts\/testing\/migrations\/runtimeUnification\/\*\.test\.ts/);
  assert.match(scripts['test:policy:self'] ?? '', /scripts\/testing\/smoke\/\*\.test\.ts/);
});

test('root scripts expose the stripped-PATH binary smoke', () => {
  const scripts = readRootScripts();

  assert.equal(scripts['test:smoke:stripped-path'], STRIPPED_PATH_SMOKE_COMMAND);
});
