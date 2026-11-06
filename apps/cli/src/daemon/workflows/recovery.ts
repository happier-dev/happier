import { EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES } from '@happier-dev/protocol/actions/externalActionLimits';
import { decodeExecutionRunResultObservation, validateExecutionRunProfileResult } from '@happier-dev/protocol/execution/runs/resultContract';
import { classifyWorkflowReviewEntryV1, applyWorkflowInvocationFactV1, WorkflowRunInvocationIndexV1Schema, WorkflowRunSummaryV1Schema } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { resolveWorkflowInvocationStructureV1, type WorkflowInvocationBindingRowV1 } from '@happier-dev/protocol/workflows/workflowInvocationStructureV1';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, openWorkflowCheckpointStoredEnvelopeV1, openWorkflowProgressStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1, sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema, WorkflowRunRecipientKeyEnvelopeCommitResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { resolveWorkflowRunDataKeyV1, runWorkflowRecipientKeyPreparationV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import type { WorkflowRunEncryptionV1, JsonValue, WorkflowAcceptedSnapshotV1, WorkflowInvocationLifecycleV1, WorkflowProgressEnvelopeV1, WorkflowRunInvocationIndexV1, WorkflowRunSummaryV1, WorkflowUsageV1, WorkflowMaterializedLeafV1 } from '@happier-dev/protocol';

import { getRandomBytes } from '@/api/encryption';
import {
  type AvailableAutomationAccountEncryptionV1,
} from '@/plugins/runtime/automations/automationAccountCurrentness';
import type { WorkflowRunStorageOperation } from './workflowRunStorageClient';
import { isWorkflowJsonObject } from './input';
import { createWorkflowRunReviewEntryNotificationHandler } from '@/notifications/activity/dispatchWorkflowRunUpdateNotification';
import { DurableWorkflowCoordinatorStore } from './production';
import { logger } from '@/ui/logger';
import { readWorkflowProjectSetupConsentHold } from './stepExecution';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { WorkflowCoordinatorInvocation } from './coordinator';
import type { ApprovalExecutionOriginV1 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { DiscussionInviteInputV1Schema } from '@happier-dev/protocol/discussions/actions';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveWorkflowAcceptedStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { WorkflowDiscussionPublicationUnavailable } from './workflowDiscussionPublication';

const RECOVERABLE_INVOCATION_LIFECYCLES = [
  'pending',
  'waiting_for_capacity',
  'admitting',
  'running',
  'waiting_for_approval',
  'needs_attention',
  'cancel_requested',
  'outcome_uncertain',
] as const;

const TERMINAL_RUN_STATES = new Set([
  'succeeded', 'failed', 'cancelled', 'expired', 'dispatch_failed', 'skipped',
  'missed', 'outcome_uncertain',
]);

const TERMINAL_INVOCATION_LIFECYCLES = new Set<WorkflowInvocationLifecycleV1>([
  'completed', 'failed', 'cancelled', 'skipped', 'superseded', 'outcome_uncertain',
]);

function hasActiveWorkflowRunCustody(run: WorkflowRunSummaryV1): boolean {
  return !TERMINAL_RUN_STATES.has(run.state) && run.workflowCustodyState === 'pending';
}

type Storage = Readonly<{
  execute: (operation: WorkflowRunStorageOperation, options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function openMode(encryption: WorkflowRunEncryptionV1) {
  return encryption.runCrypto;
}

type RecoveryCandidate = Readonly<{ run: WorkflowRunSummaryV1; parentAttempt: number }>;
type RecoveredInvocationPublisher = (input: Readonly<{
  run: WorkflowRunSummaryV1; accepted: WorkflowAcceptedSnapshotV1;
  invocation: WorkflowCoordinatorInvocation; encryption: WorkflowRunEncryptionV1; signal?: AbortSignal;
}>) => Promise<void>;

export type WorkflowInvocationRecoveryObservation = (
  | Readonly<{ kind: 'unresolved'; code?: string; waitForCompletion?: () => Promise<void>;
    setupConsentOutput?: Readonly<{ operation: ActionOperationSnapshotV1 }> }>
  | Readonly<{ kind: 'completed'; result: JsonValue; usage?: WorkflowUsageV1 }>
  | Readonly<{ kind: 'needs_attention'; code: 'session_input_result_unavailable'; usage?: WorkflowUsageV1 }>
  | Readonly<{ kind: 'failed'; code: string; message?: string; failureCause?: ActionFailureCauseV1; runtimeIssueV1?: NonNullable<WorkflowProgressEnvelopeV1['reason']>['runtimeIssueV1']; usage?: WorkflowUsageV1 }>
  | Readonly<{ kind: 'cancelled'; code?: string; usage?: WorkflowUsageV1 }>
  | Readonly<{ kind: 'stopped'; code: string }>
  | Readonly<{ kind: 'outcome_uncertain'; code: string; usage?: WorkflowUsageV1 }>
) & Readonly<{ execution?: WorkflowProgressEnvelopeV1['execution']; replyOutcome?: WorkflowProgressEnvelopeV1['replyOutcome'] }>;

type ReconciledInvocationTransition = Readonly<{
  id: string;
  expectedLifecycle: WorkflowInvocationLifecycleV1;
  lifecycle: WorkflowInvocationLifecycleV1;
  expectedContentRevision?: string;
}>;

type ReconciledInvocationCustody = Readonly<{
  invocationTransitions: readonly ReconciledInvocationTransition[];
  cancellationRequested: boolean;
}>;

function parseRunPage(value: unknown): Readonly<{ candidates: readonly RecoveryCandidate[]; nextCursor?: string }> {
  const body = record(value);
  if (!body || !Array.isArray(body.candidates)) throw new Error('workflow_recovery_response_invalid');
  const candidates = body.candidates.map((raw) => {
    const candidate = record(raw);
    if (!candidate || !Number.isSafeInteger(candidate.parentAttempt) || Number(candidate.parentAttempt) < 0) {
      throw new Error('workflow_recovery_response_invalid');
    }
    return { run: WorkflowRunSummaryV1Schema.parse(candidate.run), parentAttempt: Number(candidate.parentAttempt) };
  });
  return { candidates, ...(typeof body.nextCursor === 'string' ? { nextCursor: body.nextCursor } : {}) };
}

export function createWorkflowInvocationRecoveryFactWriter(params: Readonly<{
  accountId: string;
  run: WorkflowRunSummaryV1;
  encryption: WorkflowRunEncryptionV1;
  storage: Storage;
  signal?: AbortSignal;
  /** Reservation admission cannot use the terminal facts needed by recovery. */
  requireActiveCustody?: boolean;
  onReviewEntered?: (entry: Readonly<{ runId: string }>) => Promise<void>;
  onInvocationSettled?: RecoveredInvocationPublisher;
} & (
  | Readonly<{ parentAttempt: number; expectedRevision?: never }>
  | Readonly<{ expectedRevision: number; parentAttempt?: never }>
)>) {
  const readInvocation = async (recordId: string) => {
    const detailBody = record(await params.storage.execute({
      operation: 'invocations.get', runId: params.run.id, invocationId: recordId,
    }, params.signal ? { signal: params.signal } : {}));
    const invocation = record(detailBody?.invocation);
    const index = WorkflowRunInvocationIndexV1Schema.safeParse(invocation?.index);
    const contentEnvelope = invocation?.contentEnvelope;
    const envelope = parseWorkflowStoredContentEnvelopeV1(contentEnvelope);
    if (!index.success || index.data.id !== recordId || index.data.runId !== params.run.id
      || typeof contentEnvelope !== 'string' || !envelope) return undefined;
    const opened = openWorkflowProgressStoredEnvelopeV1({
      ...openMode(params.encryption),
      binding: { v: 1, purpose: 'invocation_progress', accountId: params.accountId, runId: params.run.id,
        recordId, sequence: index.data.sequence, parentRecordId: index.data.parentRecordId,
        memberOrdinal: index.data.memberOrdinal, attempt: index.data.attempt },
      envelope,
    });
    return opened.kind === 'available' ? { index: index.data, progress: opened.content, contentEnvelope } : undefined;
  };
  let acceptedSnapshot: Promise<WorkflowAcceptedSnapshotV1 | undefined> | undefined;
  const readAcceptedSnapshot = async () => {
    acceptedSnapshot ??= (async () => {
      const body = record(await params.storage.execute({ operation: 'get', runId: params.run.id }, params.signal ? { signal: params.signal } : {}));
      if (params.requireActiveCustody) {
        const run = WorkflowRunSummaryV1Schema.safeParse(body?.run);
        if (!run.success || run.data.id !== params.run.id || !hasActiveWorkflowRunCustody(run.data)) return undefined;
      }
      const envelope = parseWorkflowStoredContentEnvelopeV1(body?.acceptedEnvelope);
      if (!envelope) return undefined;
      const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...openMode(params.encryption),
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: params.accountId, runId: params.run.id }, envelope });
      return opened.kind === 'available' ? opened.content : undefined;
    })();
    return await acceptedSnapshot;
  };
  const loadProjectionStore = async (includeTerminalRoot = false) => {
    const accepted = await readAcceptedSnapshot();
    if (!accepted) return;
    const body = record(await params.storage.execute({ operation: 'get', runId: params.run.id },
      params.signal ? { signal: params.signal } : {}));
    if (typeof body?.checkpointEnvelope !== 'string') return;
    const opened = openWorkflowCheckpointStoredEnvelopeV1({ ...openMode(params.encryption),
      binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: params.run.id },
      envelope: parseWorkflowStoredContentEnvelopeV1(body.checkpointEnvelope) });
    if (opened.kind !== 'available') return;
    const root = await readInvocation(opened.content.rootRecordId);
    if (!root || root.progress.blockKind !== 'root') return;
    if (!includeTerminalRoot && TERMINAL_INVOCATION_LIFECYCLES.has(root.index.lifecycle)) return;
    const currentRun = WorkflowRunSummaryV1Schema.parse(body.run);
    // Reuse the executing owner's stored invocation projection and publisher;
    // reattach never acquires a coordinator claim or changes root lifecycle.
    const store = await DurableWorkflowCoordinatorStore.load({ accountId: params.accountId, runId: params.run.id,
      parentAttempt: params.parentAttempt ?? 0,
      ...(currentRun.state === 'interrupted' ? { projectionExpectedRevision: currentRun.revision } : {}),
      revision: currentRun.revision,
      encryption: params.encryption, rootRecordId: opened.content.rootRecordId, checkpoint: opened.content,
      authoredDefinition: accepted.authoredDefinition,
      definition: accepted.definition,
      frozenChildren: accepted.frozenChildren,
      destinations: root.progress.stepProgress?.destinations,
      storage: { execute: async (operation, options) => await params.storage.execute(operation,
        { ...options, ...(params.signal ? { signal: params.signal } : {}) }) },
    });
    return { store, accepted, run: currentRun };
  };
  const refreshRootStepProgress = async () => {
    const loaded = await loadProjectionStore();
    await loaded?.store.refreshStepProgress();
  };
  const publishSettledInvocations = async () => {
    if ((await readAcceptedSnapshot())?.resultDelivery?.kind !== 'originating_discussion') return;
    const loaded = await loadProjectionStore(true);
    if (!loaded) throw new Error('workflow_invocation_content_unavailable');
    const terminal = await loaded.store.listByLifecycle({ runId: params.run.id, lifecycles: ['completed', 'failed', 'cancelled'] });
    for (const invocation of terminal) {
      if (invocation.blockKind !== 'step' && invocation.blockKind !== 'action') continue;
      params.signal?.throwIfAborted();
      try {
        if (!params.onInvocationSettled) throw new WorkflowDiscussionPublicationUnavailable('workflow_discussion_publisher_unavailable');
        await params.onInvocationSettled({ run: loaded.run, accepted: loaded.accepted, invocation,
          encryption: params.encryption, ...(params.signal ? { signal: params.signal } : {}) });
      } catch (error) {
        params.signal?.throwIfAborted();
        // A thrown append may have committed. Classify only at this recovery
        // boundary so another Run can recover without changing live execution.
        if (!(error instanceof WorkflowDiscussionPublicationUnavailable)) throw new WorkflowDiscussionPublicationUnavailable();
        if (!error.terminal
          || !TERMINAL_RUN_STATES.has(loaded.run.state) && loaded.store.rootIndex?.lifecycle !== 'cancelled') throw error;
        // Terminal refusal ends only publication custody, never the accepted
        // result or execution fact. Unknown/lost acknowledgements still throw.
        logger.warn('[workflowRecovery] Terminal Discussion publication refused; retiring publication custody', {
          runId: params.run.id, invocationId: invocation.recordId, errorCode: error.code,
        });
      }
    }
  };
  const resolveFrozenLeaf = async (invocation: NonNullable<Awaited<ReturnType<typeof readInvocation>>>) => {
    const accepted = await readAcceptedSnapshot();
    return accepted ? await resolveWorkflowInvocationStructureV1({ definition: accepted.definition,
      frozenChildren: accepted.frozenChildren, inputs: accepted.inputs, invocation, readInvocation,
      ...(params.requireActiveCustody ? { isAncestryCurrent: (row: WorkflowInvocationBindingRowV1) =>
        row.index.lifecycle !== 'cancel_requested' && !TERMINAL_INVOCATION_LIFECYCLES.has(row.index.lifecycle) } : {}),
      keyOfInvocation: (row) => row.index.id }) : undefined;
  };
  const resolveFrozenActionContract = async (invocation: NonNullable<Awaited<ReturnType<typeof readInvocation>>>) => {
    const resolved = await resolveFrozenLeaf(invocation);
    const accepted = await readAcceptedSnapshot();
    if (resolved?.leaf.kind !== 'action' || invocation.progress.execution?.kind !== 'action'
      || resolved.leaf.actionId !== invocation.progress.execution.actionId) return undefined;
    const actionLeaf = resolved.leaf;
    return accepted?.materializedLeaves.find((leaf) => leaf.sourceKey === resolved.sourceKey
      && leaf.blockId === actionLeaf.id && leaf.kind === 'action' && leaf.actionId === actionLeaf.actionId)?.actionContract;
  };
  const adaptCompletion = async (
    invocation: NonNullable<Awaited<ReturnType<typeof readInvocation>>>,
    observation: Extract<WorkflowInvocationRecoveryObservation, { kind: 'completed' }>,
  ): Promise<Exclude<WorkflowInvocationRecoveryObservation, { kind: 'stopped' }>> => {
    let resolved: Awaited<ReturnType<typeof resolveFrozenLeaf>>;
    try {
      resolved = await resolveFrozenLeaf(invocation);
    } catch {
      return { kind: 'unresolved', code: 'workflow_invocation_binding_unavailable' };
    }
    const step = resolved?.leaf;
    if (!step || (step.kind !== 'step' && step.kind !== 'action')) return { kind: 'unresolved', code: 'workflow_invocation_binding_unavailable' };
    const execution = observation.execution ?? invocation.progress.execution;
    if (step.kind === 'action') {
      const consent = readWorkflowProjectSetupConsentHold(step.actionId, observation.result);
      if (consent) return { kind: 'unresolved', code: consent.code };
      const contract = await resolveFrozenActionContract(invocation);
      const schema = contract?.outputSchema;
      if (!isWorkflowJsonObject(schema)) {
        return { kind: 'unresolved', code: 'workflow_invocation_binding_unavailable' };
      }
      const value = step.pauseForReview && invocation.progress.review?.resultSource?.kind === 'published'
        && invocation.progress.result !== undefined ? invocation.progress.result : observation.result;
      const validated = validateExecutionRunProfileResult(value, { kind: 'json', schema });
      return validated.ok ? { ...observation, result: validated.value } : { kind: 'failed', code: 'schema_mismatch' };
    }
    const value = step.pauseForReview && invocation.progress.review?.resultSource?.kind === 'published'
      && invocation.progress.result !== undefined
      ? { encoding: 'typed' as const, value: invocation.progress.result }
      : execution?.kind === 'session' || execution?.kind === 'session_ready'
      ? typeof observation.result === 'string' ? { encoding: 'raw_text' as const, value: observation.result } : null
      : execution?.kind === 'detached_run' ? { encoding: 'typed' as const, value: observation.result } : null;
    const decoded = value ? decodeExecutionRunResultObservation(value, step.result) : null;
    return decoded?.ok ? { ...observation, result: decoded.value }
      : { kind: 'failed', code: 'invalid_result_contract', ...(decoded && !decoded.ok ? { message: decoded.reason } : {}),
        ...(observation.usage ? { usage: observation.usage } : {}) };
  };
  const commitFact = async (
    index: WorkflowRunInvocationIndexV1,
    lifecycle: WorkflowInvocationLifecycleV1,
    contentEnvelope: string,
    resolution?: 'observed_terminal_execution',
  ): Promise<boolean> => {
    try {
      await params.storage.execute({
        operation: 'invocations.fact',
        runId: params.run.id,
        ...(params.expectedRevision !== undefined
          ? { expectedRevision: params.expectedRevision, resolution: 'observed_terminal_execution' as const }
          : { parentAttempt: params.parentAttempt }),
        accountCurrentness: params.encryption.witness,
        invocationId: index.id,
        invocationAttempt: index.attempt,
        expectedLifecycle: index.lifecycle,
        expectedContentRevision: index.contentRevision,
        lifecycle,
        contentEnvelope,
        ...(resolution ? { resolution } : {}),
      }, params.signal ? { signal: params.signal } : {});
      return true;
    } catch {
      const rejoinBody = record(await params.storage.execute({
        operation: 'invocations.get', runId: params.run.id, invocationId: index.id,
      }, params.signal ? { signal: params.signal } : {}));
      const rejoinInvocation = record(rejoinBody?.invocation);
      const rejoinIndex = rejoinInvocation
        ? WorkflowRunInvocationIndexV1Schema.safeParse(rejoinInvocation.index)
        : null;
      return rejoinIndex?.success === true
        && rejoinIndex.data.attempt === index.attempt
        && rejoinIndex.data.lifecycle === lifecycle
        && rejoinInvocation?.contentEnvelope === contentEnvelope;
    }
  };
  const commitObservation = async (
    invocation: NonNullable<Awaited<ReturnType<typeof readInvocation>>>,
    observed: WorkflowInvocationRecoveryObservation,
  ): Promise<ReconciledInvocationTransition | null> => {
    const { index: exactIndex, progress } = invocation;
    const currentLifecycle = exactIndex.lifecycle;
    // An unavailable result cannot confirm or replace an outstanding Stop.
    if (currentLifecycle === 'cancel_requested' && observed.kind === 'needs_attention') return null;
    if (params.expectedRevision !== undefined
      && (currentLifecycle === 'completed' || currentLifecycle === 'failed'
        || currentLifecycle === 'cancelled' || currentLifecycle === 'skipped')) return null;
    if (currentLifecycle === 'waiting_for_review' || currentLifecycle === 'superseded') return null;
    // This retires custody only. It cannot resolve an interrupted Run's input
    // outcome or make a new attempt eligible from unknown historical effects.
    if (observed.kind === 'stopped' && !TERMINAL_RUN_STATES.has(params.run.state)) return null;
    const prior = progress.previousAttemptRecordId ? await readInvocation(progress.previousAttemptRecordId) : undefined;
    const generation = prior?.progress.review?.decision?.kind === 'generate';
    const step = observed.kind === 'completed' || generation ? (await resolveFrozenLeaf(invocation).catch(() => undefined))?.leaf : undefined;
    const observation = observed.kind === 'stopped'
      ? { kind: 'cancelled' as const, code: observed.code }
      : observed.kind === 'completed' ? await adaptCompletion(invocation, observed) : observed;
    const setupConsent = observation.kind === 'unresolved' && observation.setupConsentOutput
      && progress.execution?.kind === 'action' && !TERMINAL_RUN_STATES.has(params.run.state)
      && currentLifecycle !== 'cancel_requested' && currentLifecycle !== 'outcome_uncertain'
      ? readWorkflowProjectSetupConsentHold(progress.execution.actionId, observation.setupConsentOutput) : null;
    if (params.expectedRevision !== undefined && observed.kind === 'completed' && observation.kind === 'unresolved') {
      throw Object.assign(new Error('workflow_outcome_unresolved'), { code: 'workflow_outcome_unresolved' });
    }
    if (observation.kind === 'unresolved' && !setupConsent
      || (params.expectedRevision !== undefined && observation.kind === 'outcome_uncertain')) return null;
    if (currentLifecycle === 'outcome_uncertain' && observation.kind === 'outcome_uncertain') {
      // Another leaf may have kept custody pending after this fact was committed.
      // Re-observing definitive uncertainty resolves this pass without rewriting
      // the same fact or requiring a success/cancellation that cannot be known.
      return { id: exactIndex.id, expectedLifecycle: currentLifecycle, lifecycle: currentLifecycle,
        expectedContentRevision: exactIndex.contentRevision };
    }
    const resolvingUncertain = currentLifecycle === 'outcome_uncertain';
    const stoppedWithUncertainEffects = observed.kind === 'stopped' || (resolvingUncertain
      && (observation.kind === 'failed' || observation.kind === 'cancelled'));
    const reviewRequired = classifyWorkflowReviewEntryV1({
      mayEnterReview: !TERMINAL_RUN_STATES.has(params.run.state) && currentLifecycle !== 'cancel_requested',
      pauseForReview: Boolean(step && 'pauseForReview' in step && step.pauseForReview),
      isGeneration: generation,
      inputCompleted: observed.kind === 'completed',
      observation,
    }) === 'waiting_for_review';
    const lifecycle: WorkflowInvocationLifecycleV1 = setupConsent ? 'needs_attention' : reviewRequired ? 'waiting_for_review' : stoppedWithUncertainEffects && !TERMINAL_RUN_STATES.has(params.run.state)
      ? 'needs_attention'
      : observation.kind === 'unresolved' ? 'needs_attention' : observation.kind;
    const nextProgress: WorkflowProgressEnvelopeV1 = {
      ...applyWorkflowInvocationFactV1(progress, {
        ...(observed.execution ? { execution: observed.execution } : {}),
        ...(observed.replyOutcome ? { replyOutcome: observed.replyOutcome } : {}),
        ...(observation.kind === 'completed' ? { result: observation.result } : {}),
        ...(observation.kind !== 'unresolved' && observation.usage ? { usage: observation.usage } : {}),
        ...(observation.kind !== 'completed' && observation.code ? { reason: observation.code,
          ...(observation.kind === 'failed' && observation.failureCause ? { failureCause: observation.failureCause } : {}),
          ...(observation.kind === 'failed' && observation.runtimeIssueV1 ? { runtimeIssueV1: observation.runtimeIssueV1 } : {}),
          ...(observation.kind === 'failed' && observation.message !== undefined ? { reasonMessage: observation.message } : {}) } : {}),
      }, { previousLifecycle: currentLifecycle, lifecycle, observedAtMs: Date.now() }),
      ...(observation.kind === 'completed' && (reviewRequired || generation) && !progress.review?.resultSource
        ? { review: { ...progress.review, resultSource: { kind: 'execution_input' as const } } } : {}),
      ...(stoppedWithUncertainEffects ? { uncertainPriorEffects: { activity: 'stopped' as const } } : {}),
      ...(setupConsent && observation.kind === 'unresolved' && observation.setupConsentOutput && progress.execution?.kind === 'action'
        ? { reason: { code: setupConsent.code }, execution: { ...progress.execution,
          output: normalizeStrictJsonValue(observation.setupConsentOutput) } } : {}),
    };
    const binding = {
      v: 1 as const, purpose: 'invocation_progress' as const, accountId: params.accountId, runId: params.run.id,
      recordId: exactIndex.id, sequence: exactIndex.sequence,
      parentRecordId: exactIndex.parentRecordId, memberOrdinal: exactIndex.memberOrdinal,
      attempt: exactIndex.attempt,
    };
    const sealMode = params.encryption.runCrypto.mode === 'e2ee'
      ? { ...params.encryption.runCrypto, randomBytes: getRandomBytes }
      : params.encryption.runCrypto;
    const contentEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({
      ...sealMode,
      binding,
      progress: nextProgress,
    }));
    const committed = await commitFact(exactIndex, lifecycle, contentEnvelope,
      resolvingUncertain ? 'observed_terminal_execution' : undefined).catch((error: unknown) => {
      params.signal?.throwIfAborted();
      if (params.expectedRevision === undefined) throw error;
      throw Object.assign(new Error('workflow_outcome_unresolved'), { code: 'workflow_outcome_unresolved' });
    });
    if (!committed) {
      const fresh = await readInvocation(exactIndex.id);
      if (fresh && fresh.index.attempt === exactIndex.attempt && fresh.index.lifecycle === currentLifecycle
        && fresh.index.contentRevision !== exactIndex.contentRevision) return await commitObservation(fresh, observed);
      if (params.expectedRevision !== undefined) {
        throw Object.assign(new Error('workflow_outcome_unresolved'), { code: 'workflow_outcome_unresolved' });
      }
      return null;
    }
    await refreshRootStepProgress();
    if (reviewRequired) await params.onReviewEntered?.({ runId: params.run.id });
    const fresh = await readInvocation(exactIndex.id);
    return { id: exactIndex.id, expectedLifecycle: lifecycle, lifecycle,
      ...(fresh?.index.lifecycle === lifecycle ? { expectedContentRevision: fresh.index.contentRevision } : {}) };
  };
  return { readInvocation, readAcceptedSnapshot, resolveFrozenLeaf, commitFact, commitObservation, resolveFrozenActionContract, refreshRootStepProgress, publishSettledInvocations };
}

