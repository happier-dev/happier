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
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';

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

function fixture(deploy = vi.fn<NonNullable<Parameters<typeof createActionExecutor>[0]['deploymentAction']>>(async () => receipt),
  extra: Partial<Parameters<typeof createActionExecutor>[0]> = {}) {
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
    ...extra,
  });
  return { runtime, executor, deploy, setInstallationId: (id: string) => { installationId = id; },
    invoke: (input: typeof authored, id: string) => executor.execute('deployments.deploy', input, context(id)) };
}

it('joins an identical authored Deploy after each CLI request is approved in the app', async () => {
  let stored: ApprovalRequestV2 | null = null;
  const { executor, deploy } = fixture(undefined, {
    // Approval Artifact storage is external; admission, decisions and operation identity remain real.
    approvalsCreate: async ({ request }) => {
      stored = ApprovalRequestV2Schema.parse(structuredClone(request));
      return { artifactId: 'deploy-review' };
    },
    approvalsGet: async () => structuredClone(stored),
    approvalsUpdate: async ({ request, expectedStatus }) => {
      if (!stored) throw new Error('Missing deployment review');
      const next = ApprovalRequestV2Schema.parse(request);
      const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
      if (!transition.ok) return transition;
      stored = structuredClone(next);
      return { ok: true };
    },
    isApprovalExecutionOriginCurrent: async () => true,
  });
  const cli = { ...context('request-1'), surface: 'cli' as const, authority: 'account_automation' as const,
    serverIdentityId: authored.serverId, defaultSessionMachineId: machineId };
  const approve = () => executor.execute('approval.request.decide', { artifactId: 'deploy-review', decision: 'approve' },
    { ...cli, surface: 'ui', authority: 'present_user' });
  expect(await executor.execute('deployments.deploy', authored, cli)).toMatchObject({ ok: true,
    result: { kind: 'approval_request_created' } });
  expect(await approve()).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
  expect(await executor.execute('deployments.deploy', authored, { ...cli, actionRequestId: 'request-2' }))
    .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  expect(await approve()).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
  expect(await executor.execute('deployments.deploy', { ...authored, whenBusy: 'refuse' },
    { ...cli, actionRequestId: 'request-3' })).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
  expect(await approve()).toMatchObject({ ok: true, result: { status: 'failed',
    execution: { ok: false, errorCode: 'action_request_input_conflict' } } });
  expect(deploy).toHaveBeenCalledTimes(1);
});

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

