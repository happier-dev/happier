import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// A warm Vitest catalog hides ESM initialization cycles. Load the adoption leaf
// first in a fresh process, as a source consumer can, before reading the catalog.
const isolatedAdoption = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
  import assert from 'node:assert/strict';
  await import('./packages/protocol/src/actions/operations/v1.ts');
  const { MACHINE_SERVICE_ADOPT_SPEC } = await import('./packages/protocol/src/actions/specs/machine/serviceAdoption.ts');
  const { getActionSpec } = await import('./packages/protocol/src/actions/actionSpecs.ts');
  assert.equal(MACHINE_SERVICE_ADOPT_SPEC.id, 'machines.services.adopt');
  assert.equal(getActionSpec(MACHINE_SERVICE_ADOPT_SPEC.id).id, MACHINE_SERVICE_ADOPT_SPEC.id);
`], {
  cwd: fileURLToPath(new URL('../../../../../../', import.meta.url)),
  encoding: 'utf8',
});

it('cold-loads the adoption spec and registers it without an initialization cycle', () => {
  expect(isolatedAdoption.error).toBeUndefined();
  expect(isolatedAdoption.status, isolatedAdoption.stdout + isolatedAdoption.stderr).toBe(0);
});
