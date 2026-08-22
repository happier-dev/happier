import {
  ExternalSessionOperationCancelInputV1Schema,
  ExternalSessionOperationResumeInputV1Schema,
  isRetryableExternalLinkedAdmissionAcknowledgementReconciliationV1,
  projectExternalSessionOperationProgressV1,
  resolveExternalHistoryImportV1FromMetadata,
  readLinkedExternalSessionV1FromMetadata,
  resolveLinkedExternalSessionMetadataV1,
  type PluginAgentExternalLinkedTakeoverWriterSafetyV1,
  type ExternalSessionOperationActionResponseV1,
  type ExternalSessionOperationRecordV1,
} from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';

import type {
  createExternalSessionFollowLeaseManager,
} from '@/api/session/external/leases/createExternalSessionFollowLeaseManager';
import {
  inspectExternalSessionDestructiveQuiescence,
} from '@/api/session/external/takeover/inspectExternalSessionDestructiveQuiescence';
import {
  resolveExternalLinkedTakeoverWriterSafety,
} from '@/api/session/external/takeover/resolveExternalLinkedTakeoverWriterSafety';
import {
  resolveExternalTakeoverSpawnOptions,
  spawnResolvedExternalTakeoverSession,
  type ExternalTakeoverFencedSpawnResult,
  type ExternalTakeoverSpawnResolution,
} from '@/api/session/external/takeover/resolveExternalTakeoverSpawnOptions';
import {
  loadLinkedExternalSession,
  type LoadedLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readStoredCredentials } from '@/persistence';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import {
  tryDecryptSessionOwnerMetadataView,
} from '@/session/transport/encryption/sessionEncryptionContext';
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
  PersistedTakeoverAdmissionWaitRegistration,
  PersistedTakeoverAdmissionWaiter,
} from '@/daemon/spawn/persistedTakeoverAdmission';
import type {
  ExternalSessionMaterializeActionExecutor,
  ExternalSessionPersistedTakeoverImportRecord,
  ExternalSessionPersistedTakeoverPreparation,
} from './materializeAction';
import {
  ExternalSessionPersistedTakeoverPreflightError,
} from './materializeAction';
import {
  resolveGenerationBoundExternalSessionFollowSurface,
} from './providerOpsResolution';
import {
  assertExternalSessionExternalLinkedTakeoverSourceContinuity,
  assertExternalSessionPersistedTakeoverSourceContinuity,
  type ExternalSessionPersistedTakeoverContinuityRequirement,
} from './takeoverSourceContinuity';
import {
  ExternalSessionOperationRecordReadError,
  mutateExternalSessionOperationRecordAtRevision,
  readExternalSessionOperationRecord,
} from './operationRecordStore';
import {
  resolveExternalSessionSourceKeyOwner,
} from '@/session/external/resolveExternalSessionSourceKeyOwner';

export {
  assertExternalSessionPersistedTakeoverSourceContinuity,
  type ExternalSessionPersistedTakeoverContinuityRequirement,
} from './takeoverSourceContinuity';

type PersistedTakeoverRequest = Extract<
  ExternalSessionOperationRecordV1['request'],
  { plan: 'takeover' }
> & Readonly<{ targetStorageMode: 'persisted' }>;

type TakeoverRequest = Extract<
  ExternalSessionOperationRecordV1['request'],
  { plan: 'takeover' }
>;

type ExternalLinkedTakeoverRecord = ExternalSessionOperationRecordV1 & Readonly<{
  request: Extract<
    ExternalSessionOperationRecordV1['request'],
    { plan: 'takeover' }
  > & Readonly<{ targetStorageMode: 'external-linked' }>;
}>;

function isExternalLinkedTakeoverRecord(
  record: ExternalSessionOperationRecordV1 | null,
): record is ExternalLinkedTakeoverRecord {
  return record?.request.plan === 'takeover'
    && record.request.targetStorageMode === 'external-linked';
}

function isCommittedExternalLinkedRuntimeBindingCandidate(
  record: ExternalSessionOperationRecordV1 | null,
  input: Readonly<{
    sessionId: string;
    operationId: string;
    attemptId: string;
  }>,
): record is ExternalLinkedTakeoverRecord {
  return isExternalLinkedTakeoverRecord(record)
    && record.request.sessionId === input.sessionId
    && record.operationId === input.operationId
    && record.status === 'running'
    && record.phase === 'spawning'
    && record.bindings.targetRuntimeAttemptId === input.attemptId;
}

export type ExternalSessionPersistedTakeoverPhaseRunner = Readonly<{
  resume(input: unknown): Promise<ExternalSessionOperationActionResponseV1>;
}>;

export function createExternalSessionPersistedTakeoverPhaseRunner(input: Readonly<{
  importExecutor: Pick<
    ExternalSessionMaterializeActionExecutor,
    'resumePersistedTakeover'
  >;
}>): ExternalSessionPersistedTakeoverPhaseRunner {
  return Object.freeze({
    resume: async (resumeInput) =>
      await input.importExecutor.resumePersistedTakeover(resumeInput),
  });
}

export type PreparedExternalSessionExternalLinkedTakeoverSource = Readonly<{
  linked: LoadedLinkedExternalSession;
  pluginGeneration: string;
  quiescenceIdentity: string;
  permitsAdmission: boolean;
  hostedOwnerSessionId: string | null;
}>;

