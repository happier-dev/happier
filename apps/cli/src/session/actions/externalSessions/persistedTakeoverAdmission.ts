import {
  ExternalHistoryImportV1Schema,
  removeLinkedExternalSessionMetadataV1,
  type SessionMetadataOwnerPatchV1,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSocketCommandV1,
  type ExternalSessionOperationSocketResponseV1,
  type SessionMetadataPublisherPreconditionV1,
} from '@happier-dev/protocol';

import type {
  PersistedTakeoverAdmissionWaiter,
} from '@/daemon/spawn/persistedTakeoverAdmission';
import {
  resolveExternalTakeoverSpawnOptions,
  type ExternalTakeoverSpawnResolution,
  type ResolvedExternalTakeoverSpawn,
} from '@/api/session/external/takeover/resolveExternalTakeoverSpawnOptions';
import type {
  LoadedLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readStoredCredentials } from '@/persistence';
import {
  prepareSessionMetadataTuplePatchForTransaction,
} from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';

import {
  mutateExternalSessionOperationRecordAtRevision,
  readExternalSessionOperationRecord,
} from './operationRecordStore';
import type {
  ExternalSessionPersistedTakeoverImportRecord,
} from './materializeAction';
import { logExternalSessionsInternalError } from './responseErrors';
import {
  loadCurrentExternalSessionExternalLinkedTakeoverSource,
  loadCurrentExternalSessionPersistedTakeoverTarget,
  loadCurrentExternalSessionPersistedTakeoverSource,
  type PreparedExternalSessionExternalLinkedTakeoverSource,
  type PreparedExternalSessionPersistedTakeoverSource,
} from './takeoverPhaseRunner';

type PersistedTakeoverRecord = ExternalSessionOperationRecordV1 & Readonly<{
  request: Extract<
    ExternalSessionOperationRecordV1['request'],
    { plan: 'takeover' }
  > & Readonly<{ targetStorageMode: 'persisted' }>;
}>;

type PersistedTakeoverAdmissionRecord = PersistedTakeoverRecord & Readonly<{
  publication: NonNullable<ExternalSessionOperationRecordV1['publication']>;
  bindings: ExternalSessionOperationRecordV1['bindings'] & Readonly<{
    operationClaimId: string;
    targetRuntimeAttemptId: string;
  }>;
}>;

type ExternalLinkedTakeoverRecord = ExternalSessionOperationRecordV1 & Readonly<{
  request: Extract<
    ExternalSessionOperationRecordV1['request'],
    { plan: 'takeover' }
  > & Readonly<{ targetStorageMode: 'external-linked' }>;
}>;

type ExternalLinkedTakeoverAdmissionRecord = ExternalLinkedTakeoverRecord & Readonly<{
  bindings: ExternalSessionOperationRecordV1['bindings'] & Readonly<{
    operationClaimId: string;
    targetRuntimeAttemptId: string;
  }>;
}>;

type AdmissionCorrelation = Readonly<{
  sessionId: string;
  mode?: 'persisted' | 'external_linked';
  operationId: string;
  attemptId: string;
  publisherPrecondition?: SessionMetadataPublisherPreconditionV1;
  signal?: AbortSignal;
}>;

type PersistedTakeoverMetadataPatch = SessionMetadataOwnerPatchV1;

type PersistedTakeoverAdmissionOwnerDependencies = Readonly<{
  activeServerDir: string;
  admissionWaiter: Pick<
    PersistedTakeoverAdmissionWaiter,
    'isPending' | 'settle' | 'reserveRuntimeBound'
  >;
  isFollowSuspended(input: Readonly<{
    sessionId: string;
    reason: string;
  }>): boolean;
  suspendFollow(input: Readonly<{
    sessionId: string;
    reason: string;
  }>): Promise<void>;
  reconcilePassiveFollowSession?(sessionId: string): Promise<unknown>;
  sendHistoricalCommand(
    command: ExternalSessionOperationSocketCommandV1,
  ): Promise<ExternalSessionOperationSocketResponseV1>;
  cleanupTerminalStaging?(
    operationId: string,
  ): Promise<'cleaned' | 'missing' | 'not_ready' | 'not_terminal'>;
  loadCurrent?(
    record: ExternalSessionPersistedTakeoverImportRecord,
    requirement?: 'allow_advanced_for_catch_up' | 'already_current_for_admission',
  ): Promise<PreparedExternalSessionPersistedTakeoverSource>;
  loadExternalLinkedCurrent?(
    record: ExternalLinkedTakeoverRecord,
  ): Promise<PreparedExternalSessionExternalLinkedTakeoverSource>;
  loadCanonicalTarget?(
    record: ExternalSessionPersistedTakeoverImportRecord,
  ): Promise<LoadedLinkedExternalSession>;
  prepareLinkRetirementPatch?(input: Readonly<{
    linked: LoadedLinkedExternalSession;
    importedAtMs: number;
  }>): Promise<PersistedTakeoverMetadataPatch>;
  resolveSpawnOptions?(input: Readonly<{
    linked: PreparedExternalSessionPersistedTakeoverSource['linked'];
    sessionId: string;
    targetDirectory: string;
    signal?: AbortSignal;
  }>): Promise<ExternalTakeoverSpawnResolution>;
  nowMs?: () => number;
}>;

export function buildPersistedTakeoverRetiredMetadata(input: Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  linked: Pick<
    LoadedLinkedExternalSession,
    'agentId' | 'remoteSessionId' | 'source' | 'linkData'
  >;
  importedAtMs: number;
}>): Record<string, unknown> {
  return {
    ...removeLinkedExternalSessionMetadataV1(input.metadata),
    externalHistoryImportV1: ExternalHistoryImportV1Schema.parse({
      v: 1,
      agentId: input.linked.agentId,
      remoteSessionId: input.linked.remoteSessionId,
      importedAtMs: input.importedAtMs,
      source: input.linked.source,
      ...(input.linked.linkData === undefined
        ? {}
        : { linkData: input.linked.linkData }),
    }),
  };
}

async function preparePersistedTakeoverLinkRetirementPatch(input: Readonly<{
  linked: LoadedLinkedExternalSession;
  importedAtMs: number;
}>): Promise<PersistedTakeoverMetadataPatch> {
  const credentials = await readStoredCredentials();
  if (!credentials) {
    throw new Error('persisted_takeover_admission_credentials_unavailable');
  }
  const accountEncryptionCurrentness = await fetchAccountEncryptionCurrentness({
    token: credentials.token,
  });
  const patch = await prepareSessionMetadataTuplePatchForTransaction({
    credentials,
    accountEncryptionCurrentness,
    rawSession: input.linked.rawSession,
    updater: (metadata) => buildPersistedTakeoverRetiredMetadata({
      metadata,
      linked: input.linked,
      importedAtMs: input.importedAtMs,
    }),
  });
  return patch;
}

export type ExternalSessionPersistedTakeoverAdmissionOwner = Readonly<{
  prepareSpawn(
    record: ExternalSessionOperationRecordV1,
    signal?: AbortSignal,
  ): Promise<ResolvedExternalTakeoverSpawn>;
  admit(input: AdmissionCorrelation): Promise<void>;
  runtimeBound(input: AdmissionCorrelation): Promise<void>;
  reconcileRuntimeBindingFailure(
    input: AdmissionCorrelation,
  ): Promise<ExternalSessionOperationRecordV1 | null>;
  reconcileAuthority(
    record: ExternalSessionOperationRecordV1,
  ): Promise<ExternalSessionOperationRecordV1 | null>;
}>;

