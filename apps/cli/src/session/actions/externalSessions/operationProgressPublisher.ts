import {
  clearSessionStateFieldFromMetadata,
  writeSessionStateFieldToMetadata,
} from '@happier-dev/agents/session/state/metadataWriters';
import {
  EXTERNAL_SESSION_OPERATION_METADATA_KEY,
  EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY,
  ExternalSessionOperationReferenceV1Schema,
  ExternalSessionOperationSharedPresentationV1Schema,
  ExternalSessionOperationStateV1Schema,
  isRetryableExternalLinkedAdmissionAcknowledgementReconciliationV1,
  projectExternalSessionOperationProgressV1,
  projectExternalSessionOperationSharedPresentationV1,
  type ExternalSessionOperationProgressV1,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSharedPresentationV1,
  type SessionMetadata,
} from '@happier-dev/protocol';
import { readStoredCredentials } from '@/persistence';
import {
  readSessionMetadataTupleWriterSnapshot,
  updateSessionMetadataWithRetry,
} from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import {
  acknowledgeExternalSessionOperationProgressProjection,
  compactExternalSessionOperationRecordToCompletionReceipt,
  deleteExpiredExternalSessionOperationCompletionReceipt,
  listExternalSessionOperationRecords,
  mutateExternalSessionOperationRecordAtRevision,
  pruneExpiredExternalSessionOperationCompletionReceipts,
  readExternalSessionOperationRecord,
  readExternalSessionOperationStoredEntry,
  resolveExternalSessionOperationCompletionCompactionEligibility,
  withExternalSessionOperationSessionAdmissionLock,
  type ExternalSessionOperationPriorTerminalReceiptEvidence,
} from './operationRecordStore';
import { logExternalSessionsInternalError } from './responseErrors';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { resolveConnectedServicesServerApiTimeoutMs } from '@/api/client/connectedServicesServerApiTimeout';
import { configuration } from '@/configuration';

const REPLACEABLE_TERMINAL_STATUSES = new Set([
  'completed',
  'cancelled',
  'discarded',
]);
const EXTERNAL_SESSION_OPERATION_PROJECTION_METADATA_MAX_ATTEMPTS = 6;

type ExternalSessionOperationStagingDisposition =
  | 'not_applicable'
  | 'cleaned'
  | 'missing'
  | 'not_ready'
  | 'not_terminal';

function isExternalLinkedTakeoverCompletion(
  record: ExternalSessionOperationRecordV1,
): boolean {
  return record.status === 'completed'
    && record.request.plan === 'takeover'
    && record.request.targetStorageMode === 'external-linked';
}

async function compactTerminalExternalSessionOperation(
  activeServerDir: string,
  record: ExternalSessionOperationRecordV1,
  stagingDisposition: ExternalSessionOperationStagingDisposition,
): Promise<void> {
  if (
    resolveExternalSessionOperationCompletionCompactionEligibility(record)
      !== 'eligible'
  ) {
    return;
  }
  if (
    stagingDisposition !== 'not_applicable'
    && stagingDisposition !== 'cleaned'
    && stagingDisposition !== 'missing'
  ) {
    return;
  }
  await compactExternalSessionOperationRecordToCompletionReceipt({
    activeServerDir,
    operationId: record.operationId,
    expectedRevision: record.revision,
    stagingDisposition,
  });
}

export function resolveExternalSessionOperationProjectionBarrierAcquisitionTimeoutMs(
  input: Readonly<{
    sessionControlTimeoutMs?: number;
    connectedServicesTimeoutMs?: number;
  }> = {},
): number {
  const sessionControlTimeoutMs = input.sessionControlTimeoutMs
    ?? configuration.sessionControlHttpTimeoutMs;
  const connectedServicesTimeoutMs =
    input.connectedServicesTimeoutMs
    ?? resolveConnectedServicesServerApiTimeoutMs();
  // One repair barrier can converge an admitted revision-zero successor and
  // then its repaired current revision. Each pass can perform one presentation
  // read, one publisher snapshot read, the tuple owner's six retry attempts,
  // one authoritative conflict refresh, and three Account-currentness reads.
  // Treat parallel reads as sequential here and retain a minute for local CAS,
  // retry delays, publication receipt acknowledgement, and scheduling jitter.
  const sessionControlRequestsPerPass =
    3 + EXTERNAL_SESSION_OPERATION_PROJECTION_METADATA_MAX_ATTEMPTS;
  const calculated = 2 * (
    (sessionControlRequestsPerPass * sessionControlTimeoutMs)
    + (3 * connectedServicesTimeoutMs)
  ) + 60_000;
  return Number.isSafeInteger(calculated)
    ? calculated
    : Number.MAX_SAFE_INTEGER;
}

function isPassivelyResumableInterruptedOperation(
  record: ExternalSessionOperationRecordV1,
): boolean {
  if (record.status !== 'running') return false;
  if (record.request.plan === 'materialize') {
    return record.phase === 'validating'
      || record.phase === 'staging'
      || record.phase === 'importing'
      || record.phase === 'publishing';
  }
  if (record.request.targetStorageMode === 'external-linked') {
    return record.phase === 'validating'
      || record.phase === 'quiescing'
      || record.phase === 'admitting'
      || record.phase === 'finalizing';
  }
  return record.request.targetStorageMode === 'persisted'
    && (
      record.phase === 'validating'
      || record.phase === 'quiescing'
      || record.phase === 'staging'
      || record.phase === 'importing'
      || record.phase === 'final_catch_up'
    );
}

type PassiveRepairMode =
  | 'awaiting_user_resume'
  | 'admission_recovery_required'
  | 'reconciliation_required'
  | 'hosted_offline';