type ExternalLinkedTakeoverPhaseRunnerDependencies = Readonly<{
  activeServerDir: string;
  operationExclusion: ExternalSessionOperationExclusion;
  resolveWriterSafety(
    agentId: Parameters<typeof resolveExternalLinkedTakeoverWriterSafety>[0],
  ): Promise<PluginAgentExternalLinkedTakeoverWriterSafetyV1>;
  loadCurrent(
    record: ExternalLinkedTakeoverRecord,
  ): Promise<PreparedExternalSessionExternalLinkedTakeoverSource>;
  followLeaseManager: Pick<
    ReturnType<typeof createExternalSessionFollowLeaseManager>,
    'suspendSession' | 'resumeSession'
  >;
  resolveSpawn(input: Readonly<{
    linked: LoadedLinkedExternalSession;
    sessionId: string;
    targetDirectory: string;
    signal?: AbortSignal;
  }>): Promise<ExternalTakeoverSpawnResolution>;
  spawnResolvedTakeoverSession(input: Readonly<{
    resolved: Extract<ExternalTakeoverSpawnResolution, { ok: true }>['value'];
    options: Pick<
      SpawnSessionOptions,
      'transcriptStorage' | 'persistedTakeoverAdmission'
    >;
    signal?: AbortSignal;
    spawnSession(options: SpawnSessionOptions): Promise<SpawnSessionResult>;
  }>): Promise<ExternalTakeoverFencedSpawnResult>;
  spawnSession(options: SpawnSessionOptions): Promise<SpawnSessionResult>;
  admissionWaiter?: Pick<PersistedTakeoverAdmissionWaiter, 'register'>;
  reconcileRuntimeBindingFailure(input: Readonly<{
    mode: 'external_linked';
    sessionId: string;
    operationId: string;
    attemptId: string;
  }>): Promise<ExternalSessionOperationRecordV1 | null>;
  publishProgress(input: Readonly<{
    sessionId: string;
    progress: ReturnType<typeof projectExternalSessionOperationProgressV1>;
  }>): Promise<ExternalSessionOperationRecordV1 | void>;
  nowMs?: () => number;
  createAttemptId?: () => string;
}>;

const EXTERNAL_LINKED_ADMISSION_ACK_AMBIGUOUS =
  'external_linked_takeover_admission_ack_ambiguous';

export type ExternalSessionExternalLinkedTakeoverPhaseRunner = Readonly<{
  resume(input: unknown): Promise<ExternalSessionOperationActionResponseV1>;
  retry(input: unknown): Promise<ExternalSessionOperationActionResponseV1>;
  cancel(input: unknown): Promise<ExternalSessionOperationActionResponseV1>;
}>;

function operationFailure(
  code: Extract<
    ExternalSessionOperationActionResponseV1,
    { ok: false }
  >['error']['code'],
  message: string,
): ExternalSessionOperationActionResponseV1 {
  return { ok: false, error: { code, message } };
}

function operationSuccess(
  record: ExternalSessionOperationRecordV1,
): ExternalSessionOperationActionResponseV1 {
  return {
    ok: true,
    progress: projectExternalSessionOperationProgressV1(record),
  };
}

export async function loadCurrentExternalSessionExternalLinkedTakeoverSource(
  record: ExternalLinkedTakeoverRecord,
): Promise<PreparedExternalSessionExternalLinkedTakeoverSource> {
  const linked = await loadCurrentExternalSessionTakeoverTarget(record);
  const resolved = await resolveGenerationBoundExternalSessionFollowSurface(
    linked.agentId,
    record.request.source.linkGeneration,
  );
  if (
    resolved.resource.pluginGeneration
      !== record.request.source.contributionGeneration
    || resolved.resource.retirementSignal?.aborted
  ) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'External-linked takeover contribution generation changed.',
    );
  }
  await assertExternalSessionExternalLinkedTakeoverSourceContinuity({
    record,
    providerOps: resolved.providerOps,
    source: linked.source,
  });
  if (resolved.resource.retirementSignal?.aborted) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'External-linked takeover contribution generation retired during source revalidation.',
    );
  }
  const quiescence = await inspectExternalSessionDestructiveQuiescence({
    linked,
    linkedSessionId: record.request.sessionId,
    machineId: record.request.source.machineId,
  });
  const sourceIdentity = quiescence.protocolResult?.sourceIdentity ?? null;
  const currentLink = readLinkedExternalSessionV1FromMetadata(linked.metadata);
  if (
    sourceIdentity
    && (
      !currentLink?.qualifiedIdentity
      || sourceIdentity.machineId !== record.request.source.machineId
      || sourceIdentity.linkedSessionId !== record.request.sessionId
      || sourceIdentity.remoteSessionId
        !== record.request.source.remoteSessionId
      || sourceIdentity.linkGeneration
        !== record.request.source.linkGeneration
      || sourceIdentity.sourceKey !== linked.canonicalResolvedSourceKey
      || !sameQualifiedIdentity(
        sourceIdentity.qualifiedIdentity,
        record.request.source.qualifiedIdentity,
      )
    )
  ) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'External-linked takeover quiescence no longer matches the linked source.',
    );
  }
  if (resolved.resource.retirementSignal?.aborted) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'External-linked takeover contribution generation retired.',
    );
  }
  return {
    linked,
    pluginGeneration: resolved.resource.pluginGeneration,
    quiescenceIdentity: JSON.stringify({
      status: quiescence.status,
      sourceIdentity,
      processIdentity: quiescence.protocolResult?.processIdentity ?? null,
    }),
    permitsAdmission: quiescence.permitsAdmission,
    hostedOwnerSessionId:
      quiescence.status === 'verified_running'
        ? quiescence.ownerMarker?.happySessionId ?? null
        : null,
  };
}

