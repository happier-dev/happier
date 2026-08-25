import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');

function extractJobBlock(raw, jobName) {
  const match = raw.match(new RegExp(`(?:^|\\n)  ${jobName}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9-]+:|\\n$)`));
  assert.ok(match, `expected to find job block for ${jobName}`);
  return match[1];
}

test('tests workflow keeps slow CI jobs above the observed timeout floor', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const uiE2eJob = extractJobBlock(raw, 'ui-e2e');
  const uiUnitJob = extractJobBlock(raw, 'ui-unit');
  const uiIntegrationJob = extractJobBlock(raw, 'ui-integration');
  const serverJob = extractJobBlock(raw, 'server');
  const stackJob = extractJobBlock(raw, 'stack');
  const installerSmokeWindowsJob = extractJobBlock(raw, 'installers-smoke-windows');

  assert.match(
    uiE2eJob,
    /name:\s*UI E2E \(Playwright\)[\s\S]*?timeout-minutes:\s*120\b/,
    'UI E2E job should reserve enough time to finish the slow multi-session Playwright scenarios on GitHub-hosted runners',
  );
  assert.match(uiE2eJob, /shard:\s*\$\{\{ fromJSON\(inputs\.ui_e2e_specs != ''/);
  assert.match(uiE2eJob, /--shard=\$\{\{ matrix\.shard \}\}\/9/);

  assert.match(
    uiUnitJob,
    /name:\s*UI Unit Tests[\s\S]*?timeout-minutes:\s*120\b/,
    'each UI unit partition should reserve enough time for six heap-bounded shards',
  );
  assert.match(uiUnitJob, /part:\s*\[1, 2, 3, 4\]/);
  assert.match(uiUnitJob, /HAPPIER_UI_VITEST_PART:\s*\$\{\{ matrix\.part \}\}/);
  assert.match(uiIntegrationJob, /name:\s*UI Integration Tests[\s\S]*?timeout-minutes:\s*240\b/);

  assert.match(
    serverJob,
    /name:\s*Server Tests \(unit \+ integration\)[\s\S]*?timeout-minutes:\s*45\b/,
    'Server Tests should reserve enough time for dependency installation plus unit and integration suites',
  );

  assert.match(
    stackJob,
    /name:\s*Stack Tests \(unit \+ integration\)[\s\S]*?timeout-minutes:\s*45\b/,
    'Stack Tests should reserve enough time for dependency installation plus unit and integration suites',
  );

  assert.match(
    installerSmokeWindowsJob,
    /name:\s*Installer Smoke \(Windows\)[\s\S]*?timeout-minutes:\s*45\b/,
    'Windows installer smoke should reserve enough time to finish published-channel validation on GitHub-hosted runners',
  );
});

test('UI unit and integration suites run independently before the stable aggregate check', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const uiUnitJob = extractJobBlock(raw, 'ui-unit');
  const uiIntegrationJob = extractJobBlock(raw, 'ui-integration');
  const uiJob = extractJobBlock(raw, 'ui');

  assert.match(uiUnitJob, /yarn workspace @happier-dev\/protocol test/);
  assert.match(uiUnitJob, /yarn workspace @happier-dev\/app test:unit/);
  assert.doesNotMatch(uiUnitJob, /test:integration/);
  assert.match(uiIntegrationJob, /yarn workspace @happier-dev\/app test:integration/);

  assert.match(uiJob, /name:\s*UI Tests \(unit \+ integration\)/);
  assert.match(uiJob, /needs:\s*\[ui-unit, ui-integration\]/);
  assert.match(uiJob, /if:\s*\$\{\{ always\(\)/);
  assert.match(uiJob, /needs\.ui-unit\.result/);
  assert.match(uiJob, /needs\.ui-integration\.result/);
});

test('UI E2E failure artifacts exclude whole fixture trees while retaining diagnostics', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const uiE2eJob = extractJobBlock(raw, 'ui-e2e');

  assert.match(uiE2eJob, /packages\/tests\/\.project\/logs\/e2e\/ui-playwright/);
  assert.match(uiE2eJob, /\.project\/logs\/e2e\/\*ui-e2e\*\/\*\*\/\*\.log/);
  assert.match(uiE2eJob, /\.project\/logs\/e2e\/\*ui-e2e\*\/\*\*\/\*\.jsonl/);
  assert.match(uiE2eJob, /\.project\/logs\/e2e\/\*ui-e2e\*\/\*\*\/\*\.result\.json/);
  assert.doesNotMatch(
    uiE2eJob,
    /^\s*\.project\/logs\/e2e\/\*ui-e2e\*\s*$/m,
    'whole UI E2E run roots include disposable package snapshots, databases, and credentials and can exceed the artifact uploader heap',
  );
});
