import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import YAML from 'yaml';

const repoRoot = join(import.meta.dirname, '..', '..');

function extractJobBlock(raw, jobName) {
  const match = raw.match(new RegExp(`(?:^|\\n)  ${jobName}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:|\\n$)`));
  assert.ok(match, `expected to find job block for ${jobName}`);
  return match[1];
}

test('automatic CI exercises Plugin Platform feature contracts from current source', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  assert.equal(workflow?.jobs?.['plugin-platform-packed'], undefined);
  assert.equal(workflow?.on?.workflow_call?.inputs?.run_plugin_platform_packed, undefined);
  assert.match(raw, /yarn workspace @happier-dev\/tests test:plugin-platform:source/u);
  assert.doesNotMatch(raw, /build:plugin-platform:natural|PACKED_PLUGIN_PLATFORM_|test:plugin-platform:packed-/u);
});

test('the reusable full profile cannot select a release-representation feature gate', async () => {
  const testsRaw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const dispatchRaw = await readFile(join(repoRoot, '.github', 'workflows', 'tests-dispatch.yml'), 'utf8');
  const testsWorkflow = YAML.parse(testsRaw);
  const dispatchWorkflow = YAML.parse(dispatchRaw);

  assert.equal(testsWorkflow?.on?.workflow_call?.inputs?.run_plugin_platform_packed, undefined);
  assert.equal(dispatchWorkflow?.jobs?.resolve?.outputs?.run_plugin_platform_packed, undefined);
  assert.equal(dispatchWorkflow?.jobs?.tests?.with?.run_plugin_platform_packed, undefined);
  assert.doesNotMatch(dispatchRaw, /plugin_platform_packed/u);
});

test('ordinary UI E2E path filtering includes its source-loaded Protocol and SDK dependencies', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const uiE2eJob = extractJobBlock(raw, 'ui-e2e');
  for (const dependency of [
    'packages/protocol/**',
    'packages/plugin-sdk/**',
    'packages/plugin-ui/**',
    'packages/sdk/**',
  ]) {
    assert.match(uiE2eJob, new RegExp(`- '${dependency.replaceAll('*', '\\*')}'`));
  }
});

test('automatic CI runs the public-only out-of-tree fixtures without a package archive', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const testsPackage = JSON.parse(await readFile(join(repoRoot, 'packages', 'tests', 'package.json'), 'utf8'));
  const sourceLane = testsPackage.scripts['test:plugin-platform:source'];
  assert.match(sourceLane, /out-of-tree-channel-socket-provider\/test\/public-only\.test\.mjs/u);
  assert.match(sourceLane, /out-of-tree-channel-socket-provider\/test\/public-runtime\.test\.mjs/u);
  assert.match(sourceLane, /composer-external-dogfood\/test\/public-only\.test\.mjs/u);
  assert.doesNotMatch(sourceLane, /pack-fixture|installedTarballProof|action-contract-composition|\.tgz|tarball/iu);
  assert.match(raw, /yarn workspace @happier-dev\/tests test:plugin-platform:source/u);
});

test('the existing weekly automatic workflow reaches the slow core route', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'self-host-e2e.yml'), 'utf8');
  const workflow = YAML.parse(raw);

  assert.match(raw, /schedule:\s*\n\s*# Weekly \(UTC\)\s*\n\s*- cron:/);
  assert.equal(workflow?.jobs?.self_host?.uses, './.github/workflows/tests.yml');
  assert.equal(workflow?.jobs?.self_host?.with?.run_e2e_core_slow, true);
});
