import { z } from 'zod';

import {
  EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1,
  ExternalSessionOperationSemanticRequestV1Schema,
  ExternalSessionOperationCancelInputV1Schema,
  ExternalSessionOperationDiscardInputV1Schema,
  ExternalSessionOperationResumeInputV1Schema,
  ExternalSessionOperationRetryInputV1Schema,
  ExternalSessionOperationStatusInputV1Schema,
  projectExternalSessionOperationProgressV1,
  resolveExternalSessionOperationTimelineV1,
  validateExternalSessionOperationSocketBatchV1,
  type ExternalSessionMaterializationPublicationV1,
  type ExternalSessionOperationActionResponseV1,
  type ExternalSessionOperationClaimV1,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationAuthorIntentV1,
  type ExternalSessionRequiredItemFailuresV1,
  type ExternalSessionRequiredItemDiagnosticV1,
  type ExternalSessionOperationSocketCommandV1,
  type ExternalSessionOperationSocketResponseV1,
  type ExternalSessionPriorStableStorageV1,
  type ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';

import {
  ExternalSessionOperationClaimLostError,
  maintainExternalSessionOperationClaim,
  type ExternalSessionOperationClaimMaintenance,
  type ExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';
import {
  createExternalSessionHistoricalImportReplay,
  type ExternalSessionHistoricalImportPreparationPhase,
} from '@/session/external/staging/historicalImportReplay';
import type {
  ExternalSessionOperationPrivateStagingStore,
  ExternalSessionStagingSourceCapture,
  ExternalSessionStagingSourceObservation,
} from '@/session/external/staging/operationPrivateStaging';
import { garbageCollectUncommittedSessionMedia } from '@/session/media/garbageCollect';
import {
  ExternalSessionOperationRecordAdmissionError,
  ExternalSessionOperationRecordReadError,
  compactExternalSessionOperationRecordToTerminalReceipt,
  isExternalSessionOperationSettledForTerminalCleanup,
  mutateExternalSessionOperationRecordAtRevision,
  readExternalSessionOperationRecord,
  readExternalSessionOperationStoredEntry,
  resolveExternalSessionOperationStartAdmission,
  type ExternalSessionOperationPriorTerminalReceiptEvidence,
  type ExternalSessionOperationSelectedPresentationReader,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';
import {
  readExternalSessionOperationSharedPresentation,
} from './operationProgressPublisher';

export type ExternalSessionMaterializePage = Readonly<{
  groupId: string;
  items: readonly unknown[];
  sourceRead: ExternalSessionStagingSourceObservation;
  replayOrder?: number;
  requiredItemFailures?: ExternalSessionRequiredItemFailuresV1;
}>;

type MaterializeSourceDescription = Readonly<{
  capturedSource: ExternalSessionStagingSourceCapture;
  linkedSessionRevision: number;
}>;

export type ExternalSessionMaterializeSourceInterruptionCode =
  | 'source_unavailable'
  | 'source_changed';

type ExternalSessionMaterializeRecoverableInterruptionCode =
  | ExternalSessionMaterializeSourceInterruptionCode
  | 'staging_capacity_exceeded';

class ExternalSessionMaterializeRecoverableInterruptionError extends Error {
  readonly code: ExternalSessionMaterializeRecoverableInterruptionCode;

  constructor(
    code: ExternalSessionMaterializeRecoverableInterruptionCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExternalSessionMaterializeRecoverableInterruptionError';
    this.code = code;
  }
}

export class ExternalSessionMaterializeSourceInterruptionError
  extends ExternalSessionMaterializeRecoverableInterruptionError {
  constructor(code: ExternalSessionMaterializeSourceInterruptionCode, message: string) {
    super(code, message);
    this.name = 'ExternalSessionMaterializeSourceInterruptionError';
  }
}

export class ExternalSessionPersistedTakeoverPreflightError extends Error {
  readonly actionCode:
    | 'source_unavailable'
    | 'not_allowed'
    | 'reconciliation_required';

  constructor(
    actionCode:
      | 'source_unavailable'
      | 'not_allowed'
      | 'reconciliation_required',
    message: string,
  ) {
    super(message);
    this.name = 'ExternalSessionPersistedTakeoverPreflightError';
    this.actionCode = actionCode;
  }
}

export type ExternalSessionMaterializeActionExecutor = Readonly<{
  start(
    input: unknown,
    context?: Readonly<{
      signal?: AbortSignal;
      /** Host-stamped private contextual-author admission evidence. */
      authorIntent?: ExternalSessionOperationAuthorIntentV1;
      /**
       * Reports the durable operation record the moment it is committed and its
       * progress is published, so the Start action owner can return the public
       * operation reference while this call keeps driving the operation.
       */
      onAdmitted?: (record: ExternalSessionOperationRecordV1) => void;
    }>,
  ): Promise<ExternalSessionOperationActionResponseV1>;
  status(input: unknown): Promise<ExternalSessionOperationActionResponseV1>;
  cancel(input: unknown): Promise<ExternalSessionOperationActionResponseV1>;
  resume(input: unknown): Promise<ExternalSessionOperationActionResponseV1>;
  retry(input: unknown): Promise<ExternalSessionOperationActionResponseV1>;
  discard(input: unknown): Promise<ExternalSessionOperationActionResponseV1>;
  resumePersistedTakeover(
    input: unknown,
  ): Promise<ExternalSessionOperationActionResponseV1>;
  cleanupTerminalStaging?(
    operationId: string,
  ): Promise<'cleaned' | 'missing' | 'not_ready' | 'not_terminal'>;
}>;

type ImportBearingRequest =
  | Extract<ExternalSessionOperationRecordV1['request'], { plan: 'materialize' }>
  | (
    Extract<ExternalSessionOperationRecordV1['request'], { plan: 'takeover' }>
    & Readonly<{ targetStorageMode: 'persisted' }>
  );

function isImportBearingRequest(
  request: ExternalSessionOperationRecordV1['request'],
): request is ImportBearingRequest {
  return request.plan === 'materialize'
    || request.targetStorageMode === 'persisted';
}

export type ExternalSessionPersistedTakeoverImportRecord =
  ExternalSessionOperationRecordV1 & Readonly<{
    request: Extract<
      ExternalSessionOperationRecordV1['request'],
      { plan: 'takeover' }
    > & Readonly<{ targetStorageMode: 'persisted' }>;
  }>;

export type ExternalSessionPersistedTakeoverPreparation = (
  record: ExternalSessionPersistedTakeoverImportRecord,
) => Promise<Readonly<{
  workingDirectory: string;
  resumeFollowOnFailure(): Promise<void>;
}>>;

type MaterializeDependencies = Readonly<{
  activeServerDir: string;
  operationExclusion: ExternalSessionOperationExclusion;
  staging: ExternalSessionOperationPrivateStagingStore;
  describeSource(
    request: ImportBearingRequest,
  ): Promise<MaterializeSourceDescription>;
  releaseSourceCapture?(request: ImportBearingRequest): void;
  revalidateSource(
    request: ImportBearingRequest,
    capturedSource: ExternalSessionStagingSourceCapture,
    sourceSnapshotEvidenceRef: string,
  ): Promise<void>;
  readNewestFirstPages(
    request: ImportBearingRequest,
    workingDirectory: string | undefined,
  ): AsyncIterable<ExternalSessionMaterializePage>;
  readFinalCatchUpPages(
    request: ImportBearingRequest,
    sourceSnapshotEvidenceRef: string,
    workingDirectory: string | undefined,
  ): AsyncIterable<ExternalSessionMaterializePage>;
  createStagedItemPreparationPhase?(
    request: ImportBearingRequest,
    mode: 'validate' | 'publish',
    workingDirectory: string | undefined,
    operationId: string,
  ): Promise<ExternalSessionHistoricalImportPreparationPhase>;
  garbageCollectWorkspaceMedia?: typeof garbageCollectUncommittedSessionMedia;
  preparePersistedTakeover?: ExternalSessionPersistedTakeoverPreparation;
  sendHistoricalCommand(
    command: ExternalSessionOperationSocketCommandV1,
  ): Promise<ExternalSessionOperationSocketResponseV1>;
  publishProgress?(input: Readonly<{
    sessionId: string;
    progress: ReturnType<typeof projectExternalSessionOperationProgressV1>;
    allowDifferentTerminalReplacement?: boolean;
    expectedDifferentTerminalPresentation?:
      ExternalSessionOperationSharedPresentationV1;
  }>): Promise<ExternalSessionOperationRecordV1 | void>;
  convergeProgress?(
    record: ExternalSessionOperationRecordV1,
  ): Promise<ExternalSessionOperationRecordV1>;
  validateProgressSelection?(input: Readonly<{
    sessionId: string;
    progress: ReturnType<typeof projectExternalSessionOperationProgressV1>;
    priorTerminalRecords: readonly ExternalSessionOperationRecordV1[];
    priorTerminalReceiptEvidence?:
      readonly ExternalSessionOperationPriorTerminalReceiptEvidence[];
  }>): Promise<ExternalSessionOperationSharedPresentationV1 | undefined>;
  settlePriorTerminalProgressProjection?(
    priorTerminalRecords: readonly ExternalSessionOperationRecordV1[],
    incoming: ExternalSessionOperationRecordV1,
  ): Promise<void>;
  nowMs?: () => number;
  readSelectedPresentation?:
    ExternalSessionOperationSelectedPresentationReader;
}>;

const MAX_FINAL_CATCH_UP_ROUNDS = 32;
const MAX_FINAL_CATCH_UP_PAGES = 10_000;

function emptyRequiredItemFailures(): ExternalSessionRequiredItemFailuresV1 {
  return {
    total: 0,
    record: 0,
    media: 0,
    conversion: 0,
    diagnosticsTruncated: false,
    diagnostics: [],
  };
}

function appendRequiredItemFailures(
  target: {
    total: number;
    record: number;
    media: number;
    conversion: number;
    diagnosticsTruncated: boolean;
    diagnostics: ExternalSessionRequiredItemDiagnosticV1[];
  },
  failures: ExternalSessionRequiredItemFailuresV1 | undefined,
  sourcePageIndex: number,
): void {
  if (!failures) return;
  target.total += failures.total;
  target.record += failures.record;
  target.media += failures.media;
  target.conversion += failures.conversion;
  target.diagnosticsTruncated ||= failures.diagnosticsTruncated;
  for (const diagnostic of failures.diagnostics ?? []) {
    if (target.diagnostics.length >= EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1) {
      target.diagnosticsTruncated = true;
      break;
    }
    target.diagnostics.push({
      ...diagnostic,
      sourcePageIndex,
    });
  }
  target.diagnosticsTruncated ||=
    target.total > EXTERNAL_SESSION_REQUIRED_ITEM_DIAGNOSTIC_CAP_V1;
}

class MaterializeCancellationRequestedError extends Error {
  constructor() {
    super('Materialization cancellation was requested.');
    this.name = 'MaterializeCancellationRequestedError';
  }
}

class ExternalSessionOperationProgressPublishError extends Error {
  readonly committedRecord: ExternalSessionOperationRecordV1;
  readonly cause: unknown;

  constructor(
    committedRecord: ExternalSessionOperationRecordV1,
    cause: unknown,
  ) {
    super('External-session operation progress publication failed after commit.');
    this.name = 'ExternalSessionOperationProgressPublishError';
    this.committedRecord = committedRecord;
    this.cause = cause;
  }
}

async function readRecord(
  activeServerDir: string,
  operationId: string,
): Promise<ExternalSessionOperationRecordV1 | null> {
  return await readExternalSessionOperationRecord(activeServerDir, operationId);
}

async function readExactActionRecord(
  activeServerDir: string,
  sessionId: string,
  operationId: string,
): Promise<
  | Readonly<{ kind: 'record'; record: ExternalSessionOperationRecordV1 }>
  | Readonly<{ kind: 'terminal_receipt' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'missing' }>
> {
  let stored: Awaited<ReturnType<typeof readExternalSessionOperationStoredEntry>>;
  try {
    stored = await readExternalSessionOperationStoredEntry(
      activeServerDir,
      operationId,
    );
  } catch (error) {
    if (isExternalSessionOperationIdentityUnavailable(error)) {
      return { kind: 'unavailable' };
    }
    throw error;
  }
  if (!stored) return { kind: 'missing' };
  if (stored.kind === 'terminal_receipt') {
    return stored.receipt.reference.sessionId === sessionId
      ? { kind: 'terminal_receipt' }
      : { kind: 'missing' };
  }
  return stored.record.request.sessionId === sessionId
    ? { kind: 'record', record: stored.record }
    : { kind: 'missing' };
}

async function writeRecord(
  activeServerDir: string,
  record: ExternalSessionOperationRecordV1,
  settlePriorTerminalProgressProjection?:
    MaterializeDependencies['settlePriorTerminalProgressProjection'],
  validateProgressSelection?:
    MaterializeDependencies['validateProgressSelection'],
  nowMs?: () => number,
): Promise<Readonly<{
  record: ExternalSessionOperationRecordV1;
  expectedDifferentTerminalPresentation?:
    ExternalSessionOperationSharedPresentationV1;
}>> {
  let expectedDifferentTerminalPresentation:
    ExternalSessionOperationSharedPresentationV1 | undefined;
  const committedRecord = await writeExternalSessionOperationRecord(
    activeServerDir,
    record,
    {
      validateCurrent: (current, parsed) => {
        if (
          current
          && (current.status === 'cancel_requested' || current.status === 'cancelled')
          && parsed.status !== current.status
          && parsed.status !== 'discarded'
          && parsed.status !== 'completed'
        ) {
          throw new MaterializeCancellationRequestedError();
        }
      },
      ...(settlePriorTerminalProgressProjection
        ? { settlePriorTerminalProgressProjection }
        : {}),
      ...(validateProgressSelection
        ? {
          validateSessionAdmission: async (
            _current,
            incoming,
            priorTerminalRecords,
            priorTerminalReceiptEvidence,
          ) => {
            expectedDifferentTerminalPresentation =
              await validateProgressSelection({
                sessionId: incoming.request.sessionId,
                progress:
                  projectExternalSessionOperationProgressV1(incoming),
                priorTerminalRecords,
                priorTerminalReceiptEvidence,
              });
            return expectedDifferentTerminalPresentation;
          },
        }
        : {}),
      ...(nowMs ? { nowMs } : {}),
    },
  );
  return {
    record: committedRecord,
    ...(expectedDifferentTerminalPresentation
      ? { expectedDifferentTerminalPresentation }
      : {}),
  };
}

async function mutateRecordAtRevision(
  activeServerDir: string,
  operationId: string,
  expectedRevision: number,
  mutate: (
    current: ExternalSessionOperationRecordV1,
  ) => ExternalSessionOperationRecordV1,
): Promise<
  | Readonly<{ ok: true; record: ExternalSessionOperationRecordV1 }>
  | Readonly<{ ok: false; code: 'operation_not_found' | 'stale_revision' }>
> {
  return await mutateExternalSessionOperationRecordAtRevision(
    activeServerDir,
    operationId,
    expectedRevision,
    mutate,
  );
}

function success(record: ExternalSessionOperationRecordV1): ExternalSessionOperationActionResponseV1 {
  return {
    ok: true,
    progress: projectExternalSessionOperationProgressV1(record),
  };
}

function privateClaimForRecord(
  record: ExternalSessionOperationRecordV1,
): ExternalSessionOperationClaimV1 {
  return {
    sessionId: record.request.sessionId,
    operationId: record.operationId,
    operationClaimId: record.bindings.operationClaimId,
  };
}

function failure(
  code: Extract<ExternalSessionOperationActionResponseV1, { ok: false }>['error']['code'],
  message: string,
): ExternalSessionOperationActionResponseV1 {
  return { ok: false, error: { code, message } };
}

function isExternalSessionOperationIdentityUnavailable(error: unknown): boolean {
  return (
    error instanceof ExternalSessionOperationRecordReadError
    && (
      error.reason === 'account_scope_unavailable'
      || error.reason === 'legacy_unscoped'
    )
  ) || (
    error instanceof ExternalSessionOperationRecordAdmissionError
    && error.reason === 'legacy_unavailable'
  );
}

function emptyCheckpoint() {
  return {
    sourcePagesRead: 0,
    stagedItemCount: 0,
    importedItemCount: 0,
    requiredItemFailures: emptyRequiredItemFailures(),
  } as const;
}

function sourceInterruptionFromStagingState(
  sourceState: NonNullable<
    Extract<
      Awaited<ReturnType<ExternalSessionOperationPrivateStagingStore['appendPageGroup']>>,
      { status: 'refused' }
    >['sourceState']
  >,
): ExternalSessionMaterializeSourceInterruptionError {
  if (sourceState.outcome === 'replaced_or_rewritten') {
    return new ExternalSessionMaterializeSourceInterruptionError(
      'source_changed',
      'External session source was replaced or rewritten during materialization.',
    );
  }
  return new ExternalSessionMaterializeSourceInterruptionError(
    'source_unavailable',
    sourceState.outcome === 'deleted_or_unreachable'
      ? 'External session source was deleted or became unreachable during materialization.'
      : 'External session source continuity could not be verified during materialization.',
  );
}

export function createExternalSessionMaterializeActionExecutor(
  dependencies: MaterializeDependencies,
): ExternalSessionMaterializeActionExecutor {
  const nowMs = dependencies.nowMs ?? Date.now;
  const readSelectedPresentation =
    dependencies.readSelectedPresentation
    ?? readExternalSessionOperationSharedPresentation;
  const garbageCollectWorkspaceMedia = dependencies.garbageCollectWorkspaceMedia
    ?? garbageCollectUncommittedSessionMedia;
  const cleanupTerminalStaging = async (
    operationId: string,
  ): Promise<'cleaned' | 'missing' | 'not_ready' | 'not_terminal'> => {
    const current = await readRecord(dependencies.activeServerDir, operationId);
    if (!current) return 'missing';
    // Staging and workspace media are released for every settled operation.
    // Once that cleanup is durable, the record store may retain its existing
    // bounded receipt instead of the no-longer-actionable full record.
    if (
      !isExternalSessionOperationSettledForTerminalCleanup(current)
      || !isImportBearingRequest(current.request)
    ) {
      return 'not_terminal';
    }
    if (current.status === 'discarded') {
      const ownedWorkspaceMedia = await dependencies.staging
        .readCreatedWorkspaceMediaForCleanup({ operationId });
      const pathsByWorkingDirectory = new Map<string, string[]>();
      for (const owned of ownedWorkspaceMedia) {
        const paths = pathsByWorkingDirectory.get(owned.workingDirectory) ?? [];
        paths.push(owned.candidateWorkspaceRelativePath);
        pathsByWorkingDirectory.set(owned.workingDirectory, paths);
      }
      for (const [workingDirectory, candidateWorkspaceRelativePaths] of pathsByWorkingDirectory) {
        const cleaned = await garbageCollectWorkspaceMedia({
          workingDirectory,
          candidateWorkspaceRelativePaths,
          reason: 'interrupted_ingestion',
        });
        if (cleaned === null) {
          throw new Error('historical_import_staged_media_cleanup_failed');
        }
      }
      await dependencies.staging.acknowledgeCreatedWorkspaceMediaCleanup({
        operationId,
        media: ownedWorkspaceMedia,
      });
    }
    const cleaned = await dependencies.staging.cleanupTerminalOperation({
      operationId,
    });
    const stagingDisposition = cleaned.status === 'completed'
      ? 'cleaned' as const
      : cleaned.status;
    if (
      stagingDisposition === 'cleaned'
      || stagingDisposition === 'missing'
    ) {
      await compactExternalSessionOperationRecordToTerminalReceipt({
        activeServerDir: dependencies.activeServerDir,
        operationId,
        expectedRevision: current.revision,
        stagingDisposition,
      });
    }
    return stagingDisposition;
  };
  const activeCancellationByOperationId = new Map<string, AbortController>();
  const discardingOperationIds = new Set<string>();

  const publishCommittedProgress = async (
    record: ExternalSessionOperationRecordV1,
    options: Readonly<{
      allowDifferentTerminalReplacement?: boolean;
      expectedDifferentTerminalPresentation?:
        ExternalSessionOperationSharedPresentationV1;
    }> = {},
  ): Promise<ExternalSessionOperationRecordV1> => {
    const acknowledged = await dependencies.publishProgress?.({
      sessionId: record.request.sessionId,
      progress: projectExternalSessionOperationProgressV1(record),
      ...options,
    });
    return acknowledged ?? record;
  };

  const commitRecord = async (
    record: ExternalSessionOperationRecordV1,
  ): Promise<ExternalSessionOperationRecordV1> => {
    const admission = await writeRecord(
      dependencies.activeServerDir,
      record,
      dependencies.settlePriorTerminalProgressProjection,
      dependencies.validateProgressSelection,
      nowMs,
    );
    const committed = admission.record;
    try {
      return await publishCommittedProgress(committed, {
        ...(committed.revision === 0
          && admission.expectedDifferentTerminalPresentation
          ? {
            allowDifferentTerminalReplacement: true,
            expectedDifferentTerminalPresentation:
              admission.expectedDifferentTerminalPresentation,
          }
          : {}),
      });
    } catch (error) {
      throw new ExternalSessionOperationProgressPublishError(committed, error);
    }
  };

  const mutateCommittedRecordAtRevision = async (
    operationId: string,
    expectedRevision: number,
    mutate: (
      current: ExternalSessionOperationRecordV1,
    ) => ExternalSessionOperationRecordV1,
  ): ReturnType<typeof mutateRecordAtRevision> => {
    const result = await mutateRecordAtRevision(
      dependencies.activeServerDir,
      operationId,
      expectedRevision,
      mutate,
    );
    if (!result.ok) return result;
    try {
      const acknowledged = await publishCommittedProgress(result.record);
      return { ok: true as const, record: acknowledged };
    } catch (error) {
      throw new ExternalSessionOperationProgressPublishError(
        result.record,
        error,
      );
    }
  };

  const throwIfCancellationRequested = (operationId: string): void => {
    const signal = activeCancellationByOperationId.get(operationId)?.signal;
    if (signal?.aborted) throw new MaterializeCancellationRequestedError();
  };

  const inspectPriorStableStorage = async (input: Readonly<{
    request: ImportBearingRequest;
    operationId: string;
    operationClaimId: string;
    revision: number;
  }>): Promise<ExternalSessionPriorStableStorageV1> => {
    const response = await dependencies.sendHistoricalCommand({
      v: 1,
      kind: 'inspect',
      claim: {
        sessionId: input.request.sessionId,
        operationId: input.operationId,
        operationClaimId: input.operationClaimId,
      },
      expectedRevision: input.revision,
    });
    if (
      response.kind !== 'authority'
      || response.claim.sessionId !== input.request.sessionId
      || response.claim.operationId !== input.operationId
      || response.claim.operationClaimId !== input.operationClaimId
      || response.revision !== input.revision
    ) {
      throw new ExternalSessionMaterializeSourceInterruptionError(
        'source_unavailable',
        'Materialization private storage authority could not be inspected.',
      );
    }
    return response.priorStableStorage;
  };

  const markStagingDiscardRequired = async (
    record: ExternalSessionOperationRecordV1,
  ): Promise<void> => {
    const replay = await dependencies.staging.readReplayState(record.operationId);
    if (replay.status === 'missing' || replay.status === 'discard_required') return;
    const requestedAtMs = nowMs();
    await dependencies.staging.pauseOperation({
      operationId: record.operationId,
      expiresAtMs: requestedAtMs,
    });
    await dependencies.staging.markExpiredPausedWorkDiscardRequired({
      operationId: record.operationId,
      nowMs: requestedAtMs,
    });
  };

  const writeInterruptedRecord = async (
    record: ExternalSessionOperationRecordV1,
    error: unknown,
    retryTargetPhase: ExternalSessionOperationRecordV1['phase'],
  ): Promise<ExternalSessionOperationRecordV1> => {
    const recoverableInterruption =
      error instanceof ExternalSessionMaterializeRecoverableInterruptionError
      ? error
      : null;
    let interruptedRecord = record;
    const replay = await dependencies.staging
      .readReplayState(record.operationId)
      .catch((replayError) => {
        if (recoverableInterruption) throw replayError;
        return null;
      });
    if (
      replay
      && replay.status !== 'missing'
      && replay.acceptedThroughServerSeq !== null
    ) {
      const acceptedThroughServerSeq = replay.acceptedThroughServerSeq;
      const acknowledgedItemCount = replay.acknowledgedItemCount;
      if (
        acknowledgedItemCount > record.checkpoint.stagedItemCount
        || acknowledgedItemCount < record.checkpoint.importedItemCount
        || (
          record.checkpoint.acceptedThroughServerSeq !== undefined
          && acceptedThroughServerSeq < record.checkpoint.acceptedThroughServerSeq
        )
      ) {
        throw new Error('external_session_staging_checkpoint_conflict');
      }
      if (acknowledgedItemCount > 0) {
        interruptedRecord = {
          ...record,
          currentStorageState: record.priorStableStorage.state === 'machine_only'
            ? 'server_partial'
            : 'snapshot_complete',
          checkpoint: {
            ...record.checkpoint,
            importedItemCount: acknowledgedItemCount,
            acceptedThroughServerSeq,
            acknowledgedBatchId:
              record.checkpoint.acknowledgedBatchId
              ?? 'historical-import-checkpoint',
          },
          fence: record.priorStableStorage.state === 'machine_only'
            ? {
              kind: 'initial_server_partial',
              acceptedThroughServerSeq,
            }
            : {
              kind: 'incomplete_update',
              publication: record.priorStableStorage.publication,
            },
        };
      }
    }
    const interruptedAtMs = nowMs();
    return await commitRecord({
      ...interruptedRecord,
      revision: interruptedRecord.revision + 1,
      status: 'awaiting_user_resume',
      retryTargetPhase,
      updatedAtMs: interruptedAtMs,
      ...(recoverableInterruption
        ? {
          error: {
            code: recoverableInterruption.code,
            message: recoverableInterruption.message,
            retryable: true,
            occurredAtMs: interruptedAtMs,
          },
          fence: interruptedRecord.checkpoint.acceptedThroughServerSeq !== undefined
            ? interruptedRecord.priorStableStorage.state === 'snapshot_complete'
              ? {
                kind: 'incomplete_update' as const,
                publication: interruptedRecord.priorStableStorage.publication,
              }
              : {
                kind: 'initial_server_partial' as const,
                acceptedThroughServerSeq:
                  interruptedRecord.checkpoint.acceptedThroughServerSeq,
              }
            : interruptedRecord.priorStableStorage.state === 'snapshot_complete'
              ? {
                kind: 'incomplete_update' as const,
                publication: interruptedRecord.priorStableStorage.publication,
              }
              : { kind: 'none' as const },
        }
        : {}),
    });
  };

  const reconcileCheckpointAgainstDurableReceipt = async (
    record: ExternalSessionOperationRecordV1,
    options: Readonly<{
      deferMissingUntilServerResume?: boolean;
      onDeferredMissing?: () => void;
    }> = {},
  ): Promise<ExternalSessionOperationRecordV1 | null> => {
    const acceptedThroughServerSeq =
      record.checkpoint.acceptedThroughServerSeq;
    if (acceptedThroughServerSeq === undefined) return null;

    const replay = await dependencies.staging.readReplayState(
      record.operationId,
    );
    if (
      replay.status === 'missing'
      && options.deferMissingUntilServerResume === true
    ) {
      // Missing private replay state is ambiguous at this recovery boundary.
      // Let the canonical server distinguish finalized authority from lost staging.
      options.onDeferredMissing?.();
      return null;
    }
    const observedAcceptedThroughServerSeq =
      replay.status === 'missing'
        ? null
        : replay.acceptedThroughServerSeq;
    const observedAcknowledgedItemCount =
      replay.status === 'missing'
        ? 0
        : replay.acknowledgedItemCount;
    if (
      observedAcceptedThroughServerSeq !== null
      && observedAcceptedThroughServerSeq >= acceptedThroughServerSeq
      && observedAcknowledgedItemCount >= record.checkpoint.importedItemCount
      && observedAcknowledgedItemCount <= record.checkpoint.stagedItemCount
    ) {
      return null;
    }

    const reconciledAtMs = nowMs();
    const reconciled = await mutateCommittedRecordAtRevision(
      record.operationId,
      record.revision,
      (current) => ({
        ...current,
        revision: current.revision + 1,
        status: 'reconciliation_required',
        retryTargetPhase: current.phase,
        updatedAtMs: reconciledAtMs,
        error: {
          code: 'reconciliation_required',
          message:
            'Materialization checkpoint disagrees with its durable server receipt.',
          retryable: true,
          occurredAtMs: reconciledAtMs,
        },
        canonicalOwnerEvidence: {
          ...current.canonicalOwnerEvidence,
          disagreement: {
            owner: 'publication',
            expectedRevision: acceptedThroughServerSeq,
            observedRevision: observedAcceptedThroughServerSeq ?? 0,
          },
        },
      }),
    );
    if (!reconciled.ok) {
      throw new Error(
        `external_session_operation_receipt_reconciliation_${reconciled.code}`,
      );
    }
    return reconciled.record;
  };

  const finalizeCancellation = async (
    operationId: string,
  ): Promise<ExternalSessionOperationActionResponseV1> => {
    let current = await readRecord(dependencies.activeServerDir, operationId);
    if (!current) return failure('operation_not_found', 'Materialization operation was not found.');
    if (current.status === 'cancelled') return success(current);
    if (current.status !== 'cancel_requested' || !current.cancellation) {
      return failure('invalid_state', 'Materialization cancellation is no longer current.');
    }
    if (
      current.phase === 'importing'
      && current.bindings.historicalImportJobId !== undefined
    ) {
      const reconciled = await dependencies.sendHistoricalCommand({
        v: 1,
        kind: 'resume',
        claim: {
          sessionId: current.request.sessionId,
          operationId: current.operationId,
          operationClaimId: current.bindings.operationClaimId,
        },
        expectedRevision: current.revision,
      });
      if (reconciled.kind !== 'ready') {
        return failure(
          'invalid_state',
          'Materialization cancellation could not reconcile the historical import checkpoint.',
        );
      }
      if (
        JSON.stringify(reconciled.priorStableStorage)
          !== JSON.stringify(current.priorStableStorage)
      ) {
        return failure(
          'invalid_state',
          'Materialization cancellation prior storage authority changed.',
        );
      }
      current = {
        ...current,
        bindings: {
          ...current.bindings,
          historicalImportJobId: reconciled.historicalImportJobId,
        },
      };
      if (
        reconciled.acceptedThroughServerSeq !== undefined
      ) {
        const acceptedThroughServerSeq = reconciled.acceptedThroughServerSeq;
        current = {
          ...current,
          currentStorageState: current.priorStableStorage.state === 'machine_only'
            ? 'server_partial'
            : 'snapshot_complete',
          checkpoint: {
            ...current.checkpoint,
            acceptedThroughServerSeq,
            acknowledgedBatchId: 'historical-import-cancel-checkpoint',
          },
          fence: current.priorStableStorage.state === 'machine_only'
            ? { kind: 'initial_server_partial', acceptedThroughServerSeq }
            : {
              kind: 'incomplete_update',
              publication: current.priorStableStorage.publication,
            },
        };
      }
    }
    await markStagingDiscardRequired(current);
    const { retryTargetPhase: _retryTargetPhase, error: _error, ...withoutRecovery } = current;
    const terminal = await mutateCommittedRecordAtRevision(
      operationId,
      current.revision,
      (record) => ({
        ...record,
        ...withoutRecovery,
        revision: current.revision + 1,
        status: 'cancelled',
        updatedAtMs: nowMs(),
        terminalResult: { kind: 'cancelled' },
      }),
    );
    if (!terminal.ok) {
      return failure(
        terminal.code,
        terminal.code === 'stale_revision'
          ? 'Materialization operation revision is stale.'
          : 'Materialization operation was not found.',
      );
    }
    return success(terminal.record);
  };

  const continueHistoricalImport = async (
    initialRecord: ExternalSessionOperationRecordV1,
    commandKind: 'begin' | 'resume',
    claimMaintenance: ExternalSessionOperationClaimMaintenance,
    onRecord: (record: ExternalSessionOperationRecordV1) => void,
    workingDirectory?: string,
  ): Promise<ExternalSessionOperationActionResponseV1> => {
    let record = initialRecord;
    const operationId = record.operationId;
    const request = record.request;
    if (!isImportBearingRequest(request)) {
      return failure('invalid_state', 'Operation does not carry a historical import.');
    }
    const claim: ExternalSessionOperationClaimV1 = {
      sessionId: request.sessionId,
      operationId,
      operationClaimId: record.bindings.operationClaimId,
    };

    const settleFinalized = async (
      acceptedThroughServerSeq: number,
      publication: ExternalSessionMaterializationPublicationV1 | undefined,
    ): Promise<ExternalSessionOperationActionResponseV1> => {
      if (!publication) {
        throw new Error('external_session_finalized_publication_unavailable');
      }
      const {
        retryTargetPhase: _retryTargetPhase,
        error: _error,
        ...recordWithoutRetry
      } = record;
      claimMaintenance.throwIfLost();
      const isPersistedTakeover = record.request.plan === 'takeover'
        && record.request.targetStorageMode === 'persisted';
      record = await claimMaintenance.race(() => commitRecord({
        ...recordWithoutRetry,
        revision: record.revision + 1,
        status: isPersistedTakeover ? 'awaiting_user_resume' : 'completed',
        phase: isPersistedTakeover ? 'admitting' : 'publishing',
        updatedAtMs: nowMs(),
        currentStorageState: 'snapshot_complete',
        checkpoint: {
          ...record.checkpoint,
          importedItemCount: record.checkpoint.stagedItemCount,
          acceptedThroughServerSeq,
          acknowledgedBatchId: 'historical-import-complete',
        },
        fence: { kind: 'none' },
        publication,
        ...(isPersistedTakeover
          ? { retryTargetPhase: 'admitting' as const }
          : { terminalResult: { kind: 'completed' as const } }),
      }));
      if (isPersistedTakeover) {
        return success(record);
      }
      try {
        await claimMaintenance.race(
          () => cleanupTerminalStaging(operationId),
        );
      } catch {
        // The durable terminal result is authoritative; bounded staging remains
        // available to the existing retention owner when immediate cleanup fails.
      }
      return success(record);
    };

    const settleDiscarded = async (): Promise<ExternalSessionOperationActionResponseV1> => {
      await claimMaintenance.race(() => markStagingDiscardRequired(record));
      const {
        retryTargetPhase: _retryTargetPhase,
        error: _error,
        cancellation: _cancellation,
        publication: _publication,
        terminalResult: _terminalResult,
        ...recordWithoutRecovery
      } = record;
      record = await claimMaintenance.race(() => commitRecord({
        ...recordWithoutRecovery,
        revision: record.revision + 1,
        status: 'discarded',
        updatedAtMs: nowMs(),
        currentStorageState: 'machine_only',
        checkpoint: emptyCheckpoint(),
        bindings: {
          operationClaimId: record.bindings.operationClaimId,
        },
        fence: { kind: 'none' },
        terminalResult: { kind: 'discarded' },
      }));
      try {
        await claimMaintenance.race(
          () => cleanupTerminalStaging(operationId),
        );
      } catch {
        // The durable discard is authoritative; bounded staging remains under
        // the existing retention owner when immediate cleanup fails.
      }
      return success(record);
    };

    const reconcileDurableCaptureCheckpoint = async (): Promise<void> => {
      const durableCapture = await claimMaintenance.race(
        () => dependencies.staging.readCaptureCheckpoint({ operationId }),
      );
      if (
        durableCapture.status === 'missing'
        || durableCapture.captureState !== 'complete'
      ) {
        return;
      }
      if (
        durableCapture.sourcePagesRead < record.checkpoint.sourcePagesRead
        || durableCapture.stagedItemCount < record.checkpoint.stagedItemCount
        || record.checkpoint.importedItemCount > durableCapture.stagedItemCount
      ) {
        throw new Error('external_session_staging_checkpoint_conflict');
      }
      if (
        durableCapture.sourcePagesRead === record.checkpoint.sourcePagesRead
        && durableCapture.stagedItemCount === record.checkpoint.stagedItemCount
        && (
          durableCapture.capturedThroughSourceRevision === null
          || durableCapture.capturedThroughSourceRevision
            === record.canonicalOwnerEvidence.sourceSnapshotEvidenceRef
        )
      ) {
        return;
      }
      if (durableCapture.capturedThroughSourceRevision === null) {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_unavailable',
          'Materialization cannot recover the final source revision from private staging.',
        );
      }
      const capturedThroughSourceRevision =
        durableCapture.capturedThroughSourceRevision;
      try {
        const reconciled = await claimMaintenance.race(
          () => mutateCommittedRecordAtRevision(
            record.operationId,
            record.revision,
            (current) => ({
              ...current,
              revision: current.revision + 1,
              updatedAtMs: nowMs(),
              checkpoint: {
                ...current.checkpoint,
                sourcePagesRead: durableCapture.sourcePagesRead,
                stagedItemCount: durableCapture.stagedItemCount,
              },
              canonicalOwnerEvidence: {
                ...current.canonicalOwnerEvidence,
                sourceSnapshotEvidenceRef: capturedThroughSourceRevision,
              },
            }),
          ),
        );
        if (!reconciled.ok) {
          throw new Error(
            `external_session_operation_capture_checkpoint_${reconciled.code}`,
          );
        }
        record = reconciled.record;
        onRecord(record);
      } catch (error) {
        if (error instanceof ExternalSessionOperationProgressPublishError) {
          record = error.committedRecord;
          onRecord(record);
        }
        throw error;
      }
    };

    claimMaintenance.throwIfLost();
    throwIfCancellationRequested(operationId);
    if (commandKind === 'resume') {
      await claimMaintenance.race(
        () => dependencies.staging.rollbackUnacknowledgedCaptureExtension({ operationId }),
      );
      await reconcileDurableCaptureCheckpoint();
    }
    const ready = await claimMaintenance.race(
      () => dependencies.sendHistoricalCommand(
        commandKind === 'begin'
          ? {
            v: 1,
            kind: 'begin',
            claim,
            expectedRevision: record.revision,
            expectedPriorStableStorage: record.priorStableStorage,
          }
          : {
            v: 1,
            kind: 'resume',
            claim,
            expectedRevision: record.revision,
          },
      ),
    );
    throwIfCancellationRequested(operationId);
    if (ready.kind === 'finalized') {
      return await settleFinalized(
        ready.acceptedThroughServerSeq,
        ready.publication,
      );
    }
    if (ready.kind === 'discarded') {
      return await settleDiscarded();
    }
    if (ready.kind !== 'ready') {
      throw new Error(`historical_${commandKind}:${ready.kind === 'error' ? ready.errorCode : 'invalid'}`);
    }
    if (
      JSON.stringify(ready.priorStableStorage)
        !== JSON.stringify(record.priorStableStorage)
    ) {
      throw new ExternalSessionMaterializeSourceInterruptionError(
        'source_changed',
        'Materialization prior storage authority changed before historical import.',
      );
    }
    if (ready.acceptedThroughServerSeq !== undefined) {
      const recoveredReplay = await claimMaintenance.race(
        () => dependencies.staging.readReplayState(operationId),
      );
      // A row ACK is durable local fact. The server may legitimately be ahead
      // after a crash before a later local ACK, because replay can resend that
      // content-addressed batch. It may never be behind a recovered local ACK.
      if (
        recoveredReplay.status !== 'missing'
        && recoveredReplay.acceptedThroughServerSeq !== null
        && ready.acceptedThroughServerSeq
          < recoveredReplay.acceptedThroughServerSeq
      ) {
        throw new Error('external_session_historical_server_checkpoint_regressed');
      }
    }
    claimMaintenance.throwIfLost();
    throwIfCancellationRequested(operationId);
    record = await claimMaintenance.race(() => commitRecord({
      ...record,
      revision: record.revision + 1,
      updatedAtMs: nowMs(),
      bindings: {
        ...record.bindings,
        historicalImportJobId: ready.historicalImportJobId,
      },
    }));
    onRecord(record);

    const serverCommandRevision = ready.revision;
    const replay = createExternalSessionHistoricalImportReplay({
      staging: dependencies.staging,
      sourceGeneration: request.source.sourceGeneration,
      maxBatchItems: ready.limits.maxItems,
      ...(dependencies.createStagedItemPreparationPhase
        ? {
          createPreparationPhase: (mode: 'validate' | 'publish', operationId: string) =>
            dependencies.createStagedItemPreparationPhase!(
              request,
              mode,
              workingDirectory,
              operationId,
            ),
        }
        : {}),
      isBatchWithinSerializedByteLimit: (batch) => validateExternalSessionOperationSocketBatchV1({
        v: 1,
        kind: 'batch',
        claim,
        expectedRevision: serverCommandRevision,
        batchId: batch.batchId,
        items: batch.items,
      }, ready.limits).ok,
      writeHistoricalBatch: async (batch) => {
        claimMaintenance.throwIfLost();
        throwIfCancellationRequested(operationId);
        const response = await claimMaintenance.race(() => dependencies.sendHistoricalCommand({
          v: 1,
          kind: 'batch',
          claim,
          expectedRevision: serverCommandRevision,
          batchId: batch.batchId,
          items: batch.items,
        }));
        throwIfCancellationRequested(operationId);
        return response.kind === 'batch_accepted'
          ? {
            ok: true as const,
            batchId: response.batchId,
            acceptedThroughServerSeq: response.acceptedThroughServerSeq,
          }
          : { ok: false as const, error: response.kind === 'error' ? response.errorCode : 'invalid_response' };
      },
      onReplayGroupAcknowledged: async (checkpoint) => {
        const acceptedThroughServerSeq = checkpoint.acceptedThroughServerSeq;
        const expectedStorageState =
          record.priorStableStorage.state === 'machine_only'
            ? 'server_partial'
            : 'snapshot_complete';
        if (
          record.currentStorageState === expectedStorageState
          && record.checkpoint.importedItemCount
            === checkpoint.acknowledgedItemCount
          && record.checkpoint.acceptedThroughServerSeq
            === acceptedThroughServerSeq
          && record.checkpoint.acknowledgedBatchId !== undefined
        ) {
          return;
        }
        try {
          const acknowledged = await claimMaintenance.race(
            () => mutateCommittedRecordAtRevision(
              record.operationId,
              record.revision,
              (current) => ({
                ...current,
                revision: current.revision + 1,
                updatedAtMs: nowMs(),
                currentStorageState:
                  current.priorStableStorage.state === 'machine_only'
                    ? 'server_partial'
                    : 'snapshot_complete',
                checkpoint: {
                  ...current.checkpoint,
                  importedItemCount: checkpoint.acknowledgedItemCount,
                  acceptedThroughServerSeq,
                  acknowledgedBatchId: checkpoint.groupId,
                },
                fence: current.priorStableStorage.state === 'machine_only'
                  ? {
                    kind: 'initial_server_partial' as const,
                    acceptedThroughServerSeq,
                  }
                  : {
                    kind: 'incomplete_update' as const,
                    publication: current.priorStableStorage.publication,
                  },
              }),
            ),
          );
          if (!acknowledged.ok) {
            throwIfCancellationRequested(record.operationId);
            throw new Error(
              `external_session_operation_checkpoint_${acknowledged.code}`,
            );
          }
          record = acknowledged.record;
          onRecord(record);
        } catch (error) {
          if (error instanceof ExternalSessionOperationProgressPublishError) {
            record = error.committedRecord;
            onRecord(record);
          }
          throw error;
        }
      },
    });
    const replayed = await claimMaintenance.race(() => replay.resume(operationId));
    throwIfCancellationRequested(operationId);
    if (replayed.status === 'discard_required') {
      return await settleDiscarded();
    }
    if (replayed.status !== 'completed') {
      if (
        replayed.reason === 'staging_missing'
        && record.checkpoint.acceptedThroughServerSeq !== undefined
      ) {
        const reconciled = await claimMaintenance.race(
          () => reconcileCheckpointAgainstDurableReceipt(record),
        );
        if (reconciled) return success(reconciled);
      }
      const accepted = replayed.acceptedThroughServerSeq;
      claimMaintenance.throwIfLost();
      throwIfCancellationRequested(operationId);
      record = await claimMaintenance.race(() => commitRecord({
        ...record,
        revision: record.revision + 1,
        status: 'awaiting_user_resume',
        retryTargetPhase: 'importing',
        updatedAtMs: nowMs(),
        currentStorageState: accepted === null
          ? record.priorStableStorage.state
          : record.priorStableStorage.state === 'machine_only'
            ? 'server_partial'
            : 'snapshot_complete',
        checkpoint: {
          ...record.checkpoint,
          ...(replayed.reason === 'required_items_failed' && replayed.requiredItemFailures
            ? { requiredItemFailures: replayed.requiredItemFailures }
            : {}),
          ...(accepted === null
            ? {}
            : {
              acceptedThroughServerSeq: accepted,
              acknowledgedBatchId: 'historical-import-checkpoint',
            }),
        },
        fence: accepted === null
          ? { kind: 'none' }
          : record.priorStableStorage.state === 'machine_only'
            ? { kind: 'initial_server_partial', acceptedThroughServerSeq: accepted }
            : { kind: 'incomplete_update', publication: record.priorStableStorage.publication },
        ...(replayed.reason === 'required_items_failed'
          ? {
            error: {
              code: 'required_items_failed' as const,
              message: 'One or more required source records could not be imported.',
              retryable: true,
              occurredAtMs: nowMs(),
            },
          }
          : replayed.reason === 'historical_import_failed'
            ? {
              error: {
                code: 'historical_import_failed' as const,
                message: 'Historical import could not publish a staged batch.',
                retryable: true,
                occurredAtMs: nowMs(),
              },
            }
            : {}),
      }));
      onRecord(record);
      return success(record);
    }

    let acceptedThroughServerSeq = replayed.acceptedThroughServerSeq ?? 0;
    const persistAcceptedCheckpoint = async (): Promise<void> => {
      if (
        record.checkpoint.stagedItemCount === 0
        && record.checkpoint.importedItemCount === 0
        && acceptedThroughServerSeq === 0
      ) {
        return;
      }
      const expectedStorageState =
        record.priorStableStorage.state === 'machine_only'
          ? 'server_partial'
          : 'snapshot_complete';
      if (
        record.currentStorageState === expectedStorageState
        && record.checkpoint.importedItemCount
          === record.checkpoint.stagedItemCount
        && record.checkpoint.acceptedThroughServerSeq
          === acceptedThroughServerSeq
        && record.checkpoint.acknowledgedBatchId !== undefined
      ) {
        return;
      }
      try {
        const persisted = await claimMaintenance.race(
          () => mutateCommittedRecordAtRevision(
            record.operationId,
            record.revision,
            (current) => ({
              ...current,
              revision: current.revision + 1,
              updatedAtMs: nowMs(),
              currentStorageState: current.priorStableStorage.state === 'machine_only'
                ? 'server_partial'
                : 'snapshot_complete',
              checkpoint: {
                ...current.checkpoint,
                importedItemCount: current.checkpoint.stagedItemCount,
                acceptedThroughServerSeq,
                acknowledgedBatchId: 'historical-import-checkpoint',
              },
              fence: current.priorStableStorage.state === 'machine_only'
                ? {
                  kind: 'initial_server_partial' as const,
                  acceptedThroughServerSeq,
                }
                : {
                  kind: 'incomplete_update' as const,
                  publication: current.priorStableStorage.publication,
                },
            }),
          ),
        );
        if (!persisted.ok) {
          throwIfCancellationRequested(record.operationId);
          throw new Error(
            `external_session_operation_checkpoint_${persisted.code}`,
          );
        }
        record = persisted.record;
        onRecord(record);
      } catch (error) {
        if (error instanceof ExternalSessionOperationProgressPublishError) {
          record = error.committedRecord;
          onRecord(record);
        }
        throw error;
      }
    };
    await persistAcceptedCheckpoint();

    if (
      record.request.plan === 'takeover'
      && record.request.targetStorageMode === 'persisted'
      && record.phase !== 'final_catch_up'
    ) {
      record = await claimMaintenance.race(() => commitRecord({
        ...record,
        revision: record.revision + 1,
        phase: 'final_catch_up',
        updatedAtMs: nowMs(),
      }));
      onRecord(record);
    }

    let sourceStabilized = false;
    for (let round = 0; round < MAX_FINAL_CATCH_UP_ROUNDS; round += 1) {
      const sourceSnapshotEvidenceRef =
        record.canonicalOwnerEvidence.sourceSnapshotEvidenceRef;
      if (!sourceSnapshotEvidenceRef) {
        throw new ExternalSessionMaterializeSourceInterruptionError(
          'source_unavailable',
          'Materialization source evidence is unavailable for final catch-up.',
        );
      }
      const pages = dependencies.readFinalCatchUpPages(
        request,
        sourceSnapshotEvidenceRef,
        workingDirectory,
      )[Symbol.asyncIterator]();
      let next = await claimMaintenance.race(() => pages.next());
      if (next.done) {
        sourceStabilized = true;
        break;
      }

      const extension = await claimMaintenance.race(
        () => dependencies.staging.reopenAcknowledgedCapture({ operationId }),
      );
      let extensionPageCount = 0;
      let extensionItemCount = 0;
      let capturedThroughSourceRevision = sourceSnapshotEvidenceRef;
      const requiredItemFailures = {
        ...emptyRequiredItemFailures(),
        diagnostics: [] as ExternalSessionRequiredItemDiagnosticV1[],
      };
      try {
        while (!next.done) {
          if (extensionPageCount >= MAX_FINAL_CATCH_UP_PAGES) {
            throw new ExternalSessionMaterializeSourceInterruptionError(
              'source_unavailable',
              'Materialization final catch-up exceeded its bounded page limit.',
            );
          }
          const page = next.value;
          const captureIndex = extension.nextCaptureIndex + extensionPageCount;
          const staged = await claimMaintenance.race(
            () => dependencies.staging.appendPageGroup({
              operationId,
              captureIndex,
              replayOrder: page.replayOrder
                ?? extension.nextReplayOrder - extensionPageCount,
              groupId: page.groupId,
              items: page.items,
              sourceRead: page.sourceRead,
            }),
          );
          if (staged.status === 'refused') {
            if (staged.reason === 'source_state_not_storable' && staged.sourceState) {
              throw sourceInterruptionFromStagingState(staged.sourceState);
            }
            throw new ExternalSessionMaterializeRecoverableInterruptionError(
              'staging_capacity_exceeded',
              'Materialization private staging capacity was exceeded.',
            );
          }
          if (page.sourceRead.availability === 'reachable') {
            capturedThroughSourceRevision = page.sourceRead.revision;
          }
          appendRequiredItemFailures(
            requiredItemFailures,
            page.requiredItemFailures,
            captureIndex,
          );
          extensionPageCount += 1;
          extensionItemCount += page.items.length;
          next = await claimMaintenance.race(() => pages.next());
        }
        await claimMaintenance.race(() => dependencies.staging.completeCapture({ operationId }));
      } catch (error) {
        await dependencies.staging.rollbackUnacknowledgedCaptureExtension({
          operationId,
        }).catch(() => undefined);
        throw error;
      } finally {
        if (pages.return) void pages.return().catch(() => undefined);
      }

      if (requiredItemFailures.total > 0) {
        await claimMaintenance.race(
          () => dependencies.staging.rollbackUnacknowledgedCaptureExtension({ operationId }),
        );
        const interruptedAtMs = nowMs();
        record = await claimMaintenance.race(() => commitRecord({
          ...record,
          revision: record.revision + 1,
          status: 'awaiting_user_resume',
          retryTargetPhase: 'importing',
          updatedAtMs: interruptedAtMs,
          checkpoint: {
            ...record.checkpoint,
            requiredItemFailures,
          },
          error: {
            code: 'required_items_failed',
            message: 'One or more required source records could not be imported.',
            retryable: true,
            occurredAtMs: interruptedAtMs,
          },
        }));
        onRecord(record);
        return success(record);
      }

      record = await claimMaintenance.race(() => commitRecord({
        ...record,
        revision: record.revision + 1,
        updatedAtMs: nowMs(),
        checkpoint: {
          ...record.checkpoint,
          sourcePagesRead: record.checkpoint.sourcePagesRead + extensionPageCount,
          stagedItemCount: record.checkpoint.stagedItemCount + extensionItemCount,
          requiredItemFailures: emptyRequiredItemFailures(),
        },
        canonicalOwnerEvidence: {
          ...record.canonicalOwnerEvidence,
          sourceSnapshotEvidenceRef: capturedThroughSourceRevision,
        },
      }));
      onRecord(record);
      const catchUpReplay = await claimMaintenance.race(() => replay.resume(operationId));
      if (catchUpReplay.status !== 'completed') {
        throw new Error(`historical_final_catch_up:${catchUpReplay.status}`);
      }
      acceptedThroughServerSeq = catchUpReplay.acceptedThroughServerSeq ?? acceptedThroughServerSeq;
      await persistAcceptedCheckpoint();
    }
    if (!sourceStabilized) {
      throw new ExternalSessionMaterializeSourceInterruptionError(
        'source_unavailable',
        'Materialization final catch-up could not stabilize within its bounded round limit.',
      );
    }
    claimMaintenance.throwIfLost();
    throwIfCancellationRequested(operationId);
    const finalized = await claimMaintenance.race(() => dependencies.sendHistoricalCommand({
      v: 1,
      kind: 'finalize',
      claim,
      expectedRevision: serverCommandRevision,
      expectedAcceptedThroughServerSeq: acceptedThroughServerSeq,
    }));
    if (finalized.kind !== 'finalized') {
      throw new Error(`historical_finalize:${finalized.kind === 'error' ? finalized.errorCode : 'invalid'}`);
    }
    return await settleFinalized(
      acceptedThroughServerSeq,
      finalized.publication,
    );
  };

  const stageAndImport = async (
    initialRecord: ExternalSessionOperationRecordV1,
    source: MaterializeSourceDescription,
    claimMaintenance: ExternalSessionOperationClaimMaintenance,
    onRecord: (record: ExternalSessionOperationRecordV1) => void,
    workingDirectory?: string,
  ): Promise<ExternalSessionOperationActionResponseV1> => {
    let record = initialRecord;
    const operationId = record.operationId;
    const request = record.request;
    if (!isImportBearingRequest(request)) {
      return failure('invalid_state', 'Operation does not carry a historical import.');
    }
    claimMaintenance.throwIfLost();
    throwIfCancellationRequested(operationId);
    const stagingReference = await claimMaintenance.race(() => dependencies.staging.beginOperation({
      operationId,
      representation: 'content',
      capturedSource: source.capturedSource,
    }));
    throwIfCancellationRequested(operationId);
    if (stagingReference.status === 'conflict') {
      throw new ExternalSessionMaterializeSourceInterruptionError(
        'source_changed',
        'External session source no longer matches the staged capture.',
      );
    }
    if (stagingReference.status !== 'ready') {
      throw new Error(`staging_${stagingReference.status}`);
    }
    claimMaintenance.throwIfLost();
    throwIfCancellationRequested(operationId);
    const validatingRecord = record;
    record = await claimMaintenance.race(() => commitRecord({
      ...validatingRecord,
      revision: validatingRecord.revision + 1,
      phase: validatingRecord.phase === 'importing'
        ? 'importing'
        : 'staging',
      updatedAtMs: nowMs(),
      bindings: {
        ...validatingRecord.bindings,
        privateStagingId: stagingReference.stagingReference,
      },
    }));
    onRecord(record);

    let sourcePagesRead = 0;
    let stagedItemCount = 0;
    let capturedThroughSourceRevision = source.capturedSource.revision;
    const requiredItemFailures = {
      ...emptyRequiredItemFailures(),
      diagnostics: [] as ExternalSessionRequiredItemDiagnosticV1[],
    };
    const pages = dependencies.readNewestFirstPages(
      request,
      workingDirectory,
    )[Symbol.asyncIterator]();
    try {
      while (true) {
        claimMaintenance.throwIfLost();
        throwIfCancellationRequested(operationId);
        const next = await claimMaintenance.race(() => pages.next());
        throwIfCancellationRequested(operationId);
        if (next.done) break;
        const page = next.value;
        claimMaintenance.throwIfLost();
        throwIfCancellationRequested(operationId);
        const staged = await claimMaintenance.race(() => dependencies.staging.appendPageGroup({
          operationId,
          captureIndex: sourcePagesRead,
          ...(page.replayOrder === undefined ? {} : { replayOrder: page.replayOrder }),
          groupId: page.groupId,
          items: page.items,
          sourceRead: page.sourceRead,
        }));
        throwIfCancellationRequested(operationId);
        if (staged.status === 'refused') {
          if (staged.reason === 'source_state_not_storable' && staged.sourceState) {
            throw sourceInterruptionFromStagingState(staged.sourceState);
          }
          throw new ExternalSessionMaterializeRecoverableInterruptionError(
            'staging_capacity_exceeded',
            'Materialization private staging capacity was exceeded.',
          );
        }
        if (page.sourceRead.availability === 'reachable') {
          capturedThroughSourceRevision = page.sourceRead.revision;
        }
        sourcePagesRead += 1;
        stagedItemCount += page.items.length;
        appendRequiredItemFailures(
          requiredItemFailures,
          page.requiredItemFailures,
          sourcePagesRead - 1,
        );
      }
    } finally {
      if (
        (claimMaintenance.signal.aborted
          || activeCancellationByOperationId.get(operationId)?.signal.aborted)
        && pages.return
      ) {
        void pages.return().catch(() => undefined);
      }
    }
    claimMaintenance.throwIfLost();
    throwIfCancellationRequested(operationId);
    await claimMaintenance.race(() => dependencies.staging.completeCapture({ operationId }));
    throwIfCancellationRequested(operationId);

    claimMaintenance.throwIfLost();
    throwIfCancellationRequested(operationId);
    const stagingRecord = record;
    const hasRequiredItemFailures = requiredItemFailures.total > 0;
    const {
      retryTargetPhase: _retryTargetPhase,
      error: _error,
      ...stagingRecordWithoutRecovery
    } = stagingRecord;
    record = await claimMaintenance.race(() => commitRecord({
      ...stagingRecordWithoutRecovery,
      revision: stagingRecord.revision + 1,
      ...(hasRequiredItemFailures
        ? {
          status: 'awaiting_user_resume' as const,
          retryTargetPhase: 'importing' as const,
          error: {
            code: 'required_items_failed' as const,
            message: 'One or more required source records could not be imported.',
            retryable: true,
            occurredAtMs: nowMs(),
          },
        }
        : {}),
      phase: 'importing',
      updatedAtMs: nowMs(),
      checkpoint: {
        ...stagingRecord.checkpoint,
        sourcePagesRead,
        stagedItemCount,
        requiredItemFailures,
      },
      canonicalOwnerEvidence: {
        ...stagingRecord.canonicalOwnerEvidence,
        sourceSnapshotEvidenceRef: capturedThroughSourceRevision,
      },
    }));
    onRecord(record);
    if (hasRequiredItemFailures) return success(record);
    return await continueHistoricalImport(
      record,
      record.bindings.historicalImportJobId ? 'resume' : 'begin',
      claimMaintenance,
      onRecord,
      workingDirectory,
    );
  };

  const continueExplicitly = async (
    raw: unknown,
    intent: 'resume' | 'retry',
    operationKind: 'materialize' | 'persisted_takeover' = 'materialize',
  ): Promise<ExternalSessionOperationActionResponseV1> => {
    const schema = intent === 'resume'
      ? ExternalSessionOperationResumeInputV1Schema
      : ExternalSessionOperationRetryInputV1Schema;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return failure('invalid_state', `Invalid materialization ${intent} request.`);
    const stored = await readExactActionRecord(
      dependencies.activeServerDir,
      parsed.data.sessionId,
      parsed.data.operationId,
    );
    if (stored.kind === 'unavailable') {
      return failure(
        'source_unavailable',
        'Materialization operation identity is unavailable.',
      );
    }
    if (stored.kind === 'terminal_receipt') {
      return failure(
        'invalid_state',
        'The settled operation no longer has private recovery state.',
      );
    }
    if (stored.kind === 'missing') {
      return failure('operation_not_found', 'Materialization operation was not found.');
    }
    const current = stored.record;
    if (current.revision !== parsed.data.revision) {
      return failure('stale_revision', 'Materialization operation revision is stale.');
    }
    const isPersistedTakeover = current.request.plan === 'takeover'
      && current.request.targetStorageMode === 'persisted';
    if (
      current.status !== 'awaiting_user_resume'
      || (
        operationKind === 'materialize'
          ? current.request.plan !== 'materialize'
          : !isPersistedTakeover
      )
    ) {
      return failure('invalid_state', `Materialization cannot ${intent} from its current phase.`);
    }
    const isRequiredItemCorrectionResume = intent === 'resume'
      && current.phase === 'importing'
      && current.checkpoint.requiredItemFailures.total > 0;
    const isUnpublishedRequiredItemCorrectionResume =
      isRequiredItemCorrectionResume
      && current.checkpoint.acceptedThroughServerSeq === undefined;
    if (
      current.checkpoint.requiredItemFailures.total > 0
      && !isRequiredItemCorrectionResume
    ) {
      return failure(
        'not_allowed',
        intent === 'retry'
          ? 'Materialization required-item correction requires explicit Resume.'
          : 'Materialization cannot rebuild required items after server acceptance.',
      );
    }
    const isImportRecovery = (
      current.phase === 'importing'
      || current.phase === 'publishing'
      || (
        operationKind === 'persisted_takeover'
        && current.phase === 'final_catch_up'
      )
    )
      && !isUnpublishedRequiredItemCorrectionResume;
    const isValidatingRetry = current.phase === 'validating'
      && (
        (operationKind === 'materialize' && intent === 'retry')
        || (operationKind === 'persisted_takeover' && intent === 'resume')
      );
    const isPersistedTakeoverQuiescingResume =
      operationKind === 'persisted_takeover'
      && intent === 'resume'
      && current.phase === 'quiescing'
      && current.retryTargetPhase === 'validating';
    const isStagingResume = intent === 'resume' && current.phase === 'staging';
    if (intent === 'retry' && current.phase === 'staging') {
      return failure(
        'not_allowed',
        'Materialization staging Retry requires durable capture reset proof.',
      );
    }
    if (
      !isImportRecovery
      && !isRequiredItemCorrectionResume
      && !isValidatingRetry
      && !isPersistedTakeoverQuiescingResume
      && !isStagingResume
    ) {
      return failure('invalid_state', `Materialization cannot ${intent} from its current phase.`);
    }
    if (
      operationKind === 'materialize'
      &&
      isValidatingRetry
      && (
        current.priorStableStorage.state !== 'machine_only'
        || current.currentStorageState !== 'machine_only'
        || current.checkpoint.acceptedThroughServerSeq !== undefined
        || current.bindings.historicalImportJobId !== undefined
        || current.bindings.privateStagingId !== undefined
      )
    ) {
      return failure(
        'not_allowed',
        'Materialization validating Retry requires zero accepted rows and machine-only storage.',
      );
    }

    const request: ImportBearingRequest = operationKind === 'materialize'
      ? current.request as Extract<
        ExternalSessionOperationRecordV1['request'],
        { plan: 'materialize' }
      >
      : (
        current as ExternalSessionPersistedTakeoverImportRecord
      ).request;
    const acquired = await dependencies.operationExclusion.acquire(
      operationKind === 'materialize'
        ? {
          kind: 'materialize',
          sessionId: request.sessionId,
          requestId: request.idempotencyKey,
          sourceIdentity: JSON.stringify(request.source.qualifiedIdentity),
          sourceGeneration: request.source.sourceGeneration,
        }
        : {
          kind: 'takeover',
          sessionId: request.sessionId,
          requestId: request.idempotencyKey,
          sourceIdentity: JSON.stringify(request.source.qualifiedIdentity),
          sourceGeneration: request.source.sourceGeneration,
          plan: 'persisted',
        },
    );
    if (acquired.status !== 'acquired') {
      return failure('operation_conflict', 'Materialization is already active.');
    }
    const fencedCurrent = await readRecord(
      dependencies.activeServerDir,
      current.operationId,
    );
    if (!fencedCurrent || fencedCurrent.revision !== parsed.data.revision) {
      await acquired.claim.release();
      return failure(
        fencedCurrent ? 'stale_revision' : 'operation_not_found',
        fencedCurrent
          ? 'Materialization operation revision is stale.'
          : 'Materialization operation was not found.',
      );
    }
    const claimMaintenance = maintainExternalSessionOperationClaim({
      claim: acquired.claim,
    });
    const cancellation = new AbortController();
    activeCancellationByOperationId.set(current.operationId, cancellation);
    let record = current;
    let takeoverPreparation: Awaited<
      ReturnType<NonNullable<MaterializeDependencies['preparePersistedTakeover']>>
    > | null = null;
    let reachedAdmission = false;
    const recordResult = (
      result: ExternalSessionOperationActionResponseV1,
    ): ExternalSessionOperationActionResponseV1 => {
      reachedAdmission = result.ok
        && result.progress.phase === 'admitting'
        && result.progress.status === 'awaiting_user_resume';
      return result;
    };
    try {
      let stagingMissingAfterAcceptedCheckpoint = false;
      if (isImportRecovery) {
        const reconciled = await claimMaintenance.race(
          () => reconcileCheckpointAgainstDurableReceipt(current, {
            deferMissingUntilServerResume: true,
            onDeferredMissing: () => {
              stagingMissingAfterAcceptedCheckpoint = true;
            },
          }),
        );
        if (reconciled) return success(reconciled);
      }
      if (operationKind === 'persisted_takeover') {
        const preparePersistedTakeover =
          dependencies.preparePersistedTakeover;
        if (!preparePersistedTakeover || !isPersistedTakeover) {
          return failure(
            'upgrade_required',
            'Persisted takeover phase continuation is unavailable.',
          );
        }
        takeoverPreparation = await claimMaintenance.race(
          () => preparePersistedTakeover(
            current as ExternalSessionPersistedTakeoverImportRecord,
          ),
        );
      }
      const workingDirectory = takeoverPreparation?.workingDirectory;
      if (!current.bindings.historicalImportJobId) {
        const inspectedPriorStableStorage = await claimMaintenance.race(
          () => inspectPriorStableStorage({
            request,
            operationId: current.operationId,
            operationClaimId: current.bindings.operationClaimId,
            revision: current.revision,
          }),
        );
        if (
          JSON.stringify(inspectedPriorStableStorage)
            !== JSON.stringify(current.priorStableStorage)
        ) {
          throw new ExternalSessionMaterializeSourceInterruptionError(
            'source_changed',
            'Materialization prior storage authority no longer matches its durable operation.',
          );
        }
      }
      const bridgeDescribedSourceFromCanonicalEvidence = async (
        source: MaterializeSourceDescription,
      ): Promise<void> => {
        const sourceSnapshotEvidenceRef =
          current.canonicalOwnerEvidence.sourceSnapshotEvidenceRef;
        if (!sourceSnapshotEvidenceRef) {
          throw new ExternalSessionMaterializeSourceInterruptionError(
            'source_unavailable',
            'Materialization source evidence is unavailable before capture replacement.',
          );
        }
        await claimMaintenance.race(() => dependencies.revalidateSource(
          request,
          source.capturedSource,
          sourceSnapshotEvidenceRef,
        ));
        if (source.capturedSource.revision !== sourceSnapshotEvidenceRef) {
          await claimMaintenance.race(() => dependencies.revalidateSource(
            request,
            source.capturedSource,
            source.capturedSource.revision,
          ));
        }
        throwIfCancellationRequested(current.operationId);
      };
      let sourceForPrivateCaptureRebuild: MaterializeSourceDescription | null = null;
      let capturedSourceForResume: MaterializeSourceDescription['capturedSource'] | null =
        null;
      if (isImportRecovery || isRequiredItemCorrectionResume || isStagingResume) {
        if (!stagingMissingAfterAcceptedCheckpoint) {
          const captured = await claimMaintenance.race(
            () => dependencies.staging.readCapturedSource({
              operationId: current.operationId,
            }),
          );
          if (captured.status !== 'ready') {
            throw new ExternalSessionMaterializeSourceInterruptionError(
              'source_unavailable',
              'Materialization private source evidence is unavailable for explicit continuation.',
            );
          }
          capturedSourceForResume = captured.capturedSource;
          const sourceSnapshotEvidenceRef =
            current.canonicalOwnerEvidence.sourceSnapshotEvidenceRef;
          if (!sourceSnapshotEvidenceRef) {
            throw new ExternalSessionMaterializeSourceInterruptionError(
              'source_unavailable',
              'Materialization source evidence is unavailable for explicit continuation.',
            );
          }
          await claimMaintenance.race(() => dependencies.revalidateSource(
            request,
            captured.capturedSource,
            sourceSnapshotEvidenceRef,
          ));
          throwIfCancellationRequested(current.operationId);
        }

        const admitted = await mutateCommittedRecordAtRevision(
          current.operationId,
          parsed.data.revision,
          (fresh) => {
            const {
              retryTargetPhase: _retryTargetPhase,
              error: _error,
              ...recordWithoutRetry
            } = fresh;
            return {
              ...recordWithoutRetry,
              revision: fresh.revision + 1,
              status: 'running',
              updatedAtMs: nowMs(),
            };
          },
        );
        if (!admitted.ok) {
          return failure(
            admitted.code,
            admitted.code === 'stale_revision'
              ? 'Materialization operation revision is stale.'
              : 'Materialization operation was not found.',
          );
        }
        record = admitted.record;

        if (
          !stagingMissingAfterAcceptedCheckpoint
          && (isRequiredItemCorrectionResume || isStagingResume)
        ) {
          if (!capturedSourceForResume) {
            throw new Error('external_session_materialize_resume_source_not_loaded');
          }
          const source = await claimMaintenance.race(() => dependencies.describeSource(request));
          throwIfCancellationRequested(current.operationId);
          if (
            source.capturedSource.sourceIdentity
              !== capturedSourceForResume.sourceIdentity
            || source.capturedSource.sourceGeneration !== request.source.sourceGeneration
          ) {
            throw new ExternalSessionMaterializeSourceInterruptionError(
              'source_changed',
              'Materialization Resume no longer matches its durable linked source evidence.',
            );
          }
          await bridgeDescribedSourceFromCanonicalEvidence(source);
          sourceForPrivateCaptureRebuild = source;
        }
      }
      if (isUnpublishedRequiredItemCorrectionResume) {
        if (!sourceForPrivateCaptureRebuild) {
          throw new Error('external_session_materialize_resume_source_not_revalidated');
        }
        await claimMaintenance.race(() => dependencies.staging.resetUnpublishedCapture({
          operationId: current.operationId,
        }));
        throwIfCancellationRequested(current.operationId);
        return recordResult(await stageAndImport(
          record,
          sourceForPrivateCaptureRebuild,
          claimMaintenance,
          (next) => {
            record = next;
          },
          workingDirectory,
        ));
      }
      if (isStagingResume) {
        if (!sourceForPrivateCaptureRebuild) {
          throw new Error('external_session_materialize_resume_source_not_revalidated');
        }
        await claimMaintenance.race(() => dependencies.staging.resetUnpublishedCapture({
          operationId: current.operationId,
        }));
        throwIfCancellationRequested(current.operationId);
        return recordResult(await stageAndImport(
          record,
          sourceForPrivateCaptureRebuild,
          claimMaintenance,
          (next) => {
            record = next;
          },
          workingDirectory,
        ));
      }
      if (isValidatingRetry || isPersistedTakeoverQuiescingResume) {
        const source = await claimMaintenance.race(() => dependencies.describeSource(request));
        throwIfCancellationRequested(current.operationId);
        if (
          (
            operationKind === 'materialize'
            && source.capturedSource.revision
              !== current.canonicalOwnerEvidence.sourceSnapshotEvidenceRef
          )
          || source.capturedSource.sourceGeneration !== request.source.sourceGeneration
        ) {
          return failure(
            'not_allowed',
            'Materialization validating Retry no longer matches its durable source evidence.',
          );
        }
        await bridgeDescribedSourceFromCanonicalEvidence(source);
        const { retryTargetPhase: _retryTargetPhase, error: _error, ...recordWithoutRetry } = current;
        claimMaintenance.throwIfLost();
        throwIfCancellationRequested(current.operationId);
        record = await claimMaintenance.race(() => commitRecord({
          ...recordWithoutRetry,
          revision: current.revision + 1,
          status: 'running',
          phase: operationKind === 'persisted_takeover'
            ? 'quiescing'
            : current.phase,
          updatedAtMs: nowMs(),
          bindings: {
            ...current.bindings,
            operationClaimId: acquired.claim.record.claimId,
          },
          canonicalOwnerEvidence: {
            ...current.canonicalOwnerEvidence,
            sourceSnapshotEvidenceRef: source.capturedSource.revision,
          },
        }));
        const result = await stageAndImport(
          record,
          source,
          claimMaintenance,
          (next) => {
            record = next;
          },
          workingDirectory,
        );
        return recordResult(result);
      }
      const result = await continueHistoricalImport(
        record,
        'resume',
        claimMaintenance,
        (next) => {
          record = next;
        },
        workingDirectory,
      );
      return recordResult(result);
    } catch (error) {
      if (error instanceof ExternalSessionOperationProgressPublishError) {
        record = error.committedRecord;
        if (
          (record.status === 'completed'
            || record.status === 'cancelled'
            || record.status === 'discarded')
          && record.terminalResult?.kind === record.status
        ) {
          return success(record);
        }
        reachedAdmission = record.request.plan === 'takeover'
          && record.request.targetStorageMode === 'persisted'
          && record.phase === 'admitting'
          && record.status === 'awaiting_user_resume';
        if (reachedAdmission) return success(record);
      }
      if (error instanceof MaterializeCancellationRequestedError) {
        return await finalizeCancellation(current.operationId);
      }
      if (error instanceof ExternalSessionPersistedTakeoverPreflightError) {
        return failure(error.actionCode, error.message);
      }
      if (error instanceof ExternalSessionOperationClaimLostError) {
        await writeInterruptedRecord(record, error, record.phase).catch(() => undefined);
        return failure('operation_conflict', error.code);
      }
      try {
        record = await writeInterruptedRecord(
          record,
          error,
          isStagingResume ? 'staging' : record.phase,
        );
      } catch (writeError) {
        if (
          writeError instanceof Error
          && writeError.message === 'external_session_operation_record_stale_revision'
        ) {
          return failure(
            'stale_revision',
            'Materialization operation revision is stale.',
          );
        }
        throw writeError;
      }
      return success(record);
    } finally {
      if (takeoverPreparation && !reachedAdmission) {
        await takeoverPreparation.resumeFollowOnFailure().catch(() => undefined);
      }
      dependencies.releaseSourceCapture?.(request);
      if (activeCancellationByOperationId.get(current.operationId) === cancellation) {
        activeCancellationByOperationId.delete(current.operationId);
      }
      claimMaintenance.stop();
      await acquired.claim.release();
    }
  };

  return Object.freeze({
    cleanupTerminalStaging,

    async status(raw) {
      const parsed = ExternalSessionOperationStatusInputV1Schema.safeParse(raw);
      if (!parsed.success) return failure('invalid_state', 'Invalid materialization status request.');
      const stored = await readExactActionRecord(
        dependencies.activeServerDir,
        parsed.data.sessionId,
        parsed.data.operationId,
      );
      if (stored.kind === 'unavailable') {
        return failure(
          'source_unavailable',
          'Materialization operation identity is unavailable.',
        );
      }
      if (stored.kind === 'terminal_receipt') {
        return failure(
          'invalid_state',
          'The settled operation no longer has private recovery state.',
        );
      }
      if (stored.kind === 'missing') {
        return failure('operation_not_found', 'Materialization operation was not found.');
      }
      const record = stored.record;
      if (record.revision !== parsed.data.revision) {
        return failure('stale_revision', 'Materialization operation revision is stale.');
      }
      return success(record);
    },

    async cancel(raw) {
      const parsed = ExternalSessionOperationCancelInputV1Schema.safeParse(raw);
      if (!parsed.success) return failure('invalid_state', 'Invalid materialization cancel request.');
      const stored = await readExactActionRecord(
        dependencies.activeServerDir,
        parsed.data.sessionId,
        parsed.data.operationId,
      );
      if (stored.kind === 'unavailable') {
        return failure(
          'source_unavailable',
          'Materialization operation identity is unavailable.',
        );
      }
      if (stored.kind === 'terminal_receipt') {
        return failure(
          'invalid_state',
          'The settled operation no longer has private recovery state.',
        );
      }
      if (stored.kind === 'missing') {
        return failure('operation_not_found', 'Materialization operation was not found.');
      }
      const current = stored.record;
      if (current.revision !== parsed.data.revision) {
        return failure('stale_revision', 'Materialization operation revision is stale.');
      }
      const isPersistedTakeover = current.request.plan === 'takeover'
        && current.request.targetStorageMode === 'persisted';
      if (!isImportBearingRequest(current.request)) {
        return failure('invalid_state', 'Operation does not carry a historical import.');
      }
      if (current.status === 'cancelled') {
        return success(current);
      }
      if (current.status === 'cancel_requested') {
        const activeCancellation =
          activeCancellationByOperationId.get(current.operationId);
        return activeCancellation
          ? success(current)
          : await finalizeCancellation(current.operationId);
      }
      if (discardingOperationIds.has(current.operationId)) {
        return failure('operation_conflict', 'Materialization discard is already active.');
      }
      if (
        current.status === 'completed'
        || current.status === 'discarded'
        || current.status === 'reconciliation_required'
      ) {
        return failure('not_allowed', 'Materialization cannot be cancelled from its terminal state.');
      }
      if (
        isPersistedTakeover
        && (
          current.phase === 'admitting'
          || current.phase === 'spawning'
          || current.phase === 'finalizing'
          || current.currentStorageState === 'snapshot_complete'
        )
      ) {
        return failure(
          'not_allowed',
          'Persisted takeover cannot be cancelled after snapshot publication.',
        );
      }
      if (
        current.request.plan === 'materialize'
        && current.priorStableStorage.state === 'snapshot_complete'
        && current.phase === 'staging'
        && current.bindings.privateStagingId !== undefined
        && current.checkpoint.stagedItemCount === 0
      ) {
        return failure(
          'not_allowed',
          'An update materialization cannot be cancelled while its first staging checkpoint is unsettled.',
        );
      }
      const requestedAtMs = nowMs();
      const requested = await mutateCommittedRecordAtRevision(
        current.operationId,
        parsed.data.revision,
        (record) => {
          const {
            retryTargetPhase: _retryTargetPhase,
            error: _error,
            terminalResult: _terminalResult,
            ...withoutRecovery
          } = record;
          return {
            ...withoutRecovery,
            revision: record.revision + 1,
            status: 'cancel_requested',
            updatedAtMs: requestedAtMs,
            cancellation: {
              requestedAtMs,
              requestedAtRevision: record.revision,
            },
          };
        },
      );
      if (!requested.ok) {
        return failure(
          requested.code,
          requested.code === 'stale_revision'
            ? 'Materialization operation revision is stale.'
            : 'Materialization operation was not found.',
        );
      }
      const activeCancellation = activeCancellationByOperationId.get(current.operationId);
      if (activeCancellation) {
        activeCancellation.abort(new MaterializeCancellationRequestedError());
        return success(requested.record);
      }
      return await finalizeCancellation(current.operationId);
    },

    async resume(raw) {
      return await continueExplicitly(raw, 'resume');
    },

    async retry(raw) {
      return await continueExplicitly(raw, 'retry');
    },

    async resumePersistedTakeover(raw) {
      return await continueExplicitly(raw, 'resume', 'persisted_takeover');
    },

    async discard(raw) {
      const parsed = ExternalSessionOperationDiscardInputV1Schema.safeParse(raw);
      if (!parsed.success) return failure('invalid_state', 'Invalid materialization discard request.');
      const stored = await readExactActionRecord(
        dependencies.activeServerDir,
        parsed.data.sessionId,
        parsed.data.operationId,
      );
      if (stored.kind === 'unavailable') {
        return failure(
          'source_unavailable',
          'Materialization operation identity is unavailable.',
        );
      }
      if (stored.kind === 'terminal_receipt') {
        return failure(
          'invalid_state',
          'The settled operation no longer has private recovery state.',
        );
      }
      if (stored.kind === 'missing') {
        return failure('operation_not_found', 'Materialization operation was not found.');
      }
      const current = stored.record;
      if (current.revision !== parsed.data.revision) {
        return failure('stale_revision', 'Materialization operation revision is stale.');
      }
      const isPersistedTakeover = current.request.plan === 'takeover'
        && current.request.targetStorageMode === 'persisted';
      if (!isImportBearingRequest(current.request)) {
        return failure('invalid_state', 'Operation does not carry a historical import.');
      }
      const isRepeatedTerminalDiscard = current.status === 'discarded';
      const isLocalCancelledDiscard = current.status === 'cancelled'
        && current.priorStableStorage.state === 'machine_only'
        && current.currentStorageState === 'machine_only'
        && current.fence.kind === 'none'
        && current.checkpoint.acceptedThroughServerSeq === undefined
        && current.checkpoint.acknowledgedBatchId === undefined
        && current.bindings.historicalImportJobId === undefined;
      const isInitialPartialDiscard = current.priorStableStorage.state === 'machine_only'
        && current.currentStorageState === 'server_partial'
        && current.fence.kind === 'initial_server_partial'
        && current.checkpoint.acceptedThroughServerSeq !== undefined
        && current.bindings.historicalImportJobId !== undefined;
      if (
        !isRepeatedTerminalDiscard
        && !isLocalCancelledDiscard
        && !isInitialPartialDiscard
      ) {
        return failure(
          'not_allowed',
          'Materialization discard is limited to unpublished private operation state.',
        );
      }

      const request = current.request;
      const acquired = await dependencies.operationExclusion.acquire(
        isPersistedTakeover
          ? {
            kind: 'takeover',
            sessionId: request.sessionId,
            requestId: request.idempotencyKey,
            sourceIdentity: JSON.stringify(request.source.qualifiedIdentity),
            sourceGeneration: request.source.sourceGeneration,
            plan: 'persisted',
          }
          : {
            kind: 'materialize',
            sessionId: request.sessionId,
            requestId: request.idempotencyKey,
            sourceIdentity: JSON.stringify(request.source.qualifiedIdentity),
            sourceGeneration: request.source.sourceGeneration,
          },
      );
      if (acquired.status !== 'acquired') {
        return failure('operation_conflict', 'Materialization is already active.');
      }
      const fencedCurrent = await readRecord(
        dependencies.activeServerDir,
        current.operationId,
      );
      if (!fencedCurrent || fencedCurrent.revision !== current.revision) {
        await acquired.claim.release();
        return failure('stale_revision', 'Materialization operation revision is stale.');
      }
      discardingOperationIds.add(current.operationId);
      const claimMaintenance = maintainExternalSessionOperationClaim({
        claim: acquired.claim,
      });
      try {
        if (isRepeatedTerminalDiscard) {
          try {
            await claimMaintenance.race(
              () => cleanupTerminalStaging(current.operationId),
            );
          } catch (error) {
            if (error instanceof ExternalSessionOperationClaimLostError) {
              throw error;
            }
            // A repeated Discard may retry retention cleanup without changing
            // the already-authoritative terminal result.
          }
          return success(current);
        }
        if (isInitialPartialDiscard || current.bindings.historicalImportJobId) {
          claimMaintenance.throwIfLost();
          const response = await claimMaintenance.race(() => dependencies.sendHistoricalCommand({
            v: 1,
            kind: 'discard',
            claim: privateClaimForRecord(current),
            expectedRevision: current.revision,
          }));
          if (response.kind !== 'discarded') {
            return failure(
              'invalid_state',
              response.kind === 'error'
                ? `Historical import discard failed: ${response.errorCode}.`
                : 'Historical import discard returned an invalid response.',
            );
          }
        }
        await claimMaintenance.race(() => markStagingDiscardRequired(current));
        const terminal = await mutateCommittedRecordAtRevision(
          current.operationId,
          current.revision,
          (record) => {
            const {
              retryTargetPhase: _retryTargetPhase,
              error: _error,
              cancellation: _cancellation,
              publication: _publication,
              terminalResult: _terminalResult,
              ...withoutRecovery
            } = record;
            const {
              disagreement: _disagreement,
              ...canonicalOwnerEvidence
            } = record.canonicalOwnerEvidence;
            return {
              ...withoutRecovery,
              revision: record.revision + 1,
              status: 'discarded',
              updatedAtMs: nowMs(),
              currentStorageState: 'machine_only',
              checkpoint: emptyCheckpoint(),
              bindings: {
                operationClaimId: record.bindings.operationClaimId,
              },
              canonicalOwnerEvidence,
              fence: { kind: 'none' },
              terminalResult: { kind: 'discarded' },
            };
          },
        );
        if (!terminal.ok) {
          return failure(
            terminal.code,
            terminal.code === 'stale_revision'
              ? 'Materialization operation revision is stale.'
              : 'Materialization operation was not found.',
          );
        }
        try {
          await claimMaintenance.race(
            () => cleanupTerminalStaging(current.operationId),
          );
        } catch {
          // The durable discard is authoritative; bounded staging remains under
          // the existing retention owner when immediate cleanup fails.
        }
        return success(terminal.record);
      } catch (error) {
        if (error instanceof ExternalSessionOperationClaimLostError) {
          return failure('operation_conflict', error.code);
        }
        return failure(
          'internal_error',
          'Materialization discard failed.',
        );
      } finally {
        discardingOperationIds.delete(current.operationId);
        claimMaintenance.stop();
        await acquired.claim.release();
      }
    },

    async start(raw, context) {
      const parsed = z.object({
        request: ExternalSessionOperationSemanticRequestV1Schema,
      }).strict().safeParse(raw);
      if (!parsed.success || parsed.data.request.plan !== 'materialize') {
        return failure('invalid_state', 'Invalid materialization request.');
      }
      const request = parsed.data.request;
      let admission: Awaited<ReturnType<
        typeof resolveExternalSessionOperationStartAdmission
      >>;
      try {
        admission = await resolveExternalSessionOperationStartAdmission({
          activeServerDir: dependencies.activeServerDir,
          durableIdempotencyKey: request.idempotencyKey,
          intent: request,
          ...(context?.authorIntent
            ? { authorIntent: context.authorIntent }
            : {}),
          nowMs: nowMs(),
          readSelectedPresentation,
        });
      } catch (error) {
        if (isExternalSessionOperationIdentityUnavailable(error)) {
          return failure(
            'source_unavailable',
            'Materialization operation identity is unavailable.',
          );
        }
        if (
          error instanceof ExternalSessionOperationRecordReadError
          || error instanceof ExternalSessionOperationRecordAdmissionError
        ) {
          return failure(
            'internal_error',
            'Materialization operation inventory could not be read.',
          );
        }
        throw error;
      }
      if (admission.kind === 'conflict') {
        return failure(
          'operation_conflict',
          'Materialization idempotency request changed.',
        );
      }
      if (admission.kind === 'legacy_unavailable') {
        return failure(
          'source_unavailable',
          'A legacy materialization operation cannot be safely resumed.',
        );
      }
      if (admission.kind === 'terminal_receipt') {
        return failure(
          'invalid_state',
          'The settled materialization no longer has private recovery state.',
        );
      }
      if (admission.kind === 'existing_record') {
        let existing = admission.record;
        try {
          existing = dependencies.convergeProgress
            ? await dependencies.convergeProgress(existing)
            : await publishCommittedProgress(existing);
        } catch {
          return failure(
            'internal_error',
            'Materialization operation progress could not be published.',
          );
        }
        if (existing.status === 'completed') {
          try {
            await cleanupTerminalStaging(existing.operationId);
          } catch {
            // An idempotent Start may retry retention cleanup without changing
            // the already-authoritative terminal result.
          }
        }
        return success(existing);
      }
      const operationId = admission.operationId;

      const exclusionRequest = {
        kind: 'materialize' as const,
        sessionId: request.sessionId,
        requestId: request.idempotencyKey,
        sourceIdentity: JSON.stringify(request.source.qualifiedIdentity),
        sourceGeneration: request.source.sourceGeneration,
      };
      const acquireExclusion = async () => context?.signal
        ? await dependencies.operationExclusion.acquire(exclusionRequest, {
          signal: context.signal,
        })
        : await dependencies.operationExclusion.acquire(exclusionRequest);
      let acquired: Awaited<ReturnType<ExternalSessionOperationExclusion['acquire']>>;
      try {
        acquired = await acquireExclusion();
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return failure('internal_error', 'Materialization failed.');
        }
        throw error;
      }
      while (acquired.status === 'converged') {
        try {
          let durableAdmission =
            await resolveExternalSessionOperationStartAdmission({
              activeServerDir: dependencies.activeServerDir,
              durableIdempotencyKey: request.idempotencyKey,
              intent: request,
              ...(context?.authorIntent
                ? { authorIntent: context.authorIntent }
                : {}),
              nowMs: nowMs(),
              readSelectedPresentation,
            });
          if (durableAdmission.kind === 'new_operation') {
            if (!acquired.waitForRelease) {
              return failure(
                'internal_error',
                'Materialization operation convergence could not be observed.',
              );
            }
            const waited = await acquired.waitForRelease(
              context?.signal ? { signal: context.signal } : undefined,
            );
            if (waited.status !== 'ready') {
              return failure(
                'internal_error',
                'Materialization operation convergence could not be observed.',
              );
            }
            durableAdmission =
              await resolveExternalSessionOperationStartAdmission({
                activeServerDir: dependencies.activeServerDir,
                durableIdempotencyKey: request.idempotencyKey,
                intent: request,
                ...(context?.authorIntent
                  ? { authorIntent: context.authorIntent }
                  : {}),
                nowMs: nowMs(),
                readSelectedPresentation,
              });
          }
          if (durableAdmission.kind === 'existing_record') {
            let converged = durableAdmission.record;
            try {
              converged = dependencies.convergeProgress
                ? await dependencies.convergeProgress(converged)
                : await publishCommittedProgress(converged);
            } catch {
              return failure(
                'internal_error',
                'Materialization operation progress could not be published.',
              );
            }
            return success(converged);
          } else if (durableAdmission.kind === 'terminal_receipt') {
            return failure(
              'invalid_state',
              'The settled materialization no longer has private recovery state.',
            );
          } else if (durableAdmission.kind === 'conflict') {
            return failure(
              'operation_conflict',
              'Materialization idempotency request changed.',
            );
          } else if (durableAdmission.kind === 'legacy_unavailable') {
            return failure(
              'source_unavailable',
              'A legacy materialization operation cannot be safely resumed.',
            );
          } else {
            acquired = await acquireExclusion();
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            return failure('internal_error', 'Materialization failed.');
          }
          if (isExternalSessionOperationIdentityUnavailable(error)) {
            return failure(
              'source_unavailable',
              'Materialization operation identity is unavailable.',
            );
          }
          if (
            error instanceof ExternalSessionOperationRecordReadError
            || error instanceof ExternalSessionOperationRecordAdmissionError
          ) {
            return failure(
              'internal_error',
              'Materialization operation inventory could not be read.',
            );
          }
          throw error;
        }
      }
      if (acquired.status === 'conflict') {
        return failure('operation_conflict', `Materialization conflicts with ${acquired.reason}.`);
      }

      const claimMaintenance = maintainExternalSessionOperationClaim({
        claim: acquired.claim,
      });
      const cancellation = new AbortController();
      activeCancellationByOperationId.set(operationId, cancellation);
      let record: ExternalSessionOperationRecordV1 | null = null;
      try {
        const source = await claimMaintenance.race(() => dependencies.describeSource(request));
        throwIfCancellationRequested(operationId);
        const priorStableStorage = await claimMaintenance.race(
          () => inspectPriorStableStorage({
            request,
            operationId,
            operationClaimId: acquired.claim.record.claimId,
            revision: 0,
          }),
        );
        const createdAtMs = nowMs();
        claimMaintenance.throwIfLost();
        throwIfCancellationRequested(operationId);
        record = await claimMaintenance.race(() => commitRecord({
          v: 1,
          operationId,
          revision: 0,
          request,
          ...(context?.authorIntent
            ? { authorIntent: context.authorIntent }
            : {}),
          status: 'running',
          phase: 'validating',
          timeline: resolveExternalSessionOperationTimelineV1(request),
          createdAtMs,
          updatedAtMs: createdAtMs,
          priorStableStorage,
          currentStorageState: priorStableStorage.state,
          ...(priorStableStorage.state === 'snapshot_complete'
            ? { publication: priorStableStorage.publication }
            : {}),
          checkpoint: emptyCheckpoint(),
          bindings: {
            operationClaimId: acquired.claim.record.claimId,
          },
          progressProjection: {
            acknowledgedRevision: null,
          },
          canonicalOwnerEvidence: {
            linkedSessionRevision: source.linkedSessionRevision,
            sourceSnapshotEvidenceRef: source.capturedSource.revision,
          },
          fence: { kind: 'none' },
        }));
        if (record.operationId !== operationId) {
          record = dependencies.convergeProgress
            ? await dependencies.convergeProgress(record)
            : await publishCommittedProgress(record);
          return success(record);
        }
        context?.onAdmitted?.(record);
        return await stageAndImport(
          record,
          source,
          claimMaintenance,
          (next) => {
            record = next;
          },
        );
      } catch (error) {
        if (error instanceof ExternalSessionOperationProgressPublishError) {
          const failedBeforeInitialAdmissionReturned = record === null;
          record = error.committedRecord;
          if (
            (record.status === 'completed'
              || record.status === 'cancelled'
              || record.status === 'discarded')
            && record.terminalResult?.kind === record.status
          ) {
            return success(record);
          }
          if (failedBeforeInitialAdmissionReturned) {
            return failure(
              'internal_error',
              'Materialization operation progress could not be published.',
            );
          }
        }
        if (error instanceof MaterializeCancellationRequestedError) {
          return await finalizeCancellation(operationId);
        }
        if (error instanceof ExternalSessionOperationClaimLostError) {
          if (record) {
            await writeInterruptedRecord(record, error, record.phase).catch(() => undefined);
          }
          return failure('operation_conflict', error.code);
        }
        if (
          error instanceof Error
          && error.message ===
            'external_session_operation_projection_conflict'
        ) {
          return failure(
            'operation_conflict',
            'Another external session operation is selected.',
          );
        }
        if (!record) {
          return failure(
            'internal_error',
            'Materialization failed.',
          );
        }
        const failed = await writeInterruptedRecord(record, error, record.phase);
        return success(failed);
      } finally {
        dependencies.releaseSourceCapture?.(request);
        if (activeCancellationByOperationId.get(operationId) === cancellation) {
          activeCancellationByOperationId.delete(operationId);
        }
        claimMaintenance.stop();
        await acquired.claim.release();
      }
    },
  });
}
