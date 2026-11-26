import { describe, expect, it } from 'vitest';
import { createActionExecutor, invokeHostReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { invokeHostAdmittedSignedReviewedChildV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { resolveWorkflowCombinedRunPlacementV1 } from '@happier-dev/protocol/actions/executor/workflowRunActions';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { BACKUP_RECEIVER_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { BACKUP_RECEIVER_RECIPE_REF_V1 } from '@happier-dev/protocol/machines/setup/machineRecipeReferenceV1';
import { projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentCandidatePublicationV1';
import { createMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCombinedMachineSetupActionDeps, createMachineSetupApplyDispatcher } from './composeMachineSetup';

const readyActionAutomations = {
  select: async () => ({ status: 'ready' as const, subjects: [], before: [], after: [] }),
  start: async () => ({ runs: [], notices: [] }),
};

function createBackupReceiverSetupFixture(overrides?: Readonly<{
  bindingMachineId?: string;
  targetMachineId?: string;
  targetHomeId?: string;
  nonBackupRootAction?: boolean;
}>) {
  const homeId = 'srv_backup_home';
  const accountId = 'actor';
  const sourceMachineId = overrides?.bindingMachineId ?? 'source-machine';
  const receiverMachineId = 'receiver-machine';
  const receiverInstallationId = 'receiver-installation';
  const targetMachineId = overrides?.targetMachineId ?? receiverMachineId;
  const targetHomeId = overrides?.targetHomeId ?? homeId;
  const selection = { ref: BACKUP_RECEIVER_RECIPE_REF_V1, inputs: { senderPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest' } };
  const receiverPlan = createMachineSetupEffectPlan({
    basis: { kind: 'setup', machineId: targetMachineId, desiredRevision: 0, selection },
    steps: [],
    nativeFacts: [],
  });
  const applyInput = MachineSetupApplyInputV1Schema.parse({
    homeId: targetHomeId,
    machineId: targetMachineId,
    targets: [{
      homeId: targetHomeId,
      machineId: targetMachineId,
      desiredRevision: 0,
      sources: [{ kind: 'direct', setup: { items: [{ kind: 'setupRecipe', selection }] } }],
      exclusions: [],
      recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan: receiverPlan }],
    }],
  });
  const rootTarget = { kind: 'machine' as const, machineId: sourceMachineId };
  const rootInput = {
    serverId: homeId,
    environmentId: 'environment',
    expectedRevision: 3,
    intent: 'test' as const,
    destinationSetup: {
      kind: 'anotherMachine' as const,
      machineId: receiverMachineId,
      expectedInstallationId: receiverInstallationId,
      receiverInputs: {},
    },
    configuration: {
      configRevision: 1,
      destinationRef: { pluginId: 'happier.backup.local', localId: 'open' },
      occurrenceId: 'destination',
      config: { path: '/private/repository' },
      credentialBindings: [],
      sources: [{ kind: 'dump' as const, sourceId: 'database', service: 'postgres', consistency: 'logical' as const }],
      ownership: { environmentId: 'environment', prefix: 'owner-prefix' },
      retention: { kind: 'keepEverything' as const },
    },
  };
  const envelope = overrides?.nonBackupRootAction
    ? { v: 1 as const, requestId: 'setup-root', target: rootTarget, input: applyInput }
    : { v: 1 as const, requestId: 'backup-configure', target: rootTarget, input: rootInput };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({
    v: 1,
    token: 'home-verified-backup',
    binding: {
      accountId,
      custodianAccountId: accountId,
      authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'e2ee',
      serverIdentityId: homeId,
      machineId: sourceMachineId,
      installationId: 'source-installation',
      actionId: overrides?.nonBackupRootAction ? 'machines.setup.apply' : 'deployments.backups.configure',
      requestId: envelope.requestId,
      target: rootTarget,
      ...(overrides?.nonBackupRootAction ? {} : {
        environmentId: 'environment',
        deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.configure', rootInput),
      }),
      admittedMachineRole: 'manage',
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    },
  });
  const context = {
    surface: 'ui' as const,
    authority: 'present_user' as const,
    serverId: homeId,
    runtimeAccountId: accountId,
    actionRequestId: 'child-apply-request',
    externalActionExecutionAuthorization: authorization,
    externalActionTarget: rootTarget,
    originalActionEnvelope: envelope,
    operationAcceptance: { actionId: 'machines.setup.apply', operationId: 'sender-op', accept: () => {} },
  };
  return { homeId, accountId, sourceMachineId, receiverMachineId, receiverInstallationId, applyInput, rootInput, context };
}

describe('backup receiver Setup Apply forwarding', () => {
  it('forwards the reviewed Backup receiver Setup Apply child to native RPC on the source host instead of starting a local combined Run', async () => {
    const fixture = createBackupReceiverSetupFixture();
    const nativeCalls: unknown[] = [];
    let startCombinedCalls = 0;
    const setupDeps = createCombinedMachineSetupActionDeps({
      readDeps: createUnavailableActionTransportDeps,
      targetPlan: async () => { throw new Error('Plan already reviewed'); },
      readHostFacts: async () => ({ machines: [{ machineId: fixture.receiverMachineId, online: true }] }),
      orchestrationDirectory: '/sender/home',
      startCombined: async request => {
        startCombinedCalls++;
        await resolveWorkflowCombinedRunPlacementV1(request, request.start.runId, async () => ({
          machineId: fixture.sourceMachineId,
          installationId: 'source-installation',
          orchestrationDirectory: '/sender/home',
        }), dir => dir);
        throw new Error('Sender must not reach combined Run admission');
      },
      waitForRun: async () => { throw new Error('Sender must not wait on a local Run'); },
      readInvocations: async () => { throw new Error('Sender must not read local Run invocations'); },
    });
    const executor = createActionExecutor({
      ...createUnavailableActionTransportDeps(),
      actionAutomations: readyActionAutomations,
      prepareMachineSetupApply: setupDeps.prepareMachineSetupApply,
      machineSetupApply: createMachineSetupApplyDispatcher({
        readDeps: createUnavailableActionTransportDeps,
        localMachineId: fixture.sourceMachineId,
        native: async request => {
          nativeCalls.push(request.input);
          return { operationId: 'receiver-op', runId: 'receiver-run' };
        },
        compose: setupDeps.machineSetupApply!,
      }),
    });

    const result = await invokeHostReviewedChildV1({
      parent: { actionId: 'deployments.backups.configure', input: fixture.rootInput },
      child: { ...BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply, input: fixture.applyInput },
      context: fixture.context,
      approvedBy: { accountId: fixture.accountId },
      admittedReview: { ...BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply, surface: 'ui' },
      execute: (value, admitted) => executor.execute('machines.setup.apply', value, admitted),
    });

    expect(result, JSON.stringify(result)).toEqual({ ok: true, result: { operationId: 'receiver-op', runId: 'receiver-run' } });
    expect(nativeCalls).toEqual([fixture.applyInput]);
    expect(startCombinedCalls).toBe(0);
  });

  it.each([
    { label: 'with receivingAdmission', withReceivingAdmission: true, localMachineId: undefined },
    { label: 'when localMachineId matches receiver', withReceivingAdmission: false, localMachineId: 'receiver-machine' },
  ] as const)('keeps the reviewed Backup receiver Setup Apply child on the composed Workflow Run owner on the receiving Machine ($label)', async scenario => {
    const fixture = createBackupReceiverSetupFixture();
    let nativeCalls = 0;
    let composeCalls = 0;
    const dispatch = createMachineSetupApplyDispatcher({
      readDeps: createUnavailableActionTransportDeps,
      ...(scenario.localMachineId ? { localMachineId: scenario.localMachineId } : {}),
      native: async () => { nativeCalls++; return { operationId: 'wrong-native' }; },
      compose: async () => { composeCalls++; return { operationId: 'receiver-composed-op', runId: 'receiver-run' }; },
    });
    const child = {
      actionId: BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply.action,
      role: BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply.role,
      inputDigest: computeActionInputApprovalDigestV1(BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply.action, fixture.applyInput),
      environmentId: 'environment',
      input: fixture.applyInput,
    };
    const result = await invokeHostAdmittedSignedReviewedChildV1({
      context: fixture.context,
      child,
      ...(scenario.withReceivingAdmission ? {
        receivingAdmission: {
          actorAccountId: fixture.accountId,
          custodianAccountId: fixture.accountId,
          machineId: fixture.receiverMachineId,
          installationId: fixture.receiverInstallationId,
          role: 'manage' as const,
          encryptionMode: 'e2ee' as const,
        },
      } : {}),
      execute: (_value, admitted) => dispatch({ input: fixture.applyInput, context: admitted }),
    });

    expect(result).toEqual({ operationId: 'receiver-composed-op', runId: 'receiver-run' });
    expect(composeCalls).toBe(1);
    expect(nativeCalls).toBe(0);
  });

  it.each([
    'no host reviewed child proof',
    'wrong child role',
    'tampered input',
    'third machine',
    'same-machine root',
    'non-backup root action',
    'wrong homeId',
  ] as const)('refuses remote Backup receiver Setup Apply forwarding on %s', async scenario => {
    const fixture = createBackupReceiverSetupFixture({
      ...(scenario === 'third machine' ? { targetMachineId: 'third-machine' } : {}),
      ...(scenario === 'same-machine root' ? { bindingMachineId: 'receiver-machine' } : {}),
      ...(scenario === 'non-backup root action' ? { nonBackupRootAction: true } : {}),
      ...(scenario === 'wrong homeId' ? { targetHomeId: 'srv_other_home' } : {}),
    });
    let nativeCalls = 0;
    let composeCalls = 0;
    const dispatch = createMachineSetupApplyDispatcher({
      readDeps: createUnavailableActionTransportDeps,
      localMachineId: fixture.sourceMachineId,
      native: async () => { nativeCalls++; return { operationId: 'unexpected-forward' }; },
      compose: async () => { composeCalls++; return { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }; },
    });
    if (scenario === 'no host reviewed child proof') {
      await dispatch({ input: fixture.applyInput, context: fixture.context });
    } else {
      const reviewedInput = scenario === 'tampered input'
        ? { ...fixture.applyInput, targets: [{ ...fixture.applyInput.targets[0]!, desiredRevision: 99 }] }
        : fixture.applyInput;
      const role = scenario === 'wrong child role'
        ? BACKUP_RECEIVER_SETUP_CHILDREN_V1.plan.role
        : BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply.role;
      await invokeHostAdmittedSignedReviewedChildV1({
        context: fixture.context,
        child: {
          actionId: BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply.action,
          role,
          inputDigest: computeActionInputApprovalDigestV1(BACKUP_RECEIVER_SETUP_CHILDREN_V1.apply.action, reviewedInput),
          input: reviewedInput,
        },
        execute: (_value, admitted) => dispatch({ input: fixture.applyInput, context: admitted }),
      });
    }
    expect(nativeCalls).toBe(0);
    expect(composeCalls).toBe(1);
  });
});
