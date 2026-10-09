import { describe, expect, it } from 'vitest';

import {
  ACTION_OPERATION_RPC_METHODS_V1,
  ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1,
  ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1,
  ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1,
  ActionOperationDeclarationV1Schema,
  ActionOperationProgressV1Schema,
  ActionOperationDomainRefV1Schema,
  ActionOperationSnapshotV1Schema,
  ActionOperationFailureV1Schema,
  ActionOperationCancelV1RequestSchema,
  ActionOperationCancelV1ResponseSchema,
  ActionOperationGetV1RequestSchema,
  ActionOperationGetV1ResponseSchema,
  ActionOperationListV1RequestSchema,
  ActionOperationListV1ResponseSchema,
  ActionOperationSnapshotPushV1Schema,
  projectActionOperationSnapshotForV1Reader,
} from './v1.js';

const baseSnapshot = {
  version: 1,
  operationId: 'operation-1',
  revision: 1,
  actionId: 'session.spawn_new',
  state: 'accepted',
  scope: { accountId: 'account-1', machineId: 'machine-1', sessionId: 'session-1' },
  title: 'Create session',
  createdAt: 100,
  cancellation: 'unsupported',
} as const;

describe('Action operation v1 contract', () => {
  it('retains machine setup output on the exact Home and Machine without exposing executable or secret material', () => {
    const domainRef = { kind: 'machineEnvironment', serverId: 'setup-home', machineId: 'guest',
      preset: { id: 'preset', revision: 3 }, managedId: 'paid', terminalId: 'actual-terminal', exitCode: 17 };
    const snapshot = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.environment.apply',
      state: 'failed', startedAt: 110, settledAt: 120, domainRef,
      error: { errorCode: 'machine_setup_failed', error: 'Setup failed' } });
    expect(snapshot.domainRef).toEqual(domainRef);
    expect(projectActionOperationSnapshotForV1Reader(snapshot)).not.toHaveProperty('domainRef');
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, terminalId: undefined }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, setupScript: 'private script' }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, preset: { ...domainRef.preset, secret: 'private' } }).success).toBe(false);
  });
  it('retains both actual machine setup phase terminals after the current output changes', () => {
    const domainRef = { kind: 'machineEnvironment', serverId: 'home', machineId: 'guest',
      preset: { id: 'preset', revision: 1 }, terminalId: 'setup-output',
      terminals: { install: 'install-output', setup: 'setup-output' } };
    expect(ActionOperationDomainRefV1Schema.parse(domainRef)).toEqual(domainRef);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, terminals: { arbitrary: 'output' } }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, terminalId: 'unrelated-output' }).success).toBe(false);
  });
  it('retains output for the canonical first preset revision zero', () => {
    const domainRef = { kind: 'machineEnvironment', serverId: 'home', machineId: 'guest', preset: { id: 'preset', revision: 0 } };
    expect(ActionOperationDomainRefV1Schema.parse(domainRef)).toEqual(domainRef);
  });
  it('publishes numeric FIFO ahead as a queue phase while retaining the closed predecessor progress shape', () => {
    const progress = { kind: 'phase', phase: 'queued', label: 'Queued', queueAhead: 2 } as const;
    const current = ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, progress });
    expect(current.progress).toEqual(progress);
    // ../0.2 at 37a6541578749067b49d4579be8c752c9591b8c8 accepts
    // exactly kind/phase/label on its closed phase arm, not current queue facts.
    expect(projectActionOperationSnapshotForV1Reader(current).progress)
      .toEqual({ kind: 'phase', phase: 'queued', label: 'Queued' });
    for (const invalid of [
      { ...progress, queueAhead: -1 },
      { ...progress, queueAhead: 0.5 },
      { ...progress, queueAhead: Number.MAX_SAFE_INTEGER + 1 },
      { ...progress, phase: 'preparing' },
      { ...progress, queuedAccountId: 'private-requester' },
    ]) expect(ActionOperationProgressV1Schema.safeParse(invalid).success).toBe(false);
  });

  it('retains qualified source Script identity separately from its actual execution target and observed exit', () => {
    const sourceWorkspace = { serverId: 'source-home', machineId: 'source-machine', workspaceId: 'shared-id', rootPath: '/source' };
    const attachment = { kind: 'projectCommand', purpose: 'script', serverId: 'target-home', machineId: 'worker',
      workspaceRefId: 'shared-id', cwd: '/copy/packages/web', terminalId: 'actual-terminal', sourceWorkspace };
    const sources = [
      { name: 'test', source: { kind: 'command', command: 'run tests', cwd: 'packages/web' } },
      { source: { kind: 'native', tool: 'package_script', file: 'package.json', target: 'test' } },
      { source: { kind: 'pluginNative', adapter: { pluginId: 'acme.tools', localId: 'runner' }, file: 'tasks.json', target: 'test' } },
    ];
    for (const script of sources) {
      const domainRef = { ...attachment, script, exitCode: 17 };
      expect(ActionOperationDomainRefV1Schema.parse(domainRef)).toEqual(domainRef);
      expect(ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'projects.script.run', state: 'failed',
        startedAt: 110, settledAt: 140, domainRef, error: { errorCode: 'project_command_step_failed', error: 'Process failed' },
      }).domainRef).toEqual(domainRef);
      expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, sourceWorkspace: undefined }).success).toBe(false);
      expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, script: { ...script, credentials: 'private' } }).success).toBe(false);
      expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, exitCode: 1.5 }).success).toBe(false);
      expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, terminalId: undefined }).success).toBe(false);
    }
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...attachment,
      script: { name: '', source: sources[0]!.source } }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...attachment, sourceWorkspace: { ...sourceWorkspace, accountId: 'caller' } }).success).toBe(false);
  });
  it('keeps a managed row associated while its actual bootstrap task is attached', () => {
    const domainRef = { kind: 'managedMachine', id: 'managed-row',
      controller: { machineId: 'controller', installationId: 'installation' },
      resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { nativeId: 'retained' } },
      bootstrapTask: { id: 'real-task', taskKind: 'remote.ssh.bootstrapMachine.v1' } };
    expect(ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.managed.acquire', domainRef }).domainRef)
      .toEqual(domainRef);
    expect(ActionOperationDomainRefV1Schema.parse({ kind: 'managedMachine', id: 'waiting-row' }))
      .toEqual({ kind: 'managedMachine', id: 'waiting-row' });
    const { bootstrapTask: _task, ...bootRecovery } = domainRef;
    expect(ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.managed.bootstrap.retry', domainRef: bootRecovery }).domainRef)
      .toEqual(bootRecovery);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef,
      bootstrapTask: { ...domainRef.bootstrapTask, taskKind: 'arbitrary.task' } }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, intentRevision: 0 }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef,
      bootstrapTask: { ...domainRef.bootstrapTask, controller: domainRef.controller, resource: domainRef.resource } }).success).toBe(false);
  });
  it('retains only the qualified service relocation attempt without claiming a native lifetime', () => {
    const domainRef = { kind: 'projectService', purpose: 'relocation',
      workspace: { serverId: 'home', machineId: 'selected-worker', workspaceId: 'selected-ref', rootPath: '/selected' },
      declaration: { workspaceRefId: 'selected-ref', selection: { kind: 'manifest', name: 'web' } } };
    const operation = { ...baseSnapshot, actionId: 'projects.service.relocate', state: 'running', startedAt: 110,
      domainRef, observation: { kind: 'outcome_uncertain', code: 'outcome_uncertain' } };
    expect(ActionOperationSnapshotV1Schema.parse(operation).domainRef).toEqual(domainRef);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef,
      declaration: { ...domainRef.declaration, workspaceRefId: 'source-ref' } }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, managedServiceId: 'unobserved-native' }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, running: true }).success).toBe(false);
  });
  it('retains observed native Stop identity only on its qualified declaration and workspace scope', () => {
    const declaration = { workspaceRefId: 'old-ref', selection: { kind: 'manifest', name: 'web' } };
    const currentTarget = { kind: 'managed_service', managedServiceId: 'observed-native', machineId: 'old-worker',
      workspaceId: 'old-ref', declaration, cwd: 'c:/Work/Project/packages/web' };
    const domainRef = { kind: 'projectService', purpose: 'relocation',
      workspace: { serverId: 'home', machineId: 'old-worker', workspaceId: 'old-ref', rootPath: 'C:\\Work\\Project' },
      declaration, currentTarget };
    expect(ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'projects.service.relocate',
      state: 'running', startedAt: 110, domainRef, observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' },
    }).domainRef).toEqual(domainRef);
    const mismatches = [
      { ...currentTarget, machineId: 'other-worker' },
      { ...currentTarget, workspaceId: 'other-ref' },
      { ...currentTarget, declaration: { ...declaration, selection: { kind: 'manifest', name: 'other-service' } } },
      { ...currentTarget, declaration: undefined },
      { ...currentTarget, cwd: undefined },
      { ...currentTarget, sessionId: 'unrelated-session' },
    ];
    for (const target of mismatches) {
      expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, currentTarget: target }).success).toBe(false);
    }
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, currentTarget: { ...currentTarget, running: true } }).success).toBe(false);
  });
  it('keeps strict no-effect setup review live without exposing unsafe plans or terminal review state', () => {
    const setupReview = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'setup',
      reviewedEffect: { commands: [] } };
    const held = { ...baseSnapshot, actionId: 'projects.script.run', setupReview,
      domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home', machineId: 'machine',
        workspaceRefId: 'workspace', cwd: '/project' } };
    expect(ActionOperationSnapshotV1Schema.safeParse(held).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...held, setupReview: { ...setupReview, plan: { credentials: 'secret' } } }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...held, setupReview: { ...setupReview, code: 'project_script_effect_changed' } }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...held, actionId: 'session.spawn_new' }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...held, state: 'succeeded', startedAt: 110, settledAt: 120 }).success).toBe(false);
  });
  it('accepts only strict producer setup-consent facts bound to the terminal failure code', () => {
    const failure = { errorCode: 'project_setup_consent_required', error: 'Consent required', details: {
      kind: 'pendingApproval', code: 'project_setup_consent_required',
      reviewedEffect: { commands: ['install'] }, reviewedEffectDigest: 'reviewed-effect',
    } };
    expect(ActionOperationFailureV1Schema.parse(failure)).toEqual(failure);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, errorCode: 'different' }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, details: { ...failure.details, credential: 'private' } }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, details: { arbitrary: 'private' } }).success).toBe(false);
  });
  it('retains terminal Script changed-effect review without granting a setup continuation', () => {
    const failure = { errorCode: 'project_script_effect_changed', error: 'Script effect changed', details: {
      kind: 'pendingApproval', code: 'project_script_effect_changed', reviewedEffectDigest: 'current-script',
      reviewedEffect: { command: { kind: 'command', command: 'echo changed' }, environment: { kind: 'host' } },
    } };
    expect(ActionOperationFailureV1Schema.parse(failure)).toEqual(failure);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, errorCode: 'project_setup_effect_changed' }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, details: { ...failure.details, consentScope: 'untilChanged' } }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, details: { ...failure.details, setupGrant: 'private' } }).success).toBe(false);
    expect(ActionOperationFailureV1Schema.safeParse({ ...failure, details: { ...failure.details, reviewedEffect: { unsupported: undefined } } }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, actionId: 'projects.script.run', setupReview: failure.details }).success).toBe(false);
  });
  it('preserves configured worker fallback refusals without promoting unknown eligibility or exposing private facts', () => {
    for (const unavailable of ['ask', 'primary', 'fail'] as const) {
      const errorCode = unavailable === 'fail' ? 'not_accepting' : 'choice_required';
      const failure = { errorCode, error: errorCode, details: {
        kind: 'no_worker_can_accept', unavailable, reason: 'not_accepting',
      } };
      expect(ActionOperationFailureV1Schema.parse(failure)).toEqual(failure);
      expect(ActionOperationFailureV1Schema.safeParse({ ...failure, errorCode: 'process_exit_nonzero' }).success).toBe(false);
      for (const reason of ['memory_unavailable', 'worker_status_unavailable', 'load_unknown']) {
        expect(ActionOperationFailureV1Schema.safeParse({ ...failure,
          details: { ...failure.details, reason } }).success).toBe(false);
      }
      expect(ActionOperationFailureV1Schema.safeParse({ ...failure,
        details: { ...failure.details, credential: 'private' } }).success).toBe(false);
    }
    expect(ActionOperationFailureV1Schema.safeParse({ errorCode: 'choice_required', error: 'Choice needed',
      details: { kind: 'no_worker_can_accept', unavailable: 'fail', reason: 'not_accepting' } }).success).toBe(false);
  });
  it('links only the existing remote enrollment task without granting another routing identity', () => {
    const domainRef = { kind: 'systemTask', id: 'bootstrap-task', taskKind: 'remote.ssh.bootstrapMachine.v1' };
    expect(ActionOperationSnapshotV1Schema.parse({ ...baseSnapshot, actionId: 'machines.managed.acquire', domainRef }).domainRef)
      .toEqual(domainRef);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, taskKind: 'arbitrary.task' }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, token: 'secret' }).success).toBe(false);
  });
  it('keeps unknown launch or stop evidence distinct from terminal process outcomes', () => {
    const observation = { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' };
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, observation }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, observation: { ...observation, success: true } }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, state: 'cancelled', startedAt: 110,
      settledAt: 120, observation }).success).toBe(false);
  });
  it('accepts terminal observation only at get, never as an implicit stop request', () => {
    expect(ActionOperationGetV1RequestSchema.safeParse({ operationId: 'operation', waitForTerminal: true }).success).toBe(true);
    expect(ActionOperationGetV1RequestSchema.safeParse({ operationId: 'operation', waitForTerminal: true, includeSetupReview: true }).success).toBe(true);
    expect(ActionOperationGetV1RequestSchema.safeParse({ operationId: 'operation', includeSetupReview: true }).success).toBe(false);
    expect(ActionOperationGetV1RequestSchema.safeParse({ operationId: 'operation', waitForTerminal: false }).success).toBe(false);
    expect(ActionOperationCancelV1RequestSchema.safeParse({ operationId: 'operation', waitForTerminal: true }).success).toBe(false);
  });
  it('retains a strict qualified project command before launch and after failure or cancellation', () => {
    const domainRef = { kind: 'projectCommand', purpose: 'script', serverId: 'home-1',
      machineId: 'worker-1', workspaceRefId: 'workspace-1', cwd: '/project',
      originRun: { kind: 'workflow_run', serverId: 'home-1', runId: 'workflow-1' } };
    const accepted = { ...baseSnapshot, actionId: 'projects.script.run', domainRef };
    expect(ActionOperationSnapshotV1Schema.safeParse(accepted).success).toBe(true);
    expect(ActionOperationDomainRefV1Schema.parse({ ...domainRef, cwd: '/project with trailing space ' }))
      .toMatchObject({ cwd: '/project with trailing space ' });
    for (const state of ['failed', 'cancelled']) {
      const terminal = { ...accepted, state, startedAt: 110, settledAt: 120,
        domainRef: { ...domainRef, terminalId: 'terminal-1' },
        ...(state === 'failed' ? { error: { errorCode: 'process_exit_nonzero', error: 'Process failed' } } : {}) };
      expect(ActionOperationSnapshotV1Schema.safeParse(terminal).success).toBe(true);
      expect(ActionOperationSnapshotV1Schema.safeParse({ ...terminal, result: { exitCode: 1 } }).success).toBe(false);
    }
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef, actorAccountId: 'caller-minted' }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({ ...domainRef,
      originRun: { ...domainRef.originRun, authority: 'caller-minted' } }).success).toBe(false);
  });
  it('owns the exact additive machine RPC method names', () => {
    expect(ACTION_OPERATION_RPC_METHODS_V1).toEqual({
      list: 'actionOperation.list.v1',
      get: 'actionOperation.get.v1',
      cancel: 'actionOperation.cancel.v1',
    });
  });

  it('accepts only the exact v1 Action declaration', () => {
    expect(ActionOperationDeclarationV1Schema.parse({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    })).toEqual({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    });
    for (const onStart of ['current', 'detail', 'activity'] as const) {
      expect(ActionOperationDeclarationV1Schema.safeParse({
        version: 1,
        visibility: 'activity',
        progress: 'reported',
        presentation: { onStart },
      }).success).toBe(true);
    }
    expect(ActionOperationDeclarationV1Schema.safeParse({
      version: 2,
      visibility: 'activity',
      progress: 'reported',
      presentation: { onStart: 'current' },
    }).success).toBe(false);
    expect(ActionOperationDeclarationV1Schema.safeParse({
      version: 1,
      visibility: 'activity',
      progress: 'reported',
      title: 'Duplicated presentation',
    }).success).toBe(false);
  });

  it('enforces bounded truthful progress', () => {
    expect(ActionOperationProgressV1Schema.parse({
      kind: 'determinate', current: 2, total: 4, label: 'Uploading',
    })).toEqual({ kind: 'determinate', current: 2, total: 4, label: 'Uploading' });

    for (const progress of [
      { kind: 'determinate', current: -1, total: 4 },
      { kind: 'determinate', current: 5, total: 4 },
      { kind: 'determinate', current: 1, total: 0 },
      { kind: 'determinate', current: Number.POSITIVE_INFINITY, total: 4 },
      { kind: 'phase', phase: '', label: 'Preparing' },
      { kind: 'phase', phase: 'p'.repeat(ACTION_OPERATION_PROGRESS_PHASE_MAX_LENGTH_V1 + 1), label: 'Preparing' },
      { kind: 'phase', phase: 'prepare', label: 'l'.repeat(ACTION_OPERATION_PROGRESS_LABEL_MAX_LENGTH_V1 + 1) },
    ]) {
      expect(ActionOperationProgressV1Schema.safeParse(progress).success).toBe(false);
    }
  });

  it('keeps the common v1 progress bounds', () => {
    expect(ActionOperationProgressV1Schema.safeParse({
      kind: 'phase',
      phase: 'p'.repeat(200),
      label: 'l'.repeat(1_000),
    }).success).toBe(true);
  });

  it('accepts the predecessor fork strategy projection without widening other references', () => {
    expect(ActionOperationDomainRefV1Schema.parse({
      kind: 'forkRequest', id: 'fork-request-1', strategy: 'replay',
    })).toEqual({ kind: 'forkRequest', id: 'fork-request-1', strategy: 'replay' });
    expect(ActionOperationDomainRefV1Schema.safeParse({
      kind: 'handoff', id: 'handoff-1', strategy: 'native',
    }).success).toBe(false);
  });

  it('accepts the optional common-v1 handoff target without widening other references', () => {
    expect(ActionOperationDomainRefV1Schema.parse({
      kind: 'handoff', id: 'handoff-1',
    })).toEqual({ kind: 'handoff', id: 'handoff-1' });
    expect(ActionOperationDomainRefV1Schema.parse({
      kind: 'handoff', id: 'handoff-1', targetMachineId: 'machine-target',
    })).toEqual({ kind: 'handoff', id: 'handoff-1', targetMachineId: 'machine-target' });
    expect(ActionOperationDomainRefV1Schema.safeParse({
      kind: 'spawnAttempt', id: 'spawn-1', targetMachineId: 'machine-target',
    }).success).toBe(false);
    expect(ActionOperationDomainRefV1Schema.safeParse({
      kind: 'handoff', id: 'handoff-1', targetMachineId: ' ',
    }).success).toBe(false);
  });

  it('keeps the remote-dev predecessor redacted failure shape as common v1', () => {
    // remote-dev's strict public failure projection has exactly errorCode + error.
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'failed',
      startedAt: 110,
      settledAt: 120,
      error: { errorCode: 'spawn_failed', error: 'Session creation failed' },
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'failed',
      startedAt: 110,
      settledAt: 120,
      error: {
        errorCode: 'spawn_failed',
        error: 'Session creation failed',
        details: { token: 'must-not-cross-the-public-operation-wire' },
      },
    }).success).toBe(false);
  });

  it('enforces the remote-dev predecessor common snapshot bounds', () => {
    const predecessorBoundarySnapshot = {
      ...baseSnapshot,
      operationId: 'o'.repeat(2_000),
      actionId: 'a'.repeat(2_000),
      scope: {
        accountId: 'c'.repeat(2_000),
        machineId: 'm'.repeat(2_000),
        sessionId: 's'.repeat(2_000),
      },
      title: 't'.repeat(10_000),
    } as const;
    expect(ActionOperationSnapshotV1Schema.safeParse(predecessorBoundarySnapshot).success).toBe(true);

    for (const incompatible of [
      { ...baseSnapshot, operationId: 'o'.repeat(2_001) },
      { ...baseSnapshot, actionId: 'a'.repeat(2_001) },
      { ...baseSnapshot, scope: { ...baseSnapshot.scope, accountId: 'c'.repeat(2_001) } },
      { ...baseSnapshot, title: 't'.repeat(10_001) },
      { ...baseSnapshot, createdAt: 100.5 },
      {
        ...baseSnapshot,
        state: 'failed',
        startedAt: 110,
        settledAt: 120,
        error: { errorCode: 'e'.repeat(201), error: 'Failed' },
      },
      {
        ...baseSnapshot,
        state: 'failed',
        startedAt: 110,
        settledAt: 120,
        error: { errorCode: 'failed', error: 'e'.repeat(10_001) },
      },
    ]) {
      expect(ActionOperationSnapshotV1Schema.safeParse(incompatible).success).toBe(false);
    }
  });

  it('requires a positive revision and state-consistent lifecycle payload', () => {
    expect(ActionOperationSnapshotV1Schema.parse(baseSnapshot)).toEqual(baseSnapshot);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, revision: 0 }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...baseSnapshot, startedAt: 110 }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot, state: 'running', startedAt: 110,
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'succeeded',
      startedAt: 110,
      settledAt: 120,
      result: { sessionId: 'new-session' },
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'failed',
      startedAt: 110,
      settledAt: 120,
      error: { errorCode: 'spawn_failed', error: 'Session creation failed' },
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot, state: 'failed', startedAt: 110, settledAt: 120,
    }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      state: 'cancelled',
      startedAt: 110,
      settledAt: 120,
      result: { shouldNotExist: true },
    }).success).toBe(false);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot, state: 'succeeded', startedAt: 110, settledAt: 105,
    }).success).toBe(false);
  });

  it('keeps raw invocation input outside the strict snapshot wire shape', () => {
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      input: { token: 'secret' },
    }).success).toBe(false);
  });

  it('carries bounded request correlation without making it the operation identity', () => {
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      requestId: 'r'.repeat(ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1),
    }).success).toBe(true);
    expect(ActionOperationSnapshotV1Schema.safeParse({
      ...baseSnapshot,
      requestId: 'r'.repeat(ACTION_OPERATION_REQUEST_ID_MAX_LENGTH_V1 + 1),
    }).success).toBe(false);
  });

  it('owns a strict encrypted machine push envelope', () => {
    const envelope = {
      v: 1,
      machineId: 'machine-1',
      ciphertext: 'ciphertext',
    } as const;
    expect(ActionOperationSnapshotPushV1Schema.parse(envelope)).toEqual(envelope);
    expect(ActionOperationSnapshotPushV1Schema.safeParse({ ...envelope, extra: true }).success).toBe(false);
  });

  it('validates every additive machine RPC payload', () => {
    expect(ActionOperationListV1RequestSchema.safeParse({
      states: ['accepted', 'running'], sessionId: 'session-1', cursor: 'cursor-1',
    }).success).toBe(true);
    expect(ActionOperationListV1ResponseSchema.safeParse({
      items: [baseSnapshot], nextCursor: null,
    }).success).toBe(true);
    expect(ActionOperationGetV1RequestSchema.safeParse({ operationId: 'operation-1' }).success).toBe(true);
    expect(ActionOperationGetV1ResponseSchema.safeParse({ kind: 'found', operation: baseSnapshot }).success).toBe(true);
    expect(ActionOperationGetV1ResponseSchema.safeParse({ kind: 'not_found' }).success).toBe(true);
    expect(ActionOperationCancelV1RequestSchema.safeParse({ operationId: 'operation-1' }).success).toBe(true);
    for (const kind of ['unsupported', 'requested', 'already_settled', 'not_found'] as const) {
      expect(ActionOperationCancelV1ResponseSchema.safeParse({ kind }).success).toBe(true);
    }

  });

});
