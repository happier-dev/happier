import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DEPLOYMENT_ACTION_IDS_V1, deploymentOperationForRootActionV1, isDeploymentTargetLinkActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { db } from '@/storage/db';
import {
  createLightSqliteHarness,
  type LightSqliteHarness,
} from '@/testkit/lightSqliteHarness';
import { isDeploymentEnvironmentHttpReadInAdmittedScopeInTx, isDeploymentReadOperandInAdmittedScopeInTx,
  readDeploymentPreparationHttpReadPurpose } from './deploymentPreparationAuthorization';

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
    ({ deploymentPreparationAdmission: admission }) as unknown as ExternalActionExecutionAuthorizationBindingV1;

  // These constructed bindings start after admission. The composed Promote
  // regression separately covers producing the signed scope at the real mint.
  // Every sibling spends the same retained fact through the real HTTP/scope
  // owner; neither a catalog-presence assertion nor a stub decides these reads.
  it.each(DEPLOYMENT_ACTION_IDS_V1)('%s declares and spends only its admitted Environment through the shared HTTP owner', async actionId => {
    const serverId = `srv_${'b'.repeat(32)}`;
    const environmentId = 'environment-admitted';
    const admitted = {
      serverIdentityId: serverId, accountId: 'account', custodianAccountId: 'account',
      authentication: { kind: 'account', tokenEpoch: 0 },
      machineId: 'machine', installationId: 'installation', actionId,
      requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' }, environmentId,
      ...(isDeploymentTargetLinkActionIdV1(actionId) ? {
        deploymentLinkAdmission: { environmentId, owner: { kind: 'account' as const, accountId: 'account' } },
      } : {}),
    } satisfies ExternalActionExecutionAuthorizationBindingV1;
    const read = async (id: string, home = serverId, method = 'GET', effect = 'deployments.environments.get') => {
      const operands = { serverId: home, environmentId: id };
      const proof = { method, path: `/v1/deployments/environments/${id}?serverId=${home}`, routeInput: operands };
      const purpose = await readDeploymentPreparationHttpReadPurpose(db, admitted, effect, proof, readActionId => {
        // Use the real schema/HTTP binder, as the production transport matcher
        // does. This callback cannot grant a purpose or bypass its declaration.
        const spec = getActionSpec(readActionId);
        const parsed = spec.inputSchema.safeParse(operands);
        if (!parsed.success || !spec.serverTransport) return false;
        const request = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
          inputSchema: spec.inputSchema, input: parsed.data });
        return request.method === proof.method && request.path === proof.path && request.body === undefined;
      });
      return purpose !== null && await isDeploymentEnvironmentHttpReadInAdmittedScopeInTx(db, admitted, proof);
    };

    expect(await read(environmentId)).toBe(true);
    if (deploymentOperationForRootActionV1(actionId) !== undefined) {
      // Native execution retains the root effect while preparing its admitted resources.
      expect(await read(environmentId, serverId, 'GET', actionId)).toBe(true);
      expect(await read('environment-outside', serverId, 'GET', actionId)).toBe(false);
    }
    expect(await read('environment-outside')).toBe(false);
    expect(await read(environmentId, `srv_${'c'.repeat(32)}`)).toBe(false);
    expect(await read(environmentId, serverId, 'POST')).toBe(false);
    expect(await read(environmentId, serverId, 'GET', 'deployments.receipts.get')).toBe(false);
  });

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