export type WorkflowDiscussionModelReservationReplay = Readonly<{
  origin: ApprovalExecutionOriginV1;
  input: unknown;
}>;

export type WorkflowDiscussionModelReservationCustody = Readonly<{
  storage: Storage;
  resolveAccountEncryption: (signal?: AbortSignal) => Promise<AvailableAutomationAccountEncryptionV1>;
}>;

/** Editable approval metadata is only a pointer to the accepted Run's custody. */
export async function isWorkflowDiscussionModelReservationCurrent(params: WorkflowDiscussionModelReservationCustody & Readonly<{
  accountId: string;
  reservation: WorkflowDiscussionModelReservationReplay;
  signal?: AbortSignal;
}>): Promise<boolean> {
  const { origin, input } = params.reservation;
  const caller = origin.caller;
  const marker = caller.kind === 'workflowRun' ? caller.discussionModelReservation : undefined;
  const invite = DiscussionInviteInputV1Schema.safeParse(input);
  if (caller.kind !== 'workflowRun' || !marker || origin.actionId !== 'discussion.invite'
    || !invite.success || invite.data.participant.kind !== 'model'
    || invite.data.discussionId !== marker.discussionId
    || invite.data.participant.participantSlotId !== marker.participantSlotId
    || origin.accountId !== params.accountId || origin.target?.kind !== 'machine') return false;
  const prefix = `workflow:${caller.runId}:`;
  if (!marker.participantSlotId.startsWith(prefix)
    || origin.requestId !== `${marker.participantSlotId}:discussion.invite`) return false;
  const invocationId = marker.participantSlotId.slice(prefix.length);
  if (!invocationId || params.signal?.aborted) return false;
  const options = params.signal ? { signal: params.signal } : {};
  const body = record(await params.storage.execute({ operation: 'get', runId: caller.runId }, options));
  const run = WorkflowRunSummaryV1Schema.safeParse(body?.run);
  if (!run.success || run.data.id !== caller.runId || run.data.ownerAccountId !== params.accountId
    || run.data.machineId !== origin.machineId || run.data.machineId !== origin.target.machineId
    || !hasActiveWorkflowRunCustody(run.data)) return false;
  const census = WorkflowRunRecipientCensusResponseV1Schema.parse(await params.storage.execute({
    operation: 'run-key.census', runId: caller.runId,
  }, options));
  if (census.runId !== caller.runId || census.ownerAccountId !== params.accountId) return false;
  const resolved = resolveWorkflowRunDataKeyV1({ census, encryption: await params.resolveAccountEncryption(params.signal) });
  if (resolved.kind !== 'available') return false;
  const reader = createWorkflowInvocationRecoveryFactWriter({ accountId: params.accountId, run: run.data,
    parentAttempt: 0, encryption: resolved.encryption, storage: params.storage, requireActiveCustody: true, ...options });
  const accepted = await reader.readAcceptedSnapshot();
  if (!accepted || accepted.machineId !== run.data.machineId || !sameStrictJsonValue(accepted.authorization, caller.authorization)
    || accepted.origin?.discussion?.discussion.discussionId !== marker.discussionId
    || accepted.origin.actionPolicy?.surface !== marker.policySurface) return false;
  const invocation = await reader.readInvocation(invocationId);
  // The coordinator persists invitation correspondence and this hold atomically.
  // Cancellation/settlement/supersession ends the narrower reservation lifetime.
  if (!invocation || invocation.index.lifecycle !== 'waiting_for_approval'
    || invocation.progress.blockKind !== 'step' || invocation.progress.execution?.kind !== 'action'
    || invocation.progress.execution.actionId !== 'discussion.invite'
    || invocation.progress.execution.localInputId !== marker.participantSlotId
    || invocation.progress.execution.actionRequestId !== origin.requestId
    || !sameStrictJsonValue(invocation.progress.execution.input, invite.data)) return false;
  const structure = await reader.resolveFrozenLeaf(invocation);
  if (structure?.leaf.kind !== 'step') return false;
  const frozen = accepted.materializedLeaves.find(leaf => leaf.sourceKey === structure.sourceKey && leaf.blockId === structure.leaf.id);
  if (!frozen) return false;
  const selected = resolveWorkflowAcceptedStepSelectionV1(frozen, structure.frame.item?.value, structure.inputs);
  return selected.executionTarget.kind === 'session' && selected.participant?.kind === 'model'
    && sameStrictJsonValue(selected.participant.launch, invite.data.participant.launch) && !params.signal?.aborted;
}

