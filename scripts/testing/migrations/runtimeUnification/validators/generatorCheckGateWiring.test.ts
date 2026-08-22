import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT_DIR = join(import.meta.dirname, '../../../../..');
const ROOT_SCRIPT_NAME = 'test:migration:bundled-plugin-projections';
const RUNTIME_DETERMINISM_SCRIPT_NAME = 'test:migration:bundled-plugin-runtime-determinism';
const GENERATOR_CHECK_COMMAND =
  'node apps/cli/scripts/withNodeHeapLimit.mjs node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts --mode check --scope projections';
const GENERATOR_RUNTIME_DETERMINISM_COMMAND =
  'node apps/cli/scripts/withNodeHeapLimit.mjs node --experimental-strip-types scripts/migrations/extensions/generateBundledPluginEntries.ts --mode check --scope all';
const RUNTIME_UNIFICATION_VALIDATOR_COMMAND =
  'node --experimental-strip-types scripts/testing/migrations/runtimeUnification/validateReleaseContract.ts';
const FINAL_UNIFICATION_CHECK_COMMAND =
  'node --experimental-strip-types scripts/testing/migrations/runtimeUnification/checkFullyUnified.ts --final';
const BROAD_RUNTIME_UNIFICATION_GATE_COMMAND =
  'bash .project/plans/runtime-unification-v2/_validation/verify-gate.sh';
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

// The publisher re-stages every bundled daemon runtime with the current
// `plugin-sdk`/`protocol` output inlined, so the byte-equality question is a
// whole-repo build-determinism question that a plugin-projection failure must
// not be confused with. Both scopes stay wired, under their own names.
test('root scripts expose the bundled runtime build-determinism check as a separate signal', () => {
  const scripts = readRootScripts();

  assert.equal(scripts[RUNTIME_DETERMINISM_SCRIPT_NAME], GENERATOR_RUNTIME_DETERMINISM_COMMAND);
  assert.doesNotMatch(scripts[RUNTIME_DETERMINISM_SCRIPT_NAME] ?? '', /--mode\s+write/);
  assert.notEqual(scripts[ROOT_SCRIPT_NAME], scripts[RUNTIME_DETERMINISM_SCRIPT_NAME]);
});

test('runtime-unification gate enforces bundled plugin projection drift through the root script', () => {
  const scripts = readRootScripts();
  const gateText = readFileSync(
    join(ROOT_DIR, '.project/plans/runtime-unification-v2/_validation/verify-gate.sh'),
    'utf8',
  );

  assert.match(scripts['test:migration:governance'] ?? '', /test:migration:bundled-plugin-projections/);
  assert.match(scripts['test:migration:governance'] ?? '', /test:migration:bundled-plugin-runtime-determinism/);
  assert.match(gateText, /yarn -s test:migration:bundled-plugin-projections/);
  assert.doesNotMatch(gateText, /generateBundledPluginEntries\.ts[^'"]*--mode\s+write/);
});

test('root migration governance runs the composed runtime-unification validator gate', () => {
  const scripts = readRootScripts();
  const governanceScript = scripts['test:migration:governance'] ?? '';

  assert.match(governanceScript, /test:migration:bundled-plugin-projections/);
  assert.match(governanceScript, /test:migration:bundled-plugin-runtime-determinism/);
  assert.ok(governanceScript.includes(RUNTIME_UNIFICATION_VALIDATOR_COMMAND));
  assert.ok(governanceScript.includes(FINAL_UNIFICATION_CHECK_COMMAND));
  assert.ok(governanceScript.includes(BROAD_RUNTIME_UNIFICATION_GATE_COMMAND));
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
