import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LANE_ROOT_SCRIPTS,
  buildTestLaneContext,
  classifyTestFile,
  collectLaneIssues,
  resolveFeatureTagIssue,
  type TestLaneContext,
} from './testLaneMap.ts';
import { FEATURE_IDS } from './protocolFeatureIds.ts';
import { collectWorkspaceManifests } from './workspaceManifests.ts';

function workspaceManifests(
  entries: readonly Readonly<{ directory: string; name: string; scripts?: Readonly<Record<string, string>> }>[],
) {
  return collectWorkspaceManifests({
    rootDir: '/repo',
    workspacePackageJsons: entries.map((entry) => ({
      packageJsonPath: `/repo/${entry.directory}/package.json`,
      packageJsonText: JSON.stringify({ name: entry.name, scripts: entry.scripts ?? { test: 'vitest run' } }),
    })),
  });
}

const REPOSITORY_WORKSPACE_DIRECTORIES = [
  { directory: 'apps/bootstrap', name: '@happier-dev/bootstrap' },
  { directory: 'apps/cli', name: '@happier-dev/cli' },
  { directory: 'apps/server', name: '@happier-dev/server' },
  { directory: 'apps/stack', name: '@happier-dev/stack' },
  { directory: 'apps/ui', name: '@happier-dev/app' },
  { directory: 'apps/website', name: '@happier-dev/website' },
  { directory: 'packages/channels-protocol', name: '@happier-dev/channels-protocol' },
  { directory: 'packages/peer-mediation', name: '@happier-dev/peer-mediation' },
  {
    directory: 'packages/plugin-sdk',
    name: '@happier-dev/plugin-sdk',
    // Mirrors the real workspace: the vitest run covers `src/**` wholesale but excludes the
    // `examples/**` node:test files, so only the explicit `node --test` list runs those.
    scripts: {
      test: 'vitest run --exclude "examples/**/test/*.test.mjs" && node --test examples/named/test/index.test.mjs',
    },
  },
  { directory: 'packages/plugins/channels', name: '@happier-dev/plugins-channels' },
  { directory: 'packages/protocol', name: '@happier-dev/protocol' },
  { directory: 'packages/release-runtime', name: '@happier-dev/release-runtime' },
  { directory: 'packages/support', name: '@happier-dev/support' },
  {
    directory: 'packages/tests',
    name: '@happier-dev/tests',
    // Mirrors the real workspace: no vitest config includes `scripts/**`, so a file there runs
    // only where a `node --test` list names it — the Lima self lane names two, the workspace
    // `test` chain names some of the rest, and the remainder has no runner at all.
    scripts: {
      test: 'node --test scripts/plugin-platform/named-self.test.mjs',
      'test:ui:e2e:wsrepl:lima:self': 'node --test scripts/lima-vm.test.mjs scripts/wsrepl-lima-matrix.test.mjs',
    },
  },
] as const;

const ROOT_SCRIPTS = {
  test: 'apps/stack/bin/hstack-exec --script=test:local',
  'test:local': 'yarn -s test:unit:local',
  'test:unit:local': [
    'yarn workspace @happier-dev/protocol test',
    'yarn workspace @happier-dev/peer-mediation test',
    'yarn workspace @happier-dev/channels-protocol test',
    'yarn workspace @happier-dev/plugin-sdk test',
    'yarn workspace @happier-dev/support test',
    'yarn workspace @happier-dev/bootstrap test',
    'yarn workspace @happier-dev/app test',
    'yarn workspace @happier-dev/cli test:unit',
    'yarn --cwd apps/server test:unit',
    'yarn --cwd apps/stack test:unit',
  ].join(' && '),
  'test:e2e:ui:wsrepl:lima:self': 'yarn --cwd packages/tests test:ui:e2e:wsrepl:lima:self',
} satisfies Record<string, string>;

const LANE_CONTEXT: TestLaneContext = buildTestLaneContext({
  workspaceManifests: workspaceManifests(REPOSITORY_WORKSPACE_DIRECTORIES),
  rootScripts: ROOT_SCRIPTS,
});

