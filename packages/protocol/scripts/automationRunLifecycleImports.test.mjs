import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

// Native ESM children preserve the initialization order hidden by transformed
// test graphs. Bootstrap during collection, as in registryThemeImports.test.mjs.
for (const entry of ['automations/automationRunLifecycle', 'reviews/reviewNarration', 'actions/specs/session/lifecycle']) {
  const result = spawnSync(process.execPath, [
    '--conditions=happier-source', '--import', './packages/cli-common/registerSourceRuntime.mjs',
    '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      await import('./packages/protocol/src/${entry}.ts');
      const { AutomationExecutionRunLifecycleSourceSchema, AutomationRunLifecycleTriggerSchema } =
        await import('./packages/protocol/src/automations/automationRunLifecycle.ts');
      const source = { kind: 'execution_run', machineId: 'machine-1', runId: 'run-1',
        observation: { kind: 'review_walkthrough', comparisonId: 'comparison-1', afterRevision: 0 } };
      assert.deepEqual(AutomationExecutionRunLifecycleSourceSchema.parse(source), source);
      const trigger = { kind: 'runLifecycle', condition: 'terminal', source };
      assert.deepEqual(AutomationRunLifecycleTriggerSchema.parse(trigger), trigger);
      assert.equal(AutomationExecutionRunLifecycleSourceSchema.safeParse({ ...source,
        observation: { ...source.observation, afterRevision: -1 } }).success, false);
      assert.equal(AutomationExecutionRunLifecycleSourceSchema.safeParse({ kind: 'workflow_run', runId: 'run-1' }).success, false);
    `], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' });
  test(`loads ${entry} before parsing an execution Run lifecycle source`, () => {
    assert.equal(result.status, 0, result.error?.stack ?? result.stderr);
  });
}