function hasCompleteTakeoverAttemptIdentity(
  record: ExternalSessionOperationRecordV1,
): boolean {
  return record.bindings.operationClaimId !== undefined
    && record.bindings.targetRuntimeAttemptId !== undefined
    && record.fence.kind === 'none'
    && record.checkpoint.requiredItemFailures.total === 0
    && record.canonicalOwnerEvidence.disagreement === undefined;
}

function resolvePassiveRepairMode(
  record: ExternalSessionOperationRecordV1,
): PassiveRepairMode | null {
  if (
    record.status === 'running'
    && record.request.plan === 'takeover'
    && record.request.targetStorageMode === 'external-linked'
    && record.phase === 'admitting'
    && hasCompleteTakeoverAttemptIdentity(record)
  ) {
    // A durable exact attempt with no acknowledgement outcome must be retried
    // idempotently against the admission owner, not reopened as cancellable.
    // The process-local admission waiter that would have settled it does not
    // survive a restart, so the retained attempt is handed to the existing
    // reconciliation state and waits for an explicit user Retry. Leaving it
    // `running` would leave the operation with no action at all.
    return 'reconciliation_required';
  }
  if (isPassivelyResumableInterruptedOperation(record)) {
    return 'awaiting_user_resume';
  }
  if (
    record.status !== 'running'
    || record.request.plan !== 'takeover'
    || (
      record.request.targetStorageMode !== 'persisted'
      && record.request.targetStorageMode !== 'external-linked'
    )
  ) {
    return null;
  }
  if (record.phase === 'spawning') {
    return hasCompleteTakeoverAttemptIdentity(record)
      && (
        (
          record.request.targetStorageMode === 'persisted'
          && record.currentStorageState === 'hosted'
          && record.publication === undefined
        )
        || (
          record.request.targetStorageMode === 'external-linked'
          && record.currentStorageState === record.priorStableStorage.state
        )
      )
      ? 'hosted_offline'
      : 'reconciliation_required';
  }
  if (record.phase !== 'admitting') {
    return null;
  }
  if (
    !hasCompleteTakeoverAttemptIdentity(record)
    || record.currentStorageState !== 'snapshot_complete'
    || record.publication === undefined
  ) {
    return 'reconciliation_required';
  }
  const hasTranscriptAuthority =
    record.canonicalOwnerEvidence.transcriptAuthorityRevision !== undefined;
  const hasPendingAdmission =
    record.canonicalOwnerEvidence.pendingAdmissionRevision !== undefined;
  if (hasTranscriptAuthority !== hasPendingAdmission) {
    return 'reconciliation_required';
  }
  return hasTranscriptAuthority
    ? 'admission_recovery_required'
    : 'awaiting_user_resume';
}

export function selectExternalSessionOperationRecordsForPassiveRepair(
  records: readonly ExternalSessionOperationRecordV1[],
): readonly ExternalSessionOperationRecordV1[] {
  const bySession = new Map<string, ExternalSessionOperationRecordV1[]>();
  for (const record of records) {
    const sessionRecords = bySession.get(record.request.sessionId) ?? [];
    sessionRecords.push(record);
    bySession.set(record.request.sessionId, sessionRecords);
  }
  const selected: ExternalSessionOperationRecordV1[] = [];
  for (const sessionRecords of bySession.values()) {
    const nonterminal = sessionRecords.filter(
      (record) => !REPLACEABLE_TERMINAL_STATUSES.has(record.status),
    );
    const unsettledTerminal = sessionRecords.filter(
      (record) =>
        REPLACEABLE_TERMINAL_STATUSES.has(record.status)
        && (
          record.progressProjection.acknowledgedRevision === null
          || record.progressProjection.acknowledgedRevision < record.revision
        ),
    );
    if (nonterminal.length > 1) {
      throw new Error('external_session_operation_repair_conflicting_private_records');
    }
    if (nonterminal[0]) {
      if (unsettledTerminal.length > 0) {
        throw new Error(
          'external_session_operation_repair_ambiguous_selected_operation',
        );
      }
      selected.push(nonterminal[0]);
      continue;
    }
    if (unsettledTerminal.length > 1) {
      throw new Error(
        'external_session_operation_repair_ambiguous_selected_operation',
      );
    }
    if (unsettledTerminal[0]) selected.push(unsettledTerminal[0]);
  }
  return selected;
}

type ExternalSessionOperationProgressConvergenceDependencies = Readonly<{
  readPresentation?: typeof readExternalSessionOperationSharedPresentation;
  publish?(input: Readonly<{
    activeServerDir: string;
    sessionId: string;
    progress: ExternalSessionOperationProgressV1;
    allowDifferentTerminalReplacement?: boolean;
    expectedDifferentTerminalPresentation?:
      ExternalSessionOperationSharedPresentationV1;
  }>): Promise<ExternalSessionOperationRecordV1 | void>;
  acknowledge?:
    typeof acknowledgeExternalSessionOperationProgressProjection;
  allowSettledTerminalPredecessorReplacement?: boolean;
  sessionAdmissionLockHeld?: boolean;
}>;

