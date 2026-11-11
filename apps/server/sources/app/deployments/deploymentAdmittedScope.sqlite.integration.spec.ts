import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { db } from '@/storage/db';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { isDeploymentReadOperandInAdmittedScopeInTx } from './deploymentPreparationAuthorization';

// The admitted deployment scope is the one decider for declared read operands.
// Bindings are cast from fixtures: only the admission operands are read here.
describe('admitted deployment read scope (real SQLite)', () => {
  let harness: LightSqliteHarness;
  beforeAll(async () => {
    harness = await createLightSqliteHarness({
      tempDirPrefix: 'deployment-admitted-scope-',
    });
  }, 120_000);
  afterAll(async () => {
    await harness?.close();
  });

  const binding = (admission: unknown) =>
    ({ deploymentPreparationAdmission: admission }) as unknown as Pick<
      ExternalActionExecutionAuthorizationBindingV1,
      'deploymentPreparationAdmission'
    >;

  it('admits a nested { id } Source operand and refuses another Source', async () => {
    const admitted = binding({
      operation: 'catalog',
      source: { id: 'source-admitted' },
    });
    expect(
      await isDeploymentReadOperandInAdmittedScopeInTx(
        db,
        admitted,
        { serverId: 'srv', id: 'source-admitted' },
        undefined,
        'source',
      ),
    ).toBe(true);
    expect(
      await isDeploymentReadOperandInAdmittedScopeInTx(
        db,
        admitted,
        { serverId: 'srv', id: 'source-other' },
        undefined,
        'source',
      ),
    ).toBe(false);
  });

  it('refuses an Environment, Receipt or unnamed operand the admission does not own', async () => {
    const admitted = binding({
      operation: 'setup',
      environment: { id: 'environment-missing' },
    });
    for (const operands of [
      { serverId: 'srv', environmentId: 'environment-missing' },
      {
        serverId: 'srv',
        environmentId: 'environment-missing',
        deploymentId: 'receipt-foreign',
      },
      { serverId: 'srv', mysteryId: 'anything' },
      { serverId: 'srv' },
    ]) {
      expect(
        await isDeploymentReadOperandInAdmittedScopeInTx(
          db,
          admitted,
          operands,
        ),
      ).toBe(false);
    }
    expect(
      await isDeploymentReadOperandInAdmittedScopeInTx(db, binding(undefined), {
        serverId: 'srv',
        id: 'x',
      }),
    ).toBeNull();
  });
});
