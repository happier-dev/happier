import assert from 'node:assert/strict';
import test from 'node:test';

import { collectPluginWorkspaceTestPackageReport } from './lib/pluginWorkspaceTestPackages.ts';
import { collectWiringReport } from './validateTestWiring.ts';
import { FEATURE_IDS } from './lib/protocolFeatureIds.ts';

test('collectWiringReport counts lanes and feature tagged files', async () => {
  const featureId = FEATURE_IDS[0];
  const report = await collectWiringReport([
    'apps/ui/sources/screens/home.spec.tsx',
    `apps/server/sources/app/features/example.feat.${featureId}.spec.ts`,
    'packages/tests/suites/ui-e2e/login.spec.ts',
  ]);

  assert.equal(report.featureTaggedFiles, 1);
  assert.equal(report.laneCounts.test, 2);
  assert.equal(report.laneCounts['test:e2e:ui'], 1);
  assert.equal(report.issues.length, 0);
});

test('collectWiringReport surfaces invalid feature tags and miswired lane names', async () => {
  const report = await collectWiringReport([
    'apps/server/sources/app/features/example.feat.not-real.spec.ts',
    'packages/tests/suites/ui-e2e/login.test.ts',
  ]);

  assert.equal(report.featureTaggedFiles, 1);
  assert.match(report.issues.map((issue) => issue.message).join('\n'), /Invalid feature test tag/);
  assert.match(report.issues.map((issue) => issue.message).join('\n'), /UI E2E tests must use \*\.spec\.ts/);
});

test('collectWiringReport merges parity issues when repo metadata drifts', async () => {
  const report = await collectWiringReport(['packages/tests/suites/core-e2e/login.test.ts'], {
    packageJsonText: JSON.stringify({ scripts: { test: 'yarn -s test:unit' } }),
    workflowText: '',
    docsText: '',
    configTexts: {},
  });

  const messages = report.issues.map((issue) => issue.message).join('\n');
  assert.match(messages, /Missing root script test:integration/);
  assert.match(messages, /Docs are missing command yarn test/);
});

test('collectWiringReport fails plugin test wiring when a workspace has no executable test script', async () => {
  const pluginWorkspaceTestPackageReport = collectPluginWorkspaceTestPackageReport({
    rootDir: '/repo',
    workspacePackageManifests: [
      {
        packageJsonPath: '/repo/packages/plugins/missing-test/package.json',
        packageJsonText: JSON.stringify({
          name: '@happier-dev/plugins-missing-test',
          scripts: {},
        }),
      },
    ],
  });
  const report = await collectWiringReport([
    'packages/plugins/missing-test/src/example.test.ts',
  ], {
    pluginWorkspaceTestPackageReport,
  });

  assert.equal(report.laneCounts['test:plugin-workspaces'], 1);
  assert.match(
    report.issues.map((issue) => issue.message).join('\n'),
    /Plugin workspace packages\/plugins\/missing-test must define a non-empty test script/,
  );
});
