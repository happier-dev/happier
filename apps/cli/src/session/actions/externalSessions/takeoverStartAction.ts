import {
  ExternalSessionTakeoverStartInputV1Schema,
  projectExternalSessionOperationProgressV1,
  readNonAuthoritativeLinkedExternalSessionV1FromMetadata,
  resolveExternalSessionOperationTimelineV1,
  type ExternalSessionOperationActionResponseV1,
  type ExternalSessionOperationAuthorIntentV1,
  type ExternalSessionOperationRecordV1,
  type ExternalSessionOperationReferenceV1,
  type ExternalSessionOperationSharedPresentationV1,
  type ExternalSessionOperationSemanticRequestV1,
  type ExternalSessionOperationSocketCommandV1,
  type ExternalSessionOperationSocketResponseV1,
  type ExternalSessionPriorStableStorageV1,
  type ExternalSessionTakeoverStartInputV1,
} from '@happier-dev/protocol';

import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readStoredCredentials } from '@/persistence';
import {
  ExternalSessionOperationClaimLostError,
  maintainExternalSessionOperationClaim,
  type ExternalSessionOperationExclusion,
} from '@/session/external/operationExclusion';

import {
  ExternalSessionOperationRecordReadError,
  ExternalSessionOperationRecordAdmissionError,
  projectExternalSessionTakeoverIdempotencyIntent,
  resolveExternalSessionOperationStartAdmission,
  readExternalSessionOperationRecord,
  type ExternalSessionOperationPriorTerminalReceiptEvidence,
  type ExternalSessionOperationSelectedPresentationReader,
  writeExternalSessionOperationRecord,
} from './operationRecordStore';
import {
  assertExternalSessionOperationProgressCanBeSelected,
  convergeExternalSessionOperationProgressProjection,
  publishExternalSessionOperationProgress,
  readExternalSessionOperationSharedPresentation,
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
    priorTerminalRecords: readonly ExternalSessionOperationRecordV1[];
    priorTerminalReceiptEvidence?:
      readonly ExternalSessionOperationPriorTerminalReceiptEvidence[];
  }>): Promise<ExternalSessionOperationSharedPresentationV1 | undefined>;
  publishProgress(input: Readonly<{
    sessionId: string;
    progress: ReturnType<typeof projectExternalSessionOperationProgressV1>;
    allowDifferentTerminalReplacement?: boolean;
    expectedDifferentTerminalPresentation?:
      ExternalSessionOperationSharedPresentationV1;
  }>): Promise<ExternalSessionOperationRecordV1 | void>;
  convergeProgress?(
    record: ExternalSessionOperationRecordV1,
  ): Promise<ExternalSessionOperationRecordV1>;
  settlePriorTerminalProgressProjection?(
    priorTerminalRecords: readonly ExternalSessionOperationRecordV1[],
    incoming: ExternalSessionOperationRecordV1,
  ): Promise<void>;
  nowMs?: () => number;
  readSelectedPresentation?:
    ExternalSessionOperationSelectedPresentationReader;
}>;

export type ExternalSessionTakeoverStartActionExecutor = Readonly<{
  start(
    input: unknown,
    context?: Readonly<{
      signal?: AbortSignal;
      /** Host-stamped private contextual-author admission evidence. */
      authorIntent?: ExternalSessionOperationAuthorIntentV1;
    }>,
  ): Promise<ExternalSessionOperationActionResponseV1>;
}>;

export type ExternalSessionPluginTakeoverStartActionExecutor =
  ExternalSessionTakeoverStartActionExecutor & Readonly<{
  startPluginTakeover(
    input: unknown,
    context: Readonly<{
      authorIntent: Extract<
        ExternalSessionOperationAuthorIntentV1,
        { kind: 'takeover' }
      >;
      signal?: AbortSignal;
    }>,
  ): Promise<
    | Readonly<{
      ok: true;
      operation: ExternalSessionOperationReferenceV1;
    }>
    | Extract<ExternalSessionOperationActionResponseV1, { ok: false }>
  >;
}>;

