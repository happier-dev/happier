import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../..', import.meta.url).pathname;

test('manual tests dispatch can run an exact bounded UI E2E spec selection', async () => {
  const dispatch = await readFile(join(repoRoot, '.github', 'workflows', 'tests-dispatch.yml'), 'utf8');
  const reusable = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');

  assert.match(dispatch, /ui_e2e_specs:/, 'manual dispatch should expose the optional exact-spec selection');
  assert.match(dispatch, /profile=custom is required when ui_e2e_specs is set/, 'full and fast profiles must not be narrowed by a targeted selection');
  assert.match(dispatch, /custom_checks must include ui_e2e when ui_e2e_specs is set/, 'a targeted selection must activate its owning lane');
  assert.match(dispatch, /ui_e2e_specs:\s*\$\{\{\s*needs\.resolve\.outputs\.ui_e2e_specs\s*\}\}/, 'dispatch should pass only the admitted selection to the reusable workflow');
  assert.match(reusable, /UI_E2E_SPECS:\s*\$\{\{\s*inputs\.ui_e2e_specs\s*\}\}/, 'the UI E2E job should receive the selection only as environment data');
  assert.match(reusable, /packages\/tests\/suites\/ui-e2e\/\*\.spec\.ts/, 'targeted specs should be restricted to the canonical UI E2E directory');
  assert.match(reusable, /yarn -s test:e2e:ui -- "\$\{specs\[@\]\}"/, 'validated specs should be passed as a quoted argument array');
  assert.match(reusable, /\[1,2,3,4,5,6,7,8,9\]/, 'an empty selection should preserve the complete nine-shard gate');
  assert.match(reusable, /name:\s*ui-e2e-playwright-artifacts[\s\S]*?compression-level:\s*0/, 'failure artifacts should skip recompressing browser media');
});
