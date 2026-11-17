import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planAffectedTestCommands, selectAffectedTests } from './runAffectedTests.ts';

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
