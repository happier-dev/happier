import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTestFile, collectLaneIssues, resolveFeatureTagIssue } from './testLaneMap.ts';
import { FEATURE_IDS } from './protocolFeatureIds.ts';

test('classifies representative lane paths', () => {
  assert.equal(classifyTestFile('apps/ui/sources/screens/home.spec.tsx'), 'test');
  assert.equal(classifyTestFile('apps/ui/sources/screens/home.integration.test.tsx'), 'test:integration');
  assert.equal(classifyTestFile('apps/cli/src/run.slow.test.ts'), 'cli:test:slow');
  assert.equal(classifyTestFile('apps/website/tests/index.release.test.js'), 'website:test');
  assert.equal(classifyTestFile('apps/server/sources/app/db.dbcontract.spec.ts'), 'test:db-contract:docker');
  assert.equal(classifyTestFile('packages/protocol/src/example.test.ts'), 'test');
  assert.equal(classifyTestFile('packages/release-runtime/tests/http.test.mjs'), 'release-runtime:test');
  assert.equal(classifyTestFile('packages/tests/suites/core-e2e/login.test.ts'), 'test:e2e:core:fast');
  assert.equal(classifyTestFile('packages/tests/suites/core-e2e/login.slow.e2e.test.ts'), 'test:e2e:core:slow');
  assert.equal(classifyTestFile('packages/tests/suites/ui-e2e/login.spec.ts'), 'test:e2e:ui');
  assert.equal(classifyTestFile('packages/tests/suites/providers/auth.test.ts'), 'test:providers');
  assert.equal(classifyTestFile('packages/tests/suites/stress/retry.test.ts'), 'test:stress');
  assert.equal(classifyTestFile('apps/stack/scripts/runtime.test.mjs'), 'stack:test:unit');
  assert.equal(classifyTestFile('apps/stack/scripts/runtime.integration.test.mjs'), 'stack:test:integration');
  assert.equal(classifyTestFile('apps/stack/scripts/runtime.real.integration.test.mjs'), 'stack:test:real-integration');
});

test('accepts valid feature ids and flags invalid ones', () => {
  const validFeatureId = FEATURE_IDS[0];
  assert.equal(resolveFeatureTagIssue(`apps/server/sources/app/features/example.feat.${validFeatureId}.spec.ts`), null);
  assert.match(resolveFeatureTagIssue('apps/server/sources/app/features/example.feat.not-a-real-feature.spec.ts') ?? '', /Invalid feature test tag/);
});

test('flags known lane naming violations', () => {
  assert.deepEqual(collectLaneIssues('packages/tests/suites/ui-e2e/login.test.ts'), [
    'UI E2E tests must use *.spec.ts under packages/tests/suites/ui-e2e.',
    'No lane mapping matched packages/tests/suites/ui-e2e/login.test.ts.',
  ]);
  assert.deepEqual(collectLaneIssues('apps/stack/scripts/runtime.integration.spec.mjs'), [
    'Stack integration tests must use *.integration.test.* naming.',
  ]);
  assert.deepEqual(collectLaneIssues('apps/stack/scripts/runtime.spec.mjs'), [
    'Stack unit tests must use *.test.* naming.',
  ]);
  assert.deepEqual(collectLaneIssues('packages/tests/suites/core-e2e/login.slow.test.ts'), [
    'Core E2E slow files must use *.slow.e2e.test.ts naming.',
  ]);
});