async function isSettledTerminalPredecessorSelection(input: Readonly<{
  activeServerDir: string;
  selectedRecord: ExternalSessionOperationRecordV1;
  remote: ExternalSessionOperationSharedPresentationV1;
}>): Promise<boolean> {
  if (
    input.selectedRecord.revision !== 0
    || input.selectedRecord.progressProjection.acknowledgedRevision !== null
    || REPLACEABLE_TERMINAL_STATUSES.has(input.selectedRecord.status)
  ) {
    return false;
  }
  const predecessor = await readExternalSessionOperationStoredEntry(
    input.activeServerDir,
    input.remote.operationId,
  );
  if (predecessor?.kind === 'completion_receipt') {
    return predecessor.receipt.reference.sessionId
      === input.selectedRecord.request.sessionId
      && presentationsEqual(input.remote, predecessor.receipt.presentation);
  }
  if (
    !predecessor
    || predecessor.record.request.sessionId
      !== input.selectedRecord.request.sessionId
    || !REPLACEABLE_TERMINAL_STATUSES.has(predecessor.record.status)
    || predecessor.record.progressProjection.acknowledgedRevision === null
    || predecessor.record.progressProjection.acknowledgedRevision
      < predecessor.record.revision
  ) {
    return false;
  }
  return presentationsEqual(
    input.remote,
    projectExternalSessionOperationSharedPresentationV1(
      projectExternalSessionOperationProgressV1(predecessor.record),
    ),
  );
}

export async function convergeExternalSessionOperationProgressProjection(
  activeServerDir: string,
  record: ExternalSessionOperationRecordV1,
  dependencies: ExternalSessionOperationProgressConvergenceDependencies = {},
): Promise<'already_acknowledged' | 'acknowledged' | 'published'> {
  const readPresentation = dependencies.readPresentation
    ?? readExternalSessionOperationSharedPresentation;
  const publish = dependencies.publish
    ?? publishExternalSessionOperationProgress;
  const acknowledge = dependencies.acknowledge
    ?? acknowledgeExternalSessionOperationProgressProjection;
  const readResult = await readPresentation(record.request.sessionId);
  if (readResult.kind === 'gone') {
    throw new Error('external_session_operation_publish_session_not_found');
  }
  if (readResult.kind === 'malformed') {
    throw new Error('external_session_operation_projection_malformed');
  }
  const remote = readResult.kind === 'valid'
    ? readResult.presentation
    : null;
  const expected =
    projectExternalSessionOperationSharedPresentationV1(
      projectExternalSessionOperationProgressV1(record),
    );
  let settledTerminalPredecessor:
    ExternalSessionOperationSharedPresentationV1 | undefined;
  if (remote?.operationId === record.operationId) {
    if (
      remote.revision === record.revision
      && !presentationsEqual(remote, expected)
    ) {
      throw new Error(
        'external_session_operation_repair_ambiguous_selected_operation',
      );
    }
    if (remote.revision >= record.revision) {
      await acknowledge({
        activeServerDir,
        operationId: record.operationId,
        projectedRevision: record.revision,
      });
      if (remote.revision === record.revision) {
        await pruneExpiredExternalSessionOperationCompletionReceipts({
          activeServerDir,
          nowMs: Date.now(),
          sessionIds: [record.request.sessionId],
          readSelectedPresentation: readPresentation,
          sessionAdmissionLockHeld:
            dependencies.sessionAdmissionLockHeld,
        });
      }
      if (isExternalLinkedTakeoverCompletion(record)) {
        await compactTerminalExternalSessionOperation(
          activeServerDir,
          record,
          'not_applicable',
        );
      }
      return record.progressProjection.acknowledgedRevision !== null
        && record.progressProjection.acknowledgedRevision >= record.revision
        ? 'already_acknowledged'
        : 'acknowledged';
    }
  } else if (remote) {
    if (
      dependencies.allowSettledTerminalPredecessorReplacement === true
      && await isSettledTerminalPredecessorSelection({
        activeServerDir,
        selectedRecord: record,
        remote,
      })
    ) {
      settledTerminalPredecessor = remote;
    } else {
      throw new Error(
        'external_session_operation_repair_different_selected_operation',
      );
    }
  }
  const published = await publish({
    activeServerDir,
    sessionId: record.request.sessionId,
    progress: projectExternalSessionOperationProgressV1(record),
    ...(settledTerminalPredecessor
      ? {
        allowDifferentTerminalReplacement: true,
        expectedDifferentTerminalPresentation: settledTerminalPredecessor,
      }
      : {}),
  });
  // The canonical publisher also acknowledges after its metadata commit.
  // Keep this explicit for injected publishers and idempotent lost-ACK replay.
  if (
    published?.operationId !== record.operationId
    || published.progressProjection.acknowledgedRevision === null
    || published.progressProjection.acknowledgedRevision < record.revision
  ) {
    await acknowledge({
      activeServerDir,
      operationId: record.operationId,
      projectedRevision: record.revision,
    });
  }
  await pruneExpiredExternalSessionOperationCompletionReceipts({
    activeServerDir,
    nowMs: Date.now(),
    sessionIds: [record.request.sessionId],
    readSelectedPresentation: readPresentation,
    sessionAdmissionLockHeld: dependencies.sessionAdmissionLockHeld,
  });
  if (isExternalLinkedTakeoverCompletion(record)) {
    await compactTerminalExternalSessionOperation(
      activeServerDir,
      record,
      'not_applicable',
    );
  }
  return 'published';
}

export async function settlePriorTerminalExternalSessionOperationProgressProjections(
  activeServerDir: string,
  priorTerminalRecords: readonly ExternalSessionOperationRecordV1[],
  dependencies: ExternalSessionOperationProgressConvergenceDependencies = {},
): Promise<void> {
  const unsettled = priorTerminalRecords.filter(
    (record) =>
      REPLACEABLE_TERMINAL_STATUSES.has(record.status)
      && (
        record.progressProjection.acknowledgedRevision === null
        || record.progressProjection.acknowledgedRevision < record.revision
      ),
  );
  if (unsettled.length === 0) return;
  if (unsettled.length !== 1) {
    throw new Error(
      'external_session_operation_repair_ambiguous_selected_operation',
    );
  }
  await convergeExternalSessionOperationProgressProjection(
    activeServerDir,
    unsettled[0],
    dependencies,
  );
}

