import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectWiringReport, loadDefaultParityInput } from './validateTestWiring.ts';
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

test('default parity input includes test commands owned by dispatch workflows', () => {
  const input = loadDefaultParityInput();

  assert.ok(input);
  assert.match(input.workflowText, /yarn -s test:e2e:ui:wsrepl:lima\b/);
});

test('standalone governance commands fail closed when the canonical parity corpus is missing', async (t) => {
  const incompleteRoot = mkdtempSync(join(tmpdir(), 'happier-test-wiring-incomplete-'));
  t.after(() => rmSync(incompleteRoot, { recursive: true, force: true }));
  const featureCatalogPath = join(incompleteRoot, 'packages/protocol/src/features/catalog.ts');
  mkdirSync(join(incompleteRoot, 'packages/protocol/src/features'), { recursive: true });
  writeFileSync(featureCatalogPath, 'const catalog = {\n  example: {\n', 'utf8');

  for (const scriptName of ['validateTestWiring.ts', 'validateTestInventory.ts']) {
    await t.test(scriptName, () => {
      const result = spawnSync(
        process.execPath,
        ['--experimental-strip-types', fileURLToPath(new URL(`./${scriptName}`, import.meta.url))],
        { cwd: incompleteRoot, encoding: 'utf8' },
      );

      assert.notEqual(result.status, 0, `${scriptName} unexpectedly passed:\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /ENOENT/);
    });
  }
});