export function createExternalSessionExternalLinkedTakeoverPhaseRunner(
  dependencies: ExternalLinkedTakeoverPhaseRunnerDependencies,
): ExternalSessionExternalLinkedTakeoverPhaseRunner {
  const nowMs = dependencies.nowMs ?? Date.now;
  const createAttemptId = dependencies.createAttemptId ?? randomUUID;

  const publishBestEffort = async (
    record: ExternalSessionOperationRecordV1,
  ): Promise<ExternalSessionOperationRecordV1> => {
    try {
      return await dependencies.publishProgress({
        sessionId: record.request.sessionId,
        progress: projectExternalSessionOperationProgressV1(record),
      }) ?? record;
    } catch {
      return record;
    }
  };

  const mutate = async (
    record: ExternalLinkedTakeoverRecord,
    update: (
      fresh: ExternalLinkedTakeoverRecord,
    ) => ExternalSessionOperationRecordV1,
  ): Promise<ExternalLinkedTakeoverRecord | null> => {
    const result = await mutateExternalSessionOperationRecordAtRevision(
      dependencies.activeServerDir,
      record.operationId,
      record.revision,
      (fresh) => update(fresh as ExternalLinkedTakeoverRecord),
    );
    if (!result.ok) return null;
    return await publishBestEffort(
      result.record,
    ) as ExternalLinkedTakeoverRecord;
  };

  const failPreSpawn = async (
    record: ExternalLinkedTakeoverRecord,
    code:
      | 'source_unavailable'
      | 'admission_failed'
      | 'spawn_failed'
      | 'internal_error',
    message: string,
    phase: 'quiescing' | 'admitting' | 'spawning' = record.phase as
      'quiescing' | 'admitting' | 'spawning',
  ): Promise<ExternalSessionOperationActionResponseV1> => {
    const failed = await mutate(record, (fresh) => {
      const {
        terminalResult: _terminalResult,
        cancellation: _cancellation,
        ...withoutTerminal
      } = fresh;
      return {
        ...withoutTerminal,
        revision: fresh.revision + 1,
        status: 'failed',
        phase,
        updatedAtMs: nowMs(),
        retryTargetPhase: phase,
        error: {
          code,
          message,
          retryable: true,
          occurredAtMs: nowMs(),
        },
      };
    });
    return failed
      ? operationSuccess(failed)
      : operationFailure(
        'stale_revision',
        'External-linked takeover operation revision is stale.',
      );
  };

  const reconcileCommittedRuntimeBindingFailure = async (
    record: ExternalLinkedTakeoverRecord,
    attemptId: string,
  ): Promise<ExternalSessionOperationActionResponseV1 | null> => {
    const latest = await readExternalSessionOperationRecord(
      dependencies.activeServerDir,
      record.operationId,
    );
    if (!isCommittedExternalLinkedRuntimeBindingCandidate(latest, {
      sessionId: record.request.sessionId,
      operationId: record.operationId,
      attemptId,
    })) {
      return null;
    }
    const reconciled = await dependencies.reconcileRuntimeBindingFailure({
      mode: 'external_linked',
      sessionId: record.request.sessionId,
      operationId: record.operationId,
      attemptId,
    });
    return reconciled ? operationSuccess(reconciled) : null;
  };

  const phaseForAdmissionFailure = (
    record: ExternalLinkedTakeoverRecord,
  ): 'admitting' | 'spawning' =>
    record.phase === 'spawning' ? 'spawning' : 'admitting';

  const awaitAdmissionReconciliation = async (
    record: ExternalLinkedTakeoverRecord,
    attemptId: string,
  ): Promise<ExternalSessionOperationActionResponseV1> => {
    const latest = await readExternalSessionOperationRecord(
      dependencies.activeServerDir,
      record.operationId,
    );
    if (
      !latest
      || !isExternalLinkedTakeoverRecord(latest)
      || latest.request.sessionId !== record.request.sessionId
      || latest.status !== 'running'
      || latest.phase !== 'admitting'
      || latest.bindings.targetRuntimeAttemptId !== attemptId
    ) {
      return operationFailure(
        latest ? 'stale_revision' : 'operation_not_found',
        latest
          ? 'External-linked takeover operation revision is stale.'
          : 'External-linked takeover operation was not found.',
      );
    }
    const reconciled = await mutate(latest, (fresh) => {
      const {
        terminalResult: _terminalResult,
        cancellation: _cancellation,
        ...withoutTerminal
      } = fresh;
      return {
        ...withoutTerminal,
        revision: fresh.revision + 1,
        status: 'reconciliation_required',
        phase: 'admitting',
        updatedAtMs: nowMs(),
        retryTargetPhase: 'admitting',
        error: {
          code: 'reconciliation_required',
          message:
            'External-linked takeover admission acknowledgement remains ambiguous after bounded exact-attempt replay.',
          retryable: true,
          occurredAtMs: nowMs(),
        },
      };
    });
    return reconciled
      ? operationSuccess(reconciled)
      : operationFailure(
        'stale_revision',
        'External-linked takeover operation revision is stale.',
      );
  };

  const execute = async (
    raw: unknown,
    intent: 'resume' | 'retry',
  ): Promise<ExternalSessionOperationActionResponseV1> => {
    const parsed = ExternalSessionOperationResumeInputV1Schema.safeParse(raw);
    if (!parsed.success) {
      return operationFailure(
        'invalid_state',
        'Invalid external-linked takeover continuation request.',
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
        return operationFailure(
          'internal_error',
          'External-linked takeover operation could not be read safely.',
        );
      }
      throw error;
    }
    if (!current || current.request.sessionId !== parsed.data.sessionId) {
      return operationFailure(
        'operation_not_found',
        'External-linked takeover operation was not found.',
      );
    }
    if (current.revision !== parsed.data.revision) {
      return operationFailure(
        'stale_revision',
        'External-linked takeover operation revision is stale.',
      );
    }
    if (
      current.request.plan !== 'takeover'
      || current.request.targetStorageMode !== 'external-linked'
    ) {
      return operationFailure(
        'invalid_state',
        'Operation is not an external-linked takeover.',
      );
    }
    const record = current as ExternalLinkedTakeoverRecord;
    const resumableRecovery = record.status === 'awaiting_user_resume'
      && record.retryTargetPhase === record.phase
      && (
        record.phase === 'validating'
        || record.phase === 'quiescing'
        || record.phase === 'admitting'
        || record.phase === 'finalizing'
      );
    const retainedAdmissionAttemptId =
      typeof record.bindings.targetRuntimeAttemptId === 'string'
      && record.bindings.targetRuntimeAttemptId.length > 0
      && (
        (
          record.status === 'awaiting_user_resume'
          && record.phase === 'admitting'
          && record.retryTargetPhase === 'admitting'
        )
        // One rule, owned by the record contract itself, decides whether an
        // unresolved admission acknowledgement may be replayed under its exact
        // retained attempt. Restating it here could admit a replay the record
        // schema and the shared projection both refuse.
        || isRetryableExternalLinkedAdmissionAcknowledgementReconciliationV1(record)
      );
    const reusableAdmissionRecovery = retainedAdmissionAttemptId
      ? record.bindings.targetRuntimeAttemptId
      : null;
    const retryableRecovery = record.status === 'failed'
      && record.error?.retryable === true
      && record.retryTargetPhase === record.phase
      && (
        (
          record.phase === 'quiescing'
          && (
            record.error.code === 'source_unavailable'
            || record.error.code === 'internal_error'
          )
        )
        || (
          record.phase === 'admitting'
          && (
            record.error.code === 'source_unavailable'
            || record.error.code === 'internal_error'
            || record.error.code === 'admission_failed'
          )
        )
        || (
          record.phase === 'spawning'
          && (
            record.error.code === 'source_unavailable'
            || record.error.code === 'internal_error'
            || record.error.code === 'spawn_failed'
          )
        )
      );
    if (
      (
        intent === 'resume'
        && !resumableRecovery
      )
      || (
        intent === 'retry'
        && !retryableRecovery
        && !reusableAdmissionRecovery
      )
    ) {
      return operationFailure(
        'invalid_state',
        `External-linked takeover cannot ${intent} from its current state.`,
      );
    }

    const writerSafety = await dependencies.resolveWriterSafety(
      record.request.source.qualifiedIdentity.agent.localId,
    ).catch(() => 'unsupported' as const);
    if (writerSafety !== 'native_prevention') {
      return operationFailure(
        'not_allowed',
        'External-linked takeover is unsupported for this Agent writer-safety contract.',
      );
    }

    let prepared: PreparedExternalSessionExternalLinkedTakeoverSource;
    try {
      prepared = await dependencies.loadCurrent(record);
    } catch (error) {
      if (error instanceof ExternalSessionPersistedTakeoverPreflightError) {
        return operationFailure(error.actionCode, error.message);
      }
      return operationFailure(
        'source_unavailable',
        'External-linked takeover source is unavailable.',
      );
    }
    if (record.phase === 'finalizing') {
      return operationFailure(
        'not_allowed',
        'External-linked takeover finalization is owned by the admitted child runtime.',
      );
    }
    if (!prepared.permitsAdmission) {
      return operationFailure(
        'not_allowed',
        'External-linked takeover requires exact verified quiescence.',
      );
    }

    const acquired = await dependencies.operationExclusion.acquire({
      kind: 'takeover',
      sessionId: record.request.sessionId,
      requestId: record.request.idempotencyKey,
      sourceIdentity: JSON.stringify(
        record.request.source.qualifiedIdentity,
      ),
      sourceGeneration: record.request.source.sourceGeneration,
      plan: 'external-linked',
    });
    if (acquired.status !== 'acquired') {
      return operationFailure(
        'operation_conflict',
        'External-linked takeover is already active.',
      );
    }
    const maintenance = maintainExternalSessionOperationClaim({
      claim: acquired.claim,
    });
    let active = record;
    let followSuspended = false;
    let retainFollowSuspension = false;
    let admissionWait: PersistedTakeoverAdmissionWaitRegistration | null = null;
    let admissionSpawnStarted = false;
    try {
      const fenced = await readExternalSessionOperationRecord(
        dependencies.activeServerDir,
        active.operationId,
      );
      if (!fenced || fenced.revision !== active.revision) {
        return operationFailure(
          fenced ? 'stale_revision' : 'operation_not_found',
          fenced
            ? 'External-linked takeover operation revision is stale.'
            : 'External-linked takeover operation was not found.',
        );
      }
      const attemptId = reusableAdmissionRecovery ?? createAttemptId();
      const running = await maintenance.race(() => mutate(
        active,
        (fresh) => {
          const {
            retryTargetPhase: _retryTargetPhase,
            error: _error,
            terminalResult: _terminalResult,
            cancellation: _cancellation,
            ...withoutRecovery
          } = fresh;
          return {
            ...withoutRecovery,
            revision: fresh.revision + 1,
            status: 'running',
            phase: fresh.phase === 'validating'
              ? 'quiescing'
              : fresh.phase,
            updatedAtMs: nowMs(),
            bindings: {
              ...fresh.bindings,
              operationClaimId: acquired.claim.record.claimId,
              targetRuntimeAttemptId: attemptId,
            },
          };
        },
      ));
      if (!running) {
        return operationFailure(
          'stale_revision',
          'External-linked takeover operation revision is stale.',
        );
      }
      active = running;

      followSuspended = true;
      await maintenance.race(() =>
        dependencies.followLeaseManager.suspendSession({
          sessionId: active.request.sessionId,
          reason: 'takeover',
        }),
      );
      const afterSuspension = await maintenance.race(
        () => dependencies.loadCurrent(active),
      );
      if (
        !afterSuspension.permitsAdmission
        || afterSuspension.pluginGeneration !== prepared.pluginGeneration
        || afterSuspension.quiescenceIdentity !== prepared.quiescenceIdentity
      ) {
        return await failPreSpawn(
          active,
          'source_unavailable',
          'External-linked takeover source changed during follow suspension.',
        );
      }
      const resolved = await maintenance.race(() =>
        dependencies.resolveSpawn({
          linked: afterSuspension.linked,
          sessionId: active.request.sessionId,
          targetDirectory: active.request.targetDirectory,
          signal: maintenance.signal,
        }),
      );
      if (!resolved.ok) {
        return await failPreSpawn(
          active,
          'admission_failed',
          `External-linked takeover launch resolution failed: ${resolved.code}.`,
          phaseForAdmissionFailure(active),
        );
      }
      if (
        resolved.value.origin.generation
          !== record.request.source.contributionGeneration
        || resolved.value.origin.generation
          !== afterSuspension.pluginGeneration
      ) {
        return await failPreSpawn(
          active,
          'source_unavailable',
          'External-linked takeover launch generation changed.',
          phaseForAdmissionFailure(active),
        );
      }
      if (active.phase === 'quiescing') {
        const admitting = await maintenance.race(() => mutate(
          active,
          (fresh) => ({
            ...fresh,
            revision: fresh.revision + 1,
            phase: 'admitting',
            updatedAtMs: nowMs(),
          }),
        ));
        if (!admitting) {
          return operationFailure(
            'stale_revision',
            'External-linked takeover operation revision is stale.',
          );
        }
        active = admitting;
      }
      const beforeSpawn = await maintenance.race(
        () => dependencies.loadCurrent(active),
      );
      if (
        !beforeSpawn.permitsAdmission
        || beforeSpawn.pluginGeneration
          !== record.request.source.contributionGeneration
        || beforeSpawn.pluginGeneration !== afterSuspension.pluginGeneration
        || beforeSpawn.quiescenceIdentity
          !== afterSuspension.quiescenceIdentity
        || resolved.value.origin.generation !== beforeSpawn.pluginGeneration
      ) {
        return await failPreSpawn(
          active,
          'source_unavailable',
          'External-linked takeover source changed before runtime launch.',
          phaseForAdmissionFailure(active),
        );
      }
      const immediatelyCurrent = await readExternalSessionOperationRecord(
        dependencies.activeServerDir,
        active.operationId,
      );
      if (
        !immediatelyCurrent
        || immediatelyCurrent.revision !== active.revision
        || immediatelyCurrent.status !== 'running'
        || (
          immediatelyCurrent.phase !== 'admitting'
          && immediatelyCurrent.phase !== 'spawning'
        )
        || immediatelyCurrent.bindings.targetRuntimeAttemptId !== attemptId
      ) {
        return operationFailure(
          immediatelyCurrent ? 'stale_revision' : 'operation_not_found',
          immediatelyCurrent
            ? 'External-linked takeover operation revision is stale.'
            : 'External-linked takeover operation was not found.',
        );
      }
      if (!dependencies.admissionWaiter) {
        return await failPreSpawn(
          active,
          'admission_failed',
          'External-linked takeover admission is unavailable.',
          phaseForAdmissionFailure(active),
        );
      }
      admissionWait = dependencies.admissionWaiter.register({
        mode: 'external_linked',
        operationId: active.operationId,
        attemptId,
      });
      admissionSpawnStarted = true;
      const spawned = await maintenance.race(() =>
        dependencies.spawnResolvedTakeoverSession({
          resolved: resolved.value,
          options: {
            transcriptStorage: 'direct',
            persistedTakeoverAdmission: {
              mode: 'external_linked',
              operationId: active.operationId,
              attemptId,
            },
          },
          signal: maintenance.signal,
          spawnSession: dependencies.spawnSession,
        }),
      );
      if (!spawned.ok || spawned.value.type !== 'success') {
        admissionWait.cancel();
        admissionWait = null;
        const reconciled = await reconcileCommittedRuntimeBindingFailure(
          active,
          attemptId,
        );
        if (reconciled) return reconciled;
        return await failPreSpawn(
          active,
          'spawn_failed',
          'External-linked takeover runtime did not start.',
          phaseForAdmissionFailure(active),
        );
      }
      const admissionOutcome = await maintenance.race(() => admissionWait!.outcome);
      admissionWait = null;
      const admittedRecord = await readExternalSessionOperationRecord(
        dependencies.activeServerDir,
        active.operationId,
      );
      if (admissionOutcome.status === 'committed' && admittedRecord) {
        return operationSuccess(admittedRecord);
      }
      if (
        admissionOutcome.status === 'failed'
        && admissionOutcome.errorCode === EXTERNAL_LINKED_ADMISSION_ACK_AMBIGUOUS
      ) {
        const reconciliation = await awaitAdmissionReconciliation(active, attemptId);
        if (reconciliation.ok) retainFollowSuspension = true;
        return reconciliation;
      }
      const reconciled = await reconcileCommittedRuntimeBindingFailure(
        active,
        attemptId,
      );
      if (reconciled) return reconciled;
      if (
        admittedRecord
        && admittedRecord.request.targetStorageMode === 'external-linked'
        && admittedRecord.bindings.targetRuntimeAttemptId === attemptId
        && admittedRecord.status === 'failed'
        && admittedRecord.phase === 'spawning'
        && admittedRecord.error?.code === 'spawn_failed'
      ) {
        return operationSuccess(admittedRecord);
      }
      return await failPreSpawn(
        active,
        'admission_failed',
        'External-linked takeover admission did not complete.',
        phaseForAdmissionFailure(active),
      );
    } catch (error) {
      if (admissionSpawnStarted && active.status === 'running') {
        const latest = await readExternalSessionOperationRecord(
          dependencies.activeServerDir,
          active.operationId,
        ).catch(() => null);
        if (
          latest
          && latest.request.targetStorageMode === 'external-linked'
          && latest.bindings.targetRuntimeAttemptId === active.bindings.targetRuntimeAttemptId
          && (
            latest.status === 'completed'
            || (
              latest.status === 'failed'
              && latest.phase === 'spawning'
              && latest.error?.code === 'spawn_failed'
            )
          )
        ) {
          return operationSuccess(latest);
        }
        const attemptId = active.bindings.targetRuntimeAttemptId;
        if (attemptId) {
          const reconciled = await reconcileCommittedRuntimeBindingFailure(
            active,
            attemptId,
          );
          if (reconciled) return reconciled;
        }
        return await failPreSpawn(
          active,
          'admission_failed',
          error instanceof Error
            ? error.message
            : 'External-linked takeover admission failed.',
          phaseForAdmissionFailure(active),
        );
      }
      if (!admissionSpawnStarted && active.status === 'running') {
        if (error instanceof ExternalSessionOperationClaimLostError) {
          const awaiting = await mutate(active, (fresh) => {
            const {
              error: _error,
              terminalResult: _terminalResult,
              cancellation: _cancellation,
              ...withoutRecovery
            } = fresh;
            return {
              ...withoutRecovery,
              revision: fresh.revision + 1,
              status: 'awaiting_user_resume',
              updatedAtMs: nowMs(),
              retryTargetPhase: fresh.phase,
            };
          });
          if (awaiting) return operationSuccess(awaiting);
        } else {
          const code = error
            instanceof ExternalSessionPersistedTakeoverPreflightError
            && error.actionCode === 'source_unavailable'
            ? 'source_unavailable'
            : 'internal_error';
          return await failPreSpawn(
            active,
            code,
            error instanceof Error
              ? error.message
              : 'External-linked takeover continuation failed.',
          );
        }
      }
      if (error instanceof ExternalSessionOperationClaimLostError) {
        return operationFailure('operation_conflict', error.code);
      }
      return operationFailure(
        'internal_error',
        'External-linked takeover continuation failed.',
      );
    } finally {
      admissionWait?.cancel();
      if (followSuspended && !retainFollowSuspension) {
        await dependencies.followLeaseManager.resumeSession({
          sessionId: active.request.sessionId,
          reason: 'takeover',
        }).catch(() => undefined);
      }
      maintenance.stop();
      await acquired.claim.release().catch(() => undefined);
    }
  };

  const cancel = async (
    raw: unknown,
  ): Promise<ExternalSessionOperationActionResponseV1> => {
    const parsed = ExternalSessionOperationCancelInputV1Schema.safeParse(raw);
    if (!parsed.success) {
      return operationFailure(
        'invalid_state',
        'Invalid external-linked takeover cancellation request.',
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
        return operationFailure(
          'internal_error',
          'External-linked takeover operation could not be read safely.',
        );
      }
      throw error;
    }
    if (!current || current.request.sessionId !== parsed.data.sessionId) {
      return operationFailure(
        'operation_not_found',
        'External-linked takeover operation was not found.',
      );
    }
    if (
      current.request.plan !== 'takeover'
      || current.request.targetStorageMode !== 'external-linked'
    ) {
      return operationFailure(
        'invalid_state',
        'Operation is not an external-linked takeover.',
      );
    }
    if (current.revision !== parsed.data.revision) {
      return operationFailure(
        'stale_revision',
        'External-linked takeover operation revision is stale.',
      );
    }
    if (current.status === 'cancelled') return operationSuccess(current);
    const record = current as ExternalLinkedTakeoverRecord;
    const safelyCancellable = record.status === 'cancel_requested' || (
      record.status === 'awaiting_user_resume'
      && (
        record.phase === 'validating'
        || record.phase === 'quiescing'
        || record.phase === 'admitting'
      )
    ) || (
      record.status === 'failed'
      && (
        record.phase === 'quiescing'
        || record.phase === 'admitting'
      )
    );
    if (!safelyCancellable) {
      return operationFailure(
        'not_allowed',
        'External-linked takeover cannot be cancelled after runtime launch begins.',
      );
    }
    const acquired = await dependencies.operationExclusion.acquire({
      kind: 'takeover',
      sessionId: record.request.sessionId,
      requestId: record.request.idempotencyKey,
      sourceIdentity: JSON.stringify(
        record.request.source.qualifiedIdentity,
      ),
      sourceGeneration: record.request.source.sourceGeneration,
      plan: 'external-linked',
    });
    if (acquired.status !== 'acquired') {
      return operationFailure(
        'operation_conflict',
        'External-linked takeover is already active.',
      );
    }
    try {
      const fenced = await readExternalSessionOperationRecord(
        dependencies.activeServerDir,
        record.operationId,
      );
      if (!fenced || fenced.revision !== record.revision) {
        return operationFailure(
          fenced ? 'stale_revision' : 'operation_not_found',
          fenced
            ? 'External-linked takeover operation revision is stale.'
            : 'External-linked takeover operation was not found.',
        );
      }
      let requested = record;
      if (record.status !== 'cancel_requested') {
        const requestedAtMs = nowMs();
        const next = await mutate(record, (fresh) => {
          const {
            retryTargetPhase: _retryTargetPhase,
            error: _error,
            terminalResult: _terminalResult,
            ...withoutRecovery
          } = fresh;
          return {
            ...withoutRecovery,
            revision: fresh.revision + 1,
            status: 'cancel_requested',
            updatedAtMs: requestedAtMs,
            cancellation: {
              requestedAtMs,
              requestedAtRevision: fresh.revision,
            },
            bindings: {
              ...fresh.bindings,
              operationClaimId: acquired.claim.record.claimId,
            },
          };
        });
        if (!next) {
          return operationFailure(
            'stale_revision',
            'External-linked takeover operation revision is stale.',
          );
        }
        requested = next;
      }
      const cancelled = await mutate(requested, (fresh) => ({
        ...fresh,
        revision: fresh.revision + 1,
        status: 'cancelled',
        updatedAtMs: nowMs(),
        terminalResult: { kind: 'cancelled' },
      }));
      if (!cancelled) {
        return operationFailure(
          'stale_revision',
          'External-linked takeover operation revision is stale.',
        );
      }
      if (
        record.status === 'awaiting_user_resume'
        && record.phase === 'admitting'
      ) {
        await dependencies.followLeaseManager.resumeSession({
          sessionId: record.request.sessionId,
          reason: 'takeover',
        }).catch(() => undefined);
      }
      return operationSuccess(cancelled);
    } finally {
      await acquired.claim.release().catch(() => undefined);
    }
  };

  return Object.freeze({
    resume: async (raw) => await execute(raw, 'resume'),
    retry: async (raw) => await execute(raw, 'retry'),
    cancel,
  });
}