async function recoverInvocationCustody(params: Readonly<{
  accountId: string;
  run: WorkflowRunSummaryV1;
  trigger: WorkflowRecoveryTrigger;
  encryption: WorkflowRunEncryptionV1;
  storage: Storage;
  reconcileInvocation: (input: Readonly<{
    run: WorkflowRunSummaryV1;
    index: WorkflowRunInvocationIndexV1;
    progress: WorkflowProgressEnvelopeV1;
    frozenActionContract?: WorkflowMaterializedLeafV1['actionContract'];
    terminalParent: boolean;
    cancellationRequested: boolean;
    parentAttempt: number;
    trigger: WorkflowRecoveryTrigger;
    signal?: AbortSignal;
  }>) => Promise<WorkflowInvocationRecoveryObservation>;
  signal?: AbortSignal;
  parentAttempt: number;
  onReviewEntered?: (entry: Readonly<{ runId: string }>) => Promise<void>;
  onInvocationSettled?: RecoveredInvocationPublisher;
  onCompletionPending?: (index: WorkflowRunInvocationIndexV1, wait: () => Promise<void>) => void;
}>): Promise<ReconciledInvocationCustody | null> {
  const reconciled: ReconciledInvocationTransition[] = [];
  let allResolved = true;
  let cancellationRequested = false;
  const { parentAttempt, ...writerParams } = params;
  const { readInvocation, commitObservation, commitFact, resolveFrozenActionContract, refreshRootStepProgress, publishSettledInvocations } = createWorkflowInvocationRecoveryFactWriter({
    ...writerParams, ...(params.run.state === 'interrupted' ? { expectedRevision: params.run.revision } : { parentAttempt }),
  });
  let cursor: string | undefined;
  do {
    const pageBody = record(await params.storage.execute({
      operation: 'invocations.list', runId: params.run.id,
      lifecycles: [...RECOVERABLE_INVOCATION_LIFECYCLES],
      pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
      ...(cursor ? { cursor } : {}),
    }, params.signal ? { signal: params.signal } : {}));
    if (!pageBody || !Array.isArray(pageBody.invocations)) throw new Error('workflow_recovery_response_invalid');
    for (const rawIndex of pageBody.invocations) {
      const index = WorkflowRunInvocationIndexV1Schema.parse(rawIndex);
      const invocation = await readInvocation(index.id);
      if (!invocation || invocation.index.lifecycle !== index.lifecycle) {
        allResolved = false;
        continue;
      }
      const exactIndex = invocation.index;
      const storedContentEnvelope = invocation.contentEnvelope;
      const progress = invocation.progress;
      const currentLifecycle = exactIndex.lifecycle;
      if (currentLifecycle === 'cancel_requested' && exactIndex.parentRecordId === null) {
        cancellationRequested = true;
      }
      if ((currentLifecycle === 'pending' || currentLifecycle === 'waiting_for_capacity')
        && !(params.run.state === 'interrupted' && progress.blockKind === 'step')) {
        if (!TERMINAL_RUN_STATES.has(params.run.state)) {
          allResolved = false;
          continue;
        }
        const lifecycle = params.run.state === 'cancelled' ? 'cancelled' : 'skipped';
        if (lifecycle === 'cancelled') {
          const transition = await commitObservation(invocation, { kind: 'cancelled' });
          if (transition) reconciled.push(transition);
          else allResolved = false;
          continue;
        }
        if (!await commitFact(exactIndex, lifecycle, storedContentEnvelope)) {
          allResolved = false;
          continue;
        }
        reconciled.push({
          id: exactIndex.id,
          expectedLifecycle: lifecycle,
          lifecycle,
        });
        continue;
      }
      if (progress.blockKind !== 'step' && progress.blockKind !== 'action') {
        if (currentLifecycle === 'cancel_requested') {
          const transition = await commitObservation(invocation, { kind: 'cancelled' });
          if (!transition) {
            allResolved = false;
            continue;
          }
          reconciled.push(transition);
          continue;
        }
        if (currentLifecycle === 'outcome_uncertain') {
          if (!await commitFact(exactIndex, currentLifecycle, storedContentEnvelope)) {
            allResolved = false;
            continue;
          }
          reconciled.push({ id: exactIndex.id, expectedLifecycle: currentLifecycle, lifecycle: currentLifecycle });
          continue;
        }
        allResolved = false;
        continue;
      }
      const observed = await params.reconcileInvocation({
        run: params.run, index: exactIndex,
        progress,
        ...(progress.blockKind === 'action' ? { frozenActionContract: await resolveFrozenActionContract(invocation) } : {}),
        terminalParent: TERMINAL_RUN_STATES.has(params.run.state),
        cancellationRequested: currentLifecycle === 'cancel_requested',
        parentAttempt: params.parentAttempt, trigger: params.trigger,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      const transition = await commitObservation(invocation, observed);
      if (!transition) {
        allResolved = false;
        if (observed.kind === 'unresolved' && observed.waitForCompletion) {
          params.onCompletionPending?.(exactIndex, observed.waitForCompletion);
        }
        continue;
      }
      reconciled.push(transition);
      // Attention is an observable fact, not terminal custody. The server's
      // existing settlement contract keeps this original input recoverable.
      if (transition.lifecycle === 'needs_attention') allResolved = false;
    }
    cursor = typeof pageBody.nextCursor === 'string' ? pageBody.nextCursor : undefined;
  } while (cursor && !params.signal?.aborted);
  // A child fact and its root projection are separate row writes. A prior
  // publication failure leaves the terminal child outside the recovery index;
  // rebuild from current slots even when this pass observed no active leaf.
  if (!params.signal?.aborted) await refreshRootStepProgress();
  // Native completion may arrive after Stop has ended the parent. Publish its
  // committed leaf before retiring custody; a lost ACK reuses this same pass.
  if (!params.signal?.aborted) await publishSettledInvocations();
  if (allResolved && !params.signal?.aborted && !cancellationRequested && !TERMINAL_RUN_STATES.has(params.run.state)) {
    // An earlier pass may have settled the cancelled root before its child
    // reached terminal. That durable root fact is no longer in the active index.
    const body = record(await params.storage.execute({ operation: 'get', runId: params.run.id },
      params.signal ? { signal: params.signal } : {}));
    const envelope = parseWorkflowStoredContentEnvelopeV1(body?.checkpointEnvelope);
    if (envelope) {
      const opened = openWorkflowCheckpointStoredEnvelopeV1({ ...openMode(params.encryption),
        binding: { v: 1, purpose: 'checkpoint', accountId: params.accountId, runId: params.run.id }, envelope });
      if (opened.kind === 'available') {
        const root = await readInvocation(opened.content.rootRecordId);
        cancellationRequested = root?.index.parentRecordId === null && root.index.lifecycle === 'cancelled'
          && root.progress.blockKind === 'root';
      }
    }
  }
  return allResolved && !params.signal?.aborted
    ? { invocationTransitions: reconciled, cancellationRequested }
    : null;
}

async function settleRecoveredRun(params: Readonly<{
  runId: string;
  parentAttempt: number;
  encryption: WorkflowRunEncryptionV1;
  storage: Storage;
  invocationTransitions: readonly ReconciledInvocationTransition[];
  cancellationRequested: boolean;
  signal?: AbortSignal;
}>): Promise<void> {
  const readTransitions = async () => {
    const transitions: (ReconciledInvocationTransition & Readonly<{ expectedContentRevision: string }>)[] = [];
    for (const transition of params.invocationTransitions) {
      const body = record(await params.storage.execute({ operation: 'invocations.get', runId: params.runId,
        invocationId: transition.id }, params.signal ? { signal: params.signal } : {}));
      const index = WorkflowRunInvocationIndexV1Schema.safeParse(record(body?.invocation)?.index);
      if (!index.success || index.data.lifecycle !== transition.expectedLifecycle) return null;
      transitions.push({ ...transition, expectedContentRevision: index.data.contentRevision });
    }
    return transitions;
  };
  const body = record(await params.storage.execute(
    { operation: 'get', runId: params.runId },
    params.signal ? { signal: params.signal } : {},
  ));
  const current = body ? WorkflowRunSummaryV1Schema.safeParse(body.run) : null;
  if (!current?.success || current.data.workflowCustodyState === 'settled') return;
  if ((!TERMINAL_RUN_STATES.has(current.data.state) && !params.cancellationRequested)
    || typeof body?.checkpointEnvelope !== 'string'
    || !parseWorkflowStoredContentEnvelopeV1(body.checkpointEnvelope)) return;
  try {
    const invocationTransitions = await readTransitions();
    if (!invocationTransitions) return;
    await params.storage.execute({
      operation: 'transition',
      runId: params.runId,
      parentAttempt: params.parentAttempt,
      accountCurrentness: params.encryption.witness,
      expectedRevision: current.data.revision,
      state: params.cancellationRequested ? 'cancelled' : current.data.state,
      checkpointEnvelope: body.checkpointEnvelope,
      custodyState: 'settled',
      invocationTransitions,
    }, params.signal ? { signal: params.signal } : {});
  } catch {
    const rejoinBody = record(await params.storage.execute(
      { operation: 'get', runId: params.runId },
      params.signal ? { signal: params.signal } : {},
    ));
    const rejoined = rejoinBody ? WorkflowRunSummaryV1Schema.safeParse(rejoinBody.run) : null;
    if (rejoined?.success && rejoined.data.workflowCustodyState === 'settled') return;
    if (!rejoined?.success
      || typeof rejoinBody?.checkpointEnvelope !== 'string'
      || !parseWorkflowStoredContentEnvelopeV1(rejoinBody.checkpointEnvelope)) return;
    try {
      const invocationTransitions = await readTransitions();
      if (!invocationTransitions) return;
      await params.storage.execute({
        operation: 'transition',
        runId: params.runId,
        parentAttempt: params.parentAttempt,
        accountCurrentness: params.encryption.witness,
        expectedRevision: rejoined.data.revision,
        state: params.cancellationRequested ? 'cancelled' : rejoined.data.state,
        checkpointEnvelope: rejoinBody.checkpointEnvelope,
        custodyState: 'settled',
        invocationTransitions,
      }, params.signal ? { signal: params.signal } : {});
    } catch {
      // Exact row facts remain durable and server custody remains pending.
    }
  }
}

export type WorkflowRecoveryTrigger = 'startup' | 'resume' | 'reconnect' | 'control';

/**
 * One daemon-lifetime, lifecycle-indexed recovery pass. It never claims,
 * initializes, resumes or coordinates a Workflow Run. Private content is
 * retrieved only for the exact rows returned by the recovery indexes.
 */
export function createWorkflowRunRecoveryReader(params: Readonly<{
  accountId: string;
  machineId: string;
  storage: Storage;
  resolveAccountEncryption: (signal?: AbortSignal) => Promise<AvailableAutomationAccountEncryptionV1>;
  reconcileInvocation: Parameters<typeof recoverInvocationCustody>[0]['reconcileInvocation'];
  onReviewEntered?: (entry: Readonly<{ runId: string }>) => Promise<void>;
  onInvocationSettled?: RecoveredInvocationPublisher;
}>): (trigger: WorkflowRecoveryTrigger, signal?: AbortSignal) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let requestedRecovery: Readonly<{ trigger: WorkflowRecoveryTrigger; signal?: AbortSignal }> | null = null;
  const completionWaits = new Set<string>();
  const onReviewEntered = params.onReviewEntered ?? createWorkflowRunReviewEntryNotificationHandler();
  const recoverCandidate = async (
    candidate: RecoveryCandidate,
    trigger: WorkflowRecoveryTrigger,
    accountEncryption: AvailableAutomationAccountEncryptionV1,
    signal?: AbortSignal,
  ): Promise<void> => {
    const { run } = candidate;
    if (signal?.aborted) return;
    const census = WorkflowRunRecipientCensusResponseV1Schema.parse(await params.storage.execute({
      operation: 'run-key.census', runId: run.id,
    }, signal ? { signal } : {}));
    const resolved = resolveWorkflowRunDataKeyV1({ encryption: accountEncryption, census });
    if (resolved.kind !== 'available' || census.ownerAccountId !== params.accountId) return;
    const encryption = resolved.encryption;
    await runWorkflowRecipientKeyPreparationV1({ runId: run.id, runCrypto: encryption.runCrypto,
      openedDataEncryptionKey: census.callerDataEncryptionKey, randomBytes: getRandomBytes,
      readCensus: async () => WorkflowRunRecipientCensusResponseV1Schema.parse(await params.storage.execute({ operation: 'run-key.census', runId: run.id }, signal ? { signal } : {})),
      commit: async input => WorkflowRunRecipientKeyEnvelopeCommitResponseV1Schema.parse(await params.storage.execute({ operation: 'run-key.commit', ...input }, signal ? { signal } : {})),
      ...(signal ? { signal } : {}),
    });
    const reconciledCustody = await recoverInvocationCustody({
      accountId: params.accountId, run, parentAttempt: candidate.parentAttempt, trigger, encryption, storage: params.storage,
      reconcileInvocation: params.reconcileInvocation, ...(signal ? { signal } : {}),
      onReviewEntered,
      ...(params.onInvocationSettled ? { onInvocationSettled: params.onInvocationSettled } : {}),
      onCompletionPending: (index, wait) => {
        const key = JSON.stringify([run.id, candidate.parentAttempt, index.id, index.attempt]);
        if (completionWaits.has(key) || signal?.aborted) return;
        completionWaits.add(key);
        void (async () => {
          await wait();
          // Join any indexed pass already publishing facts, including the pass
          // attaching this wait when the child was terminal before attachment.
          await inFlight;
          if (signal?.aborted) return;
          const rowBody = record(await params.storage.execute({ operation: 'invocations.get', runId: run.id,
            invocationId: index.id }, signal ? { signal } : {}));
          const currentIndex = WorkflowRunInvocationIndexV1Schema.safeParse(record(rowBody?.invocation)?.index);
          if (!currentIndex.success || currentIndex.data.id !== index.id || currentIndex.data.runId !== run.id
            || currentIndex.data.attempt !== index.attempt) return;
          const body = record(await params.storage.execute({ operation: 'get', runId: run.id }, signal ? { signal } : {}));
          const current = WorkflowRunSummaryV1Schema.safeParse(body?.run);
          if (!current.success || current.data.id !== run.id || current.data.machineId !== params.machineId
            || current.data.workflowCustodyState !== 'pending') return;
          // Native terminal facts wake only this Run through the same recovery
          // path. Fresh Account/key evidence and existing CAS still own writes.
          await recoverCandidate({ ...candidate, run: current.data }, trigger,
            await params.resolveAccountEncryption(signal), signal);
        })().catch((error: unknown) => {
          if (!signal?.aborted) logger.warn('[workflowRecovery] Child completion observation failed; custody remains pending', { runId: run.id, invocationId: index.id, error });
        }).finally(() => { completionWaits.delete(key); });
      },
    });
    if (reconciledCustody
      && (TERMINAL_RUN_STATES.has(run.state) || reconciledCustody.cancellationRequested)) {
      await settleRecoveredRun({
        runId: run.id,
        parentAttempt: candidate.parentAttempt,
        encryption,
        storage: params.storage,
        invocationTransitions: reconciledCustody.invocationTransitions,
        cancellationRequested: reconciledCustody.cancellationRequested,
        ...(signal ? { signal } : {}),
      });
    }
  };
  const recoverIndexedCandidates = async (trigger: WorkflowRecoveryTrigger, signal?: AbortSignal) => {
    const accountEncryption = await params.resolveAccountEncryption(signal);
    let cursor: string | undefined;
    do {
      const page = parseRunPage(await params.storage.execute({
        operation: 'recovery.list',
        pageByteLimit: EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
        ...(cursor ? { cursor } : {}),
      }, signal ? { signal } : {}));
      for (const candidate of page.candidates) {
        if (signal?.aborted) return;
        try { await recoverCandidate(candidate, trigger, accountEncryption, signal); }
        catch (error) {
          signal?.throwIfAborted();
          if (!(error instanceof WorkflowDiscussionPublicationUnavailable)) throw error;
          logger.warn('[workflowRecovery] Discussion publication unavailable; Run custody remains pending', {
            runId: candidate.run.id, errorCode: error.code,
          });
        }
      }
      cursor = page.nextCursor;
    } while (cursor && !signal?.aborted);
  };
  return async (trigger, signal) => {
    if (signal?.aborted) return;
    requestedRecovery = { trigger, ...(signal ? { signal } : {}) };
    if (inFlight) return await inFlight;
    const operation = (async () => {
      try {
        // A release/control notification can arrive after the current pass
        // captured its index page. Coalesce notifications, not the last wake:
        // reread the index once more before releasing this recovery owner.
        while (requestedRecovery) {
          const request = requestedRecovery;
          requestedRecovery = null;
          await recoverIndexedCandidates(request.trigger, request.signal);
        }
      } finally {
        inFlight = null;
      }
    })();
    inFlight = operation;
    await operation;
  };
}