test('classifies representative lane paths', () => {
    assert.equal(classifyTestFile(LANE_CONTEXT, 'apps/ui/sources/screens/home.spec.tsx'), 'test');
    assert.equal(classifyTestFile(LANE_CONTEXT, 'apps/ui/sources/screens/home.integration.test.tsx'), 'test:integration');
    assert.equal(classifyTestFile(LANE_CONTEXT, 'apps/ui/scripts/qa/tauriActivitySurfaces.native-e2e.test.mjs'), 'test:e2e:desktop:native');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'apps/cli/src/run.slow.test.ts'), 'cli:test:slow');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'apps/website/tests/index.release.test.js'), 'website:test');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'apps/server/sources/app/db.dbcontract.spec.ts'), 'test:db-contract:docker');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/protocol/src/example.test.ts'), 'test');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/peer-mediation/src/route/decision.test.ts'), 'test');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/peer-mediation/test/packageContents.test.mjs'), 'test');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/plugin-sdk/src/acp/__tests__/defineAcpBackend.test.ts'), 'test');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/plugin-sdk/src/engine.test.ts'), 'test');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/support/src/example.test.ts'), 'test');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/release-runtime/tests/http.test.mjs'), 'release-runtime:test');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/tests/suites/core-e2e/login.test.ts'), 'test:e2e:core:fast');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/tests/suites/core-e2e/login.slow.e2e.test.ts'), 'test:e2e:core:slow');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/tests/suites/ui-e2e/login.spec.ts'), 'test:e2e:ui');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/tests/scripts/wsrepl-lima-matrix.test.mjs'), 'test:e2e:ui:wsrepl:lima:self');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/tests/scripts/lima-vm.test.mjs'), 'test:e2e:ui:wsrepl:lima:self');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/tests/suites/agents/auth.test.ts'), 'test:agents');
  assert.equal(
    classifyTestFile(LANE_CONTEXT, 'packages/tests/src/scenarios/accountDirectory.registerDiscoverEnroll.scenario.ts'),
    'test:e2e:core:fast',
  );
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/tests/suites/stress/retry.test.ts'), 'test:stress');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'apps/stack/scripts/runtime.test.mjs'), 'stack:test:unit');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'apps/stack/scripts/runtime.integration.test.mjs'), 'stack:test:integration');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'apps/stack/scripts/runtime.real.integration.test.mjs'), 'stack:test:real-integration');
});

test('credits a lane only when that lane\'s script chain names the file', () => {
  // Both directories are excluded from their workspace's main runner, so directory membership is
  // not evidence that anything opens the file. Classifying the directory wholesale reported the
  // Lima self lane's neighbours as gated by a root script that runs exactly two other files, and
  // reported every published SDK example as covered by the vitest run that skips all of them.
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/tests/scripts/plugin-platform/named-self.test.mjs'), 'workspace:test');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/tests/scripts/plugin-platform/unnamed-self.test.mjs'), null);
  assert.deepEqual(collectLaneIssues(LANE_CONTEXT, 'packages/tests/scripts/plugin-platform/unnamed-self.test.mjs'), [
    'No lane mapping matched packages/tests/scripts/plugin-platform/unnamed-self.test.mjs.',
  ]);

  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/plugin-sdk/examples/named/test/index.test.mjs'), 'test');
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/plugin-sdk/examples/unnamed/test/index.test.mjs'), null);
  assert.deepEqual(collectLaneIssues(LANE_CONTEXT, 'packages/plugin-sdk/examples/unnamed/test/index.test.mjs'), [
    'No lane mapping matched packages/plugin-sdk/examples/unnamed/test/index.test.mjs.',
  ]);
});

test('maps plugin workspace unit tests to the derived plugin workspace lane', () => {
  assert.equal(classifyTestFile(LANE_CONTEXT, 'packages/channels-protocol/src/v1/index.test.ts'), 'test');

  for (const packageTestPath of [
    'packages/plugins/channels/src/automationResultDelivery.test.ts',
    'packages/plugins/channel-telegram/src/telegramBotApi.test.ts',
    'packages/plugins/channel-discord/src/discordGateway.test.ts',
    'packages/plugins/scm-github/src/githubAutomationEventActions.test.ts',
  ]) {
    assert.equal(classifyTestFile(LANE_CONTEXT, packageTestPath), 'test:plugin-workspaces', packageTestPath);
  }
});

test('accepts valid feature ids and flags invalid ones', () => {
  const validFeatureId = FEATURE_IDS[0];
  assert.equal(resolveFeatureTagIssue(`apps/server/sources/app/features/example.feat.${validFeatureId}.spec.ts`), null);
  assert.match(resolveFeatureTagIssue('apps/server/sources/app/features/example.feat.not-a-real-feature.spec.ts') ?? '', /Invalid feature test tag/);
});

