import assert from 'node:assert/strict';
import { test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Prepare cold native-process observations once during collection. The contracts
// below concern construction and import order, not transpiler/bootstrap latency.
const censusResult = spawnSync(process.execPath, [
  '--experimental-transform-types', '--expose-gc',
  fileURLToPath(new URL('./profile-schema-memory.mjs', import.meta.url)),
  'packages/protocol/src/automations/automationApiV3.ts', '--census', '--all-owners',
], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' });

test('keeps private Automation read projections cold during catalog import', () => {
  // Count real Classic constructor allocations in a fresh native graph. This is
  // instrumentation, not a replacement parser or a mocked schema factory.
  assert.equal(censusResult.status, 0, censusResult.stderr);
  const census = JSON.parse(censusResult.stdout.trim());
  const projections = census.ownersByLiveCount.find(([owner]) => owner.endsWith('/json/storedReadSchema.ts'));
  assert.equal(projections?.[1].instances ?? 0, 0);
});

const nativeImportResult = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
  // Vitest transforms the module graph; native ESM also has to admit an ID-first
  // consumer without reading a catalog binding in its temporal dead zone.
  import assert from 'node:assert/strict';
  const { ACTION_IDS, ActionIdSchema } = await import('./src/actions/actionIds.ts');
  const { PluginInvocableActionIdSchema } = await import('./src/actions/pluginActionSurface.ts');
  const { getActionSpec } = await import('./src/actions/actionSpecs.ts');

  assert.ok(ACTION_IDS.includes('memory.remember'));
  assert.equal(ActionIdSchema.parse('memory.remember'), 'memory.remember');
  assert.equal(PluginInvocableActionIdSchema.parse('memory.remember'), 'memory.remember');
  assert.equal(PluginInvocableActionIdSchema.safeParse('session.handoff.commit').success, false);
  assert.equal(PluginInvocableActionIdSchema.safeParse('not.an.action').success, false);
  assert.equal(getActionSpec('memory.remember').executionPlacement, 'account');

  const groupInput = getActionSpec('widgets.group.ungroup').inputSchema;
  const ref = { surface: { serverId: 'home', accountId: 'account', owner: { kind: 'home' } }, instanceId: 'group' };
  assert.deepEqual(groupInput.parse({ ref }), { ref });
  assert.equal(groupInput.safeParse({ ref: { ...ref, extra: true } }).success, false);
  assert.equal(groupInput.safeParse({ ref: { ...ref, surface: {
    ...ref.surface, owner: { kind: 'sessionBoard', sessionId: 'session' },
  } } }).success, false);
  `], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' });

test('initializes the Action vocabulary before loading its payload catalog in native ESM', () => {
  assert.equal(nativeImportResult.status, 0, nativeImportResult.stderr);
});

// These factory calls used to force another module's lazy schema before its
// bindings were initialized; static imported-binding reads alone cannot see it.
for (const entry of ['widgets/widgetPublicProfileAdmissionV1', 'sessions/follow/sessionFollowRuleOccurrenceV1']) {
  const result = spawnSync(process.execPath, ['--experimental-transform-types',
    fileURLToPath(new URL('./profile-schema-memory.mjs', import.meta.url)),
    `packages/protocol/src/${entry}.ts`, '--native'],
  { cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8' });
  test(`initializes ${entry} before its transitive schema graph`, () => {
    assert.equal(result.status, 0, result.error?.stack ?? result.stderr);
  });
}
