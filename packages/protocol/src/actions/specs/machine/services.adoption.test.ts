import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getActionSpec } from '../../actionSpecs.js';

// A warm Vitest catalog hides ESM initialization cycles. Load the adoption leaf
// first in a fresh process, as a source consumer can, before reading the catalog.
const isolatedAdoption = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
  import assert from 'node:assert/strict';
  await import('./packages/protocol/src/actions/operations/v1.ts');
  const { MACHINE_SERVICE_ADOPTION_ACTION_SPECS } = await import('./packages/protocol/src/actions/specs/machine/serviceAdoption.ts');
  const [spec] = MACHINE_SERVICE_ADOPTION_ACTION_SPECS;
  const { getActionSpec } = await import('./packages/protocol/src/actions/actionSpecs.ts');
  assert.equal(spec.id, 'machines.services.adopt');
  assert.equal(getActionSpec(spec.id).id, spec.id);
`], {
  cwd: fileURLToPath(new URL('../../../../../../', import.meta.url)),
  encoding: 'utf8',
});

it('cold-loads the adoption spec and registers it without an initialization cycle', () => {
  expect(isolatedAdoption.error).toBeUndefined();
  expect(isolatedAdoption.status, isolatedAdoption.stdout + isolatedAdoption.stderr).toBe(0);
});

it('requires a deliberate future profile selection and explicit binding confirmation for watched Compose adoption', () => {
  const spec = getActionSpec('machines.services.adopt');
  expect(spec).toBeDefined();
  const input = { serverId: 'home', machineId: 'machine', serviceId: 'watched', expectedGeneration: 'generation',
    requestKey: 'adopt', mode: 'review', profiles: [] };
  expect(spec!.inputSchema.safeParse(input).success).toBe(true);
  const { profiles: _profiles, ...missing } = input;
  expect(spec!.inputSchema.safeParse(missing).success).toBe(false);
  const apply = { ...input, mode: 'apply', reviewedDigest: `sha256:${'a'.repeat(64)}`,
    destination: { name: 'Imported', projectSourceId: 'source', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers' },
    bindings: [] };
  expect(spec.inputSchema.safeParse({ ...apply, bindingsConfirmed: true }).success).toBe(true);
  expect(spec.inputSchema.safeParse(apply).success).toBe(false);
});