test('flags known lane naming violations', () => {
  assert.deepEqual(collectLaneIssues(LANE_CONTEXT, 'packages/tests/suites/ui-e2e/login.test.ts'), [
    'UI E2E tests must use *.spec.ts under packages/tests/suites/ui-e2e.',
    'No lane mapping matched packages/tests/suites/ui-e2e/login.test.ts.',
  ]);
  assert.deepEqual(collectLaneIssues(LANE_CONTEXT, 'apps/stack/scripts/runtime.integration.spec.mjs'), [
    'Stack integration tests must use *.integration.test.* naming.',
  ]);
  assert.deepEqual(collectLaneIssues(LANE_CONTEXT, 'apps/stack/scripts/runtime.spec.mjs'), [
    'Stack unit tests must use *.test.* naming.',
  ]);
  assert.deepEqual(collectLaneIssues(LANE_CONTEXT, 'packages/tests/suites/core-e2e/login.slow.test.ts'), [
    'Core E2E slow files must use *.slow.e2e.test.ts naming.',
  ]);
});

test('exposes the WSREPL Lima UI lane as a root script', () => {
    assert.equal(LANE_ROOT_SCRIPTS['test:e2e:ui:wsrepl:lima'], 'yarn test:e2e:ui:wsrepl:lima');
    assert.equal(LANE_ROOT_SCRIPTS['test:e2e:ui:wsrepl:lima:self'], 'yarn test:e2e:ui:wsrepl:lima:self');
    assert.equal(LANE_ROOT_SCRIPTS['test:e2e:desktop:native'], 'yarn test:e2e:desktop:native');
    assert.equal(LANE_ROOT_SCRIPTS['test:plugin-workspaces'], 'yarn test:plugin-workspaces');
});

test('derives non-bespoke workspace lanes from workspace metadata and the root unit executor', () => {
  const context = buildTestLaneContext({
    workspaceManifests: workspaceManifests([
      { directory: 'packages/wired-workspace', name: '@happier-dev/wired-workspace' },
      { directory: 'packages/unwired-workspace', name: '@happier-dev/unwired-workspace' },
      { directory: 'packages/untested-workspace', name: '@happier-dev/untested-workspace', scripts: { build: 'tsc' } },
    ]),
    rootScripts: {
      test: 'apps/stack/bin/hstack-exec --script=test:local',
      'test:local': 'yarn -s test:unit:local',
      'test:unit:local': 'yarn workspace @happier-dev/wired-workspace test',
    },
  });

  assert.equal(classifyTestFile(context, 'packages/wired-workspace/src/example.test.ts'), 'test');
  assert.equal(classifyTestFile(context, 'packages/unwired-workspace/src/example.test.ts'), 'workspace:test');
  assert.equal(classifyTestFile(context, 'packages/untested-workspace/src/example.test.ts'), null);
  assert.deepEqual(collectLaneIssues(context, 'packages/untested-workspace/src/example.test.ts'), [
    'No lane mapping matched packages/untested-workspace/src/example.test.ts.',
  ]);
});

test('resolves the root unit lane through the Stack executor delegation chain', () => {
  const context = buildTestLaneContext({
    workspaceManifests: workspaceManifests([{ directory: 'packages/only-via-cwd', name: '@happier-dev/only-via-cwd' }]),
    rootScripts: {
      test: 'apps/stack/bin/hstack-exec --script=test:local',
      'test:local': 'yarn -s test:unit:local',
      'test:unit:local': 'yarn --cwd packages/only-via-cwd test',
    },
  });

  assert.equal(classifyTestFile(context, 'packages/only-via-cwd/src/example.test.ts'), 'test');
});

test('prefers the deepest workspace when workspaces nest', () => {
  const context = buildTestLaneContext({
    workspaceManifests: workspaceManifests([
      { directory: 'packages/plugins/channels', name: '@happier-dev/plugins-channels' },
      { directory: 'packages/host', name: '@happier-dev/host' },
    ]),
    rootScripts: { test: 'yarn workspace @happier-dev/host test' },
  });

  assert.equal(classifyTestFile(context, 'packages/plugins/channels/src/a.test.ts'), 'test:plugin-workspaces');
  assert.equal(classifyTestFile(context, 'packages/host/src/a.test.ts'), 'test');
});
