import {
  ExternalSessionTakeoverStartInputV1Schema,
  projectExternalSessionOperationProgressV1,
  readLinkedExternalSessionV1FromMetadata,
  resolveExternalSessionOperationTimelineV1,
  type ExternalSessionOperationActionResponseV1,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationSemanticRequestV1,
  type ExternalSessionOperationSocketCommandV1,
  type ExternalSessionOperationSocketResponseV1,
  type ExternalSessionPriorStableStorageV1,
  type ExternalSessionTakeoverStartInputV1,
} from '@happier-dev/protocol';

import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readCredentials } from '@/persistence';
import {
  ExternalSessionOperationClaimLostError,
  maintainExternalSessionOperationClaim,
  type ExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';

import {
  ExternalSessionOperationRecordReadError,
  ExternalSessionOperationRecordAdmissionError,
  assertExternalSessionOperationRecordAdmission,
  externalSessionOperationIdForRequest,
  readExternalSessionOperationRecord,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';
import {
  assertExternalSessionOperationProgressCanBeSelected,
  convergeExternalSessionOperationProgressProjection,
  publishExternalSessionOperationProgress,
  settlePriorTerminalExternalSessionOperationProgressProjections,
} from './operationProgressPublisher';
import {
  resolveGenerationBoundExternalSessionFollowSurface,
} from './providerOpsResolution';
import {
  createExternalSessionSourceGenerationAnchor,
} from './sourceGenerationAnchor';

type TakeoverSemanticRequest = Extract<
  ExternalSessionOperationSemanticRequestV1,
  { plan: 'takeover' }
>;
type TakeoverStartIntent = ExternalSessionTakeoverStartInputV1['request'];
const TAKEOVER_SOURCE_CAPTURE_MAX_BYTES = 512 * 1024;
const TAKEOVER_SOURCE_CAPTURE_MAX_ITEMS = 1;

export async function captureExternalSessionTakeoverSourceSnapshot(
  readPage: () => Promise<Readonly<{ tailCursor?: string | null }>>,
): Promise<Readonly<{
  sourceGeneration: string;
  sourceSnapshotEvidenceRef: string;
}>> {
  const page = await readPage().catch(() => {
    throw new Error('external_session_takeover_start_source_unavailable');
  });
  const sourceSnapshotEvidenceRef =
    typeof page.tailCursor === 'string' ? page.tailCursor : '';
  if (
    !sourceSnapshotEvidenceRef.trim()
    || sourceSnapshotEvidenceRef.length > 4_096
  ) {
    throw new Error('external_session_takeover_start_source_unavailable');
  }
  return {
    sourceGeneration:
      createExternalSessionSourceGenerationAnchor(sourceSnapshotEvidenceRef),
    sourceSnapshotEvidenceRef,
  };
}

type TakeoverStartDependencies = Readonly<{
  activeServerDir: string;
  operationExclusion: ExternalSessionOperationExclusion;
  describeSession(
    request: TakeoverStartIntent,
  ): Promise<Readonly<{
    request: TakeoverSemanticRequest;
    sourceSnapshotEvidenceRef: string;
    linkedSessionRevision: number;
  }>>;
  sendHistoricalCommand(
    command: ExternalSessionOperationSocketCommandV1,
  ): Promise<ExternalSessionOperationSocketResponseV1>;
  validateProgressSelection(input: Readonly<{
    sessionId: string;
    progress: ReturnType<typeof projectExternalSessionOperationProgressV1>;
  }>): Promise<void>;
  publishProgress(input: Readonly<{
    sessionId: string;
    progress: ReturnType<typeof projectExternalSessionOperationProgressV1>;
    allowDifferentTerminalReplacement?: boolean;
  }>): Promise<ExternalSessionOperationRecordV1 | void>;
  convergeProgress?(
    record: ExternalSessionOperationRecordV1,
  ): Promise<ExternalSessionOperationRecordV1>;
  settlePriorTerminalProgressProjection?(
    priorTerminalRecords: readonly ExternalSessionOperationRecordV1[],
    incoming: ExternalSessionOperationRecordV1,
  ): Promise<void>;
  nowMs?: () => number;
}>;

export type ExternalSessionTakeoverStartActionExecutor = Readonly<{
  start(
    input: unknown,
    context?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ExternalSessionOperationActionResponseV1>;
}>;

export function createDefaultExternalSessionTakeoverStartActionExecutor(
  input: Readonly<{
    activeServerDir: string;
    operationExclusion: ExternalSessionOperationExclusion;
    publishProgress: TakeoverStartDependencies['publishProgress'];
    sendHistoricalCommand: TakeoverStartDependencies['sendHistoricalCommand'];
  }>,
): ExternalSessionTakeoverStartActionExecutor {
  return createExternalSessionTakeoverStartActionExecutor({
    ...input,
    convergeProgress: async (record) => {
      await convergeExternalSessionOperationProgressProjection(
        input.activeServerDir,
        record,
      );
      const converged = await readExternalSessionOperationRecord(
        input.activeServerDir,
        record.operationId,
      );
      if (!converged) {
        throw new Error(
          'external_session_operation_progress_convergence_record_missing',
        );
      }
      return converged;
    },
    settlePriorTerminalProgressProjection: async (priorTerminalRecords) => {
      await settlePriorTerminalExternalSessionOperationProgressProjections(
        input.activeServerDir,
        priorTerminalRecords,
        {
          publish: async (publishInput) =>
            await publishExternalSessionOperationProgress({
              ...publishInput,
              sessionAdmissionLockHeld: true,
            }),
        },
      );
    },
    validateProgressSelection:
      assertExternalSessionOperationProgressCanBeSelected,
    describeSession: async (intent) => {
      const credentials = await readCredentials();
      if (!credentials) throw new Error('external_session_takeover_start_unauthenticated');
      const loaded = await loadLinkedExternalSession({
        credentials,
        sessionId: intent.sessionId,
        machineId: intent.source.machineId,
      });
      if (!loaded.ok) {
        if (loaded.error === 'linked_session_reconciliation_required') {
          throw new Error('linked_session_reconciliation_required');
        }
        throw new Error('external_session_takeover_start_source_unavailable');
      }
      const linked = readLinkedExternalSessionV1FromMetadata(loaded.session.metadata);
      if (
        !linked?.qualifiedIdentity
        || loaded.session.remoteSessionId !== intent.source.remoteSessionId
        || loaded.session.linkGeneration !== intent.source.linkGeneration
        || JSON.stringify(linked.qualifiedIdentity)
          !== JSON.stringify(intent.source.qualifiedIdentity)
      ) {
        throw new Error('external_session_takeover_start_source_changed');
      }
      const resolved = await resolveGenerationBoundExternalSessionFollowSurface(
        loaded.session.agentId,
        loaded.session.linkGeneration,
      );
      if (resolved.resource.retirementSignal?.aborted) {
        throw new Error('external_session_takeover_start_source_changed');
      }
      if (!resolved.providerOps.pageTranscript) {
        throw new Error('external_session_takeover_start_source_unavailable');
      }
      const captured = await captureExternalSessionTakeoverSourceSnapshot(
        async () => await resolved.providerOps.pageTranscript!({
          source: loaded.session.source,
          remoteSessionId: loaded.session.remoteSessionId,
          direction: 'older',
          maxBytes: TAKEOVER_SOURCE_CAPTURE_MAX_BYTES,
          maxItems: TAKEOVER_SOURCE_CAPTURE_MAX_ITEMS,
        }),
      );
      if (resolved.resource.retirementSignal?.aborted) {
        throw new Error('external_session_takeover_start_source_unavailable');
      }
      return {
        request: {
          ...intent,
          source: {
            ...intent.source,
            sourceGeneration: captured.sourceGeneration,
            contributionGeneration: resolved.resource.pluginGeneration,
          },
        },
        sourceSnapshotEvidenceRef: captured.sourceSnapshotEvidenceRef,
        linkedSessionRevision: Number.isSafeInteger(
          Number(loaded.session.rawSession.metadataVersion),
        )
          ? Number(loaded.session.rawSession.metadataVersion)
          : 0,
      };
    },
  });
}

function publicIntentForSemanticRequest(
  request: TakeoverSemanticRequest,
): TakeoverStartIntent | null {
  const {
    sourceGeneration: _sourceGeneration,
    contributionGeneration: _contributionGeneration,
    ...source
  } = request.source;
  return {
    ...request,
    source,
  };
}

function classifyStartFailure(error: unknown): ExternalSessionOperationActionResponseV1 {
  const code = error instanceof Error ? error.message : '';
  if (error instanceof ExternalSessionOperationRecordAdmissionError) {
    return error.reason === 'conflicting_operation'
      ? failure('operation_conflict', 'Another external-session operation is active.')
      : failure('internal_error', 'Takeover operation inventory could not be read.');
  }
  if (
    code === 'external_session_takeover_start_source_changed'
    || code === 'external_session_takeover_start_source_unavailable'
  ) {
    return failure('source_unavailable', 'Linked external session identity changed.');
  }
  if (code === 'linked_session_reconciliation_required') {
    return failure(
      'reconciliation_required',
      'Linked external session metadata requires reconciliation.',
    );
  }
  if (code === 'external_session_operation_projection_conflict') {
    return failure('operation_conflict', 'Another external-session operation is active.');
  }
  return failure('internal_error', 'Takeover operation could not be started.');
}

function failure(
  code: Extract<ExternalSessionOperationActionResponseV1, { ok: false }>['error']['code'],
  message: string,
): ExternalSessionOperationActionResponseV1 {
  return { ok: false, error: { code, message } };
}

function emptyCheckpoint(): ExternalSessionOperationRecordV1['checkpoint'] {
  return {
    sourcePagesRead: 0,
    stagedItemCount: 0,
    importedItemCount: 0,
    requiredItemFailures: {
      total: 0,
      record: 0,
      media: 0,
      conversion: 0,
      diagnosticsTruncated: false,
      diagnostics: [],
    },
  };
}

function success(
  record: ExternalSessionOperationRecordV1,
): ExternalSessionOperationActionResponseV1 {
  return {
    ok: true,
    progress: projectExternalSessionOperationProgressV1(record),
  };
}

async function readConvergedTakeoverOperation(
  dependencies: Pick<TakeoverStartDependencies, 'activeServerDir'>,
  operationId: string,
  waitForRelease?: Extract<
    Awaited<ReturnType<ExternalSessionOperationExclusion['acquire']>>,
    { status: 'converged' }
  >['waitForRelease'],
  waitInput?: Readonly<{ signal?: AbortSignal }>,
): Promise<
  | Readonly<{ status: 'record'; record: ExternalSessionOperationRecordV1 }>
  | Readonly<{ status: 'retry_acquire' }>
  | Readonly<{ status: 'failed' }>
> {
  const published = await readExternalSessionOperationRecord(
    dependencies.activeServerDir,
    operationId,
  );
  if (published) return { status: 'record', record: published };
  if (!waitForRelease) return { status: 'failed' };
  let waited: Awaited<ReturnType<NonNullable<typeof waitForRelease>>>;
  try {
    waited = await waitForRelease(waitInput);
  } catch {
    return { status: 'failed' };
  }
  if (waited.status !== 'ready') return { status: 'failed' };
  const afterWait = await readExternalSessionOperationRecord(
    dependencies.activeServerDir,
    operationId,
  );
  return afterWait
    ? { status: 'record', record: afterWait }
    : { status: 'retry_acquire' };
}

export function createExternalSessionTakeoverStartActionExecutor(
  dependencies: TakeoverStartDependencies,
): ExternalSessionTakeoverStartActionExecutor {
  const nowMs = dependencies.nowMs ?? Date.now;

  return Object.freeze({
    async start(raw, context) {
      const parsed = ExternalSessionTakeoverStartInputV1Schema.safeParse(raw);
      if (!parsed.success || parsed.data.request.plan !== 'takeover') {
        return failure('invalid_state', 'Invalid takeover operation request.');
      }
      const intent = parsed.data.request;
      const operationId = externalSessionOperationIdForRequest(intent);
      let existing: ExternalSessionOperationRecordV1 | null;
      try {
        existing = await readExternalSessionOperationRecord(
          dependencies.activeServerDir,
          operationId,
        );
      } catch (error) {
        if (error instanceof ExternalSessionOperationRecordReadError) {
          return failure(
            'internal_error',
            'Takeover operation record could not be read.',
          );
        }
        throw error;
      }
      try {
        await assertExternalSessionOperationRecordAdmission(
          dependencies.activeServerDir,
          {
            sessionId: intent.sessionId,
            operationId,
            idempotencyKey: intent.idempotencyKey,
          },
        );
      } catch (error) {
        return classifyStartFailure(error);
      }
      if (existing) {
        if (
          existing.request.plan !== 'takeover'
          || JSON.stringify(publicIntentForSemanticRequest(existing.request))
          !== JSON.stringify(intent)
        ) {
          return failure('operation_conflict', 'Takeover idempotency request changed.');
        }
        try {
          const converged = dependencies.convergeProgress
            ? await dependencies.convergeProgress(existing)
            : await dependencies.publishProgress({
              sessionId: existing.request.sessionId,
              progress: projectExternalSessionOperationProgressV1(existing),
            }) ?? existing;
          return success(converged);
        } catch (error) {
          return classifyStartFailure(error);
        }
      }
      let described: Awaited<ReturnType<TakeoverStartDependencies['describeSession']>>;
      try {
        described = await dependencies.describeSession(intent);
      } catch (error) {
        return classifyStartFailure(error);
      }
      const request = described.request;
      if (JSON.stringify(publicIntentForSemanticRequest(request)) !== JSON.stringify(intent)) {
        return failure('source_unavailable', 'Linked external session identity changed.');
      }
      const exclusionRequest = {
        kind: 'takeover',
        sessionId: request.sessionId,
        requestId: request.idempotencyKey,
        sourceIdentity: JSON.stringify(request.source.qualifiedIdentity),
        sourceGeneration: request.source.sourceGeneration,
        plan: request.targetStorageMode,
      } as const;
      let acquired = await dependencies.operationExclusion.acquire(
        exclusionRequest,
      );
      while (acquired.status === 'converged') {
        let converged: Awaited<ReturnType<
          typeof readConvergedTakeoverOperation
        >>;
        try {
          converged = await readConvergedTakeoverOperation(
            dependencies,
            operationId,
            acquired.waitForRelease,
            context?.signal ? { signal: context.signal } : undefined,
          );
        } catch (error) {
          if (error instanceof ExternalSessionOperationRecordReadError) {
            return failure(
              'internal_error',
              'Takeover operation record could not be read.',
            );
          }
          return failure(
            'internal_error',
            'Takeover operation convergence could not be observed.',
          );
        }
        if (converged.status === 'failed') {
          return failure(
            'internal_error',
            'Takeover operation convergence could not be observed.',
          );
        }
        if (converged.status === 'record') {
          const convergedRecord = converged.record;
          if (
            convergedRecord.request.plan !== 'takeover'
            || JSON.stringify(publicIntentForSemanticRequest(
              convergedRecord.request,
            )) !== JSON.stringify(intent)
          ) {
            return failure(
              'operation_conflict',
              'Takeover idempotency request changed.',
            );
          }
          try {
            const published = dependencies.convergeProgress
              ? await dependencies.convergeProgress(convergedRecord)
              : await dependencies.publishProgress({
                sessionId: convergedRecord.request.sessionId,
                progress: projectExternalSessionOperationProgressV1(
                  convergedRecord,
                ),
              }) ?? convergedRecord;
            return success(published);
          } catch (error) {
            return classifyStartFailure(error);
          }
        }
        acquired = await dependencies.operationExclusion.acquire(
          exclusionRequest,
        );
      }
      if (acquired.status !== 'acquired') {
        return failure('operation_conflict', 'Takeover operation is already active.');
      }

      const maintenance = maintainExternalSessionOperationClaim({
        claim: acquired.claim,
      });
      try {
        const authority = await maintenance.race(
          () => dependencies.sendHistoricalCommand({
            v: 1,
            kind: 'inspect',
            claim: {
              sessionId: request.sessionId,
              operationId,
              operationClaimId: acquired.claim.record.claimId,
            },
            expectedRevision: 0,
          }),
        );
        if (
          authority.kind !== 'authority'
          || authority.claim.sessionId !== request.sessionId
          || authority.claim.operationId !== operationId
          || authority.claim.operationClaimId !== acquired.claim.record.claimId
          || authority.revision !== 0
        ) {
          throw new Error('external_session_takeover_start_source_unavailable');
        }
        const priorStableStorage: ExternalSessionPriorStableStorageV1 =
          authority.priorStableStorage;
        const createdAtMs = nowMs();
        let record = await maintenance.race(
          () => writeExternalSessionOperationRecord(
            dependencies.activeServerDir,
            {
              v: 1,
              operationId,
              revision: 0,
              request,
              status: 'awaiting_user_resume',
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
                linkedSessionRevision: described.linkedSessionRevision,
                sourceSnapshotEvidenceRef:
                  described.sourceSnapshotEvidenceRef,
              },
              fence: { kind: 'none' },
              retryTargetPhase: 'validating',
            },
            {
              ...(dependencies.settlePriorTerminalProgressProjection
                ? {
                  settlePriorTerminalProgressProjection:
                    dependencies.settlePriorTerminalProgressProjection,
                }
                : {}),
              validateSessionAdmission: async (_current, incoming) => {
                await dependencies.validateProgressSelection({
                  sessionId: incoming.request.sessionId,
                  progress: projectExternalSessionOperationProgressV1(incoming),
                });
              },
            },
          ),
        );
        record = await maintenance.race(async () =>
          await dependencies.publishProgress({
            sessionId: request.sessionId,
            progress: projectExternalSessionOperationProgressV1(record),
            allowDifferentTerminalReplacement: true,
          }) ?? record
        );
        return success(record);
      } catch (error) {
        if (error instanceof ExternalSessionOperationClaimLostError) {
          return failure('operation_conflict', error.code);
        }
        return classifyStartFailure(error);
      } finally {
        maintenance.stop();
        await acquired.claim.release().catch(() => undefined);
      }
    },
  });
}