export async function repairExternalSessionOperationProgressProjections(
  activeServerDir: string,
  dependencies: Readonly<{
    listRecords?: typeof listExternalSessionOperationRecords;
    readPresentation?:
      typeof readExternalSessionOperationSharedPresentation;
    publish?(input: Readonly<{
      activeServerDir: string;
      sessionId: string;
      progress: ExternalSessionOperationProgressV1;
    }>): Promise<ExternalSessionOperationRecordV1 | void>;
    acknowledge?:
      typeof acknowledgeExternalSessionOperationProgressProjection;
    inspectOperationClaim(input: Readonly<{
      sessionId: string;
      operationClaimId: string;
    }>): Promise<'active' | 'inactive'>;
    withOperationClaimBarrier<TResult>(
      input: Readonly<{
        sessionId: string;
        operationClaimId: string;
      }>,
      effect: () => Promise<TResult>,
    ): Promise<
      | Readonly<{ status: 'active' }>
      | Readonly<{ status: 'executed'; value: TResult }>
    >;
    cleanupTerminalStaging?(
      operationId: string,
    ): Promise<'cleaned' | 'missing' | 'not_ready' | 'not_terminal'>;
    nowMs?: () => number;
  }>,
): Promise<number> {
  const records = await (
    dependencies.listRecords ?? listExternalSessionOperationRecords
  )(activeServerDir);
  const nowMs = dependencies.nowMs ?? Date.now;
  const readPresentation = dependencies.readPresentation
    ?? readExternalSessionOperationSharedPresentation;
  const recordsBySession = new Map<
    string,
    ExternalSessionOperationRecordV1[]
  >();
  for (const record of records) {
    const sessionRecords =
      recordsBySession.get(record.request.sessionId) ?? [];
    sessionRecords.push(record);
    recordsBySession.set(record.request.sessionId, sessionRecords);
  }
  let convergedCount = 0;
  for (const sessionRecords of recordsBySession.values()) {
    const stagingDispositionByOperationId = new Map<
      string,
      ExternalSessionOperationStagingDisposition
    >();
    for (const terminalRecord of sessionRecords) {
      const stagingIsStructurallyAbsent =
        isExternalLinkedTakeoverCompletion(terminalRecord);
      const requiresTerminalStagingCleanup =
        (
          terminalRecord.status === 'completed'
          || terminalRecord.status === 'discarded'
        )
        && !(
          terminalRecord.request.plan === 'takeover'
          && terminalRecord.request.targetStorageMode === 'external-linked'
        );
      if (
        !stagingIsStructurallyAbsent
        && (
          !requiresTerminalStagingCleanup
          || !dependencies.cleanupTerminalStaging
        )
      ) {
        continue;
      }
      try {
        if (
          await dependencies.inspectOperationClaim({
            sessionId: terminalRecord.request.sessionId,
            operationClaimId: terminalRecord.bindings.operationClaimId,
          }) === 'active'
        ) {
          continue;
        }
        const barrier = await dependencies.withOperationClaimBarrier(
          {
            sessionId: terminalRecord.request.sessionId,
            operationClaimId: terminalRecord.bindings.operationClaimId,
          },
          async () => {
            if (
              terminalRecord.status === 'completed'
              && terminalRecord.progressProjection.acknowledgedRevision
                === terminalRecord.revision
            ) {
              // Publication owns first-ACK predecessor deletion before
              // compaction. Repeat the same bounded convergence step on boot
              // so a crash after the ACK cannot strand the selected expired
              // predecessor once this full successor becomes a receipt.
              await pruneExpiredExternalSessionOperationCompletionReceipts({
                activeServerDir,
                nowMs: nowMs(),
                sessionIds: [terminalRecord.request.sessionId],
                readSelectedPresentation: readPresentation,
              });
            }
            const stagingDisposition = stagingIsStructurallyAbsent
              ? 'not_applicable' as const
              : await dependencies.cleanupTerminalStaging!(
                terminalRecord.operationId,
              );
            await compactTerminalExternalSessionOperation(
              activeServerDir,
              terminalRecord,
              stagingDisposition,
            );
            return stagingDisposition;
          },
        );
        if (barrier.status === 'executed') {
          stagingDispositionByOperationId.set(
            terminalRecord.operationId,
            barrier.value,
          );
        }
      } catch (error) {
        logExternalSessionsInternalError(
          'external_session.operation_terminal_staging_repair',
          error,
        );
      }
    }
    try {
      const [selectedRecord] =
        selectExternalSessionOperationRecordsForPassiveRepair(sessionRecords);
      if (!selectedRecord) continue;
      if (
        await dependencies.inspectOperationClaim({
          sessionId: selectedRecord.request.sessionId,
          operationClaimId: selectedRecord.bindings.operationClaimId,
        }) === 'active'
      ) {
        continue;
      }
      let record: ExternalSessionOperationRecordV1 | null = selectedRecord;
      const repairMode = resolvePassiveRepairMode(record);
      const presentation = await readPresentation(
        selectedRecord.request.sessionId,
      );
      if (presentation.kind === 'malformed') {
        throw new Error('external_session_operation_projection_malformed');
      }
      let replacesSettledTerminalPredecessor = false;
      if (
        presentation.kind === 'valid'
        && presentation.presentation.operationId !==
          selectedRecord.operationId
      ) {
        replacesSettledTerminalPredecessor =
          await isSettledTerminalPredecessorSelection({
            activeServerDir,
            selectedRecord,
            remote: presentation.presentation,
          });
        if (!replacesSettledTerminalPredecessor) {
          throw new Error(
            'external_session_operation_repair_different_selected_operation',
          );
        }
      }
      if (
        presentation.kind === 'valid'
        && presentation.presentation.operationId ===
          selectedRecord.operationId
        && presentation.presentation.revision === selectedRecord.revision
        && !presentationsEqual(
          presentation.presentation,
          projectExternalSessionOperationSharedPresentationV1(
            projectExternalSessionOperationProgressV1(selectedRecord),
          ),
        )
      ) {
        throw new Error(
          'external_session_operation_repair_ambiguous_selected_operation',
        );
      }
      // Keep the pre-CAS remote read outside the filesystem critical section.
      // The canonical claim barrier then serializes the local CAS and the
      // fresh convergence read/write against a racing Resume claim.
      const barrier = await dependencies.withOperationClaimBarrier(
        {
          sessionId: selectedRecord.request.sessionId,
          operationClaimId: selectedRecord.bindings.operationClaimId,
        },
        async () => {
          if (replacesSettledTerminalPredecessor) {
            // Admission settled this exact predecessor before writing the
            // revision-zero successor. Publish and acknowledge that durable
            // successor before its passive interruption transition so a crash
            // during repair retains enough evidence for the next repair.
            await convergeExternalSessionOperationProgressProjection(
              activeServerDir,
              selectedRecord,
              {
                ...dependencies,
                allowSettledTerminalPredecessorReplacement: true,
              },
            );
          }
          if (repairMode) {
            const repaired =
              await mutateExternalSessionOperationRecordAtRevision(
                activeServerDir,
                selectedRecord.operationId,
                selectedRecord.revision,
                (current) => {
                  if (
                    current.request.sessionId !== record?.request.sessionId
                    || resolvePassiveRepairMode(current) !== repairMode
                  ) {
                    throw new Error(
                      'external_session_operation_repair_state_changed',
                    );
                  }
                  if (repairMode === 'hosted_offline') {
                    return {
                      ...current,
                      revision: current.revision + 1,
                      status: 'failed',
                      updatedAtMs: nowMs(),
                      retryTargetPhase: 'spawning',
                      error: {
                        code: 'spawn_failed',
                        message:
                          'Takeover runtime was interrupted before runtime binding completed.',
                        retryable: true,
                        occurredAtMs: nowMs(),
                      },
                    };
                  }
                  if (repairMode === 'admission_recovery_required') {
                    const {
                      acceptedThroughServerSeq: _acceptedThroughServerSeq,
                      acknowledgedBatchId: _acknowledgedBatchId,
                      ...checkpoint
                    } = current.checkpoint;
                    return {
                      ...current,
                      revision: current.revision + 1,
                      status: 'failed',
                      checkpoint,
                      updatedAtMs: nowMs(),
                      retryTargetPhase: 'admitting',
                      error: {
                        code: 'admission_failed',
                        message:
                          'Persisted takeover admission authority requires explicit reconciliation.',
                        retryable: true,
                        occurredAtMs: nowMs(),
                      },
                    };
                  }
                  if (repairMode === 'reconciliation_required') {
                    const reconciledAtMs = nowMs();
                    const reconciled = {
                      ...current,
                      revision: current.revision + 1,
                      status: 'reconciliation_required' as const,
                      updatedAtMs: reconciledAtMs,
                      retryTargetPhase: current.phase,
                      error: {
                        code: 'reconciliation_required' as const,
                        message:
                          'External-linked takeover admission acknowledgement is unresolved after restart.',
                        retryable: true,
                        occurredAtMs: reconciledAtMs,
                      },
                    };
                    // A retained exact external-linked admission attempt stands
                    // on its own identity: explicit user Retry replays it
                    // idempotently against the admission owner, so no
                    // canonical-owner disagreement is fabricated for it — that
                    // evidence would make the same status unretryable.
                    if (
                      isRetryableExternalLinkedAdmissionAcknowledgementReconciliationV1(
                        reconciled,
                      )
                    ) {
                      return reconciled;
                    }
                    return {
                      ...reconciled,
                      error: {
                        ...reconciled.error,
                        message:
                          'Persisted takeover admission evidence is incomplete or ambiguous after restart.',
                      },
                      canonicalOwnerEvidence: {
                        ...current.canonicalOwnerEvidence,
                        disagreement: {
                          owner: 'runtime_control',
                          expectedRevision:
                            current.canonicalOwnerEvidence.runtimeControlRevision
                            ?? current.canonicalOwnerEvidence.linkedSessionRevision,
                          observedRevision: 0,
                        },
                      },
                    };
                  }
                  const retryPhase = current.request.plan === 'takeover'
                    && current.request.targetStorageMode === 'persisted'
                    && current.phase === 'quiescing'
                    ? 'validating'
                    : current.phase;
                  return {
                    ...current,
                    revision: current.revision + 1,
                    status: 'awaiting_user_resume',
                    retryTargetPhase: retryPhase,
                    updatedAtMs: nowMs(),
                  };
                },
              );
            if (repaired.ok) {
              record = repaired.record;
            } else if (repaired.code === 'operation_not_found') {
              record = null;
            } else {
              const latest = await readExternalSessionOperationRecord(
                activeServerDir,
                selectedRecord.operationId,
              );
              if (!latest) {
                record = null;
              } else if (
                latest.request.sessionId !== selectedRecord.request.sessionId
                || resolvePassiveRepairMode(latest) !== null
              ) {
                throw new Error(
                  'external_session_operation_repair_concurrent_state_conflict',
                );
              } else {
                // A current-revision action won the race. Publish only those
                // newer durable bytes; the metadata binding rejects revision
                // regression.
                record = latest;
              }
            }
          }
          if (!record) return false;
          await convergeExternalSessionOperationProgressProjection(
            activeServerDir,
            record,
            dependencies,
          );
          const stagingDisposition =
            stagingDispositionByOperationId.get(record.operationId)
            ?? (isExternalLinkedTakeoverCompletion(record)
              ? 'not_applicable'
              : undefined);
          if (stagingDisposition) {
            await compactTerminalExternalSessionOperation(
              activeServerDir,
              record,
              stagingDisposition,
            );
          }
          return true;
        },
      );
      if (barrier.status === 'executed' && barrier.value) {
        convergedCount += 1;
      }
    } catch (error) {
      // Each session is an independent repair unit. Conflicting or malformed
      // state fails closed for that session without suppressing later repairs.
      logExternalSessionsInternalError(
        'external_session.operation_projection_repair_session',
        error,
      );
    }
  }
  return convergedCount;
}

