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
import { isDeploymentEnvironmentHttpReadInAdmittedScopeInTx, isDeploymentPreparationMachineReadHttpPurposeInTx,
  isDeploymentReadOperandInAdmittedScopeInTx, readDeclaredDeploymentPreparationHttpRead, readDeploymentLinkPreparationHttpPurpose,
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
      const declaredRead = readDeclaredDeploymentPreparationHttpRead(admitted, effect, proof, readActionId => {
        // Use the real schema/HTTP binder, as the production transport matcher
        // does. This callback cannot grant a purpose or bypass its declaration.
        const spec = getActionSpec(readActionId);
        const parsed = spec.inputSchema.safeParse(operands);
        if (!parsed.success || !spec.serverTransport) return false;
        const request = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
          inputSchema: spec.inputSchema, input: parsed.data });
        return request.method === proof.method && request.path === proof.path && request.body === undefined;
      });
      const purpose = await readDeploymentPreparationHttpReadPurpose(db, admitted, declaredRead);
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

  it.each(['deployments.deploy', 'deployments.rollback', 'deployments.promote'] as const)(
    '%s refuses a preview template from another Account at the admitted scope owner', async actionId => {
      const account = await db.account.create({ data: { encryptionMode: 'plain' } });
      const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
      const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id, metadata: '{}' } });
      const environment = async (accountId: string) => {
        const source = await db.projectSource.create({ data: { createdByAccountId: accountId, name: 'Preview scope',
          owner: { kind: 'account', accountId }, audience: {}, attachments: [] } });
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId,
          header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
        return await db.deploymentEnvironment.create({ data: { projectSourceId: source.id, createdByAccountId: accountId,
          protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id,
          contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
      };
      const template = await environment(account.id);
      const foreignTemplate = await environment(foreign.id);
      const runtime = await db.deploymentTargetLink.create({ data: { environmentId: template.id, createdByAccountId: account.id,
        role: 'runtime', state: 'configured', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer',
        contentArtifactId: template.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 } });
      const preview = await db.deploymentEnvironment.create({ data: { ...template, id: crypto.randomUUID(),
        purpose: 'preview', previewTemplateEnvironmentId: template.id, previewRepositoryId: template.projectSourceId,
        previewPullRequestId: '17', previewTargetLinkId: runtime.id } });
      const admitted = { serverIdentityId: `srv_${'b'.repeat(32)}`, accountId: account.id,
        custodianAccountId: account.id, authentication: { kind: 'account', tokenEpoch: 0 },
        machineId: machine.id, installationId: 'installation', actionId, requestId: crypto.randomUUID(),
        requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: machine.id }, environmentId: preview.id,
      } satisfies ExternalActionExecutionAuthorizationBindingV1;
      const canRead = (environmentId: string, readActionId?: 'deployments.environments.get') =>
        isDeploymentReadOperandInAdmittedScopeInTx(db, admitted, { serverId: admitted.serverIdentityId, environmentId },
          undefined, undefined, readActionId);
      for (const readActionId of ['deployments.environments.get', undefined] as const) {
        expect(await canRead(template.id, readActionId)).toBe(true);
      }
      // The persisted reference is a DB boundary input. It cannot expand the
      // admitted preview's Source to another Account's unrelated template.
      await db.deploymentEnvironment.update({ where: { id: preview.id }, data: { previewTemplateEnvironmentId: foreignTemplate.id } });
      for (const readActionId of ['deployments.environments.get', undefined] as const) {
        expect.soft(await canRead(foreignTemplate.id, readActionId)).toBe(false);
      }
    },
  );

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

  // F14: a telemetry Domain add reads the Environment's selected collector Machine
  // (environment.telemetryMachineId) before placing its route; the Domain owner binds that same Machine.
  it('admits a Domain root read of its Environment\'s collector Machine and refuses an unrelated Machine', async () => {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const machine = async () => (await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id, metadata: '{}' } })).id;
    const [controller, collector, unrelated] = [await machine(), await machine(), await machine()];
    const source = await db.projectSource.create({ data: { createdByAccountId: account.id, name: 'Collector scope',
      owner: { kind: 'account', accountId: account.id }, audience: {}, attachments: [] } });
    const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: account.id,
      header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
    const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.id, createdByAccountId: account.id,
      protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: controller,
      telemetryMachineId: collector, contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
    const root = { serverIdentityId: `srv_${'e'.repeat(32)}`, accountId: account.id, custodianAccountId: account.id,
      authentication: { kind: 'account', tokenEpoch: 0 }, machineId: controller, installationId: 'installation',
      actionId: 'deployments.domains.add', requestId: crypto.randomUUID(), requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: controller }, environmentId: environment.id,
    } satisfies ExternalActionExecutionAuthorizationBindingV1;
    const readMachine = (machineId: string) => isDeploymentPreparationMachineReadHttpPurposeInTx(db, root,
      'deployments.domains.add', { method: 'GET', path: `/v1/machines/${machineId}` });
    expect(await readMachine(controller)).toBe(true);
    expect(await readMachine(collector)).toBe(true);
    expect(await readMachine(unrelated)).toBe(false);
  });

  it('spends a Link root only on a write carrying exactly its recorded replacement', async () => {
    const environmentId = 'environment-link';
    const replacement = { replacesLinkId: 'source-link', expectedTargetLinkRevision: 2,
      machines: [{ machineId: 'destination', installationId: 'destination-installation' }] };
    const root = (recorded?: typeof replacement) => ({
      serverIdentityId: `srv_${'d'.repeat(32)}`, accountId: 'account', custodianAccountId: 'account',
      authentication: { kind: 'account', tokenEpoch: 0 }, machineId: 'controller', installationId: 'installation',
      actionId: 'deployments.targets.link', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'controller' },
      deploymentLinkAdmission: { environmentId, owner: { kind: 'account' as const, accountId: 'account' },
        ...(recorded ? { replacement: recorded } : {}) },
    }) satisfies ExternalActionExecutionAuthorizationBindingV1;
    const write = (binding: ExternalActionExecutionAuthorizationBindingV1, body: Record<string, unknown>) =>
      readDeploymentLinkPreparationHttpPurpose(db, binding, 'deployments.targets.link', {
        method: 'POST', path: `/v1/deployments/environments/${environmentId}/targets`, body,
      }, actionId => actionId === 'deployments.targets.link');
    const body = { serverId: 'srv', environmentId, expectedRevision: 3, requestKey: 'request', targetId: 'own-server',
      role: 'runtime', ...replacement };
    expect(await write(root(replacement), body)).toBe(true);
    expect(await write(root(replacement), { ...body, replacesLinkId: 'sibling-link' })).toBe(false);
    expect(await write(root(replacement), { ...body, expectedTargetLinkRevision: 1 })).toBe(false);
    expect(await write(root(replacement), { ...body,
      machines: [{ machineId: 'destination', installationId: 'another-installation' }] })).toBe(false);
    expect(await write(root(replacement), { ...body, machines: [...replacement.machines,
      { machineId: 'sibling', installationId: 'sibling-installation' }] })).toBe(false);
    // A root admitted without a replacement cannot retarget an existing Link at write time.
    expect(await write(root(), body)).toBe(false);
    const { replacesLinkId: _replaced, expectedTargetLinkRevision: _revision, ...firstLink } = body;
    expect(await write(root(), firstLink)).toBe(true);
    expect(await write(root(replacement), firstLink)).toBe(false);
  });
});