export type PreparedExternalSessionPersistedTakeoverSource = Readonly<{
  linked: LoadedLinkedExternalSession;
  pluginGeneration: string;
  quiescenceIdentity: string;
}>;

function sameQualifiedIdentity(
  left: TakeoverRequest['source']['qualifiedIdentity'],
  right: TakeoverRequest['source']['qualifiedIdentity'],
): boolean {
  return left.agent.pluginId === right.agent.pluginId
    && left.agent.localId === right.agent.localId
    && left.source.kind === right.source.kind
    && left.source.contractVersion === right.source.contractVersion;
}

function currentSourceMatchesRequest(
  linked: LoadedLinkedExternalSession,
  request: TakeoverRequest,
): boolean {
  const currentLink = readLinkedExternalSessionV1FromMetadata(linked.metadata);
  return linked.machineId === request.source.machineId
    && linked.remoteSessionId === request.source.remoteSessionId
    && linked.linkGeneration === request.source.linkGeneration
    && currentLink?.qualifiedIdentity !== undefined
    && sameQualifiedIdentity(
      currentLink.qualifiedIdentity,
      request.source.qualifiedIdentity,
  );
}

async function attachCurrentExternalSessionSourceKey(
  linked: LoadedLinkedExternalSession,
): Promise<LoadedLinkedExternalSession> {
  const sourceKeyOwner = await resolveExternalSessionSourceKeyOwner(
    linked.agentId,
    linked.source,
  ).catch(() => null);
  let resolvedSourceKey: string | null = null;
  try {
    resolvedSourceKey = sourceKeyOwner?.resolveSourceKey(linked.source) ?? null;
  } catch {
    resolvedSourceKey = null;
  }
  if (
    !sourceKeyOwner
    || resolvedSourceKey !== sourceKeyOwner.sourceKey
    || (
      linked.canonicalResolvedSourceKey !== undefined
      && linked.canonicalResolvedSourceKey !== sourceKeyOwner.sourceKey
    )
  ) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'Persisted takeover source declaration changed.',
    );
  }
  return {
    ...linked,
    canonicalResolvedSourceKey: sourceKeyOwner.sourceKey,
  };
}