function isPersistedTakeoverRecord(
  record: ExternalSessionOperationRecordV1 | null,
): record is PersistedTakeoverRecord {
  return record?.request.plan === 'takeover'
    && record.request.targetStorageMode === 'persisted';
}

function assertAdmissionRecord(
  record: ExternalSessionOperationRecordV1 | null,
  input: AdmissionCorrelation,
): asserts record is PersistedTakeoverAdmissionRecord {
  if (
    !isPersistedTakeoverRecord(record)
    || record.request.sessionId !== input.sessionId
    || record.operationId !== input.operationId
    || record.status !== 'running'
    || record.phase !== 'admitting'
    || record.currentStorageState !== 'snapshot_complete'
    || record.publication === undefined
    || record.fence.kind !== 'none'
    || record.checkpoint.requiredItemFailures.total !== 0
    || record.canonicalOwnerEvidence.disagreement !== undefined
    || !record.bindings.operationClaimId
    || record.bindings.targetRuntimeAttemptId !== input.attemptId
  ) {
    throw new Error('persisted_takeover_admission_operation_mismatch');
  }
}

function readNonnegativeInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number {
  const value = record[key];
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new Error(`persisted_takeover_admission_invalid_${key}`);
  }
  return value;
}

function assertCurrentAuthority(
  record: PersistedTakeoverAdmissionRecord,
  current: PreparedExternalSessionPersistedTakeoverSource,
): Readonly<{
  metadataVersion: number;
  seq: number;
  pendingVersion: number;
  pendingCount: number;
  pendingBlockedCount: number;
}> {
  const raw = current.linked.rawSession as Readonly<Record<string, unknown>>;
  const metadataVersion = readNonnegativeInteger(raw, 'metadataVersion');
  const seq = readNonnegativeInteger(raw, 'seq');
  const pendingVersion = readNonnegativeInteger(raw, 'pendingVersion');
  const pendingCount = readNonnegativeInteger(raw, 'pendingCount');
  const pendingBlockedCount = readNonnegativeInteger(raw, 'pendingBlockedCount');
  const publication = record.publication;
  if (!publication) {
    throw new Error('persisted_takeover_admission_publication_missing');
  }
  if (
    current.pluginGeneration !== record.request.source.contributionGeneration
    || current.linked.machineId !== record.request.source.machineId
    || current.linked.remoteSessionId !== record.request.source.remoteSessionId
    || current.linked.linkGeneration !== record.request.source.linkGeneration
    || seq !== publication.publishedThroughServerSeq
    || raw.currentStorageState !== 'snapshot_complete'
    || raw.acceptedThroughServerSeq !== null
    || raw.active !== true
    || raw.thinking === true
  ) {
    throw new Error('persisted_takeover_admission_authority_mismatch');
  }
  return {
    metadataVersion,
    seq,
    pendingVersion,
    pendingCount,
    pendingBlockedCount,
  };
}

function isExactHostedAuthority(
  record: PersistedTakeoverAdmissionRecord,
  linked: LoadedLinkedExternalSession,
  expected: Readonly<{
    metadataVersion: number;
    seq: number;
    pendingVersion: number;
    pendingCount: number;
    pendingBlockedCount: number;
  }>,
): boolean {
  const raw = linked.rawSession as Readonly<Record<string, unknown>>;
  return linked.machineId === record.request.source.machineId
    && linked.remoteSessionId === record.request.source.remoteSessionId
    && linked.linkGeneration === record.request.source.linkGeneration
    && raw.metadataVersion === expected.metadataVersion + 1
    && raw.seq === expected.seq
    && raw.pendingVersion === expected.pendingVersion
    && raw.pendingCount === expected.pendingCount
    && raw.pendingBlockedCount === expected.pendingBlockedCount
    && raw.currentStorageState === 'hosted'
    && raw.active === true
    && raw.thinking === false
    && raw.acceptedThroughServerSeq === null;
}

function isAuthorityReconciliationRecord(
  record: ExternalSessionOperationRecordV1,
): record is PersistedTakeoverAdmissionRecord {
  const isInterruptedRunning = record.status === 'running';
  const isExplicitRecovery = record.status === 'failed'
    && record.error?.code === 'admission_failed'
    && record.error.retryable === true
    && record.retryTargetPhase === 'admitting';
  return isPersistedTakeoverRecord(record)
    && (isInterruptedRunning || isExplicitRecovery)
    && record.phase === 'admitting'
    && record.currentStorageState === 'snapshot_complete'
    && record.publication !== undefined
    && record.fence.kind === 'none'
    && record.canonicalOwnerEvidence.transcriptAuthorityRevision !== undefined
    && record.canonicalOwnerEvidence.pendingAdmissionRevision !== undefined
    && record.bindings.operationClaimId !== undefined
    && record.bindings.targetRuntimeAttemptId !== undefined
    && record.canonicalOwnerEvidence.disagreement === undefined;
}

function canonicalTargetMatchesPersistedFence(
  record: PersistedTakeoverAdmissionRecord,
  linked: LoadedLinkedExternalSession,
  metadataVersion: number,
): boolean {
  const raw = linked.rawSession as Readonly<Record<string, unknown>>;
  return linked.machineId === record.request.source.machineId
    && linked.remoteSessionId === record.request.source.remoteSessionId
    && linked.linkGeneration === record.request.source.linkGeneration
    && raw.metadataVersion === metadataVersion
    && raw.seq
      === record.canonicalOwnerEvidence.transcriptAuthorityRevision
    && raw.pendingVersion
      === record.canonicalOwnerEvidence.pendingAdmissionRevision
    && raw.active === true
    && raw.thinking === false;
}

function isExactPersistedHostedTarget(
  record: PersistedTakeoverAdmissionRecord,
  linked: LoadedLinkedExternalSession,
): boolean {
  const raw = linked.rawSession as Readonly<Record<string, unknown>>;
  return canonicalTargetMatchesPersistedFence(
    record,
    linked,
    record.canonicalOwnerEvidence.linkedSessionRevision + 1,
  )
    && raw.currentStorageState === 'hosted'
    && raw.acceptedThroughServerSeq === null;
}

function isExactPersistedSnapshotTarget(
  record: PersistedTakeoverAdmissionRecord,
  linked: LoadedLinkedExternalSession,
): boolean {
  const raw = linked.rawSession as Readonly<Record<string, unknown>>;
  return canonicalTargetMatchesPersistedFence(
    record,
    linked,
    record.canonicalOwnerEvidence.linkedSessionRevision,
  )
    && raw.currentStorageState === 'snapshot_complete'
    && raw.acceptedThroughServerSeq === null;
}

function isLocallyConverged(
  record: ExternalSessionOperationRecordV1 | null,
  input: AdmissionCorrelation,
): record is PersistedTakeoverRecord {
  return isPersistedTakeoverRecord(record)
    && record.request.sessionId === input.sessionId
    && record.operationId === input.operationId
    && record.status === 'running'
    && record.phase === 'spawning'
    && record.currentStorageState === 'hosted'
    && record.publication === undefined
    && record.bindings.targetRuntimeAttemptId === input.attemptId;
}

function isRuntimeBoundCompleted(
  record: ExternalSessionOperationRecordV1 | null,
  input: AdmissionCorrelation,
): boolean {
  return isPersistedTakeoverRecord(record)
    && record.request.sessionId === input.sessionId
    && record.operationId === input.operationId
    && record.status === 'completed'
    && record.phase === 'finalizing'
    && record.currentStorageState === 'hosted'
    && record.publication === undefined
    && record.terminalResult?.kind === 'completed'
    && record.bindings.targetRuntimeAttemptId === input.attemptId;
}