export function createDefaultExternalSessionTakeoverStartActionExecutor(
  input: Readonly<{
    activeServerDir: string;
    operationExclusion: ExternalSessionOperationExclusion;
    publishProgress: TakeoverStartDependencies['publishProgress'];
    sendHistoricalCommand: TakeoverStartDependencies['sendHistoricalCommand'];
  }>,
): ExternalSessionPluginTakeoverStartActionExecutor {
  return createExternalSessionTakeoverStartActionExecutor({
    ...input,
    convergeProgress: async (record) => {
      await convergeExternalSessionOperationProgressProjection(
        input.activeServerDir,
        record,
        {
          allowSettledTerminalPredecessorReplacement: true,
        },
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
          sessionAdmissionLockHeld: true,
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
      const credentials = await readStoredCredentials();
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
      const linked = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(loaded.session.metadata);
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
): Extract<ExternalSessionOperationActionResponseV1, { ok: false }> {
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
  dependencies: Pick<
    TakeoverStartDependencies,
    'activeServerDir' | 'readSelectedPresentation'
  >,
  intent: TakeoverStartIntent,
  nowMs: () => number,
  waitForRelease?: Extract<
    Awaited<ReturnType<ExternalSessionOperationExclusion['acquire']>>,
    { status: 'converged' }
  >['waitForRelease'],
  waitInput?: Readonly<{ signal?: AbortSignal }>,
  authorIntent?: ExternalSessionOperationAuthorIntentV1,
): Promise<
  | Readonly<{ status: 'record'; record: ExternalSessionOperationRecordV1 }>
  | Readonly<{ status: 'terminal_receipt' }>
  | Readonly<{ status: 'conflict' }>
  | Readonly<{ status: 'retry_acquire' }>
  | Readonly<{ status: 'failed' }>
> {
  const resolveDurableAdmission = async () =>
    await resolveExternalSessionOperationStartAdmission({
      activeServerDir: dependencies.activeServerDir,
      durableIdempotencyKey: intent.idempotencyKey,
      intent,
      ...(authorIntent ? { authorIntent } : {}),
      nowMs: nowMs(),
      readSelectedPresentation:
        dependencies.readSelectedPresentation
        ?? readExternalSessionOperationSharedPresentation,
    });
  const published = await resolveDurableAdmission();
  if (published.kind === 'existing_record') {
    return { status: 'record', record: published.record };
  }
  if (published.kind === 'terminal_receipt') {
    return { status: 'terminal_receipt' };
  }
  if (published.kind === 'conflict') return { status: 'conflict' };
  if (published.kind === 'legacy_unavailable') return { status: 'failed' };
  if (!waitForRelease) return { status: 'failed' };
  let waited: Awaited<ReturnType<NonNullable<typeof waitForRelease>>>;
  try {
    waited = await waitForRelease(waitInput);
  } catch {
    return { status: 'failed' };
  }
  if (waited.status !== 'ready') return { status: 'failed' };
  const afterWait = await resolveDurableAdmission();
  if (afterWait.kind === 'existing_record') {
    return { status: 'record', record: afterWait.record };
  }
  if (afterWait.kind === 'terminal_receipt') {
    return { status: 'terminal_receipt' };
  }
  if (afterWait.kind === 'conflict') return { status: 'conflict' };
  if (afterWait.kind === 'legacy_unavailable') return { status: 'failed' };
  return { status: 'retry_acquire' };
}

export function createExternalSessionTakeoverStartActionExecutor(
  dependencies: TakeoverStartDependencies,
): ExternalSessionPluginTakeoverStartActionExecutor {
  const nowMs = dependencies.nowMs ?? Date.now;

  const executor: ExternalSessionPluginTakeoverStartActionExecutor = Object.freeze({
    async start(raw, context) {
      const parsed = ExternalSessionTakeoverStartInputV1Schema.safeParse(raw);
      if (!parsed.success || parsed.data.request.plan !== 'takeover') {
        return failure('invalid_state', 'Invalid takeover operation request.');
      }
      const intent = parsed.data.request;
      let admission: Awaited<ReturnType<
        typeof resolveExternalSessionOperationStartAdmission
      >>;
      try {
        admission = await resolveExternalSessionOperationStartAdmission({
          activeServerDir: dependencies.activeServerDir,
          durableIdempotencyKey: intent.idempotencyKey,
          intent,
          ...(context?.authorIntent
            ? { authorIntent: context.authorIntent }
            : {}),
          nowMs: nowMs(),
          readSelectedPresentation:
            dependencies.readSelectedPresentation
            ?? readExternalSessionOperationSharedPresentation,
        });
      } catch (error) {
        if (
          error instanceof ExternalSessionOperationRecordReadError
          || error instanceof ExternalSessionOperationRecordAdmissionError
        ) {
          return failure(
            'internal_error',
            'Takeover operation inventory could not be read.',
          );
        }
        throw error;
      }
      if (admission.kind === 'conflict') {
        return failure(
          'operation_conflict',
          'Takeover idempotency request changed.',
        );
      }
      if (admission.kind === 'legacy_unavailable') {
        return failure(
          'source_unavailable',
          'A legacy takeover operation cannot be safely resumed.',
        );
      }
      if (admission.kind === 'terminal_receipt') {
        return failure(
          'invalid_state',
          'The settled takeover no longer has private recovery state.',
        );
      }
      if (admission.kind === 'existing_record') {
        const existing = admission.record;
        if (
          existing.request.plan !== 'takeover'
          || JSON.stringify(
            projectExternalSessionTakeoverIdempotencyIntent(existing.request),
          ) !== JSON.stringify(
            projectExternalSessionTakeoverIdempotencyIntent(intent),
          )
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
      const operationId = admission.operationId;
      let described: Awaited<ReturnType<TakeoverStartDependencies['describeSession']>>;
      try {
        described = await dependencies.describeSession(intent);
      } catch (error) {
        return classifyStartFailure(error);
      }
      const request = described.request;
      if (
        JSON.stringify(
          projectExternalSessionTakeoverIdempotencyIntent(request),
        ) !== JSON.stringify(
          projectExternalSessionTakeoverIdempotencyIntent(intent),
        )
      ) {
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
      const exclusionAcquireInput = context?.signal
        ? { signal: context.signal }
        : undefined;
      let acquired: Awaited<ReturnType<ExternalSessionOperationExclusion['acquire']>>;
      try {
        acquired = await dependencies.operationExclusion.acquire(
          exclusionRequest,
          exclusionAcquireInput,
        );
      } catch (error) {
        return classifyStartFailure(error);
      }
      while (acquired.status === 'converged') {
        let converged: Awaited<ReturnType<
          typeof readConvergedTakeoverOperation
        >>;
        try {
          converged = await readConvergedTakeoverOperation(
            dependencies,
            intent,
            nowMs,
            acquired.waitForRelease,
            context?.signal ? { signal: context.signal } : undefined,
            context?.authorIntent,
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
        if (converged.status === 'terminal_receipt') {
          return failure(
            'invalid_state',
            'The settled takeover no longer has private recovery state.',
          );
        }
        if (converged.status === 'conflict') {
          return failure(
            'operation_conflict',
            'Takeover idempotency request changed.',
          );
        }
        if (converged.status === 'record') {
          const convergedRecord = converged.record;
          if (
            convergedRecord.request.plan !== 'takeover'
            || JSON.stringify(
              projectExternalSessionTakeoverIdempotencyIntent(
                convergedRecord.request,
              ),
            ) !== JSON.stringify(
              projectExternalSessionTakeoverIdempotencyIntent(intent),
            )
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
        try {
          acquired = await dependencies.operationExclusion.acquire(
            exclusionRequest,
            exclusionAcquireInput,
          );
        } catch (error) {
          return classifyStartFailure(error);
        }
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
        let expectedDifferentTerminalPresentation:
          ExternalSessionOperationSharedPresentationV1 | undefined;
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
              ...(context?.authorIntent
                ? { authorIntent: context.authorIntent }
                : {}),
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
              validateSessionAdmission: async (
                _current,
                incoming,
                priorTerminalRecords,
                priorTerminalReceiptEvidence,
              ) => {
                expectedDifferentTerminalPresentation =
                  await dependencies.validateProgressSelection({
                    sessionId: incoming.request.sessionId,
                    progress:
                      projectExternalSessionOperationProgressV1(incoming),
                    priorTerminalRecords,
                    priorTerminalReceiptEvidence,
                  });
                return expectedDifferentTerminalPresentation;
              },
              nowMs,
            },
          ),
        );
        if (record.operationId !== operationId) {
          const convergedRecord = dependencies.convergeProgress
            ? await dependencies.convergeProgress(record)
            : await dependencies.publishProgress({
              sessionId: record.request.sessionId,
              progress: projectExternalSessionOperationProgressV1(record),
            }) ?? record;
          return success(convergedRecord);
        }
        record = await maintenance.race(async () =>
          await dependencies.publishProgress({
            sessionId: request.sessionId,
            progress: projectExternalSessionOperationProgressV1(record),
            ...(expectedDifferentTerminalPresentation
              ? {
                allowDifferentTerminalReplacement: true,
                expectedDifferentTerminalPresentation,
              }
              : {}),
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
    async startPluginTakeover(raw, context) {
      const parsed = ExternalSessionTakeoverStartInputV1Schema.safeParse(raw);
      if (!parsed.success || parsed.data.request.plan !== 'takeover') {
        return failure('invalid_state', 'Invalid takeover operation request.');
      }
      const result = await executor.start(raw, context);
      if (result.ok) {
        return {
          ok: true,
          operation: {
            sessionId: parsed.data.request.sessionId,
            operationId: result.progress.operationId,
            revision: result.progress.revision,
          },
        };
      }

      // Once the durable record/receipt exists, a late cancellation, lost
      // response, projection failure, or other unknown outcome cannot be
      // relabelled as "no effect". Re-read the canonical admission owner and
      // return only its public reference.
      try {
        const admitted = await resolveExternalSessionOperationStartAdmission({
          activeServerDir: dependencies.activeServerDir,
          durableIdempotencyKey: parsed.data.request.idempotencyKey,
          intent: parsed.data.request,
          authorIntent: context.authorIntent,
          nowMs: nowMs(),
          readSelectedPresentation:
            dependencies.readSelectedPresentation
            ?? readExternalSessionOperationSharedPresentation,
        });
        if (admitted.kind === 'existing_record') {
          return {
            ok: true,
            operation: {
              sessionId: admitted.record.request.sessionId,
              operationId: admitted.record.operationId,
              revision: admitted.record.revision,
            },
          };
        }
        if (admitted.kind === 'terminal_receipt') {
          return {
            ok: true,
            operation: admitted.receipt.reference,
          };
        }
      } catch {
        // Preserve the canonical Start failure if the follow-up read cannot
        // prove that admission committed.
      }
      return result as Extract<
        ExternalSessionOperationActionResponseV1,
        { ok: false }
      >;
    },
  });
  return executor;
}