type ExternalSessionOperationSelectionOptions = Readonly<{
  allowDifferentTerminalReplacement?: boolean;
  expectedDifferentTerminalPresentation?:
    ExternalSessionOperationSharedPresentationV1;
}>;

function permitsDifferentTerminalReplacement(
  current: ExternalSessionOperationSharedPresentationV1,
  options: ExternalSessionOperationSelectionOptions,
): boolean {
  return REPLACEABLE_TERMINAL_STATUSES.has(current.status)
    && options.allowDifferentTerminalReplacement === true
    && options.expectedDifferentTerminalPresentation !== undefined
    && presentationsEqual(
      options.expectedDifferentTerminalPresentation,
      current,
    );
}

function parseOptionalExternalSessionOperationState(
  metadata: SessionMetadata,
) {
  const hasOwnerOperation = Object.hasOwn(
    metadata,
    EXTERNAL_SESSION_OPERATION_METADATA_KEY,
  );
  const parsed = ExternalSessionOperationStateV1Schema.safeParse(
    metadata[EXTERNAL_SESSION_OPERATION_METADATA_KEY],
  );
  if (hasOwnerOperation && !parsed.success) {
    throw new Error('external_session_operation_projection_malformed');
  }
  return parsed.success ? parsed.data : null;
}

export function selectExternalSessionOperationProgressMetadata(
  metadata: SessionMetadata,
  progress: ExternalSessionOperationProgressV1,
  options: ExternalSessionOperationSelectionOptions = {},
): SessionMetadata {
  const hasPresentation = Object.hasOwn(
    metadata,
    EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY,
  );
  const parsedPresentation =
    ExternalSessionOperationSharedPresentationV1Schema.safeParse(
      metadata[EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY],
    );
  if (hasPresentation && !parsedPresentation.success) {
    throw new Error('external_session_operation_projection_malformed');
  }
  const current =
    parseOptionalExternalSessionOperationState(metadata)?.progress ?? null;
  const incomingPresentation =
    projectExternalSessionOperationSharedPresentationV1(progress);
  if (current && parsedPresentation.success) {
    const currentPresentation =
      projectExternalSessionOperationSharedPresentationV1(current);
    if (!presentationsEqual(currentPresentation, parsedPresentation.data)) {
      throw new Error('external_session_operation_projection_conflict');
    }
  } else if (parsedPresentation.success) {
    const presentation = parsedPresentation.data;
    if (presentation.operationId === progress.operationId) {
      if (
        presentation.revision > progress.revision
        || (
          presentation.revision === progress.revision
          && !presentationsEqual(presentation, incomingPresentation)
        )
      ) {
        throw new Error('external_session_operation_projection_conflict');
      }
    } else if (!permitsDifferentTerminalReplacement(presentation, options)) {
      throw new Error('external_session_operation_projection_conflict');
    }
  }
  let selectedMetadata: SessionMetadata = metadata;
  if (current && current.operationId !== progress.operationId) {
    if (!permitsDifferentTerminalReplacement(
      projectExternalSessionOperationSharedPresentationV1(current),
      options,
    )) {
      throw new Error('external_session_operation_projection_conflict');
    }
    // Clearing and selecting happen in one encrypted metadata CAS. The binding
    // itself never infers cross-operation currentness from timestamps.
    selectedMetadata = clearSessionStateFieldFromMetadata(
      selectedMetadata,
      'runtime.externalSessionOperation',
    );
  }
  const ownerMetadata = writeSessionStateFieldToMetadata(
    selectedMetadata,
    'runtime.externalSessionOperation',
    { v: 1, progress },
  );
  const selectedState = ExternalSessionOperationStateV1Schema.parse(
    ownerMetadata[EXTERNAL_SESSION_OPERATION_METADATA_KEY],
  );
  return {
    ...ownerMetadata,
    [EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY]:
      projectExternalSessionOperationSharedPresentationV1(
        selectedState.progress,
      ),
  };
}

