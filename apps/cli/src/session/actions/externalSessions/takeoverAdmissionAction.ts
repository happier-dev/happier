import { randomUUID } from 'node:crypto';

import { ExternalSessionOperationResumeInputV1Schema } from '@happier-dev/protocol/sessions/external/operationActionSchemasV1';
import { projectExternalSessionOperationProgressV1 } from '@happier-dev/protocol/sessions/external/operationV1';
import type { ExternalSessionOperationActionResponseV1, ExternalSessionOperationRecordV1 } from '@happier-dev/protocol';

import type { ExternalSessionOperationExclusion } from '@/session/external/operationExclusion';
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
  PersistedTakeoverAdmissionContext,
} from '@/daemon/spawn/persistedTakeoverAdmission';

import {
  ExternalSessionOperationRecordReadError,
  mutateExternalSessionOperationRecordAtRevision,
  readExternalSessionOperationRecord,
  captureExternalSessionOperationAccountAdmission,
  type ExternalSessionOperationAccountAdmission,
  resolveExternalSessionOperationRecordsDirectory,
} from './operationRecordStore';
import {
  recoverExternalSessionTakeoverPrecommitAdmission,
} from './takeoverPrecommitAdmissionRecovery';
import { logExternalSessionsInternalError } from './responseErrors';

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
    context?: PersistedTakeoverAdmissionContext,
  ): Promise<ResolvedExternalTakeoverSpawn & Readonly<{ admissionContext?: PersistedTakeoverAdmissionContext }>>;
  reconcileAuthority?(
    record: ExternalSessionOperationRecordV1,
    context?: PersistedTakeoverAdmissionContext,
  ): Promise<ExternalSessionOperationRecordV1 | null>;
  reconcileRuntimeBindingFailure?(input: Readonly<{
    sessionId: string;
    operationId: string;
    attemptId: string;
    context?: PersistedTakeoverAdmissionContext;
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
    credentials?: PersistedTakeoverAdmissionContext['credentials'];
    accountScope?: PersistedTakeoverAdmissionContext['accountScope'];
  }>): Promise<ExternalSessionOperationRecordV1 | void>;
  createAttemptId?: () => string;
  nowMs?: () => number;
}>;

export type ExternalSessionTakeoverAdmissionActionExecutor = Readonly<{
  resume(input: unknown, admission?: ExternalSessionOperationAccountAdmission): Promise<ExternalSessionOperationActionResponseV1>;
  retry(input: unknown, admission?: ExternalSessionOperationAccountAdmission): Promise<ExternalSessionOperationActionResponseV1>;
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
      && record.canonicalOwnerEvidence.transcriptAuthorityRevision === undefined
    );
  const isAuthorityReconciliation = record.status === 'failed'
    && record.error?.code === 'admission_failed'
    && record.error.retryable === true
    && record.fence.kind === 'none'
    && record.canonicalOwnerEvidence.transcriptAuthorityRevision !== undefined;
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
    && record.canonicalOwnerEvidence.transcriptAuthorityRevision !== undefined;
}

