import { describe, expect, it, vi } from 'vitest';

import { createActionOperationRunner } from './actionOperationRunner';
import { createActionOperationStore } from './actionOperationStore';
import { getActionSpec } from '@happier-dev/protocol/actions';
import { MACHINE_REACHABILITY_ACTION_IDS_V1 } from '@happier-dev/protocol/machines/reachability/actionIdsV1';
import { MachineAgentIsolationReadyPreviewV1Schema, MachineAgentIsolationSetInputV1Schema, MachineStorageDockerPruneResultV1Schema } from '@happier-dev/protocol';
import { ActionOperationCredentialUseV1Schema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ActionOperationSnapshotV1Schema, projectActionOperationSnapshotForV1Reader, readActionOperationTerminalResultV1 } from '@happier-dev/protocol/actions/operations/v1';
import { MachineAdminAccessMutationResultV1Schema } from '@happier-dev/protocol/machines/adminAccessV1';
import { ActionOperationSnapshotV1Schema as PredecessorSnapshotSchema } from './testFixtures/predecessorActionOperationV1';
import { createRpcCallError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { completeSpawnActionResult, normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';
import { callSocketRpc, type SocketRpcContent } from '@happier-dev/sync-client';

const scope = { accountId: 'account-1', machineId: 'machine-1' } as const;

describe('action operation canonical execution observer', () => {
  it.each(['returned', 'thrown'] as const)('retains a managed child refusal through the %s failure carrier and current reader', async carrier => {
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.managed.acquire');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'managed-refusal',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    const refusal = { type: 'error' as const, code: 'spawn_failed' as const, retryable: false,
      launchError: { kind: 'launch_error' as const, code: 'agent_cli_target_unavailable', message: 'The Agent CLI cannot run in this target' } };
    const child = completeSpawnActionResult(refusal);
    if (child.ok) throw new Error('Expected the ordinary spawn failure');
    const failure = { ...child, requestId: 'native-child-request', effectAttempted: false };
    const request = { actionId: spec.id, scope, requestId: 'managed-root-request', input: {}, execute: async () => {
      if (carrier === 'thrown') throw ManagedMachineControllerError.fromActionFailure(failure, 'session.spawn_new');
      return failure;
    } };
    if (carrier === 'thrown') await expect(runner.observe(request)).rejects.toMatchObject({ code: 'spawn_failed' });
    else await expect(runner.observe(request)).resolves.toMatchObject(failure);
    const retained = ActionOperationSnapshotV1Schema.parse(JSON.parse(JSON.stringify(store.get(scope, 'managed-refusal'))));
    expect(retained).toMatchObject({ state: 'failed', requestId: 'managed-root-request', error: {
      errorCode: 'spawn_failed', error: refusal.launchError.message, requestId: failure.requestId, effectAttempted: false, details: refusal,
    } });
    expect(readActionOperationTerminalResultV1(retained)).toMatchObject(failure);
  });
  it.each([
    { actionId: 'machines.setup.apply', privateContent: false, retained: true },
    { actionId: 'machines.reboot', privateContent: false, retained: false },
    { actionId: 'machines.setup.apply', privateContent: true, retained: false },
  ] as const)('retains only the public combined Setup receipt while its root is active ($actionId, private=$privateContent)', async ({ actionId, privateContent, retained }) => {
    const store = createActionOperationStore();
    const spec = getActionSpec(actionId);
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'receipt-root', resolveAction: () => ({
      actionId: spec.id, title: spec.title, operation: spec.operation,
    }) });
    let finish!: () => void;
    const effect = new Promise<void>(resolve => { finish = resolve; });
    const receipt = { operationId: 'receipt-root', runId: 'setup-run', ...(privateContent ? { privateToken: 'do-not-retain' } : {}) };
    const request = { actionId, scope, requestId: 'combined-setup-receipt', input: {},
      execute: async (context: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]) => {
        context.operationAcceptance?.accept(receipt);
        await effect;
        return { ok: true as const, result: { settled: true } };
      },
    };
    try {
      expect(await runner.observe(request)).toEqual({ ok: true, result: receipt });
      expect(store.get(scope, 'receipt-root')?.state).toBe('running');
      expect(store.get(scope, 'receipt-root')?.result).toEqual(retained ? receipt : undefined);
    } finally { finish(); }
    expect(await runner.observe({ ...request, response: 'terminal' })).toEqual({ ok: true, result: { settled: true } });
    expect(store.get(scope, 'receipt-root')).toMatchObject({ state: 'succeeded', result: { settled: true } });
  });

  it('keeps a child terminal observer attached while another observer receives its approval', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, resolveAction: actionId => ({ actionId,
      title: 'Verify source workspace', operation: { version: 1, visibility: 'activity', progress: 'reported' } }) });
    const approval = { kind: 'approval_request_created', artifactId: 'workspace-approval', actionId: 'action.invoke' };
    let finish!: () => void;
    const decision = new Promise<void>(resolve => { finish = resolve; });
    let executions = 0;
    const request = { actionId: 'example.review-source/prepare', scope, requestId: 'account-workspace-child', input: {},
      execute: async (context: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]) => {
        executions++;
        context.operationAcceptance?.accept(approval);
        await decision;
        return { ok: true as const, result: { kind: 'verified' } };
      } };
    let childSettled = false;
    const child = runner.observe({ ...request, response: 'terminal' }).then(result => { childSettled = true; return result; });
    try {
      expect(await runner.observe(request)).toEqual({ ok: true, result: approval });
      await Promise.resolve();
      expect(childSettled).toBe(false);
    } finally { finish(); }
    expect(await child).toEqual({ ok: true, result: { kind: 'verified' } });
    expect(executions).toBe(1);
    expect(store.list(scope).items).toMatchObject([{ state: 'succeeded' }]);
  });

  it.each(MACHINE_REACHABILITY_ACTION_IDS_V1)('retains closed native Network failures in Activity for %s', async actionId => {
    const store = createActionOperationStore();
    const spec = getActionSpec(actionId);
    let sequence = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `network-failure-${sequence++}`,
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    const details = { requiredFact: 'caddyContainer', failure: { kind: 'native_observation_unavailable',
      reason: 'required_fact_unavailable', requiredFact: 'caddyContainer', errorCode: 'ENOENT' },
      remedy: 'Restore native container inventory before retrying.' };
    const failure = { ok: false as const, errorCode: 'required_fact_unavailable', error: 'required_fact_unavailable',
      effectAttempted: false, details };
    await runner.observe({ actionId, scope, requestId: 'closed-native-failure', input: {}, execute: async () => failure });
    expect(store.get(scope, 'network-failure-0')).toMatchObject({ state: 'failed',
      error: { errorCode: failure.errorCode, effectAttempted: false, details } });
    await runner.observe({ actionId, scope, requestId: 'private-native-output', input: {},
      execute: async () => ({ ...failure, details: { ...details, stderr: 'private native output' } }) });
    expect(store.get(scope, 'network-failure-1')?.error).not.toHaveProperty('details');
  });
  it('preserves strict authored input for an existing fresh bootstrap retry policy', async () => {
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.managed.bootstrap.retry');
    const runner = createActionOperationRunner({ store, resolveAction: () => ({ actionId: spec.id, title: spec.title,
      operation: spec.operation, operationReentry: spec.operationReentry }) });
    const input = spec.inputSchema.parse({ homeId: 'home', managedId: 'original-machine', expectedIntentRevision: 0 });
    const request = { actionId: spec.id, scope, requestId: 'bootstrap-retry', input,
      execute: async () => ({ ok: false as const, errorCode: 'action_failed', error: 'action_failed', effectAttempted: false }) };
    await runner.observe(request);
    let effects = 0;
    const retry = { ...request, execute: async () => { effects++; return { ok: true as const, result: {} }; } };
    expect(await runner.observe({ ...retry,
      input: spec.inputSchema.parse({ homeId: 'home', managedId: 'substituted-machine', expectedIntentRevision: 0 }) }))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    expect(effects).toBe(0);
    expect(await runner.observe(retry)).toMatchObject({ ok: true });
    expect(effects).toBe(1);
  });

  it('preserves deployment child and token origin checks when retrying a no-effect failure', async () => {
    const store = createActionOperationStore();
    const spec = getActionSpec('deployments.deploy');
    let sequence = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `deployment-attempt-${sequence++}`,
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation,
        operationReentry: () => 'freshEquivalentInput' }) });
    const semanticInput = { serverId: 'home', environmentId: 'environment', targetLinkId: 'target',
      requestKey: 'deploy-request', sha: 'a'.repeat(40) };
    const input = { serverId: 'home', environmentId: 'environment', expectedRevision: 2, requestKey: 'deploy-request',
      targetLinkId: 'target', expectedTargetLinkRevision: 1, contentArtifactId: 'first-candidate',
      contentHeaderVersion: 3, contentBodyVersion: 3 };
    const request = { actionId: spec.id, scope, requestId: 'deploy-request', input, semanticInput,
      deploymentChildIdentity: 'original-child',
      deploymentTokenOrigin: { serverIdentityId: 'home', credentialId: 'original-credential', environmentId: 'environment' },
      execute: async () => ({ ok: false as const, errorCode: 'database_transaction_conflict_exhausted',
        error: 'database_transaction_conflict_exhausted', effectAttempted: false }) };
    await runner.observe(request);
    const execute = vi.fn(async () => ({ ok: true as const, result: { deploymentId: 'receipt' } }));
    const retry = { ...request, input: { ...input, contentArtifactId: 'regenerated-candidate' }, execute };
    expect(await runner.observe({ ...retry, deploymentChildIdentity: 'different-child' }))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    expect(await runner.observe({ ...retry, deploymentTokenOrigin: { ...request.deploymentTokenOrigin, credentialId: 'different-credential' } }))
      .toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    expect(execute).not.toHaveBeenCalled();
    expect(await runner.observe(retry)).toMatchObject({ ok: true, result: { deploymentId: 'receipt' } });
  });

  it.each(['backup_failed', 'cancelled'] as const)('retains exact Test probe cleanup facts on settlement and replay (%s)', async code => {
    const store = createActionOperationStore();
    const spec = getActionSpec('deployments.backups.test');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'probe-failure',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    const probe = { key: 'happier-destination-probe-5c933c77-66a9-41c2-9a47-068b2b795ce9', cleanup: 'unknown' } as const;
    const request = { actionId: spec.id, scope, requestId: 'test-destination', input: {},
      execute: async () => ({ ok: false as const, errorCode: code, error: code,
        details: { step: 'delete', code, probe, privateValue: 'native-secret-output' } }) };
    await runner.observe(request);
    const snapshot = store.get(scope, 'probe-failure');
    expect(snapshot).toMatchObject({ state: code === 'cancelled' ? 'cancelled' : 'failed',
      result: { step: 'delete', code, probe } });
    expect(ActionOperationSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('native-secret-output');
    expect(await runner.observe({ ...request, execute: async () => { throw new Error('Must replay the retained result'); } }))
      .toMatchObject({ ok: false, details: { step: 'delete', code, probe } });
  });

  it('settles a known Project Open checkout refusal as failed with its original failureCause and receipt', async () => {
    const store = createActionOperationStore();
    const spec = getActionSpec('projects.open');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'failed-open',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    const result = { kind: 'refused', code: 'COMMAND_FAILED', failureCause: { phase: 'project_open.checkout_ref',
      errorClass: 'Error', errorCode: null, httpStatus: null } } as const;
    await runner.observe({ actionId: spec.id, scope, requestId: 'open', input: {},
      execute: async () => ({ ok: true, result }) });
    expect(store.get(scope, 'failed-open')).toMatchObject({ state: 'failed',
      error: { errorCode: result.code, failureCause: result.failureCause }, result });
  });
  it('retains the child failureCause on the managed operation and projects it away for a predecessor reader', async () => {
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.managed.acquire');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'failed-acquire',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    const failure = normalizeActionExecutorThrownError(ManagedMachineControllerError.fromActionFailure({ ok: false,
      errorCode: 'RPC_FORBIDDEN', error: 'token=PRIVATE_TOKEN', details: { token: 'PRIVATE_TOKEN' },
    }, 'machines.agentIsolation.preview'));
    await runner.observe({ actionId: spec.id, scope, requestId: 'creation', input: {}, execute: async () => ({ ok: false, ...failure }) });
    const snapshot = store.get(scope, 'failed-acquire');
    expect(snapshot).toMatchObject({ state: 'failed', error: { errorCode: 'action_failed', error: 'RPC_FORBIDDEN', failureCause: {
      errorClass: 'ManagedMachineControllerError', errorCode: 'RPC_FORBIDDEN', phase: 'machines.agentIsolation.preview',
    } } });
    if (!snapshot) throw new Error('Missing retained failure');
    const predecessor = projectActionOperationSnapshotForV1Reader(snapshot);
    expect(PredecessorSnapshotSchema.safeParse(predecessor).success).toBe(true);
    expect(predecessor.error).not.toHaveProperty('details');
    expect(predecessor.error).not.toHaveProperty('failureCause');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_TOKEN');
  });
  it('rejoins pending review only for matching input and clears its result before a newly reviewed resume', async () => {
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.agentIsolation.set');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'reviewed-owner',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation!, operationReentry: spec.operationReentry }) });
    const firstReview = MachineAgentIsolationReadyPreviewV1Schema.parse({ kind: 'ready', policy: { enabled: true }, metadataVersion: 1,
      status: { kind: 'applying', phase: 'workspace' }, plan: { roots: [], ancestorAcls: [], sessionsToReplace: 0,
        requiresAdmin: true, planDigest: 'first-review' } });
    const nextReview = MachineAgentIsolationReadyPreviewV1Schema.parse({ ...firstReview,
      plan: { ...firstReview.plan, planDigest: 'changed-native-facts' } });
    const firstInput = MachineAgentIsolationSetInputV1Schema.parse({ machineId: scope.machineId, enabled: true,
      expectedPolicy: firstReview.policy, expectedMetadataVersion: firstReview.metadataVersion, expectedPlanDigest: firstReview.plan.planDigest });
    const nextInput = { ...firstInput, expectedPlanDigest: nextReview.plan.planDigest };
    const identity = { actionId: spec.id, scope, requestId: 'retained-native-intent' };
    const pendingReceipt = { kind: 'approval_request_created', artifactId: 'pending-first-review', actionId: spec.id } as const;
    const nextPendingReceipt = { ...pendingReceipt, artifactId: 'pending-changed-review' };
    let executions = 0;
    await runner.observe({ ...identity, input: { ...firstInput, expectedPlanDigest: 'initial' }, execute: async operation => {
      executions++;
      operation.publishOwnerUpdate({ state: 'running', observation: { kind: 'review_required', code: 'agent_isolation_effect_changed',
        machineId: scope.machineId, enabled: true, current: firstReview } });
      return { ok: true, result: { kind: 'plan_changed', operationId: 'reviewed-owner', current: firstReview } };
    } });
    expect(await runner.observe({ ...identity, input: firstInput, rejoinPendingApproval: true, execute: async () => {
      executions++; return { ok: true, result: pendingReceipt };
    } })).toEqual({ ok: true, result: pendingReceipt });
    const mustNotExecute = async () => { throw new Error('A retry is not another native intent'); };
    expect(await runner.observe({ ...identity, input: firstInput, rejoinPendingApproval: true, execute: mustNotExecute }))
      .toEqual({ ok: true, result: pendingReceipt });
    expect(await runner.observe({ ...identity, input: { ...firstInput, expectedPlanDigest: 'not-reviewed' },
      rejoinPendingApproval: true, execute: mustNotExecute })).toMatchObject({ ok: false, errorCode: 'action_request_input_conflict' });
    // The approved continuation may itself discover new facts. Its original
    // Artifact cannot answer the newly reviewed operands on the next native submit.
    await runner.observe({ ...identity, input: firstInput, execute: async operation => {
      executions++;
      expect(operation.resumeActionRequest).toBe(true);
      operation.publishOwnerUpdate({ state: 'running', observation: { kind: 'review_required', code: 'agent_isolation_effect_changed',
        machineId: scope.machineId, enabled: true, current: nextReview } });
      return { ok: true, result: { kind: 'plan_changed', operationId: 'reviewed-owner', current: nextReview } };
    } });
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const resumed = runner.observe({ ...identity, input: nextInput, rejoinPendingApproval: true, execute: async operation => {
      executions++; expect(operation.resumeActionRequest).toBe(true);
      enter(); await held;
      return { ok: true, result: nextPendingReceipt };
    } });
    try {
      expect(await Promise.race([entered.then(() => 'executing'), resumed.then(() => 'old-receipt')])).toBe('executing');
      expect(store.get(scope, 'reviewed-owner')).not.toHaveProperty('result');
      expect(store.list(scope).items).toHaveLength(1);
    } finally { release(); await resumed; }
    expect(await resumed).toEqual({ ok: true, result: nextPendingReceipt });
    expect(await runner.observe({ ...identity, input: nextInput, rejoinPendingApproval: true, execute: mustNotExecute }))
      .toEqual({ ok: true, result: nextPendingReceipt });
    expect(executions).toBe(4);
  });

  it('refuses an observation-only pending join after terminal projection while the original handler is still alive', async () => {
    const store = createActionOperationStore();
    const spec = getActionSpec('deployments.deploy');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'pending-observation',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const pending = { ok: true, environmentId: 'environment', revision: 2,
      kind: 'pending', actionOperationId: 'pending-observation' } as const;
    const request = { actionId: 'deployments.deploy', scope, requestId: 'original-deploy', input: { captured: 'unchanged' },
      async execute(context: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]) {
        context.operationAcceptance?.accept(pending);
        await gate;
        return { ok: true as const, result: { settled: true } };
      } };
    try {
      expect(await runner.observe(request)).toEqual({ ok: true, result: pending });
      store.succeed('pending-observation', { settled: true });
      const onOperation = vi.fn();
      // The private host hint cannot replay a terminal result or expose the
      // still-live acceptance promise after the canonical snapshot settled.
      const observation = { ...request, existingDeploymentOperationId: 'pending-observation', onOperation };
      expect(await runner.observe(observation)).toEqual({ ok: false,
        errorCode: 'action_operation_unavailable', error: 'action_operation_unavailable' });
      expect(onOperation).not.toHaveBeenCalled();
      expect(store.get(scope, 'pending-observation')).toMatchObject({ state: 'succeeded', result: { settled: true } });
    } finally { finish(); }
  });

  it.each(['not_applied', 'outcome_unknown', 'needs_attendance'] as const)('does not call a persisted administrator intent host success (%s)', async outcome => {
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.setup.adminAccess.set');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'admin-transition',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    const receipt = { status: 'applied' as const, policy: { version: 1 as const, mode: 'preauthorized' as const }, metadataVersion: 2,
      effect: outcome === 'not_applied' ? { outcome, reasonCode: 'not_preauthorized' as const }
        : outcome === 'needs_attendance' ? { outcome, operationId: 'admin-transition',
          prompt: { kind: 'sudo.password' as const, adminUsername: 'ops.admin' } } : { outcome } };
    let executions = 0;
    const request = { actionId: spec.id, scope, requestId: 'reviewed-admin-transition',
      execute: async () => { executions++; return { ok: true as const, result: receipt }; } };
    expect(await runner.observe(request)).toEqual({ ok: true, result: receipt });
    const operation = store.get(scope, 'admin-transition');
    if (outcome === 'not_applied') {
      expect(operation).toMatchObject({ state: 'failed', error: { errorCode: 'not_preauthorized' } });
      expect(operation).not.toHaveProperty('result');
    } else {
      expect(operation).toMatchObject({ state: 'running', cancellation: 'unsupported',
        observation: { kind: 'outcome_uncertain', code: outcome === 'needs_attendance' ? outcome : 'action_outcome_unknown' } });
      expect(operation).not.toHaveProperty('settledAt');
      expect(await runner.observe(request)).toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
      expect(executions).toBe(1);
    }
  });

  it.each([
    ['distinctAdministrator', 'Choose an administrator account different from the Machine daemon user, then retry.'],
    ['administratorSudoToRoot', 'Choose an administrator with its own sudo-to-root right and a valid password, then retry.'],
  ])('retains the native %s recovery on a refused administrator transition', async (requiredFact, remedy) => {
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.setup.adminAccess.set');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'admin-transition',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    const failure = { kind: 'native_check_unavailable', reason: 'required_fact_unavailable', requiredFact, remedy };
    const receipt = MachineAdminAccessMutationResultV1Schema.parse({ status: 'applied',
      policy: { version: 1, mode: 'ask', administratorUsername: 'ops.admin' }, metadataVersion: 2,
      effect: { outcome: 'not_applied', reasonCode: failure.kind, failure } });
    await runner.observe({ actionId: spec.id, scope, requestId: 'reviewed-admin-transition',
      execute: async () => ({ ok: true as const, result: receipt }) });
    const operation = ActionOperationSnapshotV1Schema.parse(store.get(scope, 'admin-transition'));
    expect(operation).toMatchObject({ state: 'failed', error: { errorCode: failure.kind,
      details: { kind: 'machineSetup', failure } } });
    expect(operation).not.toHaveProperty('result');
  });

  it.each(['already_waiting', 'becomes_waiting'] as const)('returns an active approval hold without settling or replaying the Action (%s)', async timing => {
    const store = createActionOperationStore();
    const spec = getActionSpec('deployments.deploy');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'approval-held',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }),
    });
    let finish!: () => void;
    let hold!: () => void;
    const executionGate = new Promise<void>(resolve => { finish = resolve; });
    const execute = vi.fn(async (context: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]) => {
      hold = () => context.updateProgress({ phase: 'waiting_for_approval', label: 'Waiting for approval',
        approval: { kind: 'approval_request_created', artifactId: 'approval', actionId: 'deployments.deploy' } });
      if (timing === 'already_waiting') hold();
      await executionGate;
      return { ok: true as const, result: { deployed: true } };
    });
    const execution = runner.observe({ actionId: 'deployments.deploy', scope, requestId: 'exact-deploy', execute });
    await new Promise<void>(resolve => setImmediate(resolve));
    const observation = new AbortController();
    let observed: Awaited<ReturnType<typeof runner.waitForTerminal>> | undefined;
    const waiting = runner.waitForTerminal(scope, 'approval-held', observation.signal,
      { includeSetupReview: true }).then(snapshot => { observed = snapshot; });
    let terminalObserved = false;
    const terminal = runner.waitForTerminal(scope, 'approval-held').then(snapshot => {
      terminalObserved = true;
      return snapshot;
    });
    try {
      if (timing === 'becomes_waiting') hold();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(observed).toMatchObject({ operationId: 'approval-held', state: 'running',
        progress: { kind: 'phase', phase: 'waiting_for_approval' } });
      expect(observed).not.toHaveProperty('settledAt');
      expect(terminalObserved).toBe(false);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      observation.abort();
      await waiting.catch(() => undefined);
      finish();
      await execution;
      await terminal;
    }
    await expect(runner.waitForTerminal(scope, 'approval-held')).resolves.toMatchObject({ state: 'succeeded', result: { deployed: true } });
  });

  it.each(['acknowledged', 'handler_cancelled', 'handler_throws', 'other_operation', 'unvalidated_receipt'] as const)('keeps uncertain native service control owned instead of terminalizing its typed receipt (%s)', async carrier => {
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.services.control');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'native-control',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    const execution = runner.observe({ actionId: spec.id, scope, requestId: 'native-stop',
      input: { serverId: 'home', machineId: scope.machineId, serviceId: 'service', expectedGeneration: 'generation', operation: 'stop' },
      async execute(context) {
        if (!context.operationAcceptance) throw new Error('Expected canonical operation acceptance');
        context.publishOwnerUpdate({ cancellation: 'unsupported', outcome: {
          ok: false, errorCode: 'action_outcome_unknown', error: 'Native settlement is unknown',
        } });
        if (carrier === 'handler_throws') throw Object.assign(new Error('Caller release failed'), { code: 'caller_release_failed' });
        if (carrier === 'handler_cancelled') return { ok: false, errorCode: 'cancelled', error: 'Current caller retired' };
        return { ok: true, result: { kind: 'outcome_unknown', operation: {
          operationId: carrier === 'other_operation' ? 'other-native-operation' : context.operationAcceptance.operationId,
        }, ...(carrier === 'unvalidated_receipt' ? { state: 'stopped' } : {}) } };
      } });
    const errorCode = carrier === 'handler_throws' ? 'caller_release_failed'
      : carrier === 'handler_cancelled' ? 'cancelled' : 'action_outcome_unknown';
    if (carrier === 'handler_throws') await expect(execution).rejects.toMatchObject({ code: errorCode });
    else expect(await execution).toMatchObject(carrier === 'acknowledged'
        ? { ok: true, result: { kind: 'outcome_unknown', operation: { operationId: 'native-control' } } }
        : { ok: false, errorCode });
    expect(store.get(scope, 'native-control')).toMatchObject({ state: 'running', cancellation: 'unsupported',
      observation: { kind: 'outcome_uncertain', code: errorCode } });
    expect(store.get(scope, 'native-control')).not.toHaveProperty('settledAt');
  });

  it.each(['acknowledged', 'unvalidated_receipt'] as const)('retains a strict typed prune receipt while native settlement stays uncertain without effect replay (%s)', async carrier => {
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.storage.docker.prune');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'native-prune',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    const receipt = MachineStorageDockerPruneResultV1Schema.parse({ kind: 'outcome_unknown', removed: [], kept: [] });
    let effects = 0;
    const request = { actionId: spec.id, scope, requestId: 'native-prune-request',
      input: { serverId: 'home', machineId: scope.machineId, expectedEngineId: 'engine',
        selection: { kind: 'explicit', images: [], buildCacheIds: [] } },
      async execute(context: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]) {
        effects++;
        context.publishOwnerUpdate({ cancellation: 'unsupported', outcome: {
          ok: false, errorCode: 'action_outcome_unknown', error: 'Native settlement is unknown',
        } });
        return { ok: true as const, result: carrier === 'acknowledged' ? receipt : { ...receipt, state: 'removed' } };
      } };
    const observed = await runner.observe(request);
    expect(store.get(scope, 'native-prune')).toMatchObject({ state: 'running', cancellation: 'unsupported',
      observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' } });
    expect(store.get(scope, 'native-prune')).not.toHaveProperty('settledAt');
    if (carrier === 'acknowledged') expect(observed).toEqual({ ok: true, result: receipt });
    else expect(observed).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
    expect(await runner.observe(request)).toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
    expect(effects).toBe(1);
  });

  it('retains a typed RPC refusal thrown by a managed Action in its terminal operation', async () => {
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.managed.power.set');
    const runner = createActionOperationRunner({ store,
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    await expect(runner.observe({ actionId: 'machines.managed.power.set', scope, requestId: 'explicit-stop',
      input: { homeId: 'home', managedId: 'managed', intent: 'stop', when: 'now' },
      execute: async () => { throw createRpcCallError({ error: 'Guest refused the activity read', errorCode: RPC_ERROR_CODES.FORBIDDEN }); } }))
      .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    expect(store.list(scope).items).toMatchObject([{ state: 'failed', error: { errorCode: RPC_ERROR_CODES.FORBIDDEN } }]);
  });
  it.each(['plain', 'e2ee'] as const)('retains Home availability facts from a thrown %s socket refusal in the Setup operation', async mode => {
    const details = { reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' };
    const store = createActionOperationStore();
    const spec = getActionSpec('machines.setup.apply');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'refused-setup',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation! }) });
    // Only the Home socket is faked; RPC decoding, exception projection and operation persistence stay real.
    const socket = { emit() {}, timeout: () => ({ emitWithAck: async () => ({ ok: false,
      error: 'Target unavailable', errorCode: 'target_unavailable', details }) }) };
    const content: SocketRpcContent = mode === 'plain' ? { mode } : { mode, cipher: {
      encryptRaw: async () => 'ciphertext', decryptRaw: async () => { throw new Error('Refusal must not be opened'); },
    } };
    await expect(runner.observe({ actionId: spec.id, scope, requestId: 'setup-request',
      execute: async () => ({ ok: true, result: await callSocketRpc({ socket,
        target: { kind: 'machine', id: scope.machineId }, method: 'actionOperation.list.v2', params: {}, content, timeoutMs: 30_000 }) }) }))
      .rejects.toMatchObject({ rpcErrorCode: 'target_unavailable', details });
    const snapshot = ActionOperationSnapshotV1Schema.parse(JSON.parse(JSON.stringify(store.get(scope, 'refused-setup'))));
    expect(snapshot).toMatchObject({ state: 'failed', error: { errorCode: 'target_unavailable', details,
      failureCause: { phase: spec.id, errorClass: 'RpcError', errorCode: 'target_unavailable' } } });
    expect(PredecessorSnapshotSchema.safeParse(projectActionOperationSnapshotForV1Reader(snapshot)).success).toBe(true);
  });
  it('continues an arbitrary tracked Action past its deferred approval receipt', async () => {
    const store = createActionOperationStore();
    let operationNumber = 0;
    let executionCount = 0;
    const action = {
      actionId: 'plugin.example.publish',
      title: 'Publish example',
      operation: {
        version: 1 as const,
        visibility: 'activity' as const,
        progress: 'reported' as const,
        presentation: { onStart: 'detail' as const },
      },
    };
    const runner = createActionOperationRunner({
      store,
      generateOperationId: () => `arbitrary-approval-${operationNumber++}`,
      resolveAction: () => action,
    });
    const terminalResult = { published: true };
    const request = {
      actionId: action.actionId,
      scope,
      requestId: 'approved-plugin-request',
      input: { itemId: 'item-1' },
      execute: async () => ++executionCount === 1
        ? { ok: true as const, result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId: action.actionId } }
        : { ok: true as const, result: terminalResult },
    };

    const pending = await runner.observe(request);
    expect(pending).toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId: action.actionId },
    });
    // Another delivery of the original native-confirmed invocation is not an
    // Artifact decision. It observes the same pending receipt without creating
    // a second request or entering its effect. Actual approved continuation
    // retains the ordinary fresh re-entry below.
    const repeatedInvocation = { ...request, rejoinPendingApproval: true as const };
    await expect(runner.observe(repeatedInvocation)).resolves.toEqual(pending);
    expect(executionCount).toBe(1);
    expect(store.list(scope).items).toHaveLength(1);
    await expect(runner.observe(request)).resolves.toEqual({ ok: true, result: terminalResult });
    await expect(runner.observe(request)).resolves.toEqual({ ok: true, result: terminalResult });

    expect(executionCount).toBe(2);
    expect(store.list(scope).items).toHaveLength(2);
  });

  it('continues a finite Project Action past approval before projecting its operation receipt', async () => {
    const store = createActionOperationStore();
    let operationNumber = 0;
    let executionCount = 0;
    const runner = createActionOperationRunner({
      store,
      generateOperationId: () => `project-approval-${operationNumber++}`,
      resolveAction: actionId => ({
        actionId,
        title: 'Run project script',
        operation: { version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' } },
      }),
    });
    const terminalResult = { exitCode: 0 };
    const request = {
      actionId: 'projects.script.run',
      scope,
      requestId: 'approved-project-request',
      input: { workspaceRefId: 'workspace', cwd: '/project' },
      execute: async (context: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]) => {
        // The outer Action executor requests approval before the finite command
        // owner can publish acceptance of the approved execution.
        if (++executionCount === 1) return { ok: true as const,
          result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId: 'projects.script.run' } };
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        return { ok: true as const, result: terminalResult };
      },
    };

    await expect(runner.observe(request)).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', actionId: 'projects.script.run' },
    });
    await expect(runner.observe(request)).resolves.toMatchObject({ ok: true, result: {
      operation: { operationId: 'project-approval-1', domainRef: { kind: 'projectCommand' } },
    } });
    await expect(runner.waitForTerminal(scope, 'project-approval-1')).resolves.toMatchObject({ state: 'succeeded', result: terminalResult });
    await expect(runner.observe(request)).resolves.toMatchObject({
      ok: true,
      result: { operation: { state: 'succeeded', result: terminalResult } },
    });
    expect(executionCount).toBe(2);
  });

  it.each([
    'machines.managed.delete',
    'machines.managed.power.set',
    'machines.managed.rebuild',
    'machines.managed.bootstrap.retry',
    'machines.managed.acquire',
  ] as const)('continues approved %s exactly once past its deferred approval receipt', async actionId => {
    const store = createActionOperationStore();
    let operationNumber = 0;
    let executionCount = 0;
    const spec = getActionSpec(actionId);
    const runner = createActionOperationRunner({
      store,
      generateOperationId: () => `${actionId}-${operationNumber++}`,
      resolveAction: () => ({
        actionId,
        title: spec.title,
        operation: spec.operation!,
        ...(spec.operationReentry ? { operationReentry: spec.operationReentry } : {}),
      }),
    });
    const terminalResult = { managedId: 'managed', status: 'completed' };
    const request = {
      actionId,
      scope,
      requestId: 'approved-request',
      input: { managedId: 'managed' },
      execute: async () => ++executionCount === 1
        ? { ok: true as const, result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId } }
        : { ok: true as const, result: terminalResult },
    };

    await expect(runner.observe(request)).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-1', actionId },
    });
    await expect(runner.observe(request)).resolves.toEqual({ ok: true, result: terminalResult });
    await expect(runner.observe(request)).resolves.toEqual({ ok: true, result: terminalResult });

    expect(executionCount).toBe(2);
    expect(store.list(scope).items).toHaveLength(2);
    expect(store.get(scope, `${actionId}-1`)).toMatchObject({ state: 'succeeded', result: terminalResult });
  });

  it('applies declaration-owned re-entry behavior to a new Action without runner changes', async () => {
    const store = createActionOperationStore();
    let operationNumber = 0;
    let executionCount = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `declared-reentry-${operationNumber++}`,
      resolveAction: actionId => ({ actionId, title: 'Declared re-entry', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' },
      }, operationReentry: (snapshot: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1) => (
        snapshot.state === 'failed' ? 'fresh' : 'refuse'
      ) }),
    });
    const request = { actionId: 'test.declared-reentry', scope, requestId: 'stable-request', input: { value: 'same' },
      execute: async () => ++executionCount === 1
        ? { ok: false as const, errorCode: 'first_attempt_failed', error: 'first_attempt_failed' }
        : { ok: true as const, result: { completed: true } },
    };

    await expect(runner.observe(request)).resolves.toMatchObject({ ok: false, errorCode: 'first_attempt_failed' });
    await expect(runner.observe(request)).resolves.toEqual({ ok: true, result: { completed: true } });
    expect(executionCount).toBe(2);
    expect(store.get(scope, 'declared-reentry-0')).toMatchObject({ state: 'failed' });
    expect(store.get(scope, 'declared-reentry-1')).toMatchObject({ state: 'succeeded' });
  });

  it('starts a fresh managed bootstrap retry for the same explicit retry identity after an unconfirmed attempt', async () => {
    const store = createActionOperationStore();
    let operationNumber = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `bootstrap-retry-${operationNumber++}`,
      resolveAction: actionId => ({ actionId, title: 'Retry install', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      }, operationReentry: getActionSpec('machines.managed.bootstrap.retry').operationReentry }),
    });
    let executions = 0;
    const request = { actionId: 'machines.managed.bootstrap.retry', scope, requestId: 'stable-retry', input: { managedId: 'managed' },
      execute: async () => ++executions === 1
        ? { ok: false as const, errorCode: 'action_outcome_unknown', error: 'Outcome unknown' }
        : { ok: true as const, result: { managedId: 'managed', operation: { operationId: 'bootstrap-retry-1' } } },
    };

    await expect(runner.observe(request)).resolves.toMatchObject({ ok: false, errorCode: 'action_outcome_unknown' });
    expect(store.get(scope, 'bootstrap-retry-0')).toMatchObject({ state: 'running', observation: { kind: 'outcome_uncertain' } });
    await expect(runner.observe(request)).resolves.toMatchObject({ ok: true });
    expect(executions).toBe(2);
    expect(store.get(scope, 'bootstrap-retry-1')).toMatchObject({ state: 'succeeded' });
  });

  it.each([
    { ok: true, result: { outcome: 'accepted', operationCredentialUses: [{ label: 'forged plugin actor' }] } },
    { ok: false, errorCode: 'external_write_failed', error: 'Write failed' },
    { ok: false, errorCode: 'action_outcome_unknown', error: 'Outcome unknown' },
    { ok: false, errorCode: 'cancelled', error: 'cancelled' },
  ] as const)('retains admitted credential observations across operation reads and exact request rejoin: $ok $errorCode', async outcome => {
    const operationCredentialUses = [ActionOperationCredentialUseV1Schema.parse({
      v: 1, kind: 'team_resource', label: 'Acme GitHub', owner: { kind: 'team', teamId: 'team-1' },
      service: { pluginId: 'acme.github', localId: 'github' },
      why: { kind: 'purpose_binding', purpose: { consumer: { pluginId: 'acme.release', localId: 'release' }, purpose: 'publish' }, target: 'group' },
      currentness: { kind: 'current_at_materialization', resourceRevision: 4 },
    })];
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'credential-operation',
      resolveAction: actionId => ({ actionId, title: 'Publish', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let executions = 0;
    const request = { actionId: 'acme.github.publish', scope, requestId: 'credential-request', execute: async () => {
      executions++;
      return { ...outcome, operationCredentialUses };
    } };
    const original = await runner.observe(request);
    const operation = store.get(scope, 'credential-operation');
    expect(operation).toMatchObject({ operationCredentialUses });
    expect(ActionOperationSnapshotV1Schema.parse(operation)).toEqual(operation);
    expect(store.list(scope).items[0]).toMatchObject({ operationCredentialUses });
    expect(store.get({ ...scope, accountId: 'other-account' }, 'credential-operation')).toBeNull();
    expect(await runner.observe({ ...request, execute: async () => { throw new Error('Rejoin must not execute'); } })).toEqual(original);
    expect(executions).toBe(1);
    const legacy = projectActionOperationSnapshotForV1Reader(operation!);
    expect(legacy).not.toHaveProperty('operationCredentialUses');
    expect(PredecessorSnapshotSchema.parse(legacy)).toEqual(legacy);
    if (outcome.ok) expect(legacy.result).toEqual(outcome.result);
    else expect(legacy.state).toBe(outcome.errorCode === 'cancelled' ? 'cancelled' : 'failed');
  });

  it('retains actual handler credential observations when a native failure determines settlement', async () => {
    // These are host-observed result annotations, as stamped by the canonical
    // Action executor; the plugin's domain JSON cannot supply this metadata.
    const handlerUse = ActionOperationCredentialUseV1Schema.parse({
      v: 1, kind: 'connected_account', label: 'Personal GitHub',
      owner: { kind: 'account', accountId: scope.accountId },
      service: { pluginId: 'acme.github', localId: 'github' },
      why: { kind: 'purpose_binding', purpose: { consumer: { pluginId: 'acme.release', localId: 'release' }, purpose: 'download' }, target: 'account' },
      currentness: { kind: 'current_at_materialization' },
    });
    const operationCredentialUses = [handlerUse];
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'native-credential-operation',
      resolveAction: actionId => ({ actionId, title: 'Download', operation: {
        version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' },
      } }),
    });
    const request = { actionId: 'acme.release.download', scope, requestId: 'native-credential-request',
      execute: async ({ publishOwnerUpdate }: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]) => {
        publishOwnerUpdate({ outcome: { ok: false, errorCode: 'receiver_refused', error: 'Receiver refused' } });
        return { ok: true as const, result: { state: 'failed' }, operationCredentialUses: [handlerUse] };
      } };
    const result = await runner.observe(request);
    expect(result).toMatchObject({ ok: false, errorCode: 'receiver_refused', operationCredentialUses });
    const operation = store.get(scope, 'native-credential-operation');
    expect(operation).toMatchObject({ state: 'failed', operationCredentialUses });
    expect(ActionOperationSnapshotV1Schema.parse(operation)).toEqual(operation);
    expect(store.list(scope).items[0]).toMatchObject({ operationCredentialUses });
    expect(await runner.observe({ ...request, execute: async () => { throw new Error('Rejoin must not execute'); } })).toEqual(result);
  });

  it('does not derive credential attribution from a plugin result payload', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'unobserved-operation',
      resolveAction: actionId => ({ actionId, title: 'Publish', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const result = { operationCredentialUses: [{ label: 'forged plugin actor' }] };
    expect(await runner.observe({ actionId: 'acme.github.publish', scope,
      execute: async () => ({ ok: true, result }) })).toEqual({ ok: true, result });
    expect(store.get(scope, 'unobserved-operation')).not.toHaveProperty('operationCredentialUses');
  });

  it.each(['machines.managed.power.set', 'machines.managed.acquire', 'machines.managed.bootstrap.retry'])(
    'retains admitted credential observations when %s reports an unconfirmed outcome', async actionId => {
    const operationCredentialUses = [ActionOperationCredentialUseV1Schema.parse({
      v: 1, kind: 'connected_account', label: null, owner: null,
      service: { pluginId: 'acme.compute', localId: 'cloud' },
      why: { kind: 'purpose_binding', purpose: { consumer: { pluginId: 'acme.compute', localId: 'vm' }, purpose: 'manage' }, target: 'account' },
      currentness: { kind: 'current_at_materialization' },
    })];
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'unconfirmed-credential-operation',
      resolveAction: actionId => ({ actionId, title: 'Stop', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    await runner.observe({ actionId, scope, execute: async () => ({
      ok: false, errorCode: 'action_outcome_unknown', error: 'Outcome unknown', operationCredentialUses,
    }) });
    const operation = store.get(scope, 'unconfirmed-credential-operation');
    expect(operation).toMatchObject({ state: 'running', observation: { kind: 'outcome_uncertain' }, operationCredentialUses });
    expect(operation).not.toHaveProperty('settledAt');
    expect(ActionOperationSnapshotV1Schema.parse(operation)).toEqual(operation);
    const legacy = projectActionOperationSnapshotForV1Reader(operation!);
    expect(PredecessorSnapshotSchema.parse(legacy)).toEqual(legacy);
    expect(legacy.state).toBe('running');
  });

  it('returns recorded uncertainty to ordinary Wait while retirement still waits for physical settlement', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'uncertain-wait',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let publish!: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]['publishOwnerUpdate'];
    let release!: () => void;
    await runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
      publish = context.publishOwnerUpdate;
      context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
        machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' }, state: 'running' });
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    } });
    let observed: Awaited<ReturnType<typeof runner.waitForTerminal>> | undefined;
    const waiting = runner.waitForTerminal(scope, 'uncertain-wait').then(value => { observed = value; return value; });
    let retired = false;
    const retirement = runner.retireProjectFiniteOperations().then(() => { retired = true; });
    try {
      publish({ observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(observed).toMatchObject({ state: 'running', observation: { kind: 'stop_unconfirmed' } });
      expect(await runner.waitForTerminal(scope, 'uncertain-wait')).toEqual(observed);
      expect(retired).toBe(false);
      expect(store.get(scope, 'uncertain-wait')).not.toHaveProperty('settledAt');
    } finally {
      release();
      await waiting;
      await retirement;
    }
    expect(store.get(scope, 'uncertain-wait')).toMatchObject({ state: 'cancelled' });
  });
  it('retains the original source Script and actual worker exit on failure without exposing native error details', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'script-failure',
      resolveAction: actionId => ({ actionId, title: 'Run tests', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const attachment = { kind: 'projectCommand', purpose: 'script', serverId: 'worker-home', machineId: 'actual-worker',
      workspaceRefId: 'copied-workspace', cwd: '/copy/packages/web' } as const;
    const observed = { ...attachment, terminalId: 'actual-terminal',
      sourceWorkspace: { serverId: 'source-home', machineId: 'source-machine', workspaceId: 'original-workspace', rootPath: '/source' },
      script: { name: 'test', source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'test' } }, exitCode: 17 } as const;
    let release!: () => void;
    const processExit = new Promise<void>(resolve => { release = resolve; });
    await runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
      context.publishOwnerUpdate({ domainRef: attachment });
      context.publishOwnerUpdate({ state: 'running', domainRef: observed });
      await processExit;
      return { ok: false, errorCode: 'project_command_step_failed', error: 'Process failed',
        details: { exitCode: 17, environment: { SECRET: 'private' } } };
    } });
    try {
      expect(store.get(scope, 'script-failure')).toMatchObject({ state: 'running', domainRef: observed });
    } finally { release(); }
    const settled = await runner.waitForTerminal(scope, 'script-failure');
    expect(settled).toMatchObject({ state: 'failed', domainRef: observed,
      error: { errorCode: 'project_command_step_failed', error: 'Process failed' } });
    expect(settled?.error).not.toHaveProperty('details');
    expect(settled).not.toHaveProperty('result');
  });
  it('retains a no-effect setup review on the original invocation and resumes only exact admitted replay', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'review-held',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const details = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'setup',
      reviewedEffect: { commands: ['reviewed command'] } } as const;
    let executions = 0;
    let resumed = false;
    let release!: () => void;
    await runner.observe({ actionId: 'projects.script.run', scope, requestId: 'original', input: { workspace: 'original' },
      cancellation: 'supported', execute: async context => {
        executions++;
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        await context.operationReview.waitForResume(details);
        resumed = true;
        await new Promise<void>(resolve => { release = resolve; });
        return { ok: true, result: {} };
      },
    });
    expect(await runner.waitForTerminal(scope, 'review-held', undefined, { includeSetupReview: true }))
      .toMatchObject({ state: 'accepted', setupReview: details });
    let settled = false;
    const terminal = runner.waitForTerminal(scope, 'review-held').then(value => { settled = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(store.get(scope, 'review-held')).not.toHaveProperty('settledAt');
    const doNotExecute = async () => { throw new Error('Fresh replay is not the original continuation'); };
    expect(await runner.observe({ actionId: 'projects.script.run', scope, requestId: 'original',
      input: { workspace: 'changed' }, execute: doNotExecute })).toMatchObject({ errorCode: 'action_request_input_conflict' });
    expect(resumed).toBe(false);
    await runner.observe({ actionId: 'projects.script.run', scope, requestId: 'original',
      input: { workspace: 'original' }, execute: doNotExecute });
    expect(resumed).toBe(true);
    expect(executions).toBe(1);
    expect(store.get(scope, 'review-held')).not.toHaveProperty('setupReview');
    release();
    expect(await terminal).toMatchObject({ state: 'succeeded' });
  });

  it('cancels the original no-effect setup-review wait without waiting for a new request', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'review-cancel',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    await runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
      context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
        machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
      try {
        await context.operationReview.waitForResume({ kind: 'pendingApproval', code: 'project_setup_effect_changed',
          reviewedEffectDigest: 'setup', reviewedEffect: { commands: [] } });
      } catch { return { ok: false, errorCode: 'cancelled', error: 'cancelled' }; }
      throw new Error('Cancelled review cannot launch');
    } });
    expect(runner.cancel(scope, 'review-cancel')).toEqual({ kind: 'requested' });
    expect(await runner.waitForTerminal(scope, 'review-cancel')).toMatchObject({ state: 'cancelled' });
    expect(store.get(scope, 'review-cancel')).not.toHaveProperty('setupReview');
  });

  it.each([
    { ok: false, errorCode: 'project_setup_consent_required', error: 'project_setup_consent_required',
      details: { kind: 'pendingApproval', code: 'project_setup_consent_required',
        reviewedEffect: { commands: ['install'] }, reviewedEffectDigest: 'reviewed-effect' } },
    { ok: false, errorCode: 'approval_stale', error: 'approval_stale', details: { reason: 'home_changed' } },
  ] as const)('retains typed $errorCode failure facts across scoped get and exact request replay without leaking arbitrary details', async failure => {
    const store = createActionOperationStore();
    let executions = 0;
    let operationIndex = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `consent-review-${++operationIndex}`,
      resolveAction: actionId => ({ actionId, title: 'Prepare', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const request = { actionId: 'projects.prepare', scope, requestId: 'prepare-request', execute: async () => {
      executions++;
      return failure;
    } };
    expect(await runner.observe(request)).toEqual(failure);
    expect(store.get(scope, 'consent-review-1')).toMatchObject({ state: 'failed', error: {
      errorCode: failure.errorCode, details: failure.details,
    } });
    expect(store.get({ ...scope, accountId: 'another-requester' }, 'consent-review-1')).toBeNull();
    expect(await runner.observe(request)).toEqual(failure);
    expect(executions).toBe(1);
    const arbitrary = { ...failure, details: { ...failure.details, credential: 'private' } };
    await runner.observe({ ...request, requestId: 'unrecognized-details', execute: async () => arbitrary });
    expect(store.get(scope, 'consent-review-2')?.error).not.toHaveProperty('details');
  });
  it('retires only actual finite invocations and keeps retirement pending through unconfirmed Stop until settlement', async () => {
    const store = createActionOperationStore();
    let nextId = 0;
    const runner = createActionOperationRunner({ store, generateOperationId: () => `retire-${++nextId}`,
      resolveAction: actionId => ({ actionId, title: 'Work', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const releases: (() => void)[] = [];
    const stops: string[] = [];
    const launch = async (actionId: string, accountId: string) => await runner.observe({ actionId,
      scope: { ...scope, accountId }, requestId: `${accountId}-${actionId}`, cancellation: 'supported', execute: async context => {
        const operationId = context.operationAcceptance!.operationId;
        context.onCancellationRequested(() => {
          stops.push(operationId);
          context.publishOwnerUpdate({ observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } });
        });
        if (actionId === 'projects.compute.exec') context.publishOwnerUpdate({
          domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home', machineId: scope.machineId,
            workspaceRefId: 'workspace', cwd: '/project' }, state: 'running',
        });
        else context.operationAcceptance!.accept({ status: 'accepted' });
        context.updateProgress({ phase: 'waiting_for_approval', label: 'Waiting for approval' });
        // Only actual process settlement, not cancellation, resolves this boundary.
        await new Promise<void>(resolve => { releases.push(resolve); });
        return context.signal.aborted ? { ok: false, errorCode: 'cancelled', error: 'cancelled' }
          : { ok: true, result: {} };
      },
    });
    await launch('projects.compute.exec', scope.accountId);
    await launch('projects.compute.exec', 'other-requester');
    await launch('projects.service.relocate', scope.accountId);
    let retired = false;
    const retirement = runner.retireProjectFiniteOperations().then(() => { retired = true; });
    const sameRetirement = runner.retireProjectFiniteOperations();
    expect(runner.retireProjectFiniteOperations()).toBe(sameRetirement);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stops).toEqual(['retire-1', 'retire-2']);
    expect(retired).toBe(false);
    let lateExecutions = 0;
    const lateExecution = async () => { lateExecutions++; return { ok: true as const, result: {} }; };
    expect(await runner.observe({ actionId: 'projects.compute.exec', scope, requestId: 'arrived-after-retirement',
      execute: lateExecution })).toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
    expect(await runner.observe({ actionId: 'projects.compute.exec', scope,
      requestId: `${scope.accountId}-projects.compute.exec`, execute: lateExecution }))
      .toMatchObject({ ok: true, result: { operation: { operationId: 'retire-1' } } });
    expect(lateExecutions).toBe(0);
    expect(store.get(scope, 'retire-1')).toMatchObject({ state: 'running', observation: { kind: 'stop_unconfirmed' } });
    expect(runner.cancel(scope, 'retire-1')).toEqual({ kind: 'requested' });
    expect(stops).toEqual(['retire-1', 'retire-2', 'retire-1']);
    releases[0]!();
    await runner.waitForTerminal(scope, 'retire-1');
    expect(retired).toBe(false);
    releases[1]!();
    await retirement;
    expect(store.get({ ...scope, accountId: 'other-requester' }, 'retire-2')?.state).toBe('cancelled');
    expect(store.get(scope, 'retire-3')?.state).toBe('running');
    releases[2]!();
    await runner.waitForTerminal(scope, 'retire-3');
    await runner.retireProjectFiniteOperations();
    expect(stops).toEqual(['retire-1', 'retire-2', 'retire-1']);
  });
  it('waits for the actual Project terminal attachment before settlement without replaying or leaking sibling scope', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'mounted-script',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let owner!: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0];
    let release!: () => void;
    const attachment = { kind: 'projectCommand', purpose: 'script', serverId: 'home',
      machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } as const;
    let executions = 0;
    await runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
      executions++;
      owner = context;
      context.publishOwnerUpdate({ domainRef: attachment });
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: false, errorCode: 'nonzero', error: 'nonzero' };
    } });
    let attached = false;
    const wait = runner.waitForProjectTerminalAttachment(scope, 'mounted-script').then(value => { attached = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(attached).toBe(false);
    expect(await runner.waitForProjectTerminalAttachment({ ...scope, accountId: 'another' }, 'mounted-script')).toBeNull();
    owner.publishOwnerUpdate({ domainRef: { ...attachment, purpose: 'setup', terminalId: 'setup-terminal' }, state: 'running' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(attached).toBe(false);
    owner.publishOwnerUpdate({ domainRef: { ...attachment, terminalId: 'actual-terminal' }, state: 'running' });
    expect(await wait).toMatchObject({ domainRef: { terminalId: 'actual-terminal' } });
    expect(store.get(scope, 'mounted-script')).toMatchObject({ state: 'running' });
    expect(store.get(scope, 'mounted-script')).not.toHaveProperty('settledAt');
    expect(executions).toBe(1);
    release();
    expect(await runner.waitForTerminal(scope, 'mounted-script')).toMatchObject({ state: 'failed' });
  });

  it('ends attachment observation on owner uncertainty and observation abort without stopping accepted work', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'uncertain-attachment',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let owner!: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0];
    let release!: () => void;
    await runner.observe({ actionId: 'projects.script.run', scope, cancellation: 'supported', execute: async context => {
      owner = context;
      context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
        machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: true, result: {} };
    } });
    expect(owner.operationAcceptance).toMatchObject({ operationId: 'uncertain-attachment', actionId: 'projects.script.run' });
    const observation = new AbortController();
    const aborted = runner.waitForProjectTerminalAttachment(scope, 'uncertain-attachment', observation.signal);
    observation.abort(new Error('viewer left'));
    await expect(aborted).rejects.toThrow('viewer left');
    expect(owner.signal.aborted).toBe(false);
    const uncertain = runner.waitForProjectTerminalAttachment(scope, 'uncertain-attachment');
    owner.publishOwnerUpdate({ observation: { kind: 'outcome_uncertain', code: 'launch_unknown' } });
    expect(await uncertain).toMatchObject({ state: 'accepted', observation: { code: 'launch_unknown' } });
    release();
    await runner.waitForTerminal(scope, 'uncertain-attachment');
  });
  it('delivers every supported Stop to the retained owner without delivering unsupported or settled requests', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'repeat-stop',
      resolveAction: actionId => ({ actionId, title: 'Exec', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let stopAttempts = 0;
    let firstAbort = 0;
    let release!: () => void;
    await runner.observe({ actionId: 'projects.compute.exec', scope, cancellation: 'supported',
      execute: async context => {
        context.signal.addEventListener('abort', () => { firstAbort++; });
        const unsubscribe = context.onCancellationRequested(() => { stopAttempts++; });
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        await new Promise<void>(resolve => { release = resolve; });
        unsubscribe();
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    expect(runner.cancel(scope, 'repeat-stop')).toEqual({ kind: 'requested' });
    expect(runner.cancel(scope, 'repeat-stop')).toEqual({ kind: 'requested' });
    expect(stopAttempts).toBe(2);
    expect(firstAbort).toBe(1);
    expect(runner.cancel({ ...scope, accountId: 'another' }, 'repeat-stop')).toEqual({ kind: 'not_found' });
    expect(stopAttempts).toBe(2);
    release();
    await runner.waitForTerminal(scope, 'repeat-stop');
    expect(runner.cancel(scope, 'repeat-stop')).toEqual({ kind: 'already_settled' });
    expect(stopAttempts).toBe(2);
    const unsupported = createActionOperationRunner({ store, generateOperationId: () => 'unsupported-stop',
      resolveAction: actionId => ({ actionId, title: 'Exec', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    await unsupported.observe({ actionId: 'projects.compute.exec', scope, cancellation: 'unsupported',
      execute: async context => {
        context.onCancellationRequested(() => { stopAttempts++; });
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        return await new Promise(resolve => { release = () => resolve({ ok: true, result: {} }); });
      },
    });
    expect(unsupported.cancel(scope, 'unsupported-stop')).toEqual({ kind: 'unsupported' });
    expect(stopAttempts).toBe(2);
    release();
    await unsupported.waitForTerminal(scope, 'unsupported-stop');
  });
  it('publishes live unconfirmed Stop evidence without settling and clears it only on observed terminal completion', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'unconfirmed',
      resolveAction: actionId => ({ actionId, title: 'Exec', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let report!: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]['publishOwnerUpdate'];
    let release!: () => void;
    await runner.observe({ actionId: 'projects.compute.exec', scope, cancellation: 'supported',
      execute: async ({ publishOwnerUpdate }) => {
        report = publishOwnerUpdate;
        publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' }, state: 'running' });
        await new Promise<void>(resolve => { release = resolve; });
        return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      },
    });
    const update = { observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } } as const;
    report(update);
    expect(store.get(scope, 'unconfirmed')).toMatchObject({ state: 'running', observation: update.observation });
    expect(store.get(scope, 'unconfirmed')).not.toHaveProperty('settledAt');
    release();
    await expect.poll(() => store.get(scope, 'unconfirmed')?.state).toBe('cancelled');
    expect(await runner.waitForTerminal(scope, 'unconfirmed')).toMatchObject({ state: 'cancelled' });
    expect(store.get(scope, 'unconfirmed')).not.toHaveProperty('observation');
  });
  it('does not retain stoppable execution custody after a synchronous owner throw', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'sync-throw',
      resolveAction: actionId => ({ actionId, title: 'Exec', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    await runner.observe({ actionId: 'projects.compute.exec', scope, cancellation: 'supported',
      execute: ({ publishOwnerUpdate }) => {
        publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'exec', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        throw new Error('Synchronous observation lost');
      },
    }).catch(() => undefined);
    expect(store.get(scope, 'sync-throw')).toMatchObject({ state: 'accepted', observation: { kind: 'outcome_uncertain' } });
    expect(runner.cancel(scope, 'sync-throw')).toEqual({ kind: 'unsupported' });
  });
  it('keeps accepted finite custody uncertain when its observation throws instead of reporting process exit', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'lost-observation',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let starts = 0;
    const request = { actionId: 'projects.script.run', requestId: 'lost-request', scope,
      execute: async (context: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]) => {
        starts++;
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
          machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
        throw new Error('Completion observation lost');
      },
    };
    await runner.observe(request);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(store.get(scope, 'lost-observation')).toMatchObject({ state: 'accepted', observation: { kind: 'outcome_uncertain' } });
    expect(store.get(scope, 'lost-observation')).not.toHaveProperty('settledAt');
    await runner.observe(request);
    expect(starts).toBe(1);
  });
  it.each([
    ['projects.service.relocate', 'stop_unconfirmed'],
    ['projects.service.relocate', 'outcome_uncertain'],
    ['localServices.launcher.start', 'outcome_uncertain'],
  ])('keeps %s %s running without replay or false cancellation', async (actionId, errorCode) => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'service-move',
      resolveAction: actionId => ({ actionId, title: 'Move service', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'detail' },
      } }),
    });
    let effects = 0;
    const request = { actionId, requestId: 'move-request',
      input: { currentTarget: 'old-instance', destination: 'new-machine' }, scope,
      cancellation: 'supported' as const,
      execute: async () => { effects += 1; return { ok: false as const, errorCode, error: errorCode }; },
    };
    await expect(runner.observe(request)).resolves.toMatchObject({ ok: false, errorCode });
    expect(store.get(scope, 'service-move')).toMatchObject({ state: 'running' });
    expect(store.get(scope, 'service-move')).not.toHaveProperty('settledAt');
    expect(runner.cancel(scope, 'service-move')).toEqual({ kind: 'unsupported' });
    await expect(runner.observe(request)).resolves.toMatchObject({ ok: false, errorCode: 'action_operation_unavailable' });
    expect(effects).toBe(1);
  });
  it('returns admitted managed identity while keeping its native execution and replay in the same operation', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({
      store, generateOperationId: () => 'managed-operation',
      resolveAction: actionId => ({ actionId, title: 'Acquire machine', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'activity' },
      } }),
    });
    let release!: () => void;
    const nativeEffect = new Promise<void>(resolve => { release = resolve; });
    const accepted = { managedId: 'managed-machine', operation: { operationId: 'managed-operation' } };
    let starts = 0;
    const request = {
      actionId: 'machines.managed.acquire', requestId: 'managed-request', scope,
      execute: async (context: { operationAcceptance?: { operationId: string; accept(result: unknown): void } }) => {
        starts += 1;
        context.operationAcceptance?.accept(accepted);
        await nativeEffect;
        return { ok: true as const, result: accepted };
      },
    };
    let firstResponse: unknown;
    const first = runner.observe(request).then(result => { firstResponse = result; return result; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(firstResponse).toEqual({ ok: true, result: accepted });
      await expect(runner.observe(request)).resolves.toEqual(firstResponse);
      expect(starts).toBe(1);
      expect(store.get(scope, 'managed-operation')?.state).toBe('running');
    } finally {
      release();
      await first;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(store.get(scope, 'managed-operation')?.state).toBe('succeeded');
  });
  it.each(['outcome_uncertain', 'stop_unconfirmed'])('keeps finite %s evidence unsettled and never replays it', async (errorCode) => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'finite-unknown',
      resolveAction: actionId => ({ actionId, title: 'Run script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    const execute = vi.fn(async () => ({ ok: false as const, errorCode, error: errorCode }));
    const request = { actionId: 'projects.compute.exec', requestId: 'unknown-request', scope, execute };
    await expect(runner.observe(request)).resolves.toMatchObject({ ok: false, errorCode });
    expect(store.get(scope, 'finite-unknown')).toMatchObject({ state: 'accepted' });
    expect(store.get(scope, 'finite-unknown')).toMatchObject({ observation: { kind: errorCode, code: errorCode } });
    expect(store.get(scope, 'finite-unknown')).not.toHaveProperty('settledAt');
    await runner.observe(request);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('publishes finite acceptance and output association before observed exit, joining the same request without replay', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'finite-1',
      resolveAction: actionId => ({ actionId, title: 'Run script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }),
    });
    let release!: () => void;
    const exit = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn(async (context: Parameters<Parameters<typeof runner.observe>[0]['execute']>[0]) => {
      context.operationAcceptance?.accept({ premature: true });
      context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home',
        machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/project' } });
      await exit;
      return { ok: false as const, errorCode: 'process_exit_nonzero', error: 'Process failed' };
    });
    const request = { actionId: 'projects.script.run', requestId: 'finite-request', scope, cancellation: 'supported' as const, execute };
    let accepted: unknown;
    const accepting = runner.observe(request).then(value => { accepted = value; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(accepted).toMatchObject({ ok: true, result: { operation: { state: 'accepted',
      domainRef: { kind: 'projectCommand', cwd: '/project' } } } });
    await expect(runner.observe(request)).resolves.toEqual(accepted);
    expect(runner.cancel(scope, 'finite-1')).toEqual({ kind: 'requested' });
    expect(store.get(scope, 'finite-1')?.state).toBe('accepted');
    release();
    await accepting;
    await Promise.resolve();
    expect(store.get(scope, 'finite-1')).toMatchObject({ state: 'failed', domainRef: { kind: 'projectCommand' } });
    await expect(runner.observe(request)).resolves.toMatchObject({ ok: true, result: { operation: { state: 'failed',
      error: { errorCode: 'process_exit_nonzero' }, domainRef: { kind: 'projectCommand' } } } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('publishes every revision while returning the canonical result unchanged exactly once', async () => {
    const published: unknown[] = [];
    const store = createActionOperationStore({ onSnapshot: (snapshot) => published.push(snapshot) });
    const execute = vi.fn(async ({ updateProgress }: { updateProgress: (value: { phase: string; label: string }) => void }) => {
      updateProgress({ phase: 'working', label: 'Working' });
      return { ok: true as const, result: { childSessionId: 'child-1' } };
    });
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId,
        title: 'Fork session',
        operation: {
          version: 1,
          visibility: 'activity',
          progress: 'reported',
          presentation: { onStart: 'current' },
        },
      }),
      generateOperationId: () => 'operation-1',
    });

    const result = await runner.observe({
      actionId: 'session.fork',
      requestId: 'request-1',
      scope,
      execute,
    });

    expect(result).toEqual({ ok: true, result: { childSessionId: 'child-1' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(published).toMatchObject([
      { revision: 1, state: 'accepted', requestId: 'request-1' },
      { revision: 2, state: 'running' },
      { revision: 3, state: 'running', progress: { kind: 'phase', phase: 'working' } },
      { revision: 4, state: 'succeeded' },
    ]);
  });

  it('does not observe an Action without a tracked declaration', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({ actionId, title: actionId }),
    });
    const execute = vi.fn(async () => ({ ok: true as const, result: 'historical' }));
    await expect(runner.observe({ actionId: 'memory.search', scope, execute }))
      .resolves.toEqual({ ok: true, result: 'historical' });
    expect(store.list(scope).items).toEqual([]);
  });

  it.each([
    { actionId: 'session.spawn_new', result: { type: 'success', disposition: 'created', sessionId: 'created-session',
      executionTarget: { serverId: 'home', machineId: 'machine-1' }, organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'notRequested' } } },
    { actionId: 'session.spawn_new', result: { type: 'error', code: 'permission_denied', retryable: false } },
    { actionId: 'session.fork', result: { type: 'error', code: 'spawn_failed', retryable: true } },
  ])('returns the terminal $actionId result for an exact replay without invoking the Action again ($result.type)', async ({ actionId, result }) => {
    const published: Array<{ operationId: string }> = [];
    const store = createActionOperationStore({ onSnapshot: (snapshot) => published.push(snapshot) });
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId, title: 'Spawn',
        operation: {
          version: 1, visibility: 'activity', progress: 'indeterminate',
          presentation: { onStart: 'current' },
        },
      }),
      generateOperationId: vi.fn(() => 'operation-1'),
    });
    const execute = vi.fn(async () => ({ ok: true as const, result }));

    await runner.observe({ actionId, requestId: 'creation-1', input: { target: 'machine-1' }, scope, execute });
    await expect(runner.observe({
      actionId, requestId: 'creation-1', input: { target: 'machine-1' }, scope, execute,
    })).resolves.toEqual({ ok: true, result });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.list(scope).items).toHaveLength(1);
    expect(new Set(published.map((snapshot) => snapshot.operationId))).toEqual(new Set(['operation-1']));
    const snapshot = store.get(scope, 'operation-1')!;
    if (actionId === 'session.spawn_new' && result.type === 'error') {
      expect(snapshot.state).toBe('failed');
      expect(projectActionOperationSnapshotForV1Reader(snapshot)).not.toHaveProperty('result');
    }
    expect(PredecessorSnapshotSchema.safeParse(projectActionOperationSnapshotForV1Reader(snapshot)).success).toBe(true);
  });

  it('retains the launch refusal from the actual spawn Action projection for operation recovery', async () => {
    const store = createActionOperationStore();
    const spec = getActionSpec('session.spawn_new');
    const runner = createActionOperationRunner({ store, generateOperationId: () => 'refused-creation',
      resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
    const refusal = { type: 'error', code: 'spawn_failed', retryable: false,
      launchError: { kind: 'launch_error', code: 'agent_cli_not_runnable', message: 'The selected Agent cannot run on this Machine.' } } as const;
    let effects = 0;
    const request = { actionId: spec.id, scope, requestId: 'refused-creation', input: {},
      execute: async () => { effects++; return completeSpawnActionResult(refusal); } };
    await expect(runner.observe(request)).resolves.toMatchObject({ ok: false, errorCode: 'spawn_failed' });
    expect(store.get(scope, 'refused-creation')).toMatchObject({ state: 'failed', result: refusal });
    await expect(runner.observe(request)).resolves.toEqual({ ok: true, result: refusal });
    expect(effects).toBe(1);
    expect(projectActionOperationSnapshotForV1Reader(store.get(scope, 'refused-creation')!)).not.toHaveProperty('result');
  });

  it('joins an in-flight exact replay and rejects the same request identity with different input', async () => {
    const store = createActionOperationStore();
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId, title: 'Handoff',
        operation: {
          version: 1, visibility: 'activity', progress: 'reported',
          presentation: { onStart: 'current' },
        },
        operationReentry: getActionSpec('session.handoff').operationReentry,
      }),
      generateOperationId: () => 'operation-1',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { ok: true as const, result: { workspace: { kind: 'none' } } };
    });

    const first = runner.observe({
      actionId: 'session.handoff', requestId: 'request-1', input: { targetMachineId: 'machine-2' }, scope, execute,
    });
    const joined = runner.observe({
      actionId: 'session.handoff', requestId: 'request-1', input: { targetMachineId: 'machine-2' }, scope, execute,
    });
    await expect(runner.observe({
      actionId: 'session.handoff', requestId: 'request-1', input: { targetMachineId: 'machine-3' }, scope, execute,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'action_request_input_conflict',
      error: 'action_request_input_conflict',
    });

    expect(execute).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([first, joined])).resolves.toEqual([
      { ok: true, result: { workspace: { kind: 'none' } } },
      { ok: true, result: { workspace: { kind: 'none' } } },
    ]);
  });

  it('keeps an indeterminate handoff recoverable and re-enters the same operation identity', async () => {
    const store = createActionOperationStore();
    const generateOperationId = vi.fn(() => 'operation-1');
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId, title: 'Handoff',
        operation: {
          version: 1, visibility: 'activity', progress: 'reported',
          presentation: { onStart: 'current' },
        },
        operationReentry: getActionSpec('session.handoff').operationReentry,
      }),
      generateOperationId,
    });
    let retainedPublicationRequestId: string | null = null;
    let publicationEffectCount = 0;
    const execute = vi.fn(async (context: { actionRequestId?: string }) => {
      const actionRequestId = context.actionRequestId;
      if (!actionRequestId) throw new Error('missing canonical Action request identity');
      if (retainedPublicationRequestId === null) {
        retainedPublicationRequestId = actionRequestId;
        publicationEffectCount += 1;
        return { ok: false as const, errorCode: 'indeterminate', error: 'publication outcome unknown' };
      }
      expect(actionRequestId).toBe(retainedPublicationRequestId);
      return { ok: true as const, result: { workspace: { kind: 'copied', operationId: actionRequestId } } };
    });
    const request = {
      actionId: 'session.handoff',
      requestId: 'request-1',
      input: { targetMachineId: 'machine-2', workspaceAction: { kind: 'copy_once' } },
      scope,
      execute,
    } as const;

    await expect(runner.observe(request)).resolves.toMatchObject({ ok: false, errorCode: 'indeterminate' });
    expect(store.get(scope, 'operation-1')).toMatchObject({
      operationId: 'operation-1', requestId: 'request-1', state: 'running',
    });

    await expect(runner.observe(request)).resolves.toMatchObject({ ok: true });
    expect(generateOperationId).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(publicationEffectCount).toBe(1);
    expect(execute.mock.calls.map(([context]) => context.actionRequestId)).toEqual(['request-1', 'request-1']);
    expect(store.get(scope, 'operation-1')).toMatchObject({ state: 'succeeded' });
  });

  it('does not fail canonical execution when snapshot publication throws', async () => {
    const store = createActionOperationStore({ onSnapshot: () => { throw new Error('socket unavailable'); } });
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId, title: 'Fork',
        operation: {
          version: 1, visibility: 'activity', progress: 'indeterminate',
          presentation: { onStart: 'current' },
        },
      }),
    });
    await expect(runner.observe({
      actionId: 'session.fork', scope,
      execute: async () => ({ ok: true, result: 'historical' }),
    })).resolves.toEqual({ ok: true, result: 'historical' });
  });

  it('preserves the strict handoff terminal result and keeps a later handoff failure visible', async () => {
    const store = createActionOperationStore();
    let operation = 0;
    const runner = createActionOperationRunner({
      store,
      resolveAction: (actionId) => ({
        actionId,
        title: 'Handoff session',
        operation: {
          version: 1,
          visibility: 'activity',
          progress: 'reported',
          presentation: { onStart: 'current' },
        },
      }),
      generateOperationId: () => `operation-${++operation}`,
    });
    const terminal = {
      ok: true as const,
      result: {
        handoffId: 'handoff-1',
        status: { handoffId: 'handoff-1', status: 'completed' as const, phase: 'finalizing' as const, recoveryActions: [] },
        workspace: { kind: 'relationship' as const, relationshipId: 'relationship-1', created: true },
        warning: { code: 'source_cleanup_failed', message: 'Source cleanup is still pending.' },
      },
    };

    await expect(runner.observe({
      actionId: 'session.handoff', requestId: 'handoff-request-1', scope,
      execute: async () => terminal,
    })).resolves.toEqual(terminal);
    await expect(runner.observe({
      actionId: 'session.handoff', requestId: 'handoff-request-2', scope,
      execute: async () => ({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }),
    })).resolves.toEqual({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' });

    expect(store.get(scope, 'operation-1')).toMatchObject({
      requestId: 'handoff-request-1', state: 'succeeded', result: terminal.result,
    });
    expect(store.get(scope, 'operation-2')).toMatchObject({
      requestId: 'handoff-request-2', state: 'failed',
      error: { errorCode: 'target_unavailable', error: 'target_unavailable' },
    });
  });
});