function isHostedOfflineRetryCandidate(
  record: ExternalSessionOperationRecordV1 | null,
): record is PersistedTakeoverRecord {
  return isPersistedTakeoverRecord(record)
    && record.status === 'running'
    && record.phase === 'spawning'
    && record.currentStorageState === 'hosted'
    && record.publication === undefined
    && record.fence.kind === 'none'
    && record.bindings.operationClaimId !== undefined
    && record.bindings.targetRuntimeAttemptId !== undefined
    && record.checkpoint.requiredItemFailures.total === 0
    && record.canonicalOwnerEvidence.disagreement === undefined;
}

function isCurrentHostedTarget(
  record: PersistedTakeoverRecord,
  linked: LoadedLinkedExternalSession,
): boolean {
  const raw = linked.rawSession as Readonly<Record<string, unknown>>;
  return linked.machineId === record.request.source.machineId
    && linked.remoteSessionId === record.request.source.remoteSessionId
    && linked.linkGeneration === record.request.source.linkGeneration
    && raw.metadataVersion
      === record.canonicalOwnerEvidence.linkedSessionRevision + 1
    && raw.currentStorageState === 'hosted'
    && raw.active === true
    && raw.thinking === false
    && raw.acceptedThroughServerSeq === null;
}

function isExactPostcommitCandidate(
  record: ExternalSessionOperationRecordV1 | null,
  input: AdmissionCorrelation,
): record is PersistedTakeoverRecord {
  return isPersistedTakeoverRecord(record)
    && record.request.sessionId === input.sessionId
    && record.operationId === input.operationId
    && record.bindings.targetRuntimeAttemptId === input.attemptId
    && record.bindings.operationClaimId !== undefined
    && record.checkpoint.requiredItemFailures.total === 0
    && record.canonicalOwnerEvidence.disagreement === undefined
    && (
      (
        record.phase === 'admitting'
        && record.currentStorageState === 'snapshot_complete'
        && record.publication !== undefined
        && (record.status === 'running' || record.status === 'failed')
      )
      || (
        record.phase === 'spawning'
        && record.currentStorageState === 'hosted'
        && record.publication === undefined
        && (record.status === 'running' || record.status === 'failed')
      )
    );
}

function toPostcommitRecord(
  record: PersistedTakeoverRecord,
  input: AdmissionCorrelation,
  waiterPending: boolean,
  nowMs: number,
): ExternalSessionOperationRecordV1 {
  if (!isExactPostcommitCandidate(record, input)) {
    throw new Error('persisted_takeover_admission_local_convergence_conflict');
  }
  const {
    publication: _publication,
    retryTargetPhase: _retryTargetPhase,
    error: _error,
    terminalResult: _terminalResult,
    ...withoutRecovery
  } = record;
  const {
    acceptedThroughServerSeq: _acceptedThroughServerSeq,
    acknowledgedBatchId: _acknowledgedBatchId,
    ...checkpoint
  } = record.checkpoint;
  return waiterPending
    ? {
        ...withoutRecovery,
        revision: record.revision + 1,
        status: 'running',
        phase: 'spawning',
        currentStorageState: 'hosted',
        checkpoint,
        fence: { kind: 'none' },
        updatedAtMs: nowMs,
      }
    : {
        ...withoutRecovery,
        revision: record.revision + 1,
        status: 'failed',
        phase: 'spawning',
        currentStorageState: 'hosted',
        checkpoint,
        fence: { kind: 'none' },
        retryTargetPhase: 'spawning',
        error: {
          code: 'spawn_failed',
          message: 'Persisted takeover was admitted after its control claim ended.',
          retryable: true,
          occurredAtMs: nowMs,
        },
        updatedAtMs: nowMs,
      };
}

function isExternalLinkedTakeoverRecord(
  record: ExternalSessionOperationRecordV1 | null,
): record is ExternalLinkedTakeoverRecord {
  return record?.request.plan === 'takeover'
    && record.request.targetStorageMode === 'external-linked';
}

function externalLinkedStableStorageMatches(
  record: ExternalLinkedTakeoverRecord,
  raw: Readonly<Record<string, unknown>>,
): boolean {
  const stable = record.priorStableStorage;
  if (stable.state === 'machine_only') {
    return record.currentStorageState === 'machine_only'
      && record.publication === undefined
      && raw.currentStorageState === 'machine_only'
      && raw.acceptedThroughServerSeq === null
      && raw.materializationPublicationId === null
      && raw.materializedThroughSourceAt === null
      && raw.publishedThroughServerSeq === null;
  }
  return record.currentStorageState === 'snapshot_complete'
    && record.publication !== undefined
    && record.publication.materializationPublicationId
      === stable.publication.materializationPublicationId
    && record.publication.materializedThroughSourceAt
      === stable.publication.materializedThroughSourceAt
    && record.publication.publishedThroughServerSeq
      === stable.publication.publishedThroughServerSeq
    && raw.currentStorageState === 'snapshot_complete'
    && raw.acceptedThroughServerSeq === null
    && raw.materializationPublicationId
      === stable.publication.materializationPublicationId
    && raw.materializedThroughSourceAt
      === stable.publication.materializedThroughSourceAt
    && raw.publishedThroughServerSeq
      === stable.publication.publishedThroughServerSeq;
}

function assertExternalLinkedAdmissionRecord(
  record: ExternalSessionOperationRecordV1 | null,
  input: AdmissionCorrelation,
): asserts record is ExternalLinkedTakeoverAdmissionRecord {
  const raw = record?.request.plan === 'takeover'
    ? record as ExternalLinkedTakeoverRecord
    : null;
  if (
    input.mode !== 'external_linked'
    || !input.publisherPrecondition
    || !isExternalLinkedTakeoverRecord(raw)
    || raw.request.sessionId !== input.sessionId
    || raw.operationId !== input.operationId
    || raw.status !== 'running'
    || raw.phase !== 'admitting'
    || raw.fence.kind !== 'none'
    || raw.checkpoint.requiredItemFailures.total !== 0
    || raw.canonicalOwnerEvidence.disagreement !== undefined
    || !raw.bindings.operationClaimId
    || raw.bindings.targetRuntimeAttemptId !== input.attemptId
    || !externalLinkedStableStorageMatches(
      raw,
      raw.priorStableStorage.state === 'machine_only'
        ? {
            currentStorageState: 'machine_only',
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
          }
        : {
            currentStorageState: 'snapshot_complete',
            acceptedThroughServerSeq: null,
            materializationPublicationId:
              raw.priorStableStorage.publication.materializationPublicationId,
            materializedThroughSourceAt:
              raw.priorStableStorage.publication.materializedThroughSourceAt,
            publishedThroughServerSeq:
              raw.priorStableStorage.publication.publishedThroughServerSeq,
          },
    )
  ) {
    throw new Error('external_linked_takeover_admission_operation_mismatch');
  }
}