export function createExternalSessionTakeoverAdmissionActionExecutor(
  dependencies: TakeoverAdmissionActionDependencies,
): ExternalSessionTakeoverAdmissionActionExecutor {
  const nowMs = dependencies.nowMs ?? Date.now;
  const createAttemptId = dependencies.createAttemptId ?? randomUUID;

  const publish = async (
    record: ExternalSessionOperationRecordV1,
    context: PersistedTakeoverAdmissionContext,
  ): Promise<ExternalSessionOperationRecordV1> => {
    return await dependencies.publishProgress?.({
      sessionId: record.request.sessionId,
      progress: projectExternalSessionOperationProgressV1(record),
      ...(context.credentials ? { credentials: context.credentials } : {}),
      ...(context.accountScope ? { accountScope: context.accountScope } : {}),
    }) ?? record;
  };

  const publishBestEffort = async (
    record: ExternalSessionOperationRecordV1,
    context: PersistedTakeoverAdmissionContext,
  ): Promise<ExternalSessionOperationRecordV1> => {
    try {
      return await publish(record, context);
    } catch {
      // The action response still carries the latest public projection, and this failure cannot
      // authorize additional operation or runtime effects.
      return record;
    }
  };

  const recoverPrecommitAdmissionFailure = async (
    record: PersistedTakeoverRecord,
    context: PersistedTakeoverAdmissionContext,
  ): Promise<ExternalSessionOperationActionResponseV1> => {
    // The admission owner commits refreshed authority evidence at
    // `revision + 1` before it sends the Server command, so `record.revision`
    // is already stale by the time a definitive pre-commit rejection lands
    // here. The shared recovery owner rereads the exact attempt and CASes
    // whatever revision the admission owner left behind. This action cancels
    // the waiter and releases the claim on the way out, so only its proof that
    // the exact attempt left `running`/`admitting` may be reported as an
    // outcome; anything else leaves the operation stranded.
    const recovery = await recoverExternalSessionTakeoverPrecommitAdmission({
      activeServerDir: await resolveExternalSessionOperationRecordsDirectory(
        dependencies.activeServerDir, record.operationId, context.accountScope,
      ),
      targetStorageMode: 'persisted',
      sessionId: record.request.sessionId,
      operationId: record.operationId,
      attemptId: record.bindings.targetRuntimeAttemptId,
      operationClaimId: record.bindings.operationClaimId,
      message: 'Persisted takeover admission did not complete.',
      nowMs: nowMs(),
    });
    if (
      recovery.status === 'recovered'
      || recovery.status === 'already_settled'
    ) {
      return success(await publishBestEffort(recovery.record, context));
    }
    return failure(
      'internal_error',
      'Persisted takeover admission recovery could not be recorded.',
    );
  };

  const execute = async (
    raw: unknown,
    intent: 'resume' | 'retry',
    admission?: ExternalSessionOperationAccountAdmission,
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
      let context: PersistedTakeoverAdmissionContext;
      try {
        context = admission ?? await captureExternalSessionOperationAccountAdmission(dependencies.activeServerDir) ?? {};
        current = await readExternalSessionOperationRecord(
          dependencies.activeServerDir,
          parsed.data.operationId,
          context.accountScope,
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
        const reconciled = await dependencies.reconcileAuthority(current, context);
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
          const published = await publishBestEffort(reconciled, context);
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
      }, context.accountScope ? { accountSubject: context.accountScope.accountSubject } : undefined);
      if (acquired.status !== 'acquired') {
        return failure('operation_conflict', 'Persisted takeover is already active.');
      }
      let activeRecord: PersistedTakeoverRecord = current;
      let admissionWait: PersistedTakeoverAdmissionWaitRegistration | null = null;
      let attemptCommitted = false;
      let admissionStage:
        | 'claim'
        | 'publish'
        | 'prepare_spawn'
        | 'register_wait'
        | 'spawn'
        | 'await_admission'
        | 'reconcile_runtime' = 'claim';
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
          context.accountScope,
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

        // Every admission episode acquires a fresh exclusion claim above and
        // launches its own child below, while the private handshake the child
        // reports back carries only `{ mode, operationId, attemptId }`. Reusing
        // a retained attempt would therefore let a detached child from the
        // released claim satisfy this episode's waiter, so each new child gets
        // its own attempt identity.
        const attemptId = createAttemptId();
        const admitted = await mutateExternalSessionOperationRecordAtRevision(
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
          context.accountScope,
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
        admissionStage = 'publish';
        activeRecord =
          await publish(activeRecord, context) as PersistedTakeoverRecord;

        admissionStage = 'prepare_spawn';
        const preparedSpawn = await dependencies.prepareSpawn(activeRecord, undefined, context);
        context = preparedSpawn.admissionContext ?? context;
        admissionStage = 'register_wait';
        admissionWait = dependencies.admissionWaiter.register({
          mode: 'persisted',
          operationId: activeRecord.operationId,
          attemptId,
        }, { context });
        admissionStage = 'spawn';
        const fencedSpawn = await dependencies.spawnResolvedTakeoverSession({
          resolved: preparedSpawn,
          options: {
            transcriptStorage: 'persisted',
            persistedTakeoverAdmission: {
              mode: 'persisted',
              operationId: activeRecord.operationId,
              attemptId,
            },
          },
          spawnSession: dependencies.spawnSession,
        });
        if (!fencedSpawn.ok) {
          logExternalSessionsInternalError(
            fencedSpawn.code === 'cancelled'
              ? 'external_session.takeover_admission.fenced_spawn.cancelled'
              : 'external_session.takeover_admission.fenced_spawn.agent_unavailable',
            new Error(),
          );
          cancelAdmissionWait();
          const reconciled =
            await dependencies.reconcileRuntimeBindingFailure?.({
              sessionId: activeRecord.request.sessionId,
              operationId: activeRecord.operationId,
              attemptId,
              context,
            });
          if (reconciled) {
            const published = await publishBestEffort(reconciled, context);
            return success(published);
          }
          return await recoverPrecommitAdmissionFailure(activeRecord, context);
        }
        const spawnResult = fencedSpawn.value;
        if (spawnResult.type === 'success') {
          admissionStage = 'await_admission';
          const admissionOutcome = await admissionWait!.outcome;
          if (admissionOutcome.status === 'committed') {
            const committedRecord = await readExternalSessionOperationRecord(
              dependencies.activeServerDir,
              activeRecord.operationId,
              context.accountScope,
            );
            if (!committedRecord) {
              return failure(
                'internal_error',
                'Committed persisted takeover operation could not be reread.',
              );
            }
            const published = await publishBestEffort(committedRecord, context);
            return success(published);
          }
          logExternalSessionsInternalError(
            'external_session.takeover_admission.await_admission.failed',
            new Error(),
          );
        } else {
          logExternalSessionsInternalError(
            spawnResult.type === 'error'
              ? 'external_session.takeover_admission.spawn'
              : 'external_session.takeover_admission.spawn.directory_approval_required',
            spawnResult,
          );
        }
        cancelAdmissionWait();
        admissionStage = 'reconcile_runtime';
        const reconciled = await dependencies.reconcileRuntimeBindingFailure?.({
          sessionId: activeRecord.request.sessionId,
          operationId: activeRecord.operationId,
          attemptId,
          context,
        });
        if (reconciled) {
          const published = await publishBestEffort(reconciled, context);
          return success(published);
        }
        return await recoverPrecommitAdmissionFailure(activeRecord, context);
      } catch (error) {
        logExternalSessionsInternalError(
          `external_session.takeover_admission.${admissionStage}`,
          error,
        );
        if (attemptCommitted) {
          const exactWait = cancelAdmissionWait();
          const admissionOutcome = exactWait
            ? exactWait.readOutcome() ?? await exactWait.outcome
            : null;
          if (admissionOutcome?.status === 'committed') {
            const committedRecord = await readExternalSessionOperationRecord(
              dependencies.activeServerDir,
              activeRecord.operationId,
              context.accountScope,
            ).catch(() => null);
            if (committedRecord) {
              const published =
                await publishBestEffort(committedRecord, context);
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
                context,
              })
            : null;
          if (reconciled) {
            const published = await publishBestEffort(reconciled, context);
            return success(published);
          }
          return await recoverPrecommitAdmissionFailure(activeRecord, context);
        }
        return failure('internal_error', 'Persisted takeover admission failed.');
      } finally {
        cancelAdmissionWait();
        await acquired.claim.release().catch(() => undefined);
      }
    };

  return Object.freeze({
    resume: async (raw, admission) => await execute(raw, 'resume', admission),
    retry: async (raw, admission) => await execute(raw, 'retry', admission),
  });
}
