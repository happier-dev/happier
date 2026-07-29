import { randomUUID } from 'node:crypto';

import {
  ExternalSessionOperationResumeInputV1Schema,
  projectExternalSessionOperationProgressV1,
  type ExternalSessionOperationActionResponseV1,
  type ExternalSessionOperationRecordV1,
} from '@happier-dev/protocol';

import {
  ExternalSessionOperationClaimLostError,
  maintainExternalSessionOperationClaim,
  type ExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';
import type {
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/session/shared/spawnSessionContract';
import type {
  ExternalTakeoverFencedSpawnResult,
  ResolvedExternalTakeoverSpawn,
} from '@/api/session/external/takeover/resolveExternalTakeoverSpawnOptions';
import type {
  PersistedTakeoverAdmissionWaitRegistration,
  PersistedTakeoverAdmissionWaiter,
} from '@/daemon/spawn/persistedTakeoverAdmission';

import {
  ExternalSessionOperationRecordReadError,
  mutateExternalSessionOperationRecordAtRevision,
  readExternalSessionOperationRecord,
} from './operationRecordStore';

type TakeoverRequest = Extract<
  ExternalSessionOperationRecordV1['request'],
  { plan: 'takeover' }
>;

type PersistedTakeoverRecord = ExternalSessionOperationRecordV1 & Readonly<{
  request: TakeoverRequest & Readonly<{ targetStorageMode: 'persisted' }>;
}>;

type AdmissionReadyRecord = PersistedTakeoverRecord;

type TakeoverAdmissionActionDependencies = Readonly<{
  activeServerDir: string;
  operationExclusion: ExternalSessionOperationExclusion;
  prepareSpawn(
    record: PersistedTakeoverRecord,
    signal?: AbortSignal,
  ): Promise<ResolvedExternalTakeoverSpawn>;
  reconcileAuthority?(
    record: ExternalSessionOperationRecordV1,
  ): Promise<ExternalSessionOperationRecordV1 | null>;
  reconcileRuntimeBindingFailure?(input: Readonly<{
    sessionId: string;
    operationId: string;
    attemptId: string;
  }>): Promise<ExternalSessionOperationRecordV1 | null>;
  spawnSession(options: SpawnSessionOptions): Promise<SpawnSessionResult>;
  spawnResolvedTakeoverSession(input: Readonly<{
    resolved: ResolvedExternalTakeoverSpawn;
    options: Pick<
      SpawnSessionOptions,
      'transcriptStorage' | 'persistedTakeoverAdmission'
    >;
    signal?: AbortSignal;
    spawnSession(options: SpawnSessionOptions): Promise<SpawnSessionResult>;
  }>): Promise<ExternalTakeoverFencedSpawnResult>;
  admissionWaiter:
    & Pick<PersistedTakeoverAdmissionWaiter, 'register'>
    & Partial<Pick<
      PersistedTakeoverAdmissionWaiter,
      'isPending' | 'settle' | 'reserveRuntimeBound'
    >>;
  isHostedAdmissionAvailable(): boolean;
  publishProgress?(input: Readonly<{
    sessionId: string;
    progress: ReturnType<typeof projectExternalSessionOperationProgressV1>;
  }>): Promise<ExternalSessionOperationRecordV1 | void>;
  createAttemptId?: () => string;
  nowMs?: () => number;
  claimRenewalIntervalMs?: number;
}>;

export type ExternalSessionTakeoverAdmissionActionExecutor = Readonly<{
  resume(input: unknown): Promise<ExternalSessionOperationActionResponseV1>;
  retry(input: unknown): Promise<ExternalSessionOperationActionResponseV1>;
}>;

function failure(
  code: Extract<
    ExternalSessionOperationActionResponseV1,
    { ok: false }
  >['error']['code'],
  message: string,
): ExternalSessionOperationActionResponseV1 {
  return { ok: false, error: { code, message } };
}

function success(
  record: ExternalSessionOperationRecordV1,
): ExternalSessionOperationActionResponseV1 {
  return {
    ok: true,
    progress: projectExternalSessionOperationProgressV1(record),
  };
}

export function isExternalSessionPersistedTakeoverAdmissionReady(
  record: ExternalSessionOperationRecordV1,
): record is AdmissionReadyRecord {
  const isNormalAdmission = (
    record.status === 'awaiting_user_resume'
    && record.fence.kind === 'none'
  ) || (
      record.status === 'failed'
      && record.error?.code === 'admission_failed'
      && record.error.retryable === true
      && record.fence.kind === 'none'
      && (
        record.canonicalOwnerEvidence.transcriptAuthorityRevision === undefined
        && record.canonicalOwnerEvidence.pendingAdmissionRevision === undefined
      )
    );
  const isAuthorityReconciliation = record.status === 'failed'
    && record.error?.code === 'admission_failed'
    && record.error.retryable === true
    && record.fence.kind === 'none'
    && record.canonicalOwnerEvidence.transcriptAuthorityRevision !== undefined
    && record.canonicalOwnerEvidence.pendingAdmissionRevision !== undefined;
  const isHostedOfflineRetry = record.status === 'failed'
    && record.phase === 'spawning'
    && record.error?.code === 'spawn_failed'
    && record.error.retryable === true
    && record.retryTargetPhase === 'spawning'
    && record.currentStorageState === 'hosted'
    && record.publication === undefined
    && record.fence.kind === 'none'
    && record.bindings.targetRuntimeAttemptId !== undefined;
  return record.request.plan === 'takeover'
    && record.request.targetStorageMode === 'persisted'
    && (
      (
        record.phase === 'admitting'
        && (isNormalAdmission || isAuthorityReconciliation)
        && record.retryTargetPhase === 'admitting'
        && record.currentStorageState === 'snapshot_complete'
        && record.publication !== undefined
      )
      || isHostedOfflineRetry
    )
    && record.checkpoint.requiredItemFailures.total === 0
    && record.canonicalOwnerEvidence.disagreement === undefined;
}

function isHostedOfflineRuntimeRetry(
  record: ExternalSessionOperationRecordV1,
): record is AdmissionReadyRecord {
  return isExternalSessionPersistedTakeoverAdmissionReady(record)
    && record.status === 'failed'
    && record.phase === 'spawning'
    && record.currentStorageState === 'hosted'
    && record.error?.code === 'spawn_failed'
    && record.retryTargetPhase === 'spawning';
}

function requiresPersistedTakeoverAuthorityReconciliation(
  record: ExternalSessionOperationRecordV1,
): boolean {
  return record.status === 'failed'
    && record.phase === 'admitting'
    && record.error?.code === 'admission_failed'
    && record.error.retryable === true
    && record.fence.kind === 'none'
    && record.canonicalOwnerEvidence.transcriptAuthorityRevision !== undefined
    && record.canonicalOwnerEvidence.pendingAdmissionRevision !== undefined;
}

export function createExternalSessionTakeoverAdmissionActionExecutor(
  dependencies: TakeoverAdmissionActionDependencies,
): ExternalSessionTakeoverAdmissionActionExecutor {
  const nowMs = dependencies.nowMs ?? Date.now;
  const createAttemptId = dependencies.createAttemptId ?? randomUUID;

  const publish = async (
    record: ExternalSessionOperationRecordV1,
  ): Promise<ExternalSessionOperationRecordV1> => {
    return await dependencies.publishProgress?.({
      sessionId: record.request.sessionId,
      progress: projectExternalSessionOperationProgressV1(record),
    }) ?? record;
  };

  const publishBestEffort = async (
    record: ExternalSessionOperationRecordV1,
  ): Promise<ExternalSessionOperationRecordV1> => {
    try {
      return await publish(record);
    } catch {
      // The action response still carries the latest public projection, and this failure cannot
      // authorize additional operation or runtime effects.
      return record;
    }
  };

  const recoverPrecommitAdmissionFailure = async (
    record: PersistedTakeoverRecord,
  ): Promise<ExternalSessionOperationActionResponseV1> => {
    let recovered: ExternalSessionOperationRecordV1 | null = null;
    try {
      const failed = await mutateExternalSessionOperationRecordAtRevision(
        dependencies.activeServerDir,
        record.operationId,
        record.revision,
        (fresh) => {
          const {
            acceptedThroughServerSeq: _acceptedThroughServerSeq,
            acknowledgedBatchId: _acknowledgedBatchId,
            ...checkpoint
          } = fresh.checkpoint;
          return {
            ...fresh,
            revision: fresh.revision + 1,
            status: 'failed',
            phase: 'admitting',
            checkpoint,
            updatedAtMs: nowMs(),
            retryTargetPhase: 'admitting',
            error: {
              code: 'admission_failed',
              message: 'Persisted takeover admission did not complete.',
              retryable: true,
              occurredAtMs: nowMs(),
            },
          };
        },
      );
      recovered = failed.ok
        ? failed.record
        : await readExternalSessionOperationRecord(
          dependencies.activeServerDir,
          record.operationId,
        );
    } catch {
      recovered = await readExternalSessionOperationRecord(
        dependencies.activeServerDir,
        record.operationId,
      ).catch(() => null);
    }
    if (!recovered) {
      return failure(
        'internal_error',
        'Persisted takeover admission recovery could not be recorded.',
      );
    }
    recovered = await publishBestEffort(recovered);
    return success(recovered);
  };

  const execute = async (
    raw: unknown,
    intent: 'resume' | 'retry',
  ): Promise<ExternalSessionOperationActionResponseV1> => {
      const parsed = ExternalSessionOperationResumeInputV1Schema.safeParse(raw);
      if (!parsed.success) {
        return failure('invalid_state', 'Invalid persisted takeover Resume request.');
      }
      if (!dependencies.isHostedAdmissionAvailable()) {
        return failure(
          'upgrade_required',
          'Persisted takeover admission requires a newer server.',
        );
      }
      let current: ExternalSessionOperationRecordV1 | null;
      try {
        current = await readExternalSessionOperationRecord(
          dependencies.activeServerDir,
          parsed.data.operationId,
        );
      } catch (error) {
        if (error instanceof ExternalSessionOperationRecordReadError) {
          return failure(
            'internal_error',
            'Persisted takeover operation record could not be read safely.',
          );
        }
        throw error;
      }
      if (
        !current
        || current.request.sessionId !== parsed.data.sessionId
      ) {
        return failure('operation_not_found', 'Persisted takeover operation was not found.');
      }
      if (current.revision !== parsed.data.revision) {
        return failure('stale_revision', 'Persisted takeover operation revision is stale.');
      }
      if (!isExternalSessionPersistedTakeoverAdmissionReady(current)) {
        return failure(
          'invalid_state',
          'Persisted takeover is not ready for runtime admission.',
        );
      }
      if (intent === 'resume' && isHostedOfflineRuntimeRetry(current)) {
        return failure(
          'not_allowed',
          'Hosted-offline persisted takeover requires explicit Retry.',
        );
      }
      if (requiresPersistedTakeoverAuthorityReconciliation(current)) {
        if (!dependencies.reconcileAuthority) {
          return failure(
            'internal_error',
            'Persisted takeover admission authority cannot be reconciled.',
          );
        }
        const reconciled = await dependencies.reconcileAuthority(current);
        if (!reconciled) {
          return failure(
            'source_unavailable',
            'Persisted takeover admission authority is temporarily unavailable.',
          );
        }
        if (
          reconciled.currentStorageState === 'hosted'
          && reconciled.phase === 'spawning'
        ) {
          const published = await publishBestEffort(reconciled);
          return success(published);
        }
        current = reconciled;
        if (
          !isExternalSessionPersistedTakeoverAdmissionReady(current)
          || requiresPersistedTakeoverAuthorityReconciliation(current)
        ) {
          return failure(
            'invalid_state',
            'Persisted takeover admission authority did not reconcile.',
          );
        }
      }
      const request = current.request;
      const acquired = await dependencies.operationExclusion.acquire({
        kind: 'takeover',
        sessionId: request.sessionId,
        requestId: request.idempotencyKey,
        sourceIdentity: JSON.stringify(request.source.qualifiedIdentity),
        sourceGeneration: request.source.sourceGeneration,
        plan: 'persisted',
      });
      if (acquired.status !== 'acquired') {
        return failure('operation_conflict', 'Persisted takeover is already active.');
      }
      const maintenance = maintainExternalSessionOperationClaim({
        claim: acquired.claim,
        ...(dependencies.claimRenewalIntervalMs === undefined
          ? {}
          : { renewalIntervalMs: dependencies.claimRenewalIntervalMs }),
      });
      let activeRecord: PersistedTakeoverRecord = current;
      let admissionWait: PersistedTakeoverAdmissionWaitRegistration | null = null;
      let attemptCommitted = false;
      const cancelAdmissionWait = (): PersistedTakeoverAdmissionWaitRegistration | null => {
        const wait = admissionWait;
        admissionWait = null;
        wait?.cancel();
        return wait;
      };
      try {
        const revalidated = await readExternalSessionOperationRecord(
          dependencies.activeServerDir,
          current.operationId,
        );
        if (!revalidated || revalidated.revision !== current.revision) {
          return failure(
            revalidated ? 'stale_revision' : 'operation_not_found',
            revalidated
              ? 'Persisted takeover operation revision is stale.'
              : 'Persisted takeover operation was not found.',
          );
        }
        if (!isExternalSessionPersistedTakeoverAdmissionReady(revalidated)) {
          return failure(
            'invalid_state',
            'Persisted takeover is not ready for runtime admission.',
          );
        }

        const attemptId = intent === 'retry'
          ? createAttemptId()
          : revalidated.bindings.targetRuntimeAttemptId ?? createAttemptId();
        const admitted = await maintenance.race(
          () => mutateExternalSessionOperationRecordAtRevision(
            dependencies.activeServerDir,
            revalidated.operationId,
            revalidated.revision,
            (fresh) => {
              if (!isExternalSessionPersistedTakeoverAdmissionReady(fresh)) {
                throw new Error('persisted_takeover_admission_state_changed');
              }
              const {
                retryTargetPhase: _retryTargetPhase,
                error: _error,
                ...withoutRecovery
              } = fresh;
              return {
                ...withoutRecovery,
                revision: fresh.revision + 1,
                status: 'running',
                updatedAtMs: nowMs(),
                bindings: {
                  ...fresh.bindings,
                  operationClaimId: acquired.claim.record.claimId,
                  targetRuntimeAttemptId: attemptId,
                },
              };
            },
          ),
        );
        if (!admitted.ok) {
          return failure(
            admitted.code,
            admitted.code === 'stale_revision'
              ? 'Persisted takeover operation revision is stale.'
              : 'Persisted takeover operation was not found.',
          );
        }
        activeRecord = admitted.record as PersistedTakeoverRecord;
        attemptCommitted = true;
        activeRecord =
          await publish(activeRecord) as PersistedTakeoverRecord;

        const preparedSpawn = await maintenance.race(
          () => dependencies.prepareSpawn(activeRecord, maintenance.signal),
        );
        maintenance.throwIfLost();
        admissionWait = dependencies.admissionWaiter.register({
          operationId: activeRecord.operationId,
          attemptId,
        });
        const fencedSpawn = await maintenance.race(
          () => dependencies.spawnResolvedTakeoverSession({
            resolved: preparedSpawn,
            options: {
              transcriptStorage: 'persisted',
              persistedTakeoverAdmission: {
                operationId: activeRecord.operationId,
                attemptId,
              },
            },
            signal: maintenance.signal,
            spawnSession: dependencies.spawnSession,
          }),
        );
        maintenance.throwIfLost();
        if (!fencedSpawn.ok) {
          cancelAdmissionWait();
          return await recoverPrecommitAdmissionFailure(activeRecord);
        }
        const spawnResult = fencedSpawn.value;
        if (spawnResult.type === 'success') {
          const admissionOutcome = await maintenance.race(
            () => admissionWait!.outcome,
          );
          if (admissionOutcome.status === 'committed') {
            const committedRecord = await readExternalSessionOperationRecord(
              dependencies.activeServerDir,
              activeRecord.operationId,
            );
            if (!committedRecord) {
              return failure(
                'internal_error',
                'Committed persisted takeover operation could not be reread.',
              );
            }
            const published = await publishBestEffort(committedRecord);
            return success(published);
          }
        }
        cancelAdmissionWait();
        const reconciled = await dependencies.reconcileRuntimeBindingFailure?.({
          sessionId: activeRecord.request.sessionId,
          operationId: activeRecord.operationId,
          attemptId,
        });
        if (reconciled) {
          const published = await publishBestEffort(reconciled);
          return success(published);
        }
        return await recoverPrecommitAdmissionFailure(activeRecord);
      } catch (error) {
        if (attemptCommitted) {
          const exactWait = admissionWait;
          const admissionOutcome = exactWait
            ? exactWait.readOutcome() ?? await exactWait.outcome
            : null;
          if (admissionOutcome?.status === 'committed') {
            const committedRecord = await readExternalSessionOperationRecord(
              dependencies.activeServerDir,
              activeRecord.operationId,
            ).catch(() => null);
            if (committedRecord) {
              const published =
                await publishBestEffort(committedRecord);
              return success(published);
            }
            return failure(
              'internal_error',
              'Committed persisted takeover operation could not be reread safely.',
            );
          }
          const attemptId = activeRecord.bindings.targetRuntimeAttemptId;
          const reconciled = attemptId
            ? await dependencies.reconcileRuntimeBindingFailure?.({
                sessionId: activeRecord.request.sessionId,
                operationId: activeRecord.operationId,
                attemptId,
              })
            : null;
          if (reconciled) {
            const published = await publishBestEffort(reconciled);
            return success(published);
          }
          return await recoverPrecommitAdmissionFailure(activeRecord);
        }
        if (error instanceof ExternalSessionOperationClaimLostError) {
          return failure('operation_conflict', error.code);
        }
        return failure('internal_error', 'Persisted takeover admission failed.');
      } finally {
        cancelAdmissionWait();
        maintenance.stop();
        await acquired.claim.release().catch(() => undefined);
      }
    };

  return Object.freeze({
    resume: async (raw) => await execute(raw, 'resume'),
    retry: async (raw) => await execute(raw, 'retry'),
  });
}