async function loadCurrentExternalSessionTakeoverTarget(
  record: ExternalSessionOperationRecordV1 & Readonly<{
    request: TakeoverRequest;
  }>,
): Promise<LoadedLinkedExternalSession> {
  const request = record.request;
  const credentials = await readStoredCredentials();
  if (!credentials) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'Persisted takeover source credentials are unavailable.',
    );
  }
  const loaded = await loadLinkedExternalSession({
    credentials,
    sessionId: request.sessionId,
    machineId: request.source.machineId,
  }).catch(() => null);
  if (!loaded) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'Persisted takeover source authority is unavailable.',
    );
  }
  if (!loaded.ok) {
    if (loaded.error === 'linked_session_reconciliation_required') {
      throw new ExternalSessionPersistedTakeoverPreflightError(
        'reconciliation_required',
        'Linked external session metadata requires reconciliation.',
      );
    }
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'Persisted takeover target identity changed.',
    );
  }
  if (!currentSourceMatchesRequest(loaded.session, request)) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'Persisted takeover target identity changed.',
    );
  }
  return await attachCurrentExternalSessionSourceKey(loaded.session);
}

export async function loadCurrentExternalSessionPersistedTakeoverTarget(
  record: ExternalSessionPersistedTakeoverImportRecord,
): Promise<LoadedLinkedExternalSession> {
  // Only the persisted-takeover admission owner calls this after commit. The
  // source-validation path below stays live-link-only so retired metadata
  // cannot restore follow, status, or loader authority.
  try {
    return await loadCurrentExternalSessionTakeoverTarget(record);
  } catch (liveLinkError) {
    const credentials = await readStoredCredentials();
    if (!credentials) throw liveLinkError;
    const [rawSession, accountEncryptionCurrentness] = await Promise.all([
      fetchSessionById({
        token: credentials.token,
        sessionId: record.request.sessionId,
      }).catch(() => null),
      fetchAccountEncryptionCurrentness({ token: credentials.token }),
    ]);
    const metadata = rawSession
      ? tryDecryptSessionOwnerMetadataView({
          credentials,
          rawSession,
          accountEncryptionMode: accountEncryptionCurrentness.mode,
        })
      : null;
    const reconstructed = rawSession && metadata
      ? reconstructPersistedTakeoverTargetFromRetiredMetadata({
          record,
          rawSession,
          metadata,
        })
      : null;
    if (!reconstructed) throw liveLinkError;
    return await attachCurrentExternalSessionSourceKey(reconstructed);
  }
}

