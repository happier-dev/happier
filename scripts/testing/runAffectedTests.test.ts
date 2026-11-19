import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planAffectedTestCommands, selectAffectedTests, selectGraphUnitTests } from './runAffectedTests.ts';

test('selected journey tests run under the runner that owns their suite', () => {
  const commands = planAffectedTestCommands({
    journeyFiles: [
      'packages/tests/suites/core-e2e/session.open.e2e.test.ts',
      'packages/tests/suites/core-e2e/session.handoff.slow.e2e.test.ts',
      'packages/tests/suites/ui-e2e/session.subroutes.spec.ts',
      'packages/tests/suites/contracts/actions.test.ts',
    ],
    unitFiles: [],
  });

  assert.deepEqual(commands.map(({ id, args }) => [id, args]), [
    ['core-e2e fast', ['--dir', 'packages/tests', 'run', 'test:core:fast',
      'suites/contracts/actions.test.ts', 'suites/core-e2e/session.open.e2e.test.ts']],
    ['core-e2e slow', ['--dir', 'packages/tests', 'exec', 'node', 'scripts/run-vitest-with-heartbeat.mjs',
      '--config', 'vitest.core.slow.config.ts', 'suites/core-e2e/session.handoff.slow.e2e.test.ts']],
    ['ui-e2e', ['--dir', 'packages/tests', 'run', 'test:ui:e2e', 'suites/ui-e2e/session.subroutes.spec.ts']],
  ]);
});

test('owner unit tests go through the root unit lane and an empty selection runs nothing', () => {
  assert.deepEqual(planAffectedTestCommands({ journeyFiles: [], unitFiles: [] }), []);
  const [unit] = planAffectedTestCommands({ journeyFiles: [], unitFiles: ['apps/server/sources/a.spec.ts'] });
  assert.deepEqual(unit, { id: 'owner unit', rootUnitFiles: ['apps/server/sources/a.spec.ts'], args: [] });
});

// Real Vitest graph on a small repository fixture; subprocess edges use the real stub specs.
test('Cursor plugin change selects its stub scenarios and unrelated docs select no provider journeys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'affected-providers-'));
  try {
    const put = async (path: string, content: string) => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    };
    for (const config of ['core', 'agents']) await put(`packages/tests/vitest.${config}.config.ts`, `export default { test: { include: ['suites/${config === 'agents' ? 'agents' : 'contracts'}/**/*.test.ts'] } };`);
    await put('packages/tests/suites/agents/provider.matrix.test.ts', "import '../../src/catalog';");
    await put('packages/tests/suites/agents/agent.test.ts', "import '../../src/catalog';");
    await put('packages/tests/src/catalog.ts', 'export const scenarios = [];');
    await put('packages/plugins/cursor/src/agent/index.ts', 'export const backend = true;');
    await put('README.md', 'unrelated');
    await cp('packages/tests/fixtures/cli-backends', join(root, 'packages/tests/fixtures/cli-backends'), { recursive: true });
    const selected = await selectAffectedTests(root, ['packages/plugins/cursor/src/agent/index.ts'], { journeysOnly: true });
    assert.deepEqual(selected.providerMatrix, [{ preset: 'cursor_acp_stub', tier: 'extended', scenarios: ['cursor_acp_stub_captured_lifecycle_replay'] }]);
    const removed = await selectAffectedTests(root, ['packages/plugins/cursor/src/agent/deleted-module.ts'], { journeysOnly: true });
    assert.deepEqual(removed.providerMatrix, selected.providerMatrix);
    const dispatch = await selectAffectedTests(root, ['apps/cli/src/index.ts'], { journeysOnly: true });
    assert.equal(dispatch.providerMatrix.length, 2);
    const removedDispatch = await selectAffectedTests(root, ['apps/cli/src/cli/deleted-dispatch.ts'], { journeysOnly: true });
    assert.deepEqual(removedDispatch.providerMatrix, dispatch.providerMatrix);
    const graph = await selectAffectedTests(root, ['packages/tests/src/catalog.ts'], { journeysOnly: true });
    assert.deepEqual(graph.agentFiles, ['packages/tests/suites/agents/agent.test.ts']);
    assert.equal(graph.providerMatrix.length, 2);
    const unrelated = await selectAffectedTests(root, ['README.md'], { journeysOnly: true });
    assert.deepEqual(unrelated.providerMatrix, []);
    assert.deepEqual(unrelated.agentFiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider journey commands use selected scenarios and stub-only presets', () => {
  const commands = planAffectedTestCommands({ journeyFiles: [], unitFiles: [],
    agentFiles: ['packages/tests/suites/agents/acpStubProvider.lifecycle.test.ts'],
    providerMatrix: [{ preset: 'codex_acp_stub', tier: 'smoke', scenarios: ['acp_stub_usage_update'] }],
  });
  assert.deepEqual(commands.map(command => command.args), [
    ['--dir', 'packages/tests', 'run', 'test:agents', 'suites/agents/acpStubProvider.lifecycle.test.ts'],
    ['--dir', 'packages/tests', 'run', 'test:agents', 'suites/agents/provider.matrix.test.ts'],
  ]);
  for (const command of commands) {
    assert.equal(command.env?.HAPPIER_E2E_PROVIDER_CODEX_ACP_STUB, '1');
    assert.equal(command.env?.HAPPIER_E2E_PROVIDER_CODEX, '0');
    assert.equal(command.env?.HAPPIER_E2E_PROVIDER_CURSOR_ACP_STUB, '0');
  }
  assert.equal(commands[1].env?.HAPPIER_E2E_PROVIDER_SCENARIOS, 'acp_stub_usage_update');
});