function presentationsEqual(
  left: ExternalSessionOperationSharedPresentationV1,
  right: ExternalSessionOperationSharedPresentationV1,
): boolean {
  return left.v === right.v
    && left.operationId === right.operationId
    && left.revision === right.revision
    && left.kind === right.kind
    && left.status === right.status
    && left.phase === right.phase;
}

export function selectExternalSessionOperationPresentationMetadata(
  metadata: SessionMetadata,
  progress: ExternalSessionOperationProgressV1,
  options: ExternalSessionOperationSelectionOptions = {},
): SessionMetadata {
  const hasPresentation = Object.hasOwn(
    metadata,
    EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY,
  );
  const parsedPresentation =
    ExternalSessionOperationSharedPresentationV1Schema.safeParse(
      metadata[EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY],
    );
  if (hasPresentation && !parsedPresentation.success) {
    throw new Error('external_session_operation_projection_malformed');
  }
  const owner = parseOptionalExternalSessionOperationState(metadata);
  const current = parsedPresentation.success
    ? parsedPresentation.data
    : owner
      ? projectExternalSessionOperationSharedPresentationV1(
          owner.progress,
        )
      : null;
  const incoming =
    projectExternalSessionOperationSharedPresentationV1(progress);
  let selected = incoming;
  if (current?.operationId === incoming.operationId) {
    if (current.revision > incoming.revision) {
      selected = current;
    } else if (current.revision === incoming.revision) {
      if (!presentationsEqual(current, incoming)) {
        throw new Error('external_session_operation_projection_conflict');
      }
      selected = current;
    }
  } else if (current && !permitsDifferentTerminalReplacement(current, options)) {
    throw new Error('external_session_operation_projection_conflict');
  }
  const {
    [EXTERNAL_SESSION_OPERATION_METADATA_KEY]: _ownerOperation,
    ...withoutOwnerOperation
  } = metadata;
  return {
    ...withoutOwnerOperation,
    [EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY]: selected,
  };
}