export function reconstructPersistedTakeoverTargetFromRetiredMetadata(
  input: Readonly<{
    record: ExternalSessionPersistedTakeoverImportRecord;
    rawSession: LoadedLinkedExternalSession['rawSession'];
    metadata: Record<string, unknown>;
  }>,
): LoadedLinkedExternalSession | null {
  const historyImport = resolveExternalHistoryImportV1FromMetadata(
    input.metadata,
  );
  if (historyImport.state !== 'valid') return null;
  const imported = historyImport.historyImport;
  const source = input.record.request.source;
  const linkedSession = resolveLinkedExternalSessionMetadataV1(input.metadata);
  if (
    input.rawSession.currentStorageState !== 'hosted'
    || linkedSession.ok
    || linkedSession.error !== 'linked_session_not_found'
    || imported.agentId !== source.qualifiedIdentity.agent.localId
    || imported.remoteSessionId !== source.remoteSessionId
    || imported.source.kind !== source.qualifiedIdentity.source.kind
  ) {
    return null;
  }
  const sessionPath = typeof input.metadata.path === 'string'
    && input.metadata.path.trim().length > 0
    ? input.metadata.path.trim()
    : null;
  return {
    rawSession: input.rawSession,
    metadata: input.metadata,
    sessionPath,
    agentId: imported.agentId,
    machineId: source.machineId,
    remoteSessionId: imported.remoteSessionId,
    linkGeneration: source.linkGeneration,
    source: imported.source,
    ...(imported.linkData === undefined
      ? {}
      : { linkData: imported.linkData }),
    codexBackendMode: null,
  };
}

