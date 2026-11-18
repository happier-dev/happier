import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { DeploymentBackupRestoreConfirmInputV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import { adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createActionOperationCancellationFixture } from './actionOperationCancellation.testkit';
import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';
import { createHostActionOperationRuntime } from './createHostActionOperationRuntime';
import { prepareProjectOpenReceiptPersistence } from './projectOpenReceiptPersistence';

const authored = { serverId: 'srv_identity_retry', environmentId: 'staging', targetLinkId: 'runtime', requestKey: 'deploy-a' };
const accountId = 'owner';
const machineId = 'controller';
const operationId = 'deploy-operation';
const preparedInput = (revision: number) => ({ ...authored, expectedRevision: revision, expectedTargetLinkRevision: 1,
  contentArtifactId: `candidate-${revision}`, contentHeaderVersion: 1, contentBodyVersion: 1 });
const receipt = { ok: true as const, environmentId: authored.environmentId, revision: 2,
  deploymentId: 'receipt-a', deploymentRevision: 2, state: 'succeeded' as const };
const context = (actionRequestId: string): ActionExecutorContext => ({
  authority: 'present_user', surface: 'ui', actionCaller: { kind: 'host' }, runtimeAccountId: accountId,
  serverId: authored.serverId, actionRequestId,
});

function fixture(deploy = vi.fn<NonNullable<Parameters<typeof createActionExecutor>[0]['deploymentAction']>>(async () => receipt)) {
  let revision = 1;
  let installationId = '';
  const runtime = createHostActionOperationRuntime({ serverId: authored.serverId, machineId,
    custodyBinding: { serverId: authored.serverId, get installationId() { return installationId; } },
    resolveAccountId: async () => accountId, generateOperationId: () => operationId });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
    runActionOperation: runtime.runActionOperation,
    presentUserActionConfirmation: async () => true,
    resolveEnvironmentApprovalScope: async () => ({ scope: { kind: 'environment', environmentId: authored.environmentId } }),
    prepareDeploymentAction: async () => ({ input: preparedInput(revision++),
      preview: { sourceMethod: 'gitIntegration' } }),
    deploymentAction: deploy,
  });
  return { runtime, deploy, setInstallationId: (id: string) => { installationId = id; },
    invoke: (input: typeof authored, id: string) => executor.execute('deployments.deploy', input, context(id)) };
}

it('reconstructs the prepared operand and joins an already pending Deploy', async () => {
  const releaseEffect = Promise.withResolvers<void>();
  const pending = { ok: true as const, environmentId: authored.environmentId, revision: 1,
    kind: 'pending' as const, actionOperationId: operationId };
  const deploy = vi.fn<NonNullable<Parameters<typeof createActionExecutor>[0]['deploymentAction']>>(async (_id, _input, ctx) => {
    ctx.operationAcceptance!.accept(pending);
    await releaseEffect.promise;
    return receipt;
  });
  const { runtime, invoke, setInstallationId } = fixture(deploy);
  const admitted = await createActionOperationCancellationFixture({ mode: 'plain', accountId, actionId: 'deployments.deploy',
    actionInput: authored, admittedMachineRole: 'manage', address: { serverId: authored.serverId, machineId, operationId },
    store: runtime.store, runner: runtime.runner });
  const installationId = admitted.installation.installationId;
  setInstallationId(installationId);
  await adoptServerProfileHomeConnectionDescriptor({ observation: 'exact', createIfMissing: true,
    descriptor: { v: 1, homeServerIdentityId: authored.serverId, canonicalServerUrl: 'https://cancel-home.invalid', revision: 1,
      endpoints: [{ kind: 'https', url: 'https://cancel-home.invalid' }] } });
  const requester = await admitted.prepareRoot();
  expect(requester, JSON.stringify(admitted.diagnostics)).not.toBeNull();
  if (!requester) throw new Error('Pending observer requester unavailable');
  const original = invoke(authored, 'transport-1');
  try {
    expect(await original).toMatchObject({ ok: true, result: pending });
    const observationContext = { ...context('transport-2'), externalActionExecutionAuthorization: requester.authorization };
    const observe = await runtime.preparePendingDeploymentObservation({
      input: authored, context: observationContext,
      admission: { requesterAccountId: accountId, serverId: authored.serverId, requestKey: authored.requestKey,
        actionOperationId: operationId, controller: { machineId, installationId }, environmentRevision: 1 },
      pendingDeploy: { t: 'encrypted', c: 'opaque' },
      validateOriginalInput: async input => { expect(input).toEqual(preparedInput(1)); },
    });
    expect(observe).toBeDefined();
    expect(await observe!(observationContext)).toEqual(await original);
    // A normal retry prepares another candidate, but joins the original active operation.
    expect(await invoke(authored, 'transport-3')).toEqual(await original);
    expect(deploy).toHaveBeenCalledTimes(1);
  } finally {
    releaseEffect.resolve();
    await runtime.runner.waitForTerminal({ accountId, machineId }, operationId);
    await requester.dispose();
  }
});