function assertExternalLinkedCurrentAuthority(
  record: ExternalLinkedTakeoverAdmissionRecord,
  current: PreparedExternalSessionExternalLinkedTakeoverSource,
  publisherPrecondition: SessionMetadataPublisherPreconditionV1,
): Readonly<{
  metadataVersion: number;
  seq: number;
  pendingVersion: number;
  pendingCount: number;
  pendingBlockedCount: number;
}> {
  const raw = current.linked.rawSession as Readonly<Record<string, unknown>>;
  const metadataVersion = readNonnegativeInteger(raw, 'metadataVersion');
  const seq = readNonnegativeInteger(raw, 'seq');
  const pendingVersion = readNonnegativeInteger(raw, 'pendingVersion');
  const pendingCount = readNonnegativeInteger(raw, 'pendingCount');
  const pendingBlockedCount = readNonnegativeInteger(raw, 'pendingBlockedCount');
  if (
    !current.permitsAdmission
    || current.pluginGeneration !== record.request.source.contributionGeneration
    || current.linked.machineId !== record.request.source.machineId
    || current.linked.remoteSessionId !== record.request.source.remoteSessionId
    || current.linked.linkGeneration !== record.request.source.linkGeneration
    || publisherPrecondition.machineId !== record.request.source.machineId
    || raw.active !== true
    || raw.thinking === true
    || !externalLinkedStableStorageMatches(record, raw)
  ) {
    throw new Error('external_linked_takeover_admission_authority_mismatch');
  }
  return {
    metadataVersion,
    seq,
    pendingVersion,
    pendingCount,
    pendingBlockedCount,
  };
}

function isExternalLinkedLocallyConverged(
  record: ExternalSessionOperationRecordV1 | null,
  input: AdmissionCorrelation,
): record is ExternalLinkedTakeoverAdmissionRecord {
  return input.mode === 'external_linked'
    && isExternalLinkedTakeoverRecord(record)
    && record.request.sessionId === input.sessionId
    && record.operationId === input.operationId
    && record.status === 'running'
    && record.phase === 'spawning'
    && record.bindings.operationClaimId !== undefined
    && record.bindings.targetRuntimeAttemptId === input.attemptId
    && record.checkpoint.requiredItemFailures.total === 0
    && record.canonicalOwnerEvidence.disagreement === undefined;
}

function isExternalLinkedRuntimeBoundCompleted(
  record: ExternalSessionOperationRecordV1 | null,
  input: AdmissionCorrelation,
): record is ExternalLinkedTakeoverRecord {
  return input.mode === 'external_linked'
    && isExternalLinkedTakeoverRecord(record)
    && record.request.sessionId === input.sessionId
    && record.operationId === input.operationId
    && record.status === 'completed'
    && record.phase === 'finalizing'
    && record.terminalResult?.kind === 'completed'
    && record.bindings.targetRuntimeAttemptId === input.attemptId;
}

function isExternalLinkedAdmissionCandidate(
  record: ExternalSessionOperationRecordV1 | null,
  input: AdmissionCorrelation,
): record is ExternalLinkedTakeoverAdmissionRecord {
  return input.mode === 'external_linked'
    && isExternalLinkedTakeoverRecord(record)
    && record.request.sessionId === input.sessionId
    && record.operationId === input.operationId
    && record.bindings.operationClaimId !== undefined
    && record.bindings.targetRuntimeAttemptId === input.attemptId
    && record.checkpoint.requiredItemFailures.total === 0
    && record.canonicalOwnerEvidence.disagreement === undefined
    && (record.phase === 'admitting' || record.phase === 'spawning')
    && (record.status === 'running' || record.status === 'failed');
}

function isExternalLinkedPostcommitCandidate(
  record: ExternalSessionOperationRecordV1 | null,
  input: AdmissionCorrelation,
): record is ExternalLinkedTakeoverAdmissionRecord {
  return isExternalLinkedAdmissionCandidate(record, input)
    && record.phase === 'spawning';
}

function toExternalLinkedLocallyConvergedRecord(
  record: ExternalLinkedTakeoverAdmissionRecord,
  input: AdmissionCorrelation,
  waiterPending: boolean,
  nowMs: number,
): ExternalSessionOperationRecordV1 {
  if (!isExternalLinkedAdmissionCandidate(record, input)) {
    throw new Error('external_linked_takeover_admission_local_convergence_conflict');
  }
  const {
    retryTargetPhase: _retryTargetPhase,
    error: _error,
    terminalResult: _terminalResult,
    cancellation: _cancellation,
    ...withoutRecovery
  } = record;
  return waiterPending
    ? {
        ...withoutRecovery,
        revision: record.revision + 1,
        status: 'running',
        phase: 'spawning',
        fence: { kind: 'none' },
        updatedAtMs: nowMs,
      }
    : {
        ...withoutRecovery,
        revision: record.revision + 1,
        status: 'failed',
        phase: 'spawning',
        fence: { kind: 'none' },
        retryTargetPhase: 'spawning',
        error: {
          code: 'spawn_failed',
          message: 'External-linked takeover was admitted after its control claim ended.',
          retryable: true,
          occurredAtMs: nowMs,
        },
        updatedAtMs: nowMs,
      };
}

