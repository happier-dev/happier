import { describe, expect, it, vi } from 'vitest';

import { createActionOperationStore } from './actionOperationStore';
import { ActionOperationGetV1ResponseSchema, ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { ActionOperationSnapshotV1Schema as PredecessorActionOperationSnapshotV1Schema } from './testFixtures/predecessorActionOperationV1';
import { buildDeploymentBackupActionInputV1, DeploymentBackupRunResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DEPLOYMENT_BACKUP_ACTION_IDS_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { ActionOperationScope } from './actionOperationTypes';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareProjectOpenReceiptPersistence } from './projectOpenReceiptPersistence';

const ACCOUNT_SCOPE = { accountId: 'account-1', machineId: 'machine-1' } as const;

describe('action operation store', () => {
  it('distinguishes an unopened receipt store from a first Backup receipt write failure', () => {
    const createBackup = (store: ReturnType<typeof createActionOperationStore>) => store.create({
      operationId: 'backup', scope: ACCOUNT_SCOPE, actionId: 'deployments.backups.run',
      title: 'Backup', cancellation: 'unsupported', inputIdentity: '{}',
    });
    const unopened = createActionOperationStore({ projectOpenReceiptPersistence: null });
    const cannotWrite = createActionOperationStore({ projectOpenReceiptPersistence: {
      retained: [], save() { throw new Error('private storage path'); }, remove() {},
    } });

    expect(() => createBackup(unopened)).toThrow(expect.objectContaining({ storagePhase: 'open', effectAttempted: false }));
    expect(() => createBackup(cannotWrite)).toThrow(expect.objectContaining({ storagePhase: 'write', effectAttempted: false }));
    expect(cannotWrite.get(ACCOUNT_SCOPE, 'backup')).toBeNull();
  });
  it('retains owner steps through approval and indeterminate progress overlays until explicitly replaced', () => {
    const store = createActionOperationStore();
    store.create({ operationId: 'prepare-steps', scope: ACCOUNT_SCOPE, actionId: 'machines.presets.prepare',
      title: 'Prepare', cancellation: 'supported', inputIdentity: '{}' });
    store.markRunning('prepare-steps');
    const steps = [{ id: 'build-image', label: 'Build prepared image', state: 'running' as const }];
    store.updateProgress('prepare-steps', { kind: 'phase', phase: 'build-image', label: 'Build prepared image', steps });
    for (const progress of [
      { kind: 'phase' as const, phase: 'waiting_for_approval', label: 'Waiting for approval' },
      { kind: 'indeterminate' as const },
    ]) {
      expect(store.updateProgress('prepare-steps', progress)?.progress).toEqual({ ...progress, steps });
    }
    expect(store.updateProgress('prepare-steps', { kind: 'phase', phase: 'save-image', label: 'Save image', steps: [] })?.progress)
      .toEqual({ kind: 'phase', phase: 'save-image', label: 'Save image', steps: [] });
  });

  it('projects active Project commands before PTY attachment and removes them at actual settlement', () => {
    const store = createActionOperationStore();
    const command = { kind: 'projectCommand' as const, purpose: 'setup' as const,
      serverId: 'home', machineId: ACCOUNT_SCOPE.machineId, workspaceRefId: 'workspace', cwd: '/checkout' };
    store.create({ operationId: 'preparing', scope: ACCOUNT_SCOPE, actionId: 'projects.prepare',
      title: 'Prepare', cancellation: 'supported', domainRef: command, inputIdentity: '{}' });
    expect(store.readActiveProjectCommands()).toEqual([command]);
    store.markRunning('preparing');
    expect(store.readActiveProjectCommands()).toEqual([command]);
    store.succeed('preparing', {});
    expect(store.readActiveProjectCommands()).toEqual([]);
  });

  it('emits one outcome per backup run settlement, never for progress, replay or maintenance', () => {
    const outcomes: unknown[] = [];
    const store = createActionOperationStore({ onBackupOutcome: outcome => outcomes.push(outcome) });
    const input = buildDeploymentBackupActionInputV1('deployments.backups.run', {
      serverId: 'home', environmentId: 'environment', machineId: ACCOUNT_SCOPE.machineId,
      installationId: 'installation', targetLinkId: 'target', deploymentId: 'deployment', expectedRevision: 1, configRevision: 1,
    });
    expect(outcomes).toEqual([]);
    for (const state of ['succeeded', 'failed'] as const) {
      store.create({ operationId: state, scope: ACCOUNT_SCOPE, actionId: 'deployments.backups.run',
        title: 'Backup', cancellation: 'unsupported', inputIdentity: JSON.stringify(input), originRunId: 'backup-workflow' });
      store.markRunning(state);
      store.updateProgress(state, { kind: 'phase', phase: 'backup', label: 'Backing up' });
      expect(outcomes).toHaveLength(state === 'succeeded' ? 0 : 1);
      if (state === 'succeeded') store.succeed(state, { kind: 'verified', operationId: state, manifests: [] });
      else store.fail(state, { errorCode: 'backup_failed', error: 'Private native output' });
      // Re-observing a retained terminal result is not another run.
      store.get(ACCOUNT_SCOPE, state);
      store.succeed(state, {});
    }
    store.create({ operationId: 'verify', scope: ACCOUNT_SCOPE, actionId: 'deployments.backups.verify',
      title: 'Verify', cancellation: 'unsupported', inputIdentity: JSON.stringify(input) });
    store.succeed('verify', {});
    expect(outcomes).toMatchObject([
      { kind: 'backup', serverId: 'home', machineId: ACCOUNT_SCOPE.machineId, environmentId: 'environment',
        operationId: 'succeeded', state: 'succeeded', errorCode: null, originRunId: 'backup-workflow' },
      { kind: 'backup', operationId: 'failed', state: 'failed', errorCode: 'backup_failed', originRunId: 'backup-workflow' },
    ]);
    expect(outcomes).toHaveLength(2);
    expect(JSON.stringify(outcomes)).not.toContain('Private native output');
  });

  it('recovers safe backup outcomes from retained native input without another Account or native output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-outcome-recovery-'));
    try {
      // Real native receipt persistence proves recovery without a successful live publication.
      const open = () => prepareProjectOpenReceiptPersistence({ directory: join(directory, 'receipts'),
        keyPath: join(directory, 'key.json'), accountId: ACCOUNT_SCOPE.accountId, machineId: ACCOUNT_SCOPE.machineId });
      const first = createActionOperationStore({ projectOpenReceiptPersistence: await open(), now: () => 100 });
      const input = buildDeploymentBackupActionInputV1('deployments.backups.run', {
        serverId: 'home', environmentId: 'environment', machineId: ACCOUNT_SCOPE.machineId,
        installationId: 'installation', targetLinkId: 'target', deploymentId: 'deployment', expectedRevision: 1, configRevision: 1,
      });
      first.create({ operationId: 'first-failure', scope: ACCOUNT_SCOPE, actionId: 'deployments.backups.run',
        title: 'Backup', cancellation: 'unsupported', inputIdentity: JSON.stringify(input) });
      first.markRunning('first-failure');
      first.fail('first-failure', { errorCode: 'backup_failed', error: 'PRIVATE_NATIVE_OUTPUT' });
      const restarted = createActionOperationStore({ projectOpenReceiptPersistence: await open(), now: () => 101 });
      const requestedProjection = { ...ACCOUNT_SCOPE, machineOutcomes: true as const };
      const recovered = restarted.list(requestedProjection);
      expect(recovered).toMatchObject({ machineOutcomes: [{ kind: 'backup', serverId: 'home',
        machineId: ACCOUNT_SCOPE.machineId, environmentId: 'environment', operationId: 'first-failure',
        state: 'failed', occurredAt: 100, errorCode: 'backup_failed' }] });
      expect(JSON.stringify('machineOutcomes' in recovered && recovered.machineOutcomes)).not.toContain('PRIVATE_NATIVE_OUTPUT');
      expect(restarted.list(ACCOUNT_SCOPE)).not.toHaveProperty('machineOutcomes');
      expect(restarted.list({ ...requestedProjection, accountId: 'another-account' }))
        .toMatchObject({ items: [], machineOutcomes: [] });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('retains a shared Machine requester capture in the custodian partition without disclosing it to another Account', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'backup-receipt-scope-'));
    try {
      const open = () => prepareProjectOpenReceiptPersistence({ directory: join(directory, 'receipts'),
        keyPath: join(directory, 'key.json'), accountId: 'machine-custodian', machineId: ACCOUNT_SCOPE.machineId });
      const input = buildDeploymentBackupActionInputV1('deployments.backups.run', {
        serverId: 'home', environmentId: 'environment', machineId: ACCOUNT_SCOPE.machineId,
        installationId: 'installation', targetLinkId: 'target', deploymentId: 'deployment', expectedRevision: 1, configRevision: 1,
      });
      const persistence = await open();
      const writes = vi.spyOn(persistence, 'save'); // Real filesystem adapter; observe disk work without replacing it.
      const first = createActionOperationStore({ projectOpenReceiptPersistence: persistence });
      first.create({ operationId: 'shared-capture', scope: ACCOUNT_SCOPE, actionId: 'deployments.backups.run',
        title: 'Backup', cancellation: 'unsupported', inputIdentity: JSON.stringify(input) });
      first.succeed('shared-capture', DeploymentBackupRunResultV1Schema.parse({ kind: 'verified', operationId: 'shared-capture', manifests: [{
        schemaVersion: 1, environmentId: input.environmentId, sourceId: 'database', kind: 'dump', configRevision: 1,
        repositoryId: 'a'.repeat(64), producerChecksumSha256: 'b'.repeat(64),
        snapshot: { snapshotId: 'c'.repeat(64), treeId: 'd'.repeat(64), hostname: 'host',
          time: '2026-11-09T23:39:30Z', paths: ['database.dump'], tags: [] }, totalBytesProcessed: 10, totalFilesProcessed: 1,
      }] }));
      first.create({ operationId: 'lost-backup', scope: ACCOUNT_SCOPE, actionId: 'deployments.backups.run',
        title: 'Backup', cancellation: 'unsupported', inputIdentity: JSON.stringify(input) });
      first.markRunning('lost-backup');
      for (let index = 0; index < 100; index++) {
        first.updateProgress('lost-backup', { kind: 'phase', phase: 'backup', label: `Backing up ${index}` });
      }
      expect(writes).toHaveBeenCalledTimes(3); // Two admissions + one terminal fact; progress adds no disk writes.
      const outcomes: unknown[] = [];
      const onBackupOutcome = (outcome: unknown) => { outcomes.push(outcome); };
      const restarted = createActionOperationStore({ projectOpenReceiptPersistence: await open(), onBackupOutcome });
      expect(restarted.readDeploymentBackupOperations(ACCOUNT_SCOPE, input)).toContainEqual(
        { snapshot: first.get(ACCOUNT_SCOPE, 'shared-capture'), input });
      expect(restarted.get(ACCOUNT_SCOPE, 'lost-backup')).toMatchObject({ state: 'failed',
        error: { errorCode: 'action_outcome_unknown', effectAttempted: true } });
      expect(createActionOperationStore({ projectOpenReceiptPersistence: await open(), onBackupOutcome }).get(ACCOUNT_SCOPE, 'lost-backup'))
        .toEqual(restarted.get(ACCOUNT_SCOPE, 'lost-backup'));
      expect(outcomes).toMatchObject([{ kind: 'backup', operationId: 'lost-backup', state: 'failed', errorCode: 'action_outcome_unknown' }]);
      expect(outcomes).toHaveLength(1);
      expect(restarted.readDeploymentBackupOperations({ ...ACCOUNT_SCOPE, accountId: 'machine-custodian' }, input)).toEqual([]);
      expect(restarted.get({ ...ACCOUNT_SCOPE, accountId: 'other' }, 'shared-capture')).toBeNull();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('settles and reads failed worker operations even when their optional cause is unknown', () => {
    const store = createActionOperationStore();
    store.create({ operationId: 'worker-failed', actionId: 'projects.script.run', title: 'Script',
      scope: ACCOUNT_SCOPE, cancellation: 'supported', inputIdentity: '{}' });
    store.updateProgress('worker-failed', { kind: 'phase', phase: 'copying', label: 'Copying current files' });
    const failure = { errorCode: 'project_script_effect_changed', error: 'Project inputs changed',
      cause: { kind: 'future_worker_cause', privateValue: 'must-not-cross-the-reader' } };
    store.fail('worker-failed', failure);
    const response = ActionOperationGetV1ResponseSchema.parse({ kind: 'found', operation: store.get(ACCOUNT_SCOPE, 'worker-failed') });
    expect(response).toMatchObject({ kind: 'found', operation: { state: 'failed', error: {
      errorCode: failure.errorCode, error: failure.error,
      failureCause: { kind: 'unknown', errorCode: 'unknown_failure_cause' },
    } } });
    expect(JSON.stringify(response)).not.toContain('must-not-cross-the-reader');
    expect(store.get({ ...ACCOUNT_SCOPE, accountId: 'other' }, 'worker-failed')).toBeNull();
  });

  it('projects future cause diagnostics without accepting invalid operation lifecycle facts', () => {
    const store = createActionOperationStore();
    store.create({ operationId: 'worker-future', actionId: 'projects.script.run', title: 'Script',
      scope: ACCOUNT_SCOPE, cancellation: 'supported', inputIdentity: '{}' });
    const failure = { errorCode: 'project_script_effect_changed', error: 'Project inputs changed',
      failureCause: { phase: 'project.worker.prepare', errorClass: 'Error' as const,
        errorCode: null, httpStatus: null, futureDiagnostic: 'must-not-cross-the-reader' } };
    store.fail('worker-future', failure);
    const operation = store.get(ACCOUNT_SCOPE, 'worker-future');
    expect(ActionOperationGetV1ResponseSchema.parse({ kind: 'found', operation })).toMatchObject({ operation: {
      state: 'failed', error: { failureCause: { kind: 'unknown', errorCode: 'unknown_failure_cause' } },
    } });
    expect(JSON.stringify(operation)).not.toContain('must-not-cross-the-reader');
    expect(ActionOperationSnapshotV1Schema.safeParse({ ...operation, state: 'accepted' }).success).toBe(false);
  });

  it('reads exact backup target receipts without enumerating the operation inventory and retires their authored input with custody', () => {
    let now = 1_000;
    const store = createActionOperationStore({ now: () => now, settledRetentionLimit: 2, settledRetentionMs: 100 });
    const target = { serverId: 'server-1', environmentId: 'environment-1', machineId: 'machine-1',
      installationId: 'installation-1', targetLinkId: 'target-1', deploymentId: 'deployment-1' };
    const input = buildDeploymentBackupActionInputV1('deployments.backups.run', {
      ...target, expectedRevision: 1, configRevision: 1,
    });
    const create = (operationId: string, scope: ActionOperationScope = ACCOUNT_SCOPE, authored = input) => store.create({
      operationId, scope, actionId: 'deployments.backups.run', title: 'Backup', cancellation: 'unsupported',
      inputIdentity: JSON.stringify(authored),
    });
    create('capture');
    const result = DeploymentBackupRunResultV1Schema.parse({ kind: 'verified', operationId: 'capture', manifests: [{
      schemaVersion: 1, environmentId: target.environmentId, sourceId: 'database', kind: 'dump', configRevision: 1,
      repositoryId: 'a'.repeat(64), producerChecksumSha256: 'b'.repeat(64),
      snapshot: { snapshotId: 'c'.repeat(64), treeId: 'd'.repeat(64), hostname: 'host',
        time: '2026-11-04T10:00:00Z', paths: ['database.dump'], tags: [] },
      totalBytesProcessed: 10, totalFilesProcessed: 1,
    }] });
    store.succeed('capture', result);
    const { deploymentId: _deploymentId, ...backupScope } = target;
    for (const [key, value] of Object.entries(backupScope)) {
      create(`another-${key}`, ACCOUNT_SCOPE, { ...input, [key]: `${value}-other` });
    }
    create('another-account', { ...ACCOUNT_SCOPE, accountId: 'account-2' });
    create('another-machine', { ...ACCOUNT_SCOPE, machineId: 'machine-2' });
    create('session-capture', { ...ACCOUNT_SCOPE, sessionId: 'session-1' });
    const restoreInput = { ...target, expectedRevision: 1,
      source: { kind: 'repository' as const, snapshotId: 'c'.repeat(64), backupOperationId: 'capture' }, mode: 'prepare' as const };
    store.create({ operationId: 'restore', scope: ACCOUNT_SCOPE, actionId: 'deployments.backups.restore',
      title: 'Restore', cancellation: 'supported', inputIdentity: JSON.stringify(restoreInput) });
    store.project(ActionOperationSnapshotV1Schema.parse({ ...store.get(ACCOUNT_SCOPE, 'capture'),
      operationId: 'imported-capture' }));
    // Observe the actual inventory traversal; no mock replaces the store's logic.
    const read = (() => {
      const enumeration = vi.spyOn(Map.prototype, 'values');
      try {
        const all = store.readDeploymentBackupOperations(ACCOUNT_SCOPE, target);
        const session = store.readDeploymentBackupOperations({ ...ACCOUNT_SCOPE, sessionId: 'session-1' }, target);
        const missing = store.readDeploymentBackupOperations({ ...ACCOUNT_SCOPE, accountId: 'missing' }, target);
        return { all, session, missing, enumerations: enumeration.mock.calls.length };
      } finally { enumeration.mockRestore(); }
    })();
    expect(read.enumerations).toBe(0);
    expect(read.all).toEqual([
      { snapshot: expect.objectContaining({ operationId: 'capture', state: 'succeeded', result }), input },
      { snapshot: expect.objectContaining({ operationId: 'session-capture' }), input },
      { snapshot: expect.objectContaining({ operationId: 'restore' }), input: restoreInput },
    ]);
    expect(read.session).toEqual([{ snapshot: expect.objectContaining({ operationId: 'session-capture' }), input }]);
    expect(read.missing).toEqual([]);
    // A new deployment generation must not hide this Environment's retained snapshots.
    // Authored generation identity stays on each receipt, while callers use the active target.
    expect(store.readDeploymentBackupOperations(ACCOUNT_SCOPE, { ...target, deploymentId: 'new-generation' }))
      .toEqual(read.all);
    store.removeOwnerProjections(DEPLOYMENT_BACKUP_ACTION_IDS_V1, { ...ACCOUNT_SCOPE, sessionId: 'session-1' });
    store.removeOwnerProjections(['deployments.backups.restore'], ACCOUNT_SCOPE);
    expect(store.readDeploymentBackupOperations(ACCOUNT_SCOPE, target).map(item => item.snapshot.operationId)).toEqual(['capture']);
    now = 1_101;
    // A repository snapshot outlives ordinary operation history (QA #111 → #112).
    expect(store.get(ACCOUNT_SCOPE, 'capture')).toMatchObject({ state: 'succeeded', result });
    expect(store.list(ACCOUNT_SCOPE).items).toContainEqual(expect.objectContaining({ operationId: 'capture' }));
    expect(store.readDeploymentBackupOperations(ACCOUNT_SCOPE, target).map(item => item.snapshot.operationId)).toEqual(['capture']);
    create('reconciled');
    store.reconcileOwner(ACCOUNT_SCOPE, DEPLOYMENT_BACKUP_ACTION_IDS_V1, []);
    expect(store.readDeploymentBackupOperations(ACCOUNT_SCOPE, target)).toEqual([]);
    create('retargeted');
    const changedTarget = { ...target, environmentId: 'replacement-environment' };
    store.replaceInputIdentity('retargeted', JSON.stringify({ ...input, ...changedTarget }));
    expect(store.readDeploymentBackupOperations(ACCOUNT_SCOPE, target)).toEqual([]);
    expect(store.readDeploymentBackupOperations(ACCOUNT_SCOPE, changedTarget).map(item => item.snapshot.operationId))
      .toEqual(['retargeted']);
    store.reconcileOwner(ACCOUNT_SCOPE, DEPLOYMENT_BACKUP_ACTION_IDS_V1, []);
    expect(store.readDeploymentBackupOperations(ACCOUNT_SCOPE, changedTarget)).toEqual([]);
    create('old');
    store.succeed('old', result);
    now++;
    create('new');
    store.succeed('new', result);
    now++;
    create('newest');
    store.succeed('newest', result);
    expect(store.readDeploymentBackupOperations(ACCOUNT_SCOPE, target).map(item => item.snapshot.operationId))
      .toEqual(['old', 'new', 'newest']);
  });
  it('retains an exact typed refusal receipt without treating its successful transport envelope as operation success', () => {
    const store = createActionOperationStore();
    store.create({ operationId: 'reboot-blocked', actionId: 'machines.reboot', title: 'Reboot',
      scope: ACCOUNT_SCOPE, cancellation: 'supported', inputIdentity: '{}' });
    store.markRunning('reboot-blocked');
    const receipt = { kind: 'blocked', reasons: ['setup'] };
    // A variable preserves the current runtime call boundary for RED: current
    // fail ignores the third argument, rather than failing on an absent export.
    const fail: (id: string, error: { errorCode: string; error: string }, result?: unknown) => unknown = store.fail;
    fail('reboot-blocked', { errorCode: 'action_operation_failed', error: 'action_operation_failed' }, receipt);
    expect(store.get(ACCOUNT_SCOPE, 'reboot-blocked')).toMatchObject({ state: 'failed', result: receipt,
      error: { errorCode: 'action_operation_failed' } });
    // Consume the actual producer's retained row at the real strict reader.
    expect(ActionOperationGetV1ResponseSchema.parse({ kind: 'found',
      operation: store.get(ACCOUNT_SCOPE, 'reboot-blocked') })).toMatchObject({ operation: { state: 'failed', result: receipt } });
    expect(store.get({ ...ACCOUNT_SCOPE, accountId: 'other' }, 'reboot-blocked')).toBeNull();
    store.succeed('reboot-blocked', { kind: 'accepted' });
    expect(store.get(ACCOUNT_SCOPE, 'reboot-blocked')).toMatchObject({ state: 'failed', result: receipt });
  });
  it('publishes only changed running and observation facts, preserving revisions on equal updates', () => {
    const pushed: unknown[] = [];
    const store = createActionOperationStore({ onSnapshot: snapshot => pushed.push(snapshot) });
    store.create({ operationId: 'quiet', actionId: 'projects.script.run', title: 'Script',
      scope: ACCOUNT_SCOPE, cancellation: 'supported', inputIdentity: '{}' });
    store.markRunning('quiet');
    const running = store.get(ACCOUNT_SCOPE, 'quiet');
    pushed.length = 0;
    for (let i = 0; i < 100; i++) {
      store.markRunning('quiet');
      store.updateObservation('quiet', null);
    }
    expect(pushed).toHaveLength(0);
    expect(store.get(ACCOUNT_SCOPE, 'quiet')).toBe(running);
    store.updateObservation('quiet', { kind: 'outcome_uncertain', code: 'native_outcome_uncertain' });
    expect(pushed).toHaveLength(1);
    const uncertain = store.get(ACCOUNT_SCOPE, 'quiet');
    for (let i = 0; i < 100; i++) store.updateObservation('quiet', { kind: 'outcome_uncertain', code: 'native_outcome_uncertain' });
    expect(pushed).toHaveLength(1);
    expect(store.get(ACCOUNT_SCOPE, 'quiet')).toBe(uncertain);
    store.updateObservation('quiet', null);
    expect(pushed).toHaveLength(2);
    expect(store.get(ACCOUNT_SCOPE, 'quiet')?.observation).toBeUndefined();
  });
  it('does not publish another retention wake for an unchanged retained resource reference', () => {
    const store = createActionOperationStore();
    store.create({ operationId: 'retention', actionId: 'machines.managed.power.set', title: 'Unused Stop',
      scope: ACCOUNT_SCOPE, cancellation: 'supported', inputIdentity: '{}' });
    const domainRef = { kind: 'managedMachine' as const, id: 'managed',
      controller: { machineId: 'controller', installationId: 'installation' } };
    store.updateDomainRef('retention', domainRef);
    const before = store.get(ACCOUNT_SCOPE, 'retention');
    const publications: unknown[] = [];
    const unsubscribe = store.subscribe(() => publications.push(store.get(ACCOUNT_SCOPE, 'retention')));
    try {
      store.updateDomainRef('retention', { ...domainRef, controller: { ...domainRef.controller } });
      expect(store.get(ACCOUNT_SCOPE, 'retention')).toBe(before);
      expect(publications).toEqual([]);
      store.updateDomainRef('retention', { ...domainRef, controller: { ...domainRef.controller, installationId: 'replacement' } });
      expect(publications).toHaveLength(1);
      expect(store.get(ACCOUNT_SCOPE, 'retention')?.domainRef).toMatchObject({ controller: { installationId: 'replacement' } });
    } finally { unsubscribe(); }
  });
  it.each(['succeeded', 'failed', 'cancelled'] as const)('keeps %s snapshots readable when the wall clock moves backwards', state => {
    let now = 1_000;
    const store = createActionOperationStore({ now: () => now });
    for (const { startClock, expectedTime } of [
      { startClock: null, expectedTime: 1_000 },
      { startClock: 900, expectedTime: 1_000 },
      { startClock: 1_200, expectedTime: 1_200 },
    ]) {
      now = 1_000;
      const operationId = `${state}-${startClock}`;
      store.create({ operationId, actionId: 'projects.script.run', title: 'Run tests', scope: ACCOUNT_SCOPE,
        cancellation: 'supported', inputIdentity: '{}' });
      if (startClock !== null) {
        now = startClock;
        const running = store.markRunning(operationId);
        expect(ActionOperationSnapshotV1Schema.parse(running)).toMatchObject({ startedAt: expectedTime });
        expect(PredecessorActionOperationSnapshotV1Schema.parse(running)).toMatchObject({ startedAt: expectedTime });
      }
      now = 800;
      const settled = state === 'succeeded' ? store.succeed(operationId, {})
        : state === 'failed' ? store.fail(operationId, { errorCode: 'project_command_step_failed', error: 'Process failed' })
          : store.cancel(operationId);
      expect(ActionOperationSnapshotV1Schema.parse(settled)).toMatchObject({ state,
        createdAt: 1_000, startedAt: expectedTime, settledAt: expectedTime });
      expect(PredecessorActionOperationSnapshotV1Schema.parse(settled)).toMatchObject({ state,
        createdAt: 1_000, startedAt: expectedTime, settledAt: expectedTime });
    }
  });
  it('measures finite elapsed work from the first observed spawn across later setup and Script processes', () => {
    let now = 100;
    const store = createActionOperationStore({ now: () => now });
    store.create({ operationId: 'finite-duration', actionId: 'projects.script.run', title: 'Run tests', scope: ACCOUNT_SCOPE,
      cancellation: 'supported', inputIdentity: '{}' });
    expect(store.get(ACCOUNT_SCOPE, 'finite-duration')).not.toHaveProperty('startedAt');
    now = 120;
    store.markRunning('finite-duration');
    now = 160;
    store.markRunning('finite-duration');
    now = 200;
    store.fail('finite-duration', { errorCode: 'project_command_step_failed', error: 'Process failed' });
    expect(store.get(ACCOUNT_SCOPE, 'finite-duration')).toMatchObject({ state: 'failed', createdAt: 100, startedAt: 120, settledAt: 200 });
  });
  it.each(['managed.intent.waiting-idle', 'managed.intent.waiting-deadline'])(
    'excludes only an owner-confirmed passive managed wait (%s) and restores material custody before native submission', phase => {
    const store = createActionOperationStore();
    for (const [operationId, actionId] of [['stop', 'machines.managed.power.set'],
      ['delete', 'machines.managed.delete'], ['other', 'machines.managed.acquire']] as const) {
      store.create({ operationId, actionId, title: 'Managed work', scope: ACCOUNT_SCOPE,
        cancellation: 'unsupported', inputIdentity: '{}' });
      store.markRunning(operationId);
      store.updateProgress(operationId, { kind: 'phase', phase, label: 'Waiting for trigger' });
    }
    expect(store.readLiveWork().items).toEqual([expect.objectContaining({ ownerRef: 'other', state: 'active' })]);
    expect(store.get(ACCOUNT_SCOPE, 'stop')).toMatchObject({ state: 'running' });
    store.updateProgress('stop', { kind: 'phase', phase: 'managed.intent.native-effect', label: 'Applying stop' });
    store.updateObservation('delete', { kind: 'outcome_uncertain', code: 'native_outcome_uncertain' });
    expect(store.readLiveWork().items).toEqual([
      expect.objectContaining({ category: 'finite', ownerRef: 'stop', state: 'active' }),
      expect.objectContaining({ ownerRef: 'delete', state: 'unknown' }),
      expect.objectContaining({ ownerRef: 'other', state: 'active' }),
    ]);
  });
  it('projects accepted finite, setup and handoff custody until real settlement, with the actual terminal association', () => {
    const store = createActionOperationStore();
    const accepted = (operationId: string, actionId: string) => store.create({ operationId, actionId,
      title: 'Work', scope: ACCOUNT_SCOPE, cancellation: 'supported', inputIdentity: '{}' });
    accepted('finite', 'projects.script.run');
    accepted('prepare', 'projects.prepare');
    accepted('handoff', 'session.handoff');
    store.updateDomainRef('finite', { kind: 'projectCommand', purpose: 'script', serverId: 'home',
      machineId: 'machine-1', workspaceRefId: 'workspace', cwd: '/project', terminalId: 'terminal' });
    expect(store.readLiveWork()).toMatchObject({ coverage: 'complete', items: [
      { category: 'finite', ownerRef: 'finite', state: 'active', associatedTerminal: 'terminal', attribution: { kind: 'unknown' } },
      { category: 'setup', ownerRef: 'prepare', state: 'active' },
      { category: 'handoff', ownerRef: 'handoff', state: 'active' },
    ] });
    store.markRunning('finite');
    store.updateObservation('finite', { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' });
    expect(store.readLiveWork().items[0]).toMatchObject({ state: 'unknown', associatedTerminal: 'terminal' });
    store.cancel('finite');
    store.succeed('prepare', {});
    store.fail('handoff', { errorCode: 'rejected', error: 'Rejected' });
    expect(store.readLiveWork().items.every(item => item.state === 'settled')).toBe(true);
  });

  it('notifies activity readers when new custody arrives and unsubscription does not discard work', () => {
    const store = createActionOperationStore();
    const observations: unknown[] = [];
    const unsubscribe = store.subscribe(() => observations.push(store.readLiveWork()));
    store.create({ operationId: 'copy', actionId: 'daemon.filesystem.upload', title: 'Copy', scope: ACCOUNT_SCOPE,
      cancellation: 'unsupported', inputIdentity: '{}' });
    expect(observations).toContainEqual(expect.objectContaining({ items: [expect.objectContaining({
      category: 'transfer', ownerRef: 'copy', state: 'active',
    })] }));
    unsubscribe();
    store.markRunning('copy');
    expect(observations).toHaveLength(1);
    expect(store.readLiveWork().items[0]).toMatchObject({ state: 'active' });
  });
  it.each(['succeeded', 'cancelled'] as const)('clears unconfirmed failure evidence on observed %s settlement', state => {
    const published: unknown[] = [];
    const store = createActionOperationStore({ onSnapshot: snapshot => published.push(snapshot) });
    store.create({ operationId: 'finite', actionId: 'projects.prepare', title: 'Prepare',
      scope: ACCOUNT_SCOPE, cancellation: 'supported', inputIdentity: '{}' });
    store.updateObservation('finite', { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' }, undefined,
      { errorCode: 'stop_unconfirmed', error: 'Inspect the owning process.' });
    const uncertain = store.get(ACCOUNT_SCOPE, 'finite');
    published.length = 0;
    for (let i = 0; i < 100; i++) store.updateObservation('finite',
      { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' }, undefined,
      { errorCode: 'stop_unconfirmed', error: 'Inspect the owning process.' });
    expect(published).toEqual([]);
    expect(store.get(ACCOUNT_SCOPE, 'finite')).toBe(uncertain);
    expect(store.get(ACCOUNT_SCOPE, 'finite')).toMatchObject({ state: 'accepted',
      observation: { kind: 'stop_unconfirmed', code: 'stop_unconfirmed' } });
    if (state === 'succeeded') store.succeed('finite', {});
    else store.cancel('finite');
    expect(store.get(ACCOUNT_SCOPE, 'finite')).toMatchObject({ state });
    expect(store.get(ACCOUNT_SCOPE, 'finite')).not.toHaveProperty('observation');
    expect(store.get(ACCOUNT_SCOPE, 'finite')).not.toHaveProperty('error');
  });
  it('keeps revisions monotonic, terminalizes once, and scopes get/list', () => {
    let now = 1_000;
    const store = createActionOperationStore({ now: () => now });
    const accepted = store.create({
      operationId: 'operation-1',
      actionId: 'session.fork',
      scope: { ...ACCOUNT_SCOPE, sessionId: 'session-1' },
      title: 'Fork session',
      cancellation: 'unsupported',
      inputIdentity: '{}',
    });

    expect(accepted).toMatchObject({ state: 'accepted', revision: 1, createdAt: 1_000 });
    expect(store.get(ACCOUNT_SCOPE, 'operation-1')).toEqual(accepted);
    expect(store.get({ accountId: 'account-2', machineId: 'machine-1' }, 'operation-1')).toBeNull();
    expect(store.list({ ...ACCOUNT_SCOPE, sessionId: 'session-2' }).items).toEqual([]);

    now = 1_100;
    const running = store.markRunning('operation-1');
    expect(running).toMatchObject({ state: 'running', revision: 2, startedAt: 1_100 });

    now = 1_200;
    const succeeded = store.succeed('operation-1', { childSessionId: 'session-2' });
    expect(succeeded).toMatchObject({ state: 'succeeded', revision: 3, settledAt: 1_200 });
    now = 1_300;
    expect(store.fail('operation-1', { errorCode: 'late', error: 'late' })).toEqual(succeeded);
    expect(store.markRunning('operation-1')).toEqual(succeeded);

    expect(store.list(ACCOUNT_SCOPE).items[0]).not.toHaveProperty('result');
    expect(store.get(ACCOUNT_SCOPE, 'operation-1')).toEqual(succeeded);
  });

  it('has no polling observation API', () => {
    expect(createActionOperationStore()).not.toHaveProperty('wait');
  });

  it('retains active rows and only the newest 50 settled rows within 24 hours', () => {
    let now = 100_000_000;
    const store = createActionOperationStore({ now: () => now });

    store.create({
      operationId: 'active-old',
      actionId: 'session.fork',
      scope: ACCOUNT_SCOPE,
      title: 'Active',
      cancellation: 'unsupported',
      inputIdentity: '{}',
    });

    for (let index = 0; index < 52; index += 1) {
      const operationId = `settled-${index}`;
      store.create({
        operationId,
        actionId: 'session.fork',
        scope: ACCOUNT_SCOPE,
        title: `Settled ${index}`,
        cancellation: 'unsupported',
        inputIdentity: '{}',
      });
      store.markRunning(operationId);
      now += 1;
      store.succeed(operationId, { index });
    }

    const bounded = store.list(ACCOUNT_SCOPE).items;
    expect(bounded).toHaveLength(51);
    expect(bounded[0]).toMatchObject({ operationId: 'active-old', state: 'accepted' });
    expect(bounded.some((item) => item.operationId === 'settled-0')).toBe(false);
    expect(bounded.some((item) => item.operationId === 'settled-1')).toBe(false);

    now += 24 * 60 * 60 * 1_000 + 1;
    expect(store.list(ACCOUNT_SCOPE).items).toEqual([
      expect.objectContaining({ operationId: 'active-old', state: 'accepted' }),
    ]);
  });
});