it('returns the settled receipt when the original CLI teardown is retried after approval', async () => {
  const compact = { ...authored, requestKey: 'teardown-reviewed', reason: 'manual' as const, removeEnvironment: true as const };
  const prepared = { ...compact, expectedRevision: 1, expectedTargetLinkRevision: 1,
    contentArtifactId: 'teardown-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
  let stored: ApprovalRequestV2 | null = null;
  const teardown = vi.fn<NonNullable<Parameters<typeof createActionExecutor>[0]['deploymentAction']>>(async (_id, _input, ctx) => {
    ctx.operationOwnerUpdate?.update({ domainRef: { kind: 'deployment', serverId: compact.serverId,
      environmentId: compact.environmentId, deploymentId: receipt.deploymentId } });
    return receipt;
  });
  const { executor } = fixture(teardown, {
    prepareDeploymentTeardown: async () => ({ input: prepared, preview: { removeEnvironment: true } }),
    approvalsCreate: async ({ request }) => {
      stored = ApprovalRequestV2Schema.parse(structuredClone(request));
      return { artifactId: 'teardown-review' };
    },
    approvalsGet: async () => structuredClone(stored),
    approvalsUpdate: async ({ request, expectedStatus }) => {
      if (!stored) throw new Error('Missing teardown review');
      const next = ApprovalRequestV2Schema.parse(request);
      const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
      if (!transition.ok) return transition;
      stored = structuredClone(next);
      return { ok: true };
    },
    isApprovalExecutionOriginCurrent: async () => true,
  });
  const cli = { ...context('original-teardown-request'), surface: 'cli' as const, authority: 'account_automation' as const,
    serverIdentityId: authored.serverId, defaultSessionMachineId: machineId };
  expect(await executor.execute('deployments.teardown', compact, cli)).toMatchObject({ ok: true,
    result: { kind: 'approval_request_created' } });
  expect(await executor.execute('approval.request.decide', { artifactId: 'teardown-review', decision: 'approve' },
    { ...cli, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true,
      result: { status: 'executed', execution: { ok: true, result: receipt } } });
  expect(await executor.execute('deployments.teardown', compact, cli)).toMatchObject({ ok: true, result: receipt });
  expect(await executor.execute('deployments.teardown', { ...compact, reason: 'previewClosed' }, cli))
    .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
  expect(teardown).toHaveBeenCalledTimes(1);
});

it('retains revision-bearing authored teardown identity across approval replay', async () => {
  const revisionAuthored = { ...authored, expectedRevision: 1, expectedTargetLinkRevision: 1,
    requestKey: 'teardown-revision-authored', reason: 'manual' as const };
  const prepared = { ...revisionAuthored, contentArtifactId: 'teardown-revision-candidate',
    contentHeaderVersion: 1, contentBodyVersion: 1 };
  let stored: ApprovalRequestV2 | null = null;
  const teardown = vi.fn<NonNullable<Parameters<typeof createActionExecutor>[0]['deploymentAction']>>(async (_id, _input, ctx) => {
    ctx.operationOwnerUpdate?.update({ domainRef: { kind: 'deployment', serverId: revisionAuthored.serverId,
      environmentId: revisionAuthored.environmentId, deploymentId: receipt.deploymentId } });
    return receipt;
  });
  const { executor } = fixture(teardown, {
    prepareDeploymentTeardown: async () => ({ input: prepared, preview: {} }),
    approvalsCreate: async ({ request }) => {
      stored = ApprovalRequestV2Schema.parse(structuredClone(request));
      return { artifactId: 'teardown-revision-review' };
    },
    approvalsGet: async () => structuredClone(stored),
    approvalsUpdate: async ({ request, expectedStatus }) => {
      if (!stored) throw new Error('Missing teardown review');
      const next = ApprovalRequestV2Schema.parse(request);
      const transition = decideApprovalRequestTransition(stored, next, { expectedStatus });
      if (!transition.ok) return transition;
      stored = structuredClone(next);
      return { ok: true };
    },
    isApprovalExecutionOriginCurrent: async () => true,
  });
  const cli = { ...context('revision-teardown-request'), surface: 'cli' as const, authority: 'account_automation' as const,
    serverIdentityId: authored.serverId, defaultSessionMachineId: machineId };
  expect(await executor.execute('deployments.teardown', revisionAuthored, cli)).toMatchObject({ ok: true,
    result: { kind: 'approval_request_created' } });
  expect(await executor.execute('approval.request.decide', { artifactId: 'teardown-revision-review', decision: 'approve' },
    { ...cli, surface: 'ui', authority: 'present_user' })).toMatchObject({ ok: true,
      result: { status: 'executed', execution: { ok: true, result: receipt } } });
  expect(await executor.execute('deployments.teardown', revisionAuthored, cli)).toMatchObject({ ok: true, result: receipt });
  expect(await executor.execute('deployments.teardown', { ...revisionAuthored, expectedRevision: 2 }, cli))
    .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
  expect(teardown).toHaveBeenCalledTimes(1);
});

it('resumes a failed teardown via compact retry without weakening conflicting-operand checks', async () => {
  const { runtime } = fixture();
  const semanticInput = { serverId: authored.serverId, environmentId: authored.environmentId,
    requestKey: 'teardown-retry-a', reason: 'manual' as const, removeEnvironment: true as const };
  const input = { ...preparedInput(1), ...semanticInput, targetLinkId: authored.targetLinkId };
  let attempts = 0;
  const execute = vi.fn(async (ctx: ActionExecutorContext) => {
    attempts++;
    ctx.operationOwnerUpdate?.update({ domainRef: { kind: 'deployment', serverId: input.serverId,
      environmentId: input.environmentId, deploymentId: input.contentArtifactId } });
    if (attempts === 1) return { ok: false as const, errorCode: 'deployment_failed', error: 'deployment_failed' };
    return { ok: true as const, result: { ok: true, state: 'succeeded', environmentRemoved: true } };
  });
  const failed = await runtime.runActionOperation({
    actionId: 'deployments.teardown', input, semanticInput, context: context('teardown-retry-1'), execute,
  });
  expect(failed).toMatchObject({ ok: false, errorCode: 'deployment_failed' });
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), runActionOperation: runtime.runActionOperation });
  const retryInput = { serverId: authored.serverId, environmentId: authored.environmentId,
    targetLinkId: authored.targetLinkId, requestKey: semanticInput.requestKey, reason: 'manual' as const };
  expect(await executor.execute('deployments.teardown', { ...retryInput, reason: 'previewClosed' }, context('teardown-retry-conflict')))
    .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
  expect(await executor.execute('deployments.teardown', { ...retryInput, targetLinkId: 'other-link' }, context('teardown-retry-conflict-link')))
    .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
  const resumed = await executor.execute('deployments.teardown', retryInput, context('teardown-retry-2'));
  expect(resumed).toMatchObject({ ok: true, result: { ok: true, state: 'succeeded', environmentRemoved: true } });
  expect(await executor.execute('deployments.teardown', retryInput, context('teardown-retry-3'))).toEqual(resumed);
  expect(await executor.execute('deployments.teardown', { ...retryInput, reason: 'previewClosed' }, context('teardown-retry-4')))
    .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
  expect(execute).toHaveBeenCalledTimes(2);
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
