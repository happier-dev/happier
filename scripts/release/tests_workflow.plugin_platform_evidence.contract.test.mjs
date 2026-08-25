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

test('automatic CI exercises the packed plugin-platform vertical with its natural artifacts', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const workflow = YAML.parse(raw);
  const packedJob = extractJobBlock(raw, 'plugin-platform-packed');

  assert.equal(
    workflow?.jobs?.['plugin-platform-packed']?.name,
    'Plugin Platform (natural packed artifacts)',
  );

  assert.match(
    packedJob,
    /if:\s*\$\{\{\s*\(github\.event_name != 'workflow_dispatch' && github\.event_name != 'workflow_call'\) \|\| inputs\.run_plugin_platform_packed\s*\}\}/,
    'the packed proof should run automatically for normal events and when an explicit reusable caller selects it',
  );
  assert.match(
    packedJob,
    /yarn -s workspace @happier-dev\/tests build:plugin-platform:natural/,
    'the packed proof should build its natural artifact inputs through the canonical builder',
  );
  assert.match(packedJob, /--run-id "\$PACKED_PLUGIN_PLATFORM_RUN_ID"/);
  assert.match(packedJob, /--output-root "\$PACKED_PLUGIN_PLATFORM_OUTPUT_ROOT"/);
  for (const artifactField of [
    'sdkTarballPath',
    'pluginUiTarballPath',
    'channelsProtocolTarballPath',
    'cliTarballPath',
  ]) {
    assert.match(
      packedJob,
      new RegExp(`artifactInputs\\.${artifactField}`),
      `the packed runner should receive the builder's ${artifactField}`,
    );
  }
  assert.match(
    packedJob,
    /yarn -s workspace @happier-dev\/tests test:plugin-platform:packed-author/,
    'the packed proof should pass the exact natural SDK, Plugin UI, and CLI tarballs to the existing vertical runner',
  );
  assert.match(packedJob, /--sdk-tarball "\$PACKED_PLUGIN_PLATFORM_SDK_TARBALL"/);
  assert.match(packedJob, /--plugin-ui-tarball "\$PACKED_PLUGIN_PLATFORM_PLUGIN_UI_TARBALL"/);
  assert.match(packedJob, /--cli-tarball "\$PACKED_PLUGIN_PLATFORM_CLI_TARBALL"/);
  assert.doesNotMatch(packedJob, /--native-target|--native-artifacts-dir/);
});

test('the reusable full profile selects the packed plugin-platform job', async () => {
  const testsRaw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const dispatchRaw = await readFile(join(repoRoot, '.github', 'workflows', 'tests-dispatch.yml'), 'utf8');
  const testsWorkflow = YAML.parse(testsRaw);
  const dispatchWorkflow = YAML.parse(dispatchRaw);

  assert.equal(testsWorkflow?.on?.workflow_call?.inputs?.run_plugin_platform_packed?.type, 'boolean');
  assert.match(extractJobBlock(testsRaw, 'plugin-platform-packed'), /inputs\.run_plugin_platform_packed/u);
  assert.equal(dispatchWorkflow?.jobs?.resolve?.outputs?.run_plugin_platform_packed, '${{ steps.flags.outputs.run_plugin_platform_packed }}');
  assert.match(dispatchRaw, /if \[ "\$\{profile\}" = "full" \]; then[\s\S]*run_plugin_platform_packed=true/u);
  assert.equal(dispatchWorkflow?.jobs?.tests?.with?.run_plugin_platform_packed, "${{ needs.resolve.outputs.run_plugin_platform_packed == 'true' }}");
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

test('automatic CI runs the out-of-tree Channels provider fixture against the built channels-protocol tarball', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'tests.yml'), 'utf8');
  const packedJob = extractJobBlock(raw, 'plugin-platform-packed');

  assert.match(
    packedJob,
    /PACKED_PLUGIN_PLATFORM_CHANNELS_PROTOCOL_TARBALL', artifactInputs\.channelsProtocolTarballPath/,
    'the already-built channels-protocol tarball must be projected, not discarded',
  );
  assert.match(
    packedJob,
    /yarn -s workspace @happier-dev\/tests test:plugin-platform:out-of-tree-channel-socket-provider/,
    'the packed external Channels provider fixture must run in the same natural-artifact lane',
  );
  assert.match(
    packedJob,
    /CHANNELS_PROTOCOL_TARBALL="\$PACKED_PLUGIN_PLATFORM_CHANNELS_PROTOCOL_TARBALL"/,
    'the fixture reads the candidate protocol archive from CHANNELS_PROTOCOL_TARBALL',
  );
  assert.match(
    packedJob,
    /PLUGIN_SDK_TARBALL="\$PACKED_PLUGIN_PLATFORM_SDK_TARBALL"/,
    'the fixture reads the candidate SDK archive from PLUGIN_SDK_TARBALL',
  );
});

test('the existing weekly automatic workflow reaches the slow core route', async () => {
  const raw = await readFile(join(repoRoot, '.github', 'workflows', 'self-host-e2e.yml'), 'utf8');
  const workflow = YAML.parse(raw);

  assert.match(raw, /schedule:\s*\n\s*# Weekly \(UTC\)\s*\n\s*- cron:/);
  assert.equal(workflow?.jobs?.self_host?.uses, './.github/workflows/tests.yml');
  assert.equal(workflow?.jobs?.self_host?.with?.run_e2e_core_slow, true);
});