function asMetadata(value: unknown): SessionMetadata | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SessionMetadata
    : null;
}

/**
 * Read-only admission check used immediately before the durable operation row
 * write. Selection policy remains owned by the same pure function as publish.
 */
export async function assertExternalSessionOperationProgressCanBeSelected(
  input: Readonly<{
    sessionId: string;
    progress: ExternalSessionOperationProgressV1;
    priorTerminalRecords?: readonly ExternalSessionOperationRecordV1[];
    priorTerminalReceiptEvidence?:
      readonly ExternalSessionOperationPriorTerminalReceiptEvidence[];
  }>,
): Promise<ExternalSessionOperationSharedPresentationV1 | undefined> {
  const credentials = await readStoredCredentials();
  if (!credentials) throw new Error('external_session_operation_publish_unauthenticated');
  const [rawSession, accountEncryptionCurrentness] = await Promise.all([
    fetchSessionById({
      token: credentials.token,
      sessionId: input.sessionId,
    }),
    fetchAccountEncryptionCurrentness({ token: credentials.token }),
  ]);
  if (!rawSession) throw new Error('external_session_operation_publish_session_not_found');
  const snapshot = readSessionMetadataTupleWriterSnapshot({
    credentials,
    rawSession,
    accountEncryptionCurrentness,
  });
  const metadata = asMetadata(snapshot.value.metadata);
  if (!metadata) {
    throw new Error('external_session_operation_publish_metadata_unsupported');
  }
  const select = (options: ExternalSessionOperationSelectionOptions = {}) => {
    if (snapshot.metadataLayoutVersion === 0) {
      selectExternalSessionOperationPresentationMetadata(
        metadata,
        input.progress,
        options,
      );
      return;
    }
    selectExternalSessionOperationProgressMetadata(
      metadata,
      input.progress,
      options,
    );
  };
  try {
    select();
    return undefined;
  } catch (error) {
    if (
      !(error instanceof Error)
      || error.message !== 'external_session_operation_projection_conflict'
    ) {
      throw error;
    }
  }
  const matchingReceiptPresentations:
    ExternalSessionOperationSharedPresentationV1[] = [];
  for (const evidence of input.priorTerminalReceiptEvidence ?? []) {
    const receiptReference = ExternalSessionOperationReferenceV1Schema.safeParse(
      evidence.reference,
    );
    const receiptPresentation =
      ExternalSessionOperationSharedPresentationV1Schema.safeParse(
        evidence.presentation,
      );
    if (
      !receiptReference.success
      || !receiptPresentation.success
      || receiptReference.data.sessionId !== input.sessionId
      || receiptReference.data.operationId
        !== receiptPresentation.data.operationId
      || receiptReference.data.revision !== receiptPresentation.data.revision
      || receiptPresentation.data.status !== 'completed'
    ) {
      throw new Error('external_session_operation_projection_conflict');
    }
    try {
      select({
        allowDifferentTerminalReplacement: true,
        expectedDifferentTerminalPresentation: receiptPresentation.data,
      });
      matchingReceiptPresentations.push(receiptPresentation.data);
    } catch (error) {
      if (
        !(error instanceof Error)
        || error.message !== 'external_session_operation_projection_conflict'
      ) {
        throw error;
      }
    }
  }
  if (matchingReceiptPresentations.length > 1) {
    throw new Error('external_session_operation_projection_conflict');
  }
  if (matchingReceiptPresentations.length === 1) {
    return matchingReceiptPresentations[0];
  }
  for (const predecessor of input.priorTerminalRecords ?? []) {
    if (
      predecessor.request.sessionId !== input.sessionId
      || !REPLACEABLE_TERMINAL_STATUSES.has(predecessor.status)
      || predecessor.progressProjection.acknowledgedRevision === null
      || predecessor.progressProjection.acknowledgedRevision
        < predecessor.revision
    ) {
      continue;
    }
    const expectedDifferentTerminalPresentation =
      projectExternalSessionOperationSharedPresentationV1(
        projectExternalSessionOperationProgressV1(predecessor),
      );
    try {
      select({
        allowDifferentTerminalReplacement: true,
        expectedDifferentTerminalPresentation,
      });
      return expectedDifferentTerminalPresentation;
    } catch (error) {
      if (
        !(error instanceof Error)
        || error.message !== 'external_session_operation_projection_conflict'
      ) {
        throw error;
      }
    }
  }
  throw new Error('external_session_operation_projection_conflict');
}

