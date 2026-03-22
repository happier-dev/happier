import assert from 'node:assert/strict';
import test from 'node:test';

import { collectWiringReport } from './validateTestWiring.ts';
import { FEATURE_IDS } from './lib/protocolFeatureIds.ts';

test('collectWiringReport counts lanes and feature tagged files', () => {
  const featureId = FEATURE_IDS[0];
  const report = collectWiringReport([
    'apps/ui/sources/screens/home.spec.tsx',
    `apps/server/sources/app/features/example.feat.${featureId}.spec.ts`,
    'packages/tests/suites/ui-e2e/login.spec.ts',
  ]);

  assert.equal(report.featureTaggedFiles, 1);
  assert.equal(report.laneCounts.test, 2);
  assert.equal(report.laneCounts['test:e2e:ui'], 1);
  assert.equal(report.issues.length, 0);
});

test('collectWiringReport surfaces invalid feature tags and miswired lane names', () => {
  const report = collectWiringReport([
    'apps/server/sources/app/features/example.feat.not-real.spec.ts',
    'packages/tests/suites/ui-e2e/login.test.ts',
  ]);

  assert.equal(report.featureTaggedFiles, 1);
  assert.match(report.issues.map((issue) => issue.message).join('\n'), /Invalid feature test tag/);
  assert.match(report.issues.map((issue) => issue.message).join('\n'), /UI E2E tests must use \*\.spec\.ts/);
});

test('collectWiringReport merges parity issues when repo metadata drifts', () => {
  const report = collectWiringReport(['packages/tests/suites/core-e2e/login.test.ts'], {
    packageJsonText: JSON.stringify({ scripts: { test: 'yarn -s test:unit' } }),
    workflowText: '',
    docsText: '',
    configTexts: {},
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Missing root script test:integration/);
  assert.match(messages, /Docs are missing command yarn test/);
});