export async function loadCurrentExternalSessionPersistedTakeoverSource(
  record: ExternalSessionPersistedTakeoverImportRecord,
  requirement: ExternalSessionPersistedTakeoverContinuityRequirement =
    'allow_advanced_for_catch_up',
): Promise<PreparedExternalSessionPersistedTakeoverSource> {
  const request = record.request;
  const linked = await loadCurrentExternalSessionTakeoverTarget(record);
  const resolved = await resolveGenerationBoundExternalSessionFollowSurface(
    linked.agentId,
    request.source.linkGeneration,
  );
  if (
    resolved.resource.pluginGeneration
      !== request.source.contributionGeneration
    || resolved.resource.retirementSignal?.aborted
  ) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'Persisted takeover contribution generation changed.',
    );
  }
  await assertExternalSessionPersistedTakeoverSourceContinuity({
    record,
    providerOps: resolved.providerOps,
    source: linked.source,
    requirement,
  });
  if (resolved.resource.retirementSignal?.aborted) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'Persisted takeover contribution generation retired during source revalidation.',
    );
  }
  const quiescence = await inspectExternalSessionDestructiveQuiescence({
    linked,
    linkedSessionId: request.sessionId,
    machineId: request.source.machineId,
  });
  if (!quiescence.permitsAdmission || !quiescence.protocolResult) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'not_allowed',
      quiescence.status === 'verified_running'
        ? 'Persisted takeover requires the external process to stop.'
        : 'Persisted takeover quiescence could not be verified.',
    );
  }
  const currentLink = readLinkedExternalSessionV1FromMetadata(
    linked.metadata,
  );
  const sourceIdentity = quiescence.protocolResult.sourceIdentity;
  if (
    !currentLink?.qualifiedIdentity
    || sourceIdentity.machineId !== request.source.machineId
    || sourceIdentity.linkedSessionId !== request.sessionId
    || sourceIdentity.remoteSessionId !== request.source.remoteSessionId
    || sourceIdentity.linkGeneration !== request.source.linkGeneration
    || sourceIdentity.sourceKey !== linked.canonicalResolvedSourceKey
    || !sameQualifiedIdentity(
      sourceIdentity.qualifiedIdentity,
      request.source.qualifiedIdentity,
    )
  ) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'Persisted takeover quiescence no longer matches the linked source.',
    );
  }
  if (resolved.resource.retirementSignal?.aborted) {
    throw new ExternalSessionPersistedTakeoverPreflightError(
      'source_unavailable',
      'Persisted takeover contribution generation retired during quiescence revalidation.',
    );
  }
  return {
    linked,
    pluginGeneration: resolved.resource.pluginGeneration,
    quiescenceIdentity: JSON.stringify({
      sourceIdentity,
      processIdentity: quiescence.protocolResult.processIdentity,
    }),
  };
}