export async function readExternalSessionOperationSharedPresentation(
  sessionId: string,
): Promise<
  | Readonly<{ kind: 'gone' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{
    kind: 'valid';
    presentation: ExternalSessionOperationSharedPresentationV1;
  }>
  | Readonly<{ kind: 'malformed' }>
> {
  const credentials = await readStoredCredentials();
  if (!credentials) {
    throw new Error('external_session_operation_publish_unauthenticated');
  }
  const [rawSession, accountEncryptionCurrentness] = await Promise.all([
    fetchSessionById({
      token: credentials.token,
      sessionId,
    }),
    fetchAccountEncryptionCurrentness({ token: credentials.token }),
  ]);
  if (!rawSession) return { kind: 'gone' };
  const snapshot = readSessionMetadataTupleWriterSnapshot({
    credentials,
    rawSession,
    accountEncryptionCurrentness,
  });
  let presentation: unknown;
  if (snapshot.metadataLayoutVersion === 0) {
    const metadata = asMetadata(snapshot.value.metadata);
    if (!metadata) {
      throw new Error(
        'external_session_operation_publish_metadata_unsupported',
      );
    }
    presentation =
      metadata[EXTERNAL_SESSION_OPERATION_PRESENTATION_METADATA_KEY];
  } else {
    presentation =
      snapshot.value.sharedMetadata.externalSessionOperationPresentationV1;
  }
  const parsed = ExternalSessionOperationSharedPresentationV1Schema.safeParse(
    presentation,
  );
  if (presentation === undefined) return { kind: 'absent' };
  return parsed.success
    ? { kind: 'valid', presentation: parsed.data }
    : { kind: 'malformed' };
}

export async function publishExternalSessionOperationProgress(input: Readonly<{
  activeServerDir: string;
  sessionId: string;
  progress: ExternalSessionOperationProgressV1;
  allowDifferentTerminalReplacement?: boolean;
  expectedDifferentTerminalPresentation?:
    ExternalSessionOperationSharedPresentationV1;
  sessionAdmissionLockHeld?: boolean;
}>): Promise<ExternalSessionOperationRecordV1> {
  const publishUnderAdmissionLock = async () => {
    let selectedProgress = input.progress;
    let allowDifferentTerminalReplacement =
      input.allowDifferentTerminalReplacement;
    let privateRecordChangedDuringPublish = false;
    const credentials = await readStoredCredentials();
    if (!credentials) throw new Error('external_session_operation_publish_unauthenticated');
    const accountEncryptionCurrentness = await fetchAccountEncryptionCurrentness({
      token: credentials.token,
    });
    while (true) {
      const current = await readExternalSessionOperationRecord(
        input.activeServerDir,
        selectedProgress.operationId,
      );
      if (
        !current
        || current.request.sessionId !== input.sessionId
        || JSON.stringify(
          projectExternalSessionOperationProgressV1(current),
        ) !== JSON.stringify(selectedProgress)
      ) {
        throw new Error(
          'external_session_operation_projection_stale_private_record',
        );
      }
      const rawSession = await fetchSessionById({
        token: credentials.token,
        sessionId: input.sessionId,
      });
      if (!rawSession) throw new Error('external_session_operation_publish_session_not_found');
      await updateSessionMetadataWithRetry({
        token: credentials.token,
        credentials,
        sessionId: input.sessionId,
        rawSession,
        accountEncryptionCurrentness,
        maxAttempts:
          EXTERNAL_SESSION_OPERATION_PROJECTION_METADATA_MAX_ATTEMPTS,
        // The tuple owner may migrate a layout-0 source to layout 1 in this
        // mutation. Supply the complete owner view and let that owner split
        // the private operation from its shared presentation.
        updater: (metadata) =>
          selectExternalSessionOperationProgressMetadata(
            metadata,
            selectedProgress,
            {
              allowDifferentTerminalReplacement,
              expectedDifferentTerminalPresentation:
                input.expectedDifferentTerminalPresentation,
            },
          ),
      });
      const latest = await readExternalSessionOperationRecord(
        input.activeServerDir,
        selectedProgress.operationId,
      );
      if (!latest || latest.request.sessionId !== input.sessionId) {
        throw new Error(
          'external_session_operation_projection_stale_private_record',
        );
      }
      const latestProgress =
        projectExternalSessionOperationProgressV1(latest);
      if (JSON.stringify(latestProgress) !== JSON.stringify(selectedProgress)) {
        privateRecordChangedDuringPublish = true;
        selectedProgress = latestProgress;
        allowDifferentTerminalReplacement = false;
        continue;
      }
      if (privateRecordChangedDuringPublish) {
        throw new Error(
          'external_session_operation_projection_stale_private_record',
        );
      }
      const acknowledged =
        await acknowledgeExternalSessionOperationProgressProjection({
          activeServerDir: input.activeServerDir,
          operationId: selectedProgress.operationId,
          projectedRevision: selectedProgress.revision,
        });
      if (input.expectedDifferentTerminalPresentation) {
        await deleteExpiredExternalSessionOperationCompletionReceipt({
          activeServerDir: input.activeServerDir,
          sessionId: input.sessionId,
          operationId:
            input.expectedDifferentTerminalPresentation.operationId,
          expectedPresentation:
            input.expectedDifferentTerminalPresentation,
          nowMs: Date.now(),
          sessionAdmissionLockHeld: true,
        });
      }
      if (isExternalLinkedTakeoverCompletion(acknowledged)) {
        await compactTerminalExternalSessionOperation(
          input.activeServerDir,
          acknowledged,
          'not_applicable',
        );
      }
      return acknowledged;
    }
  };
  if (input.sessionAdmissionLockHeld === true) {
    return await publishUnderAdmissionLock();
  }
  return await withExternalSessionOperationSessionAdmissionLock(
    input.activeServerDir,
    input.sessionId,
    publishUnderAdmissionLock,
  );
}