it('retains the exact-input replay and conflict rules for a Machine Action without preparation', async () => {
  const { runtime } = fixture();
  const execute = vi.fn(async () => ({ ok: true as const, result: { kind: 'accepted' } }));
  const invoke = (input: unknown) => runtime.runActionOperation({
    actionId: 'machines.reboot', input, context: context('machine-reboot'), execute,
  });
  const input = { machineId, serverId: authored.serverId };
  const first = await invoke(input);
  expect(first).toMatchObject({ ok: true });
  expect(await invoke(input)).toEqual(first);
  expect(await invoke({ ...input, machineId: 'other-machine' }))
    .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
  expect(execute).toHaveBeenCalledTimes(1);
});

it('rejoins teardown through the original compact request after split retention', async () => {
  const { runtime } = fixture();
  const semanticInput = { serverId: authored.serverId, environmentId: authored.environmentId,
    requestKey: 'teardown-a', reason: 'manual' as const };
  const input = { ...preparedInput(1), ...semanticInput };
  const execute = vi.fn(async (ctx: ActionExecutorContext) => {
    ctx.operationOwnerUpdate?.update({ domainRef: { kind: 'deployment', serverId: input.serverId,
      environmentId: input.environmentId, deploymentId: input.contentArtifactId } });
    return { ok: true as const, result: { ok: true, state: 'succeeded' } };
  });
  const result = await runtime.runActionOperation({
    actionId: 'deployments.teardown', input, semanticInput, context: context('teardown-1'), execute,
  });
  expect(result).toMatchObject({ ok: true });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), runActionOperation: runtime.runActionOperation });
  expect(await executor.execute('deployments.teardown', semanticInput, context('teardown-2'))).toEqual(result);
  expect(await executor.execute('deployments.teardown', { ...semanticInput, targetLinkId: input.targetLinkId }, context('teardown-3')))
    .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
  expect(execute).toHaveBeenCalledTimes(1);
});

it.each(['legacy', 'split'] as const)('reads the exact restore operand from a %s receipt after reopening storage', async format => {
  const directory = await mkdtemp(join(tmpdir(), 'happier-restore-operand-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const scope = { accountId, machineId };
  const open = () => prepareProjectOpenReceiptPersistence({
    ...scope, directory: join(directory, 'receipts'), keyPath: join(directory, 'key.json'),
  });
  const target = { serverId: authored.serverId, environmentId: authored.environmentId, targetLinkId: authored.targetLinkId,
    machineId, installationId: 'installation', deploymentId: 'deployment' };
  const prepared = DeploymentBackupRestoreConfirmInputV1Schema.parse({ ...target, expectedRevision: 2,
    mode: 'confirm', prepareOperationId: 'prior-review', source: { kind: 'repository', snapshotId: 'snapshot' },
    destination: { kind: 'database', service: 'db', database: 'application' } });
  const semanticInput = { ...prepared, expectedRevision: 1 };
  const requestId = 'restore-request';
  const actionId = 'deployments.backups.restore';
  const store = createActionOperationStore({ projectOpenReceiptPersistence: await open() });
  store.create({ operationId, scope, actionId, requestId, title: 'Restore', cancellation: 'supported',
    inputIdentity: createCanonicalJsonSigningInput(format === 'legacy' ? prepared : semanticInput),
    ...(format === 'split' ? { preparedInput: createCanonicalJsonSigningInput(prepared) } : {}) });
  store.succeed(operationId, { kind: 'rolledBack', verified: false, nextAction: 'inspect', evidence: {} });
  const reopened = createActionOperationStore({ projectOpenReceiptPersistence: await open() });
  expect(reopened.readDeploymentInvocationInput(scope, operationId)).toEqual(prepared);
  expect(reopened.readDeploymentBackupOperations(scope, target)).toMatchObject([{ input: prepared }]);
  expect(reopened.readDeploymentInvocationInput({ ...scope, accountId: 'someone-else' }, operationId)).toBeUndefined();
  const spec = getActionSpec(actionId);
  const runner = createActionOperationRunner({ store: reopened,
    resolveAction: () => ({ actionId, title: spec.title, operation: spec.operation }) });
  const execute = vi.fn(async () => ({ ok: true as const, result: {} }));
  const retry = await runner.observe({ actionId, requestId, scope, input: prepared, semanticInput, execute });
  expect(retry).toMatchObject(format === 'legacy'
    ? { ok: false, errorCode: 'action_request_input_conflict' }
    : { ok: true, result: { kind: 'rolledBack' } });
  expect(execute).not.toHaveBeenCalled();
});
