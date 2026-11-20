import type { BackupOutcomeEventV1 } from '@happier-dev/protocol/plugins/events/machineServiceObservationV1';
import { canAdvanceActionOperationSnapshotV1, canResumeDeploymentTeardownOperationV1, ActionOperationFailureV1ReadSchema,
  ActionOperationSnapshotV1Schema, projectActionOperationListSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type {
  ActionOperationDomainRefV1,
  ActionOperationFailureV1,
  ActionOperationProgressV1,
  ActionOperationSnapshotV1,
  ActionOperationStateV1,
} from '@happier-dev/protocol/actions';
import type { ActionOperationListV2Request } from '@happier-dev/protocol/actions/operations/v1';

import type { ActionOperationQueryScope, ActionOperationScope, DeploymentTokenOperationOrigin, ManagedCreationContinuationResult } from './actionOperationTypes';
import { MANAGED_ACQUIRE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { RequesterWorkAttributionV1Schema, type RequesterWorkAttributionV1 } from '@happier-dev/protocol/machines/requesterWorkAttributionV1';
import type { LiveWorkCategoryV1, LiveWorkItemV1, LiveWorkInventoryV1, LiveWorkListenerV1 } from '@/daemon/lifecycle/managedActivity';
import { isDeepStrictEqual } from 'node:util';
import { ActionOperationCredentialUseV1Schema, isActionOutcomeUnknownErrorCodeV1, type ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentTargetLinkProvisionedResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentBackupActionInputSchemasV1, type DeploymentBackupActionInputV1, type DeploymentBackupTargetV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DeploymentBackupRestoreInputV1Schema, type DeploymentBackupRestoreInputV1 } from '@happier-dev/protocol/deployments/deploymentBackupRestoreV1';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_TEARDOWN_ACTION_ID_V1, DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1, DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, isDeploymentBackupActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { ProjectOpenReceiptPersistenceError, requiresActionOperationReceiptPersistence, type ProjectOpenReceiptPersistence } from './projectOpenReceiptPersistence';
import { MACHINE_REACHABILITY_CONFIGURE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/reachability/actionIdsV1';
import { isDeploymentBackupEvidenceActionIdV1, isDeploymentTargetLinkActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { logger } from '@/ui/logger';

type RetainedTeardownExecution = Readonly<{
  execute: import('./actionOperationTypes').HostActionOperationExecute;
  resume?: import('./actionOperationTypes').HostActionOperationExecute;
}>;

export type DeploymentBackupOperationTarget = DeploymentBackupTargetV1;
export type DeploymentBackupOperation = Readonly<{
  snapshot: ActionOperationSnapshotV1;
  input: DeploymentBackupActionInputV1 | DeploymentBackupRestoreInputV1;
}>;

function backupTargetKey(scope: ActionOperationQueryScope, target: DeploymentBackupOperationTarget): string {
  // Retained backups belong to this Environment target across deployment generations.
  // The original generation remains in the authored input, never in the lookup scope.
  return JSON.stringify([scope.accountId, scope.machineId, target.serverId, target.environmentId,
    target.machineId, target.installationId, target.targetLinkId]);
}

export type RetainedInvocationInput = Readonly<{ inputIdentity: string; preparedInput?: string }>;

function readPreparedInput(input: RetainedInvocationInput): unknown {
  // Older retained records used one value for both comparison and execution.
  try { return JSON.parse(input.preparedInput ?? input.inputIdentity); }
  catch { return undefined; }
}

function readBackupInput(actionId: string, metadata: RetainedInvocationInput): DeploymentBackupOperation['input'] | undefined {
  if (!isDeploymentBackupActionIdV1(actionId) && actionId !== DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1) return undefined;
  const input = readPreparedInput(metadata);
  const parsed = actionId === DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1
    ? DeploymentBackupRestoreInputV1Schema.safeParse(input)
    : DeploymentBackupActionInputSchemasV1[actionId].safeParse(input);
  if (!parsed.success) return undefined;
  if ('retention' in parsed.data) Object.freeze(parsed.data.retention);
  return Object.freeze(parsed.data);
}

const SETTLED_RETENTION_LIMIT = 50;
const SETTLED_RETENTION_MS = 24 * 60 * 60 * 1_000;

const TERMINAL_STATES = new Set<ActionOperationStateV1>(['succeeded', 'failed', 'cancelled']);

function retainsReturnedRecoveryResult(actionId: string): boolean {
  return isDeploymentTargetLinkActionIdV1(actionId) || actionId === MACHINE_REACHABILITY_CONFIGURE_ACTION_ID_V1;
}

type CreateActionOperationInput = Readonly<{
  operationId: string;
  actionId: string;
  originRunId?: string;
  scope: ActionOperationScope;
  title: string;
  requestId?: string;
  cancellation: ActionOperationSnapshotV1['cancellation'];
  domainRef?: ActionOperationSnapshotV1['domainRef'];
  inputIdentity: string;
  preparedInput?: string;
  deploymentChildIdentity?: string;
  deploymentTokenOrigin?: DeploymentTokenOperationOrigin;
  requesterWorkAttributionV1?: RequesterWorkAttributionV1;
}>;

type ListActionOperationsInput = ActionOperationQueryScope & Readonly<{
  states?: readonly ActionOperationStateV1[];
  cursor?: string;
  requestIdentity?: ActionOperationListV2Request['requestIdentity'];
  actorAccountId?: ActionOperationListV2Request['actorAccountId'];
  createdAtFromMs?: ActionOperationListV2Request['createdAtFromMs'];
  createdAtToMs?: ActionOperationListV2Request['createdAtToMs'];
  /** Safe native projection; callers cannot manufacture outcomes from history. */
  machineOutcomes?: true;
}>;

function isTerminal(snapshot: ActionOperationSnapshotV1): boolean {
  return TERMINAL_STATES.has(snapshot.state);
}

function materialCategory(snapshot: ActionOperationSnapshotV1): LiveWorkCategoryV1 | null {
  if (snapshot.domainRef?.kind === 'projectCommand') {
    return snapshot.domainRef.purpose === 'setup' || snapshot.domainRef.purpose === 'teardown' ? 'setup' : 'finite';
  }
  if (snapshot.domainRef?.kind === 'handoff' || snapshot.actionId.startsWith('session.handoff')) return 'handoff';
  if (snapshot.actionId.startsWith('workspace.sync.')) return 'sync';
  if (snapshot.actionId === 'daemon.filesystem.upload' || snapshot.actionId === 'daemon.filesystem.download') return 'transfer';
  if (snapshot.actionId === 'projects.script.run' || snapshot.actionId === 'projects.compute.exec') return 'finite';
  if (snapshot.actionId === 'machines.managed.power.set' || snapshot.actionId === 'machines.managed.delete') return 'finite';
  if (snapshot.actionId === 'projects.prepare' || snapshot.actionId === 'session.spawn_new' || snapshot.actionId === 'session.fork'
    || snapshot.actionId === 'machines.managed.acquire' || snapshot.domainRef?.kind === 'systemTask') return 'setup';
  if (snapshot.actionId === 'projects.service.relocate' || snapshot.actionId === 'localServices.launcher.start') return 'service';
  return null;
}

function inScope(snapshot: ActionOperationSnapshotV1, scope: ActionOperationQueryScope): boolean {
  return snapshot.scope.accountId === scope.accountId
    && snapshot.scope.machineId === scope.machineId
    && (scope.sessionId === undefined || snapshot.scope.sessionId === scope.sessionId);
}

function freezeSnapshot(snapshot: ActionOperationSnapshotV1): ActionOperationSnapshotV1 {
  return Object.freeze({
    ...snapshot,
    scope: Object.freeze({ ...snapshot.scope }),
    ...(snapshot.progress ? { progress: Object.freeze({ ...snapshot.progress }) } : {}),
    ...(snapshot.error ? { error: Object.freeze({ ...snapshot.error }) } : {}),
    ...(snapshot.domainRef ? { domainRef: Object.freeze({ ...snapshot.domainRef }) } : {}),
    ...(snapshot.observation ? { observation: Object.freeze({ ...snapshot.observation }) } : {}),
    ...(snapshot.setupReview ? { setupReview: Object.freeze({ ...snapshot.setupReview }) } : {}),
  });
}

export function createActionOperationStore(options?: Readonly<{
  now?: () => number;
  settledRetentionLimit?: number;
  settledRetentionMs?: number;
  onSnapshot?: (snapshot: ActionOperationSnapshotV1) => void;
  onBackupOutcome?: (outcome: BackupOutcomeEventV1, scope: ActionOperationScope) => void;
  /** Undefined is an in-memory host; null means the installed host could not open its receipts. */
  projectOpenReceiptPersistence?: ProjectOpenReceiptPersistence | null;
}>) {
  const now = options?.now ?? Date.now;
  // Wall-clock corrections cannot reverse the schema-ordered lifecycle facts.
  const lifecycleTime = (current: ActionOperationSnapshotV1): number =>
    Math.max(current.startedAt ?? current.createdAt, now());
  const settledRetentionLimit = options?.settledRetentionLimit ?? SETTLED_RETENTION_LIMIT;
  const settledRetentionMs = options?.settledRetentionMs ?? SETTLED_RETENTION_MS;
  const snapshots = new Map<string, ActionOperationSnapshotV1>();
  const projectOpenReceiptPersistence = options?.projectOpenReceiptPersistence;
  const assertReceiptHistoryReadable = (): void => {
    if (projectOpenReceiptPersistence === null) {
      throw new RpcError('Action operation receipt storage is unavailable on this Machine', 'action_operation_unavailable');
    }
  };
  const invocationMetadata = new Map<string, RetainedInvocationInput & Readonly<{ deploymentChildIdentity?: string;
    deploymentTokenOrigin?: DeploymentTokenOperationOrigin; requesterWorkAttributionV1?: RequesterWorkAttributionV1;
    backupInput?: DeploymentBackupOperation['input']; backupTargetKey?: string; retainedTeardown?: RetainedTeardownExecution;
    creationContinuationResult?: ManagedCreationContinuationResult }>>();
  // Derived from this owner's authored invocation input; imported history cannot
  // manufacture backup or restore evidence. No separate persisted receipt ledger.
  const backupOperationIds = new Map<string, Set<string>>();
  const unindexBackup = (operationId: string): void => {
    const key = invocationMetadata.get(operationId)?.backupTargetKey;
    if (key === undefined) return;
    const ids = backupOperationIds.get(key);
    ids?.delete(operationId);
    if (ids?.size === 0) backupOperationIds.delete(key);
  };
  const removeSnapshot = (operationId: string): void => {
    if (requiresActionOperationReceiptPersistence(snapshots.get(operationId)?.actionId)) projectOpenReceiptPersistence?.remove(operationId);
    unindexBackup(operationId);
    snapshots.delete(operationId);
    invocationMetadata.delete(operationId);
  };
  const retainInvocation = (snapshot: ActionOperationSnapshotV1,
    metadata: NonNullable<ReturnType<typeof invocationMetadata.get>>): void => {
    unindexBackup(snapshot.operationId);
    const backupInput = readBackupInput(snapshot.actionId, metadata);
    const key = backupInput ? backupTargetKey(snapshot.scope, backupInput) : undefined;
    invocationMetadata.set(snapshot.operationId, { ...metadata, backupInput, backupTargetKey: key });
    if (key !== undefined) {
      const ids = backupOperationIds.get(key) ?? new Set<string>();
      ids.add(snapshot.operationId);
      backupOperationIds.set(key, ids);
    }
  };
  const subscribers = new Set<LiveWorkListenerV1>();
  const projectLiveWork = (snapshot: ActionOperationSnapshotV1): LiveWorkItemV1 | null => {
    // Passive intent waits have no native custody until their owner advances phase.
    if ((snapshot.actionId === 'machines.managed.power.set' || snapshot.actionId === 'machines.managed.delete')
      && !isTerminal(snapshot) && !snapshot.observation && snapshot.progress?.kind === 'phase'
      && (snapshot.progress.phase === 'managed.intent.waiting-idle'
        || snapshot.progress.phase === 'managed.intent.waiting-deadline')) return null;
    const category = materialCategory(snapshot);
    return {
      category: category ?? 'setup',
      ownerRef: snapshot.operationId,
      actionOperationId: snapshot.operationId,
      attribution: invocationMetadata.get(snapshot.operationId)?.requesterWorkAttributionV1 ?? { kind: 'unknown' },
      state: isTerminal(snapshot) ? 'settled' : snapshot.observation || category === null ? 'unknown' : 'active',
      ...(snapshot.domainRef?.kind === 'projectCommand' && snapshot.domainRef.terminalId
        ? { associatedTerminal: snapshot.domainRef.terminalId } : {}),
    };
  };
  const notifySubscribers = (change?: 'observation'): void => {
    for (const subscriber of subscribers) {
      try { subscriber(change); } catch { /* Observation cannot change execution custody. */ }
    }
  };

  const projectBackupOutcome = (snapshot: ActionOperationSnapshotV1): BackupOutcomeEventV1 | null => {
    const backup = invocationMetadata.get(snapshot.operationId)?.backupInput;
    if (snapshot.actionId !== DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1 || !backup
      || snapshot.state !== 'succeeded' && snapshot.state !== 'failed' || snapshot.settledAt === undefined) return null;
    return { kind: 'backup', serverId: backup.serverId, machineId: snapshot.scope.machineId,
      environmentId: backup.environmentId, operationId: snapshot.operationId, state: snapshot.state,
      ...(snapshot.originRunId ? { originRunId: snapshot.originRunId } : {}),
      occurredAt: snapshot.settledAt, errorCode: snapshot.error?.errorCode ?? null };
  };

  const emitBackupOutcome = (snapshot: ActionOperationSnapshotV1, previous?: ActionOperationSnapshotV1): void => {
    if (!previous || isTerminal(previous)) return;
    const outcome = projectBackupOutcome(snapshot);
    if (outcome) {
      try { options?.onBackupOutcome?.(outcome, snapshot.scope); }
      catch { /* Observation cannot change the retained backup result. */ }
    }
  };

  const notify = (snapshot: ActionOperationSnapshotV1, previous?: ActionOperationSnapshotV1): void => {
    const metadata = invocationMetadata.get(snapshot.operationId);
    // Recovery needs admission, returned resource facts and terminal settlement, not each progress revision.
    const transientProgressOnly = previous !== undefined && !isTerminal(snapshot)
      && (isDeploymentBackupEvidenceActionIdV1(snapshot.actionId)
        || retainsReturnedRecoveryResult(snapshot.actionId) && isDeepStrictEqual(snapshot.result, previous.result));
    if (!transientProgressOnly && requiresActionOperationReceiptPersistence(snapshot.actionId) && metadata && projectOpenReceiptPersistence !== undefined) {
      try {
        if (!projectOpenReceiptPersistence) throw new ProjectOpenReceiptPersistenceError(false);
        projectOpenReceiptPersistence.save({ version: 1, snapshot, inputIdentity: metadata.inputIdentity,
          ...(metadata.preparedInput !== undefined ? { preparedInput: metadata.preparedInput } : {}),
          ...(metadata.deploymentChildIdentity ? { deploymentChildIdentity: metadata.deploymentChildIdentity } : {}),
          ...(metadata.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: metadata.requesterWorkAttributionV1 } : {}) });
      } catch {
        const effectAttempted = snapshot.state !== 'accepted' && previous?.state !== 'accepted';
        if (!effectAttempted) removeSnapshot(snapshot.operationId);
        throw new ProjectOpenReceiptPersistenceError(effectAttempted);
      }
    }
    const before = previous ? projectLiveWork(previous) : null;
    const after = projectLiveWork(snapshot);
    const settled = (item: LiveWorkItemV1 | null) => item === null || item.state === 'settled';
    // Snapshot revisions and progress are not work edges. Still notify ordinary
    // observers, and let facts readers observe a changed settled receipt.
    const change = isDeepStrictEqual(before, after) || (settled(before) && settled(after)) ? 'observation' : undefined;
    try {
      if (!invocationMetadata.get(snapshot.operationId)?.deploymentChildIdentity) options?.onSnapshot?.(snapshot);
    } catch {
      // Push is a recoverable projection. It must never change the historical
      // Action result; connection-time list reconciliation repairs a miss.
    }
    emitBackupOutcome(snapshot, previous);
    notifySubscribers(change);
  };

  // Native creation identity and backup recovery evidence cannot be reconstructed
  // from activity history after expiry: retain them across history pruning.
  const retainsRecoveryEvidence = (snapshot: ActionOperationSnapshotV1): boolean =>
    (snapshot.state === 'succeeded' && isDeploymentBackupEvidenceActionIdV1(snapshot.actionId)
      && invocationMetadata.get(snapshot.operationId)?.backupInput !== undefined)
    || (isDeploymentTargetLinkActionIdV1(snapshot.actionId) && snapshot.domainRef?.kind === 'deploymentTargetLink'
      && snapshot.domainRef.purpose === 'create'
      && (isActionOutcomeUnknownErrorCodeV1(snapshot.error?.errorCode)
        || DeploymentTargetLinkProvisionedResultV1Schema.safeParse(snapshot.result).success));

  const prune = (): void => {
    const cutoff = now() - settledRetentionMs;
    const retainedSettled = [...snapshots.values()]
      .filter(snapshot => isTerminal(snapshot) && !retainsRecoveryEvidence(snapshot))
      .sort((left, right) => (right.settledAt ?? 0) - (left.settledAt ?? 0));
    const retainedIds = new Set(
      retainedSettled
        .filter((snapshot) => (snapshot.settledAt ?? 0) >= cutoff)
        .slice(0, settledRetentionLimit)
        .map((snapshot) => snapshot.operationId),
    );
    let removed = false;
    for (const snapshot of retainedSettled) {
      if (!retainedIds.has(snapshot.operationId)) {
        removeSnapshot(snapshot.operationId);
        removed = true;
      }
    }
    if (removed) notifySubscribers('observation');
  };

  const findByRequestIdentity = (
    scope: ActionOperationQueryScope,
    actionId: string,
    requestId: string,
  ): ActionOperationSnapshotV1 | null => {
    // Explicit retryable creation attempts retain earlier terminal receipts.
    // Join or replay the newest receipt for that unchanged logical request.
    return [...snapshots.values()].reverse().find((snapshot) => (
      inScope(snapshot, scope)
      && snapshot.actionId === actionId
      && snapshot.requestId === requestId
    )) ?? null;
  };

  const mutate = (
    operationId: string,
    update: (current: ActionOperationSnapshotV1) => ActionOperationSnapshotV1,
  ): ActionOperationSnapshotV1 | null => {
    const current = snapshots.get(operationId);
    if (!current) return null;
    if (isTerminal(current)) return current;
    const updated = update(current);
    if (updated === current) return current;
    const next = freezeSnapshot(updated);
    snapshots.set(operationId, next);
    notify(next, current);
    if (isTerminal(next)) prune();
    return next;
  };

  // A coordinator cannot resume after host loss. Keep the exact settled
  // result, or settle its lost coordinator as typed uncertainty, never replay it.
  for (const receipt of projectOpenReceiptPersistence?.retained ?? []) {
    const prior = receipt.snapshot;
    const { observation: _observation, setupReview: _review, result: _result, ...remaining } = prior;
    const settledAt = Math.max(prior.startedAt ?? prior.createdAt, now());
    const snapshot = isTerminal(prior) ? freezeSnapshot(prior) : freezeSnapshot(ActionOperationSnapshotV1Schema.parse({
      ...remaining,
      // Returned resource and recovery facts remain useful after the coordinator is lost.
      ...(retainsReturnedRecoveryResult(prior.actionId) && prior.result !== undefined ? { result: prior.result } : {}),
      revision: prior.revision + 1, state: 'failed', cancellation: 'unsupported',
      startedAt: prior.startedAt ?? settledAt, settledAt,
      error: { errorCode: 'action_outcome_unknown', error: 'The Machine restarted before the Action operation settled',
        effectAttempted: true, ...(prior.error?.failureCause ? { failureCause: prior.error.failureCause } : {}) },
    }));
    snapshots.set(snapshot.operationId, snapshot);
    retainInvocation(snapshot, { inputIdentity: receipt.inputIdentity,
      ...(receipt.preparedInput !== undefined ? { preparedInput: receipt.preparedInput } : {}),
      ...(receipt.deploymentChildIdentity ? { deploymentChildIdentity: receipt.deploymentChildIdentity } : {}),
      ...(receipt.requesterWorkAttributionV1 ? { requesterWorkAttributionV1: receipt.requesterWorkAttributionV1 } : {}) });
    if (!isTerminal(prior)) {
      try {
        projectOpenReceiptPersistence?.save({ ...receipt, snapshot });
        emitBackupOutcome(snapshot, prior);
      }
      catch { logger.warn('Could not retain the restarted Action outcome; new recovery operations require a successful receipt write'); }
    }
  }
  prune();

  return Object.freeze({
    /** Private daemon read of this owner's real custody, independent of the public Account projection. */
    readLiveWork(): Omit<LiveWorkInventoryV1, 'idleSince'> {
      const items = [...snapshots.values()].flatMap(snapshot => {
        const item = projectLiveWork(snapshot);
        return item ? [item] : [];
      });
      return { items, coverage: 'complete' };
    },
    /** Host observers re-read through get(scope, id), preserving the canonical scope decision. */
    subscribe(listener: LiveWorkListenerV1): () => void {
      subscribers.add(listener);
      return () => { subscribers.delete(listener); };
    },
    project(input: ActionOperationSnapshotV1): void {
      const incoming = ActionOperationSnapshotV1Schema.parse(input);
      const current = snapshots.get(incoming.operationId);
      if (current && !canAdvanceActionOperationSnapshotV1(current, incoming)) return;
      const snapshot = freezeSnapshot(incoming);
      snapshots.set(snapshot.operationId, snapshot);
      prune();
      // Domain reads can include durable history beyond host retention. Do not
      // publish a receipt that was discarded here and will be read again next time.
      if (snapshots.get(snapshot.operationId) === snapshot) notify(snapshot, current);
    },

    removeOwnerProjections(actionIds: readonly string[], scope?: ActionOperationQueryScope, operationId?: string): void {
      let removed = false;
      let removedWork = false;
      for (const snapshot of snapshots.values()) {
        if (actionIds.includes(snapshot.actionId) && (!scope || inScope(snapshot, scope))
          && (operationId === undefined || snapshot.operationId === operationId)) {
          const work = projectLiveWork(snapshot);
          removedWork ||= work !== null && work.state !== 'settled';
          removeSnapshot(snapshot.operationId);
          removed = true;
        }
      }
      if (removed) notifySubscribers(removedWork ? undefined : 'observation');
    },

    reconcileOwner(scope: ActionOperationQueryScope, actionIds: readonly string[], incoming: readonly ActionOperationSnapshotV1[]): void {
      let removed = false;
      let removedWork = false;
      const retainedIds = new Set(incoming.map((snapshot) => snapshot.operationId));
      for (const snapshot of snapshots.values()) {
        if (inScope(snapshot, scope) && actionIds.includes(snapshot.actionId) && !retainedIds.has(snapshot.operationId)) {
          const work = projectLiveWork(snapshot);
          removedWork ||= work !== null && work.state !== 'settled';
          removeSnapshot(snapshot.operationId);
          removed = true;
        }
      }
      if (removed) notifySubscribers(removedWork ? undefined : 'observation');
    },

    /** Host-private installed work facts, including preparation before a terminal exists. */
    readActiveProjectCommands(): readonly Extract<ActionOperationDomainRefV1, { kind: 'projectCommand' }>[] {
      return [...snapshots.values()].flatMap(snapshot => !isTerminal(snapshot) && snapshot.domainRef?.kind === 'projectCommand'
        ? [snapshot.domainRef] : []);
    },

    create(input: CreateActionOperationInput): ActionOperationSnapshotV1 {
      if (snapshots.has(input.operationId)) {
        throw new Error(`Duplicate action operation id: ${input.operationId}`);
      }
      const attribution = input.requesterWorkAttributionV1
        ? Object.freeze(RequesterWorkAttributionV1Schema.parse(input.requesterWorkAttributionV1)) : undefined;
      if (attribution && (attribution.accountId !== input.scope.accountId || attribution.machineId !== input.scope.machineId)) {
        throw new Error('action_operation_attribution_scope_mismatch');
      }
      const snapshot = freezeSnapshot({
        version: 1,
        operationId: input.operationId,
        revision: 1,
        actionId: input.actionId,
        ...(input.originRunId !== undefined ? { originRunId: input.originRunId } : {}),
        state: 'accepted',
        scope: input.scope,
        title: input.title,
        ...(input.requestId ? { requestId: input.requestId } : {}),
        createdAt: now(),
        cancellation: input.cancellation,
        ...(input.domainRef ? { domainRef: input.domainRef } : {}),
      });
      snapshots.set(input.operationId, snapshot);
      retainInvocation(snapshot, { inputIdentity: input.inputIdentity,
        ...(input.preparedInput !== undefined ? { preparedInput: input.preparedInput } : {}),
        ...(input.deploymentChildIdentity ? { deploymentChildIdentity: input.deploymentChildIdentity } : {}),
        ...(input.deploymentTokenOrigin ? { deploymentTokenOrigin: Object.freeze({ ...input.deploymentTokenOrigin }) } : {}),
        ...(attribution ? { requesterWorkAttributionV1: attribution } : {}) });
      notify(snapshot);
      prune();
      return snapshot;
    },

    /** Only the canonical declared terminal re-entry may reopen the same operation. */
    reenter(operationId: string): ActionOperationSnapshotV1 | null {
      const current = snapshots.get(operationId);
      if (!current || !canResumeDeploymentTeardownOperationV1(current)) return current ?? null;
      const { settledAt: _settled, error: _error, result: _result, observation: _observation, ...retained } = current;
      const next = freezeSnapshot({ ...retained, state: 'running', revision: current.revision + 1,
        startedAt: current.startedAt ?? lifecycleTime(current) });
      snapshots.set(operationId, next);
      notify(next, current);
      return next;
    },

    retainTeardownExecution(scope: ActionOperationQueryScope, operationId: string, execution: RetainedTeardownExecution): void {
      const snapshot = snapshots.get(operationId), metadata = invocationMetadata.get(operationId);
      if (snapshot && inScope(snapshot, scope) && snapshot.actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1
        && metadata && !metadata.retainedTeardown) retainInvocation(snapshot, { ...metadata, retainedTeardown: execution });
    },
    retainCreationContinuationResult(scope: ActionOperationQueryScope, operationId: string, result: ManagedCreationContinuationResult): void {
      const snapshot = snapshots.get(operationId), metadata = invocationMetadata.get(operationId);
      if (snapshot && inScope(snapshot, scope) && snapshot.actionId === MANAGED_ACQUIRE_ACTION_ID_V1 && metadata) {
        retainInvocation(snapshot, { ...metadata, creationContinuationResult: result });
      }
    },
    readCreationContinuationResult(scope: ActionOperationQueryScope, operationId: string): ManagedCreationContinuationResult | undefined {
      const snapshot = snapshots.get(operationId);
      return snapshot && inScope(snapshot, scope) && snapshot.actionId === MANAGED_ACQUIRE_ACTION_ID_V1
        ? invocationMetadata.get(operationId)?.creationContinuationResult : undefined;
    },
    readRetainedTeardownExecution(scope: ActionOperationQueryScope, operationId: string): RetainedTeardownExecution | undefined {
      const snapshot = snapshots.get(operationId);
      return snapshot && inScope(snapshot, scope) && snapshot.actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1
        && snapshot.domainRef?.kind === 'deployment' ? invocationMetadata.get(operationId)?.retainedTeardown : undefined;
    },

    markRunning(operationId: string): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => current.state === 'running' ? current : ({
        ...current,
        revision: current.revision + 1,
        state: 'running',
        startedAt: current.startedAt ?? lifecycleTime(current),
      }));
    },

    hasMatchingDeploymentChildIdentity(operationId: string, identity: string | undefined): boolean {
      return invocationMetadata.get(operationId)?.deploymentChildIdentity === identity;
    },

    hasMatchingDeploymentTokenOrigin(operationId: string, origin: DeploymentTokenOperationOrigin | undefined): boolean {
      return isDeepStrictEqual(invocationMetadata.get(operationId)?.deploymentTokenOrigin, origin);
    },

    /** Used only after the Action declaration admits a newly reviewed re-entry. */
    replaceInputIdentity(operationId: string, inputIdentity: string, preparedInput?: string): void {
      const current = snapshots.get(operationId), metadata = invocationMetadata.get(operationId);
      if (!current || isTerminal(current) || !metadata) throw new Error('action_operation_unavailable');
      retainInvocation(current, { ...metadata, inputIdentity, preparedInput });
    },

    updateProgress(operationId: string, progress: ActionOperationProgressV1): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => {
        // Approval/SSH overlays report their own phase without replacing the
        // execution owner's observed steps. An explicit array replaces them.
        const next = progress.steps === undefined && current.progress?.steps !== undefined
          ? { ...progress, steps: current.progress.steps } : progress;
        return isDeepStrictEqual(current.progress, next) ? current : {
          ...current, revision: current.revision + 1, progress: next,
        };
      });
    },

    updateDomainRef(operationId: string, domainRef: ActionOperationDomainRefV1): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => isDeepStrictEqual(current.domainRef, domainRef) ? current : ({
        ...current,
        revision: current.revision + 1,
        domainRef,
      }));
    },

    updateCancellation(operationId: string, cancellation: ActionOperationSnapshotV1['cancellation']): ActionOperationSnapshotV1 | null {
      return mutate(operationId, current => current.cancellation === cancellation ? current
        : { ...current, revision: current.revision + 1, cancellation });
    },

    updateObservation(operationId: string, observation: NonNullable<ActionOperationSnapshotV1['observation']> | null,
      result?: unknown, error?: ActionOperationFailureV1): ActionOperationSnapshotV1 | null {
      // Omission retains evidence; explicit undefined clears it on admitted resume.
      const replaceResult = arguments.length > 2;
      const replaceError = arguments.length > 3;
      return mutate(operationId, (current) => {
        const nextError = observation ? replaceError ? error : current.error : undefined;
        if (isDeepStrictEqual(current.observation, observation ?? undefined)
          && (!replaceResult || isDeepStrictEqual(current.result, result))
          && isDeepStrictEqual(current.error, nextError)) return current;
        const { observation: _observation, result: previousResult, error: _error, ...retained } = current;
        const nextResult = replaceResult ? result : previousResult;
        return { ...retained, revision: current.revision + 1, ...(observation ? { observation } : {}),
          ...(nextResult === undefined ? {} : { result: nextResult }), ...(nextError ? { error: nextError } : {}) };
      });
    },

    updateSetupReview(operationId: string, setupReview: ActionOperationSnapshotV1['setupReview']): ActionOperationSnapshotV1 | null {
      return mutate(operationId, current => {
        if (isDeepStrictEqual(current.setupReview, setupReview)) return current;
        const { setupReview: _review, ...live } = current;
        return { ...live, revision: current.revision + 1, ...(setupReview ? { setupReview } : {}) };
      });
    },

    /** Retain exact host result metadata before terminal or uncertain owner projection. */
    updateCredentialUses(operationId: string, uses: readonly ActionOperationCredentialUseV1[]): ActionOperationSnapshotV1 | null {
      const operationCredentialUses = uses.map(use => ActionOperationCredentialUseV1Schema.parse(use));
      return mutate(operationId, current => isDeepStrictEqual(current.operationCredentialUses, operationCredentialUses) ? current : ({
        ...current,
        revision: current.revision + 1,
        operationCredentialUses,
      }));
    },

    succeed(operationId: string, result: unknown): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => {
        const settledAt = lifecycleTime(current);
        const { observation: _observation, setupReview: _review, error: _error, ...settled } = current;
        return {
          ...settled,
          revision: current.revision + 1,
          state: 'succeeded',
          startedAt: current.startedAt ?? settledAt,
          settledAt,
          result,
        };
      });
    },

    fail(operationId: string, error: ActionOperationFailureV1, result?: unknown): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => {
        const failure = ActionOperationFailureV1ReadSchema.parse(error);
        const settledAt = lifecycleTime(current);
        const { observation: _observation, setupReview: _review, ...settled } = current;
        return {
          ...settled,
          revision: current.revision + 1,
          state: 'failed',
          startedAt: current.startedAt ?? settledAt,
          settledAt,
          error: failure,
          ...(result === undefined ? {} : { result }),
        };
      });
    },

    cancel(operationId: string, result?: unknown): ActionOperationSnapshotV1 | null {
      return mutate(operationId, (current) => {
        const settledAt = lifecycleTime(current);
        const { observation: _observation, setupReview: _review, error: _error, ...settled } = current;
        return {
          ...settled,
          revision: current.revision + 1,
          state: 'cancelled',
          startedAt: current.startedAt ?? settledAt,
          settledAt,
          ...(result === undefined ? {} : { result }),
        };
      });
    },

    get(scope: ActionOperationQueryScope, operationId: string): ActionOperationSnapshotV1 | null {
      prune();
      const snapshot = snapshots.get(operationId);
      if (!snapshot) assertReceiptHistoryReadable();
      return snapshot && inScope(snapshot, scope) ? snapshot : null;
    },

    findByRequestIdentity(
      scope: ActionOperationQueryScope,
      actionId: string,
      requestId: string,
    ): ActionOperationSnapshotV1 | null {
      prune();
      return findByRequestIdentity(scope, actionId, requestId);
    },

    hasMatchingInputIdentity(operationId: string, inputIdentity: string, legacyInputIdentity = inputIdentity): boolean {
      const metadata = invocationMetadata.get(operationId);
      return metadata?.inputIdentity === (metadata?.preparedInput === undefined ? legacyInputIdentity : inputIdentity);
    },
    hasMatchingPreparedInputIdentity(operationId: string, inputIdentity: string): boolean {
      const metadata = invocationMetadata.get(operationId);
      return (metadata?.preparedInput ?? metadata?.inputIdentity) === inputIdentity;
    },
    /** Strict local acceptance order, independent of wall-clock ties/corrections.
     * Imported snapshots have no local invocation and cannot prove new admission.
     */
    wasInvocationAcceptedAfter(operationId: string, precedingOperationId: string): boolean {
      if (operationId === precedingOperationId || !invocationMetadata.has(operationId)
        || !invocationMetadata.has(precedingOperationId)) return false;
      let preceding = false;
      for (const id of invocationMetadata.keys()) {
        if (id === operationId) return preceding;
        if (id === precedingOperationId) preceding = true;
      }
      return false;
    },
    /** Host-only reconstruction of the exact input already held by this owner.
     * Never included in operation snapshots or RPC responses. */
    readDeploymentInvocationInput(scope: ActionOperationQueryScope, operationId: string): unknown {
      const snapshot = snapshots.get(operationId);
      const metadata = invocationMetadata.get(operationId);
      if (!snapshot || !inScope(snapshot, scope) || (snapshot.actionId !== DEPLOYMENT_DEPLOY_ACTION_ID_V1 && snapshot.actionId !== DEPLOYMENT_TEARDOWN_ACTION_ID_V1
        && snapshot.actionId !== DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1) || !metadata) return undefined;
      return readPreparedInput(metadata);
    },
    /** Exact host-only receipt read. Work is proportional to this target's
     * retained invocations, never the Machine's whole operation inventory. */
    readDeploymentBackupOperations(scope: ActionOperationQueryScope,
      target: DeploymentBackupOperationTarget): readonly DeploymentBackupOperation[] {
      assertReceiptHistoryReadable();
      const ids = backupOperationIds.get(backupTargetKey(scope, target));
      if (!ids) return [];
      const cutoff = now() - settledRetentionMs;
      const operations: DeploymentBackupOperation[] = [];
      let removed = false;
      for (const operationId of ids) {
        const snapshot = snapshots.get(operationId);
        if (!snapshot) continue;
        if (isTerminal(snapshot) && !retainsRecoveryEvidence(snapshot) && (snapshot.settledAt ?? 0) < cutoff) {
          removeSnapshot(operationId);
          removed = true;
          continue;
        }
        const input = invocationMetadata.get(operationId)?.backupInput;
        if (input && inScope(snapshot, scope)) operations.push({ snapshot, input });
      }
      if (removed) notifySubscribers('observation');
      return operations;
    },
    readRequesterWorkAttribution(operationId: string): RequesterWorkAttributionV1 | null {
      return invocationMetadata.get(operationId)?.requesterWorkAttributionV1 ?? null;
    },

    list(input: ListActionOperationsInput): Readonly<{
      items: readonly ActionOperationSnapshotV1[];
      nextCursor: string | null;
      machineOutcomes?: readonly BackupOutcomeEventV1[];
    }> {
      prune();
      assertReceiptHistoryReadable();
      const states = input.states ? new Set(input.states) : null;
      const requested = input.requestIdentity
        ? findByRequestIdentity(input, input.requestIdentity.actionId, input.requestIdentity.requestId) : null;
      const candidates = input.requestIdentity ? (requested ? [requested] : []) : [...snapshots.values()];
      const ordered = candidates
        .filter((snapshot) => inScope(snapshot, input))
        .filter((snapshot) => input.actorAccountId === undefined || snapshot.scope.accountId === input.actorAccountId)
        .filter((snapshot) => input.createdAtFromMs === undefined || snapshot.createdAt >= input.createdAtFromMs)
        .filter((snapshot) => input.createdAtToMs === undefined || snapshot.createdAt < input.createdAtToMs)
        .filter((snapshot) => !invocationMetadata.get(snapshot.operationId)?.deploymentChildIdentity)
        .filter((snapshot) => !states || states.has(snapshot.state))
        .sort((left, right) => {
          const terminalDifference = Number(isTerminal(left)) - Number(isTerminal(right));
          if (terminalDifference !== 0) return terminalDifference;
          return isTerminal(left)
            ? (right.settledAt ?? 0) - (left.settledAt ?? 0)
            : right.createdAt - left.createdAt;
        });
      const cursorIndex = input.cursor
        ? ordered.findIndex((snapshot) => snapshot.operationId === input.cursor)
        : -1;
      const page = cursorIndex >= 0 ? ordered.slice(cursorIndex + 1) : ordered;
      return {
        items: page.map((snapshot) => {
          const summary = projectActionOperationListSnapshotV1(snapshot);
          return summary === snapshot ? snapshot : freezeSnapshot(summary);
        }),
        nextCursor: null,
        ...(input.machineOutcomes ? { machineOutcomes: page.flatMap(snapshot => {
          const outcome = projectBackupOutcome(snapshot);
          return outcome ? [outcome] : [];
        }) } : {}),
      };
    },

  });
}

export type ActionOperationStore = ReturnType<typeof createActionOperationStore>;