export function createExternalSessionPersistedTakeoverAdmissionOwner(
  dependencies: PersistedTakeoverAdmissionOwnerDependencies,
): ExternalSessionPersistedTakeoverAdmissionOwner {
  const loadCurrent = dependencies.loadCurrent
    ?? loadCurrentExternalSessionPersistedTakeoverSource;
  const loadCanonicalTarget = dependencies.loadCanonicalTarget
    ?? loadCurrentExternalSessionPersistedTakeoverTarget;
  const loadExternalLinkedCurrent = dependencies.loadExternalLinkedCurrent
    ?? loadCurrentExternalSessionExternalLinkedTakeoverSource;
  const loadAdmissionAuthority = async (
    record: ExternalSessionPersistedTakeoverImportRecord,
  ): Promise<PreparedExternalSessionPersistedTakeoverSource> => await loadCurrent(
    record,
    'already_current_for_admission',
  );
  const resolveSpawnOptions = dependencies.resolveSpawnOptions
    ?? resolveExternalTakeoverSpawnOptions;
  const prepareLinkRetirementPatch = dependencies.prepareLinkRetirementPatch
    ?? preparePersistedTakeoverLinkRetirementPatch;
  const nowMs = dependencies.nowMs ?? Date.now;
  const markHostedOffline = async (
    input: AdmissionCorrelation,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await readExternalSessionOperationRecord(
        dependencies.activeServerDir,
        input.operationId,
      );
      if (!latest || !isExactPostcommitCandidate(latest, input)) {
        throw new Error('persisted_takeover_admission_offline_convergence_conflict');
      }
      if (
        latest.status === 'failed'
        && latest.phase === 'spawning'
        && latest.currentStorageState === 'hosted'
      ) {
        return;
      }
      const offline = await mutateExternalSessionOperationRecordAtRevision(
        dependencies.activeServerDir,
        latest.operationId,
        latest.revision,
        (fresh) => {
          if (!isExactPostcommitCandidate(fresh, input)) {
            throw new Error(
              'persisted_takeover_admission_offline_convergence_conflict',
            );
          }
          return toPostcommitRecord(
            fresh as PersistedTakeoverRecord,
            input,
            false,
            nowMs(),
          );
        },
      );
      if (offline.ok) return;
      if (attempt === 2) {
        throw new Error('persisted_takeover_admission_offline_convergence_failed');
      }
    }
  };
  const readAfterRuntimeBindingFailure = async (
    input: AdmissionCorrelation,
  ): Promise<ExternalSessionOperationRecordV1 | null> => {
    const latest = await readExternalSessionOperationRecord(
      dependencies.activeServerDir,
      input.operationId,
    );
    if (isRuntimeBoundCompleted(latest, input)) return latest;
    if (!isExactPostcommitCandidate(latest, input)) return null;
    if (
      latest.phase !== 'spawning'
      || latest.currentStorageState !== 'hosted'
    ) {
      return null;
    }
    await markHostedOffline(input);
    return await readExternalSessionOperationRecord(
      dependencies.activeServerDir,
      input.operationId,
    );
  };
  const fenceUnresolvedAdmission = async (
    input: AdmissionCorrelation,
    authority: Readonly<{
      metadataVersion: number;
      seq: number;
      pendingVersion: number;
    }>,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await readExternalSessionOperationRecord(
        dependencies.activeServerDir,
        input.operationId,
      );
      if (!isExactPostcommitCandidate(latest, input)) {
        throw new Error('persisted_takeover_admission_unresolved_convergence_conflict');
      }
      const publication = latest.publication;
      if (!publication) {
        throw new Error('persisted_takeover_admission_publication_missing');
      }
      const {
        acceptedThroughServerSeq: _acceptedThroughServerSeq,
        acknowledgedBatchId: _acknowledgedBatchId,
        ...checkpoint
      } = latest.checkpoint;
      const fenced = await mutateExternalSessionOperationRecordAtRevision(
        dependencies.activeServerDir,
        latest.operationId,
        latest.revision,
        (fresh) => ({
          ...fresh,
          revision: fresh.revision + 1,
          status: 'failed',
          checkpoint,
          canonicalOwnerEvidence: {
            ...fresh.canonicalOwnerEvidence,
            linkedSessionRevision: authority.metadataVersion,
            transcriptAuthorityRevision: authority.seq,
            pendingAdmissionRevision: authority.pendingVersion,
          },
          updatedAtMs: nowMs(),
          retryTargetPhase: 'admitting',
          fence: { kind: 'none' },
          error: {
            code: 'admission_failed',
            message:
              'Persisted takeover admission authority could not be reconciled.',
            retryable: true,
            occurredAtMs: nowMs(),
          },
        }),
      );
      if (fenced.ok) return;
      if (attempt === 2) {
        throw new Error('persisted_takeover_admission_unresolved_convergence_failed');
      }
    }
  };
  const markExternalLinkedOffline = async (
    input: AdmissionCorrelation,
  ): Promise<void> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await readExternalSessionOperationRecord(
        dependencies.activeServerDir,
        input.operationId,
      );
      if (!latest || !isExternalLinkedPostcommitCandidate(latest, input)) {
        throw new Error('external_linked_takeover_admission_offline_convergence_conflict');
      }
      if (latest.status === 'failed' && latest.phase === 'spawning') return;
      const offline = await mutateExternalSessionOperationRecordAtRevision(
        dependencies.activeServerDir,
        latest.operationId,
        latest.revision,
        (fresh) => {
          if (!isExternalLinkedPostcommitCandidate(fresh, input)) {
            throw new Error('external_linked_takeover_admission_offline_convergence_conflict');
          }
          return toExternalLinkedLocallyConvergedRecord(
            fresh as ExternalLinkedTakeoverAdmissionRecord,
            input,
            false,
            nowMs(),
          );
        },
      );
      if (offline.ok) return;
      if (attempt === 2) {
        throw new Error('external_linked_takeover_admission_offline_convergence_failed');
      }
    }
  };
  const readAfterExternalLinkedRuntimeBindingFailure = async (
    input: AdmissionCorrelation,
  ): Promise<ExternalSessionOperationRecordV1 | null> => {
    const latest = await readExternalSessionOperationRecord(
      dependencies.activeServerDir,
      input.operationId,
    );
    if (isExternalLinkedRuntimeBoundCompleted(latest, input)) return latest;
    if (!isExternalLinkedPostcommitCandidate(latest, input)) return null;
    await markExternalLinkedOffline(input);
    return await readExternalSessionOperationRecord(
      dependencies.activeServerDir,
      input.operationId,
    );
  };
  const admitExternalLinked = async (
    input: AdmissionCorrelation,
  ): Promise<void> => {
    if (input.mode !== 'external_linked' || !input.publisherPrecondition) {
      throw new Error('external_linked_takeover_admission_mode_mismatch');
    }
    const publisherPrecondition = input.publisherPrecondition;
    const correlation = {
      mode: 'external_linked' as const,
      operationId: input.operationId,
      attemptId: input.attemptId,
    };
    const endControlClaim = () => {
      dependencies.admissionWaiter.settle(correlation, {
        status: 'failed',
        errorCode: 'external_linked_takeover_admission_control_request_ended',
      });
    };
    if (input.signal?.aborted) {
      endControlClaim();
    } else {
      input.signal?.addEventListener('abort', endControlClaim, { once: true });
    }
    try {
      if (!dependencies.admissionWaiter.isPending(correlation)) {
        throw new Error('external_linked_takeover_admission_attempt_not_pending');
      }
      const record = await readExternalSessionOperationRecord(
        dependencies.activeServerDir,
        input.operationId,
      );
      if (isExternalLinkedLocallyConverged(record, input)) return;
      assertExternalLinkedAdmissionRecord(record, input);
      if (!dependencies.isFollowSuspended({
        sessionId: input.sessionId,
        reason: 'takeover',
      })) {
        throw new Error('external_linked_takeover_admission_follow_not_suspended');
      }
      const current = await loadExternalLinkedCurrent(record);
      const authority = assertExternalLinkedCurrentAuthority(
        record,
        current,
        publisherPrecondition,
      );
      const prepared = await mutateExternalSessionOperationRecordAtRevision(
        dependencies.activeServerDir,
        record.operationId,
        record.revision,
        (fresh) => {
          assertExternalLinkedAdmissionRecord(fresh, input);
          const priorTranscriptRevision =
            fresh.canonicalOwnerEvidence.transcriptAuthorityRevision;
          const priorPendingRevision =
            fresh.canonicalOwnerEvidence.pendingAdmissionRevision;
          if (
            (priorTranscriptRevision !== undefined
              && priorTranscriptRevision !== authority.seq)
            || (priorPendingRevision !== undefined
              && priorPendingRevision !== authority.pendingVersion)
          ) {
            throw new Error('external_linked_takeover_admission_prepared_authority_mismatch');
          }
          return {
            ...fresh,
            revision: fresh.revision + 1,
            canonicalOwnerEvidence: {
              ...fresh.canonicalOwnerEvidence,
              linkedSessionRevision: authority.metadataVersion,
              transcriptAuthorityRevision: authority.seq,
              pendingAdmissionRevision: authority.pendingVersion,
            },
            updatedAtMs: nowMs(),
          };
        },
      );
      if (!prepared.ok) {
        throw new Error(`external_linked_takeover_admission_prepare_${prepared.code}`);
      }
      const authorityRecord = prepared.record as ExternalLinkedTakeoverAdmissionRecord;
      const command: Extract<
        ExternalSessionOperationSocketCommandV1,
        { kind: 'admit_persisted_takeover'; mode: 'external_linked' }
      > = {
        v: 1,
        kind: 'admit_persisted_takeover',
        mode: 'external_linked',
        claim: {
          sessionId: input.sessionId,
          operationId: input.operationId,
          operationClaimId: authorityRecord.bindings.operationClaimId,
        },
        expectedRevision: authorityRecord.revision,
        attemptId: input.attemptId,
        publisherPrecondition,
        expectedSessionMetadataVersion: authority.metadataVersion,
        expectedSessionSeq: authority.seq,
        expectedPending: {
          version: authority.pendingVersion,
          count: authority.pendingCount,
          blockedCount: authority.pendingBlockedCount,
        },
        expectedPriorStableStorage: authorityRecord.priorStableStorage,
      };
      let response: ExternalSessionOperationSocketResponseV1;
      try {
        response = await dependencies.sendHistoricalCommand(command);
      } catch {
        try {
          response = await dependencies.sendHistoricalCommand(command);
        } catch (retryError) {
          throw new Error(
            'external_linked_takeover_admission_ack_ambiguous',
            { cause: retryError },
          );
        }
      }
      if (
        response.kind !== 'takeover_admitted'
        || response.mode !== 'external_linked'
        || response.attemptId !== input.attemptId
        || response.revision !== authorityRecord.revision
        || response.claim.sessionId !== input.sessionId
        || response.claim.operationId !== input.operationId
        || response.claim.operationClaimId
          !== authorityRecord.bindings.operationClaimId
      ) {
        throw new Error(
          response.kind === 'error'
            ? `external_linked_takeover_admission_${response.errorCode}`
            : 'external_linked_takeover_admission_response_mismatch',
        );
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const latest = await readExternalSessionOperationRecord(
          dependencies.activeServerDir,
          input.operationId,
        );
        if (isExternalLinkedLocallyConverged(latest, input)) break;
        if (!isExternalLinkedAdmissionCandidate(latest, input)) {
          throw new Error('external_linked_takeover_admission_local_convergence_conflict');
        }
        const converged = await mutateExternalSessionOperationRecordAtRevision(
          dependencies.activeServerDir,
          latest.operationId,
          latest.revision,
          (fresh) => toExternalLinkedLocallyConvergedRecord(
            fresh as ExternalLinkedTakeoverAdmissionRecord,
            input,
            dependencies.admissionWaiter.isPending(correlation),
            nowMs(),
          ),
        );
        if (converged.ok) break;
        if (attempt === 2) {
          throw new Error('external_linked_takeover_admission_local_convergence_failed');
        }
      }
      if (!dependencies.admissionWaiter.isPending(correlation)) {
        await markExternalLinkedOffline(input);
        throw new Error('external_linked_takeover_admission_control_claim_ended');
      }
    } catch (error) {
      dependencies.admissionWaiter.settle(correlation, {
        status: 'failed',
        errorCode: error instanceof Error
          ? error.message
          : 'external_linked_takeover_admission_failed',
      });
      throw error;
    } finally {
      input.signal?.removeEventListener('abort', endControlClaim);
    }
  };
  const runtimeBoundExternalLinked = async (
    input: AdmissionCorrelation,
  ): Promise<void> => {
    if (input.mode !== 'external_linked' || !input.publisherPrecondition) {
      throw new Error('external_linked_takeover_runtime_bound_mode_mismatch');
    }
    const correlation = {
      mode: 'external_linked' as const,
      operationId: input.operationId,
      attemptId: input.attemptId,
    };
    const endControlClaim = () => {
      dependencies.admissionWaiter.settle(correlation, {
        status: 'failed',
        errorCode: 'external_linked_takeover_runtime_bound_request_ended',
      });
    };
    if (input.signal?.aborted) {
      endControlClaim();
    } else {
      input.signal?.addEventListener('abort', endControlClaim, { once: true });
    }
    try {
      const initial = await readExternalSessionOperationRecord(
        dependencies.activeServerDir,
        input.operationId,
      );
      if (isExternalLinkedRuntimeBoundCompleted(initial, input)) return;
      if (!isExternalLinkedLocallyConverged(initial, input)) {
        throw new Error('external_linked_takeover_runtime_bound_operation_mismatch');
      }
      const reserved = dependencies.admissionWaiter.reserveRuntimeBound(correlation);
      if (reserved.status === 'already_reserved') {
        const outcome = await reserved.outcome;
        if (outcome.status !== 'committed') throw new Error(outcome.errorCode);
        const completed = await readExternalSessionOperationRecord(
          dependencies.activeServerDir,
          input.operationId,
        );
        if (!isExternalLinkedRuntimeBoundCompleted(completed, input)) {
          throw new Error('external_linked_takeover_runtime_bound_duplicate_mismatch');
        }
        return;
      }
      if (reserved.status === 'unavailable') {
        await markExternalLinkedOffline(input);
        throw new Error('external_linked_takeover_runtime_bound_attempt_not_pending');
      }
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (!reserved.reservation.isActive()) {
            throw new Error('external_linked_takeover_runtime_bound_custody_ended');
          }
          const latest = await readExternalSessionOperationRecord(
            dependencies.activeServerDir,
            input.operationId,
          );
          if (isExternalLinkedRuntimeBoundCompleted(latest, input)) {
            reserved.reservation.commit();
            return;
          }
          if (!isExternalLinkedLocallyConverged(latest, input)) {
            throw new Error('external_linked_takeover_runtime_bound_operation_mismatch');
          }
          const completed = await mutateExternalSessionOperationRecordAtRevision(
            dependencies.activeServerDir,
            latest.operationId,
            latest.revision,
            (fresh) => {
              if (!reserved.reservation.isActive()) {
                throw new Error('external_linked_takeover_runtime_bound_custody_ended');
              }
              if (!isExternalLinkedLocallyConverged(fresh, input)) {
                throw new Error('external_linked_takeover_runtime_bound_operation_mismatch');
              }
              const {
                retryTargetPhase: _retryTargetPhase,
                error: _error,
                ...withoutRecovery
              } = fresh;
              return {
                ...withoutRecovery,
                revision: fresh.revision + 1,
                status: 'completed',
                phase: 'finalizing',
                updatedAtMs: nowMs(),
                terminalResult: { kind: 'completed' },
              };
            },
          );
          if (completed.ok) {
            if (!reserved.reservation.commit()) {
              throw new Error('external_linked_takeover_runtime_bound_custody_ended');
            }
            return;
          }
          if (attempt === 2) {
            throw new Error('external_linked_takeover_runtime_bound_convergence_failed');
          }
        }
      } catch (error) {
        reserved.reservation.fail(
          error instanceof Error
            ? error.message
            : 'external_linked_takeover_runtime_bound_failed',
        );
        await readAfterExternalLinkedRuntimeBindingFailure(input).catch(() => null);
        throw error;
      }
    } finally {
      input.signal?.removeEventListener('abort', endControlClaim);
    }
  };

  return Object.freeze({
    async reconcileAuthority(record) {
      if (!isAuthorityReconciliationRecord(record)) {
        throw new Error(
          'persisted_takeover_admission_reconciliation_operation_mismatch',
        );
      }
      let target: LoadedLinkedExternalSession;
      try {
        target = await loadCanonicalTarget(
          record as ExternalSessionPersistedTakeoverImportRecord,
        );
      } catch {
        return null;
      }
      const input = {
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        attemptId: record.bindings.targetRuntimeAttemptId,
      };
      if (isExactPersistedHostedTarget(record, target)) {
        await markHostedOffline(input);
        return await readExternalSessionOperationRecord(
          dependencies.activeServerDir,
          record.operationId,
        );
      }
      if (!isExactPersistedSnapshotTarget(record, target)) {
        return null;
      }
      const resumed = await mutateExternalSessionOperationRecordAtRevision(
        dependencies.activeServerDir,
        record.operationId,
        record.revision,
        (fresh) => {
          if (!isAuthorityReconciliationRecord(fresh)) {
            throw new Error(
              'persisted_takeover_admission_reconciliation_state_changed',
            );
          }
          const {
            error: _error,
            ...withoutError
          } = fresh;
          return {
            ...withoutError,
            revision: fresh.revision + 1,
            status: 'awaiting_user_resume',
            updatedAtMs: nowMs(),
            retryTargetPhase: 'admitting',
            fence: { kind: 'none' },
          };
        },
      );
      return resumed.ok
        ? resumed.record
        : await readExternalSessionOperationRecord(
          dependencies.activeServerDir,
          record.operationId,
        );
    },

    async prepareSpawn(record, signal) {
      const input = {
        sessionId: record.request.sessionId,
        operationId: record.operationId,
        attemptId: record.bindings.targetRuntimeAttemptId ?? '',
      };
      if (isHostedOfflineRetryCandidate(record)) {
        const linked = await loadCanonicalTarget(
          record as ExternalSessionPersistedTakeoverImportRecord,
        );
        if (!isCurrentHostedTarget(record, linked)) {
          throw new Error('persisted_takeover_retry_hosted_target_mismatch');
        }
        const options = await resolveSpawnOptions({
          linked,
          sessionId: input.sessionId,
          targetDirectory: record.request.targetDirectory,
          ...(signal ? { signal } : {}),
        });
        if (!options.ok) {
          throw new Error(
            `persisted_takeover_admission_spawn_${options.code}`,
          );
        }
        return options.value;
      }
      assertAdmissionRecord(record, input);
      const suspension = {
        sessionId: input.sessionId,
        reason: 'takeover',
      } as const;
      if (!dependencies.isFollowSuspended(suspension)) {
        await dependencies.suspendFollow(suspension);
      }
      if (!dependencies.isFollowSuspended(suspension)) {
        throw new Error('persisted_takeover_admission_follow_not_suspended');
      }
      const current = await loadAdmissionAuthority(
        record as ExternalSessionPersistedTakeoverImportRecord,
      );
      assertCurrentAuthority(record, current);
      const options = await resolveSpawnOptions({
        linked: current.linked,
        sessionId: input.sessionId,
        targetDirectory: record.request.targetDirectory,
        ...(signal ? { signal } : {}),
      });
      if (!options.ok) {
        throw new Error(
          `persisted_takeover_admission_spawn_${options.code}`,
        );
      }
      return options.value;
    },

    async admit(input) {
      if (input.mode === 'external_linked') {
        return await admitExternalLinked(input);
      }
      if (input.mode !== 'persisted') {
        throw new Error('persisted_takeover_admission_mode_mismatch');
      }
      const publisherPrecondition = input.publisherPrecondition;
      if (!publisherPrecondition) {
        throw new Error('persisted_takeover_admission_publisher_precondition_missing');
      }
      const correlation = {
        mode: 'persisted' as const,
        operationId: input.operationId,
        attemptId: input.attemptId,
      };
      const endControlClaim = () => {
        dependencies.admissionWaiter.settle(correlation, {
          status: 'failed',
          errorCode: 'persisted_takeover_admission_control_request_ended',
        });
      };
      if (input.signal?.aborted) {
        endControlClaim();
      } else {
        input.signal?.addEventListener('abort', endControlClaim, { once: true });
      }
      try {
        if (!dependencies.admissionWaiter.isPending(correlation)) {
          throw new Error('persisted_takeover_admission_attempt_not_pending');
        }
        const record = await readExternalSessionOperationRecord(
          dependencies.activeServerDir,
          input.operationId,
        );
        if (isLocallyConverged(record, input)) {
          return;
        }
        assertAdmissionRecord(record, input);
        if (
          publisherPrecondition.machineId
          !== record.request.source.machineId
        ) {
          throw new Error('persisted_takeover_admission_publisher_machine_mismatch');
        }
        if (!dependencies.isFollowSuspended({
          sessionId: input.sessionId,
          reason: 'takeover',
        })) {
          throw new Error('persisted_takeover_admission_follow_not_suspended');
        }
        const current = await loadAdmissionAuthority(
          record as ExternalSessionPersistedTakeoverImportRecord,
        );
        const authority = assertCurrentAuthority(record, current);
        const preparedMetadataPatch = await prepareLinkRetirementPatch({
          linked: current.linked,
          importedAtMs: nowMs(),
        });
        const metadataPatch: PersistedTakeoverMetadataPatch = {
          ...preparedMetadataPatch,
          publisherPrecondition,
        };
        const metadataPatchExpectedVersion =
          metadataPatch.sharedMetadata.expectedVersion;
        if (
          metadataPatchExpectedVersion !== authority.metadataVersion
        ) {
          throw new Error(
            'persisted_takeover_admission_metadata_patch_authority_mismatch',
          );
        }
        const prepared = await mutateExternalSessionOperationRecordAtRevision(
          dependencies.activeServerDir,
          record.operationId,
          record.revision,
          (fresh) => {
            assertAdmissionRecord(fresh, input);
            const priorTranscriptRevision =
              fresh.canonicalOwnerEvidence.transcriptAuthorityRevision;
            const priorPendingRevision =
              fresh.canonicalOwnerEvidence.pendingAdmissionRevision;
            if (
              (
                priorTranscriptRevision !== undefined
                && priorTranscriptRevision !== authority.seq
              )
              || (
                priorPendingRevision !== undefined
                && priorPendingRevision !== authority.pendingVersion
              )
            ) {
              throw new Error(
                'persisted_takeover_admission_prepared_authority_mismatch',
              );
            }
            return {
              ...fresh,
              revision: fresh.revision + 1,
              canonicalOwnerEvidence: {
                ...fresh.canonicalOwnerEvidence,
                linkedSessionRevision: authority.metadataVersion,
                transcriptAuthorityRevision: authority.seq,
                pendingAdmissionRevision: authority.pendingVersion,
              },
              updatedAtMs: nowMs(),
            };
          },
        );
        if (!prepared.ok) {
          throw new Error(
            `persisted_takeover_admission_prepare_${prepared.code}`,
          );
        }
        const authorityRecord =
          prepared.record as PersistedTakeoverAdmissionRecord;
        const command: Extract<
          ExternalSessionOperationSocketCommandV1,
          { kind: 'admit_persisted_takeover' }
        > = {
          v: 1,
          kind: 'admit_persisted_takeover' as const,
          mode: 'persisted' as const,
          claim: {
            sessionId: input.sessionId,
            operationId: input.operationId,
            operationClaimId: authorityRecord.bindings.operationClaimId,
          },
          expectedRevision: authorityRecord.revision,
          attemptId: input.attemptId,
          publisherPrecondition,
          expectedSessionMetadataVersion: authority.metadataVersion,
          expectedSessionSeq: authority.seq,
          expectedPending: {
            version: authority.pendingVersion,
            count: authority.pendingCount,
            blockedCount: authority.pendingBlockedCount,
          },
          expectedPublication: authorityRecord.publication,
          metadataPatch,
        };
        let response: ExternalSessionOperationSocketResponseV1;
        try {
          response = await dependencies.sendHistoricalCommand(command);
        } catch {
          // The command is attempt-idempotent at the existing server operation
          // owner. Reusing it distinguishes a committed-but-lost ack from a
          // definitive precommit failure without adding another authority read.
          try {
            response = await dependencies.sendHistoricalCommand(command);
          } catch (retryError) {
            let targetAfterAmbiguousSend: LoadedLinkedExternalSession | null =
              null;
            try {
              targetAfterAmbiguousSend = await loadCanonicalTarget(
                record as ExternalSessionPersistedTakeoverImportRecord,
              );
            } catch {
              // The exact canonical reread below decides whether this is a
              // proven postcommit, proven precommit, or unresolved outcome.
            }
            if (
              targetAfterAmbiguousSend
              && isExactHostedAuthority(
                authorityRecord,
                targetAfterAmbiguousSend,
                authority,
              )
            ) {
              dependencies.admissionWaiter.settle(correlation, {
                status: 'failed',
                errorCode: 'persisted_takeover_admission_ack_ambiguous',
              });
              await markHostedOffline(input);
              throw new Error('persisted_takeover_admission_ack_ambiguous');
            }
            await fenceUnresolvedAdmission(input, authority);
            throw new Error(
              'persisted_takeover_admission_authority_unresolved',
              { cause: retryError },
            );
          }
        }
        if (
          response.kind !== 'takeover_admitted'
          || response.mode !== 'persisted'
          || response.attemptId !== input.attemptId
          || response.revision !== authorityRecord.revision
          || response.claim.sessionId !== input.sessionId
          || response.claim.operationId !== input.operationId
          || response.claim.operationClaimId
            !== authorityRecord.bindings.operationClaimId
        ) {
          throw new Error(
            response.kind === 'error'
              ? `persisted_takeover_admission_${response.errorCode}`
              : 'persisted_takeover_admission_response_mismatch',
          );
        }

        for (let attempt = 0; attempt < 3; attempt += 1) {
          const latest = await readExternalSessionOperationRecord(
            dependencies.activeServerDir,
            input.operationId,
          );
          if (!isExactPostcommitCandidate(latest, input)) {
            throw new Error('persisted_takeover_admission_local_convergence_conflict');
          }
          const waiterPending = dependencies.admissionWaiter.isPending(correlation);
          if (
            latest.phase === 'spawning'
            && latest.currentStorageState === 'hosted'
            && (
              (waiterPending && latest.status === 'running')
              || (!waiterPending && latest.status === 'failed')
            )
          ) {
            break;
          }
          const converged = await mutateExternalSessionOperationRecordAtRevision(
            dependencies.activeServerDir,
            latest.operationId,
            latest.revision,
            (fresh) => toPostcommitRecord(
              fresh as PersistedTakeoverRecord,
              input,
              waiterPending,
              nowMs(),
            ),
          );
          if (converged.ok) break;
          if (attempt === 2) {
            throw new Error('persisted_takeover_admission_local_convergence_failed');
          }
        }

        await dependencies.reconcilePassiveFollowSession?.(input.sessionId);

        if (!dependencies.admissionWaiter.isPending(correlation)) {
          await markHostedOffline(input);
          throw new Error('persisted_takeover_admission_control_claim_ended');
        }
      } catch (error) {
        dependencies.admissionWaiter.settle(correlation, {
          status: 'failed',
          errorCode: error instanceof Error
            ? error.message
            : 'persisted_takeover_admission_failed',
        });
        throw error;
      } finally {
        input.signal?.removeEventListener('abort', endControlClaim);
      }
    },

    async runtimeBound(input) {
      if (input.mode === 'external_linked') {
        return await runtimeBoundExternalLinked(input);
      }
      if (input.mode !== 'persisted' || !input.publisherPrecondition) {
        throw new Error('persisted_takeover_runtime_bound_mode_mismatch');
      }
      const correlation = {
        mode: 'persisted' as const,
        operationId: input.operationId,
        attemptId: input.attemptId,
      };
      const endControlClaim = () => {
        dependencies.admissionWaiter.settle(correlation, {
          status: 'failed',
          errorCode: 'persisted_takeover_runtime_bound_request_ended',
        });
      };
      if (input.signal?.aborted) {
        endControlClaim();
      } else {
        input.signal?.addEventListener('abort', endControlClaim, { once: true });
      }
      try {
        const initial = await readExternalSessionOperationRecord(
          dependencies.activeServerDir,
          input.operationId,
        );
        if (isRuntimeBoundCompleted(initial, input)) return;
        if (!isLocallyConverged(initial, input)) {
          throw new Error('persisted_takeover_runtime_bound_operation_mismatch');
        }
        const reserved =
          dependencies.admissionWaiter.reserveRuntimeBound(correlation);
        if (reserved.status === 'already_reserved') {
          const outcome = await reserved.outcome;
          if (outcome.status !== 'committed') {
            throw new Error(outcome.errorCode);
          }
          const completed = await readExternalSessionOperationRecord(
            dependencies.activeServerDir,
            input.operationId,
          );
          if (!isRuntimeBoundCompleted(completed, input)) {
            throw new Error('persisted_takeover_runtime_bound_duplicate_mismatch');
          }
          return;
        }
        if (reserved.status === 'unavailable') {
          await markHostedOffline(input);
          throw new Error('persisted_takeover_runtime_bound_attempt_not_pending');
        }
        try {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (!reserved.reservation.isActive()) {
              throw new Error('persisted_takeover_runtime_bound_custody_ended');
            }
            const latest = await readExternalSessionOperationRecord(
              dependencies.activeServerDir,
              input.operationId,
            );
            if (isRuntimeBoundCompleted(latest, input)) {
              reserved.reservation.commit();
              return;
            }
            if (!latest || !isLocallyConverged(latest, input)) {
              throw new Error('persisted_takeover_runtime_bound_operation_mismatch');
            }
            const completed = await mutateExternalSessionOperationRecordAtRevision(
              dependencies.activeServerDir,
              latest.operationId,
              latest.revision,
              (fresh) => {
                if (!reserved.reservation.isActive()) {
                  throw new Error(
                    'persisted_takeover_runtime_bound_custody_ended',
                  );
                }
                if (!isLocallyConverged(fresh, input)) {
                  throw new Error('persisted_takeover_runtime_bound_operation_mismatch');
                }
                const {
                  retryTargetPhase: _retryTargetPhase,
                  error: _error,
                  ...withoutRecovery
                } = fresh;
                return {
                  ...withoutRecovery,
                  revision: fresh.revision + 1,
                  status: 'completed',
                  phase: 'finalizing',
                  updatedAtMs: nowMs(),
                  terminalResult: { kind: 'completed' },
                };
              },
            );
            if (completed.ok) {
              if (!reserved.reservation.commit()) {
                throw new Error(
                  'persisted_takeover_runtime_bound_custody_ended',
                );
              }
              try {
                await dependencies.cleanupTerminalStaging?.(input.operationId);
              } catch (error) {
                // Terminal completion is authoritative. The existing bounded
                // lifecycle repair retries operation-private staging cleanup.
                logExternalSessionsInternalError(
                  'external_session.persisted_takeover_terminal_staging_cleanup',
                  error,
                );
              }
              return;
            }
            if (attempt === 2) {
              throw new Error('persisted_takeover_runtime_bound_convergence_failed');
            }
          }
        } catch (error) {
          reserved.reservation.fail(
            error instanceof Error
              ? error.message
              : 'persisted_takeover_runtime_bound_failed',
          );
          await readAfterRuntimeBindingFailure(input).catch(() => null);
          throw error;
        }
      } catch (error) {
        throw error;
      } finally {
        input.signal?.removeEventListener('abort', endControlClaim);
      }
    },

    async reconcileRuntimeBindingFailure(input) {
      if (input.mode === 'external_linked') {
        return await readAfterExternalLinkedRuntimeBindingFailure(input);
      }
      return await readAfterRuntimeBindingFailure(input);
    },
  });
}