export function createExternalSessionPersistedTakeoverPreparation(input: Readonly<{
  followLeaseManager: Pick<
    ReturnType<typeof createExternalSessionFollowLeaseManager>,
    'suspendSession' | 'resumeSession'
  >;
  loadCurrent?: (
    record: ExternalSessionPersistedTakeoverImportRecord,
  ) => Promise<PreparedExternalSessionPersistedTakeoverSource>;
  resolveSpawn?: (input: Readonly<{
    linked: LoadedLinkedExternalSession;
    sessionId: string;
    targetDirectory: string;
  }>) => Promise<ExternalTakeoverSpawnResolution>;
}>): ExternalSessionPersistedTakeoverPreparation {
  const loadCurrent = input.loadCurrent
    ?? loadCurrentExternalSessionPersistedTakeoverSource;
  const resolveSpawn = input.resolveSpawn
    ?? resolveExternalTakeoverSpawnOptions;

  return async (record) => {
    const request = record.request;
    const beforeSuspension = await loadCurrent(record);
    let suspended = false;
    try {
      await input.followLeaseManager.suspendSession({
        sessionId: request.sessionId,
        reason: 'takeover',
      });
      suspended = true;
      const afterSuspension = await loadCurrent(record);
      if (
        beforeSuspension.pluginGeneration !== afterSuspension.pluginGeneration
        || beforeSuspension.quiescenceIdentity
          !== afterSuspension.quiescenceIdentity
        || !currentSourceMatchesRequest(afterSuspension.linked, request)
      ) {
        throw new ExternalSessionPersistedTakeoverPreflightError(
          'source_unavailable',
          'Persisted takeover source changed during follow suspension.',
        );
      }
      const spawn = await resolveSpawn({
        linked: afterSuspension.linked,
        sessionId: request.sessionId,
        targetDirectory: request.targetDirectory,
      });
      if (!spawn.ok) {
        throw new ExternalSessionPersistedTakeoverPreflightError(
          spawn.code === 'invalid_request' || spawn.code === 'unsupported'
            ? 'not_allowed'
            : 'source_unavailable',
          `Persisted takeover launch resolution failed: ${spawn.code}.`,
        );
      }
      return {
        workingDirectory: spawn.value.options.directory,
        resumeFollowOnFailure: async () => {
          if (!suspended) return;
          suspended = false;
          await input.followLeaseManager.resumeSession({
            sessionId: request.sessionId,
            reason: 'takeover',
          });
        },
      };
    } catch (error) {
      if (suspended) {
        await input.followLeaseManager.resumeSession({
          sessionId: request.sessionId,
          reason: 'takeover',
        }).catch(() => undefined);
      }
      throw error;
    }
  };
}