test('unit selection follows the real import graph out of the changed folder, and unknown inputs widen to the package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'affected-unit-graph-'));
  try {
    const put = async (path: string, content: string) => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    };
    // The alias is Vite configuration, not TypeScript: only the real resolver sees this edge.
    await put('app/vitest.config.mjs', `export default { resolve: { alias: [{ find: /^@\\//, replacement: ${JSON.stringify(join(root, 'app/src') + '/')} }] },
      test: { include: ['src/**/*.test.ts'], setupFiles: ['./src/setup.ts'] } };`);
    await put('app/src/setup.ts', "import './testkit/env';");
    await put('app/src/testkit/env.ts', 'export const env = 1;');
    await put('app/src/lib/value.ts', 'export const value = 1;');
    await put('app/src/lib/value.test.ts', "import { value } from './value'; void value;");
    await put('app/src/feature/widget.ts', "import { value } from '@/lib/value'; import { shared } from '../../../shared/src/index'; export const widget = value + shared;");
    await put('shared/src/index.ts', 'export const shared = 1;');
    await put('app/src/feature/widget.test.ts', "import { widget } from './widget'; void widget;");
    await put('app/src/feature/lazy.test.ts', "export const load = () => import('../feature/widget');");
    await put('app/src/other/unrelated.test.ts', 'export const unrelated = 1;');
    await put('app/src/assets/strings.json', '{}');
    const select = (changedFiles: string[]) => selectGraphUnitTests({ rootDir: root, workspaceDir: 'app', config: 'vitest.config.mjs', changedFiles });
    assert.deepEqual(await select(['app/src/lib/value.ts']), { full: false, total: 4, files: [
      'app/src/feature/lazy.test.ts', 'app/src/feature/widget.test.ts', 'app/src/lib/value.test.ts'] });
    assert.deepEqual(await select(['shared/src/index.ts', 'shared/README.md']), { full: false, total: 4, files: [
      'app/src/feature/lazy.test.ts', 'app/src/feature/widget.test.ts'] });
    assert.deepEqual(await select(['app/src/other/unrelated.test.ts']), { full: false, total: 4, files: ['app/src/other/unrelated.test.ts'] });
    // Every test loads the setup closure; configuration, removed modules and unread assets are unknown inputs.
    for (const changed of ['app/src/testkit/env.ts', 'app/vitest.config.mjs', 'app/src/lib/removed.ts', 'app/src/assets/strings.json']) {
      assert.equal((await select([changed])).full, true, changed);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a change to a module only the Vitest config imports (shared tooling outside the package) runs the whole package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'affected-unit-config-'));
  try {
    const put = async (path: string, content: string) => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    };
    // apps/ui/vitest.config.ts imports scripts/testing/{featureTestGating,vitestWorkers,testHomeEnvironment}; no test does.
    await put('app/vitest.config.mjs', "import { include } from '../tooling/gating.mjs';\nexport default { test: { include } };");
    await put('tooling/gating.mjs', "import { pattern } from './patterns.mjs';\nexport const include = [pattern];");
    await put('tooling/patterns.mjs', "export const pattern = 'src/**/*.test.ts';");
    await put('app/src/value.ts', 'export const value = 1;');
    await put('app/src/value.test.ts', "import { value } from './value'; void value;");
    const select = (changedFiles: string[]) => selectGraphUnitTests({ rootDir: root, workspaceDir: 'app', config: 'vitest.config.mjs', changedFiles });
    for (const changed of ['tooling/gating.mjs', 'tooling/patterns.mjs']) {
      assert.equal((await select([changed])).full, true, changed);
    }
    assert.deepEqual(await select(['app/src/value.ts']), { full: false, total: 1, files: ['app/src/value.test.ts'] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('first-open browser journey reaches UI and Home auth changes across spawned processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'affected-first-open-'));
  try {
    const spec = 'packages/tests/suites/ui-e2e/firstOpen.browser.spec.ts';
    const webSetup = 'packages/tests/suites/ui-e2e/setup.onboardingWizard.web.spec.ts';
    const config = 'packages/tests/vitest.core.config.ts';
    await mkdir(join(root, spec, '..'), { recursive: true });
    await writeFile(join(root, spec), 'export {};');
    await writeFile(join(root, webSetup), 'export {};');
    await writeFile(join(root, config), "export default { test: { include: ['suites/ui-e2e/**/*.spec.ts'] } };");
    const fixtures = 'packages/tests/fixtures/cli-backends';
    await cp(fixtures, join(root, fixtures), { recursive: true });

    const options = { journeysOnly: true };
    const ui = await selectAffectedTests(root, ['apps/ui/sources/components/onboarding/preAuth/removedDoor.tsx'], options);
    assert.deepEqual(ui.journeyFiles, [spec]);
    const server = await selectAffectedTests(root, ['apps/server/sources/app/api/routes/auth/registerAccountAuthRoutes.ts'], options);
    assert.deepEqual(server.journeyFiles, [spec]);
    const webHandoff = await selectAffectedTests(root, ['apps/ui/sources/components/onboarding/surfaces/OnboardingWizardSurface.tsx'], options);
    assert.deepEqual(webHandoff.journeyFiles, [spec, webSetup]);
    const unrelated = await selectAffectedTests(root, [
      'apps/ui/sources/components/sessions/list/SessionList.tsx',
      'apps/ui/sources/components/onboarding/preAuth/WelcomeDecisionPanel.test.tsx',
    ], options);
    assert.deepEqual(unrelated.journeyFiles, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
