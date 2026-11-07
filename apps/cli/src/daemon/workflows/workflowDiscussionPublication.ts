import type { WorkflowDiscussionOriginV1 } from '@happier-dev/protocol/workflows/workflowDestinationsV1';
import type { DiscussionReplyReturnPublisher, DiscussionReplyReturnPublication, DiscussionSessionReplyReturnPublication } from '@/session/services/sessionMessageReply';
import { projectSessionMessageReplyOutcome, readSessionMessageReply, settleDiscussionReplyReturnPublication } from '@/session/services/sessionMessageReply';
import { classifySessionMessageReplyPublicationFailureV1, type SessionMessageReplyPublicationFailureV1,
  type SessionMessageReplyProgressV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { StoredCredentials } from '@/persistence';
import type { WorkflowCoordinatorInvocation } from './coordinator';
import { WorkflowInvocationSettlementFailure } from './invocationSettlementFailure';
import { isWorkflowDiscussionResultPublishableV1, projectWorkflowDiscussionProducerV1, projectWorkflowDiscussionResultContentV1 } from '@happier-dev/protocol/workflows/workflowDiscussionPublicationV1';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

/** Known refusal is actionable; an unacknowledged transport remains uncertain. */
export class WorkflowDiscussionPublicationUnavailable extends WorkflowInvocationSettlementFailure {
  readonly failure: SessionMessageReplyPublicationFailureV1 | undefined;
  constructor(code = 'workflow_discussion_publication_unavailable',
    failure?: SessionMessageReplyPublicationFailureV1,
    readonly pending?: Readonly<{ kind: 'approval'; artifactId: string }>) {
    const classified = failure ?? (pending ? undefined : classifySessionMessageReplyPublicationFailureV1(code, 'workflow_publication'));
    super('workflow_discussion_publication_unavailable', code, classified?.retryable === false);
    this.failure = classified;
  }
}

function matchesSessionOriginal(progress: SessionMessageReplyProgressV1 | undefined,
  expected: Pick<DiscussionSessionReplyReturnPublication, 'requestSessionId' | 'discussion' | 'workflow'>): progress is SessionMessageReplyProgressV1
    & { outcome: NonNullable<SessionMessageReplyProgressV1['outcome']> } {
  const destination = progress?.discussion;
  return !!progress?.outcome && !!destination && !!expected.workflow
    && progress.workflow?.runId === expected.workflow.runId
    && progress.workflow.invocationRecordId === expected.workflow.invocationRecordId
    && destination.discussionId === expected.discussion.discussionId
    && destination.messageId === expected.discussion.messageId && destination.throughSeq === expected.discussion.throughSeq
    && destination.participantSessionId === expected.requestSessionId;
}

/** Workflow consumes C2's original input and C3's sole publisher after accepting the exact result. */
export function createWorkflowDiscussionResultPublisher(params: Readonly<{
  credentials: StoredCredentials;
  origin: WorkflowDiscussionOriginV1;
  publish: DiscussionReplyReturnPublisher;
  /** The live coordinator awaits the existing approval owner's execution fact. */
  observeApproval?: (input: Readonly<{ artifactId: string; publication: DiscussionReplyReturnPublication; signal?: AbortSignal }>) => Promise<ActionExecuteResult>;
  /** Reclaim finds native-leaf custody at the existing exact approval Artifact. */
  findApproval?: (publication: DiscussionReplyReturnPublication, signal?: AbortSignal) => Promise<Readonly<{ kind: 'approval'; artifactId: string }> | undefined>;
  isCurrent(signal?: AbortSignal): Promise<boolean>;
  signal?: AbortSignal;
  /** New claims and startup/resume/reconnect recovery may retry; equal hints cannot. */
  retryFailedPublications?: boolean;
}>) {
  const publish = async (publication: DiscussionReplyReturnPublication, signal?: AbortSignal,
    retainedApproval?: Readonly<{ kind: 'approval'; artifactId: string }>) => {
    // Reclaim observes the exact retained request without asking the publisher
    // to create/rejoin it. Approval decisions remain the present-user owner's.
    let approval = retainedApproval;
    if (!approval && params.observeApproval && params.findApproval) {
      try { approval = await params.findApproval(publication, signal); }
      catch {
        signal?.throwIfAborted();
        throw new WorkflowDiscussionPublicationUnavailable();
      }
    }
    let published = approval
      ? { v: 1 as const, ok: false as const, error: 'discussions_unavailable' as const, pending: approval }
      : await params.publish(publication, signal ? { signal } : undefined);
    if (published.ok) return;
    if ('pending' in published && published.pending && params.observeApproval) {
      const artifactId = published.pending.artifactId;
      const observed = await params.observeApproval({ artifactId, publication, ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      if (observed.ok) return;
      const failure = classifySessionMessageReplyPublicationFailureV1(observed.errorCode, 'workflow_publication');
      if (!('kind' in publication) && (failure?.code === 'approval_rejected' || failure?.code === 'approval_canceled')) {
        // The approval Action owns the decision write. Reconcile its original
        // through the canonical reader; daemon credentials cannot repeat it.
        const original = await readSessionMessageReply({ credentials: params.credentials, sessionId: publication.requestSessionId,
          localId: publication.requestLocalId, ...(signal ? { signal } : {}) });
        const progress = original.status === 'available' ? original.progress : undefined;
        if (!matchesSessionOriginal(progress, publication) || progress.acceptedTurnId !== publication.acceptedTurnId) {
          throw new WorkflowDiscussionPublicationUnavailable();
        }
        if (progress.disposition === 'returned'
          || progress.outcome?.kind === 'answer' && 'publicationRef' in progress.outcome) return;
        const retained = progress.returnPublication;
        if (retained?.kind === 'failed' && retained.failure.code === failure.code && !retained.failure.retryable) {
          throw new WorkflowDiscussionPublicationUnavailable(retained.failure.code, retained.failure);
        }
        // Artifact CAS may be observed before the Action finishes settling the
        // original. Its exact still-pending binding already proves this refusal.
        if (retained?.kind === 'approval_pending' && retained.artifactId === artifactId) {
          throw new WorkflowDiscussionPublicationUnavailable(failure.code, failure);
        }
        throw new WorkflowDiscussionPublicationUnavailable();
      }
      published = { v: 1, ok: false, error: 'discussions_unavailable', ...(failure ? { failure } : {}) };
    }
    const pending = 'pending' in published ? published.pending : undefined;
    const failure = 'failure' in published ? published.failure
      : pending ? undefined : classifySessionMessageReplyPublicationFailureV1(published.error, 'workflow_publication');
    const retained = pending ? { kind: 'approval_pending' as const, artifactId: pending.artifactId }
      : failure ? { kind: 'failed' as const, failure } : undefined;
    if (!('kind' in publication) && retained) {
      const settled = await settleDiscussionReplyReturnPublication({ credentials: params.credentials,
        requestSessionId: publication.requestSessionId, requestLocalId: publication.requestLocalId,
        discussion: publication.discussion,
        ...(publication.acceptedTurnId ? { acceptedTurnId: publication.acceptedTurnId } : {}),
        publication: retained,
        ...(signal ? { signal } : {}) });
      if (!settled.ok) throw new WorkflowDiscussionPublicationUnavailable();
      // The append may have committed before its transport acknowledgement was
      // lost. Original-input custody, not that transport error, owns delivery.
      if (settled.progress.disposition === 'returned'
        || settled.progress.outcome?.kind === 'answer' && 'publicationRef' in settled.progress.outcome) return;
    }
    throw new WorkflowDiscussionPublicationUnavailable(failure?.code ?? published.error, failure, pending);
  };
  return async ({ runId, invocation, expectedParentRevision, signal: invocationSignal }: Readonly<{ runId: string; invocation: WorkflowCoordinatorInvocation;
    expectedParentRevision?: number; signal?: AbortSignal }>): Promise<void> => {
    const signal = invocationSignal && params.signal && invocationSignal !== params.signal
      ? AbortSignal.any([params.signal, invocationSignal]) : invocationSignal ?? params.signal;
    if (!isWorkflowDiscussionResultPublishableV1({ blockKind: invocation.blockKind ?? '', lifecycle: invocation.lifecycle,
      ...(invocation.execution ? { execution: invocation.execution } : {}) })) return;
    // A retained draft that has not been published stays under its review owner.
    if (invocation.review && invocation.lifecycle !== 'completed' && invocation.review.decision?.kind !== 'use_result') return;
    signal?.throwIfAborted();
    if (!await params.isCurrent(signal)) throw new WorkflowDiscussionPublicationUnavailable('workflow_authorization_revoked');
    const execution = invocation.execution;
    const resultDestination = invocation.discussionReplyTo ?? params.origin;
    // Accepted result delivery also carries its routing discriminator. Only
    // the committed C3 frontier belongs in the strict Machine origin envelope.
    const expectedOrigin: WorkflowDiscussionOriginV1 = { discussion: resultDestination.discussion,
      messageId: resultDestination.messageId, throughSeq: resultDestination.throughSeq };
    const workflow = { runId, invocationRecordId: invocation.recordId, invocationAttempt: String(invocation.attempt) };
    const content = projectWorkflowDiscussionResultContentV1({ ...workflow, lifecycle: invocation.lifecycle,
      ...(invocation.result !== undefined ? { result: invocation.result } : {}) });
    if (!content) return;
    if (execution?.kind !== 'session') {
      const producer = projectWorkflowDiscussionProducerV1({ ...workflow, blockKind: invocation.blockKind ?? '',
        lifecycle: invocation.lifecycle, ...(execution ? { execution } : {}),
        ...(invocation.result !== undefined ? { result: invocation.result } : {}) });
      if (!producer) throw new WorkflowDiscussionPublicationUnavailable();
      await publish({ kind: 'workflow_invocation', serverId: params.origin.discussion.serverId,
        workflow, discussion: expectedOrigin, producer, content,
        ...(expectedParentRevision !== undefined ? { expectedParentRevision } : {}) }, signal);
      return;
    }
    const original = await readSessionMessageReply({ credentials: params.credentials, sessionId: execution.sessionId,
      localId: execution.localInputId, ...(signal ? { signal } : {}) });
    const progress = original.status === 'available' ? original.progress : undefined;
    const destination = progress?.discussion;
    if (!matchesSessionOriginal(progress, { workflow, requestSessionId: execution.sessionId,
      discussion: { discussionId: expectedOrigin.discussion.discussionId, messageId: expectedOrigin.messageId,
        throughSeq: expectedOrigin.throughSeq, participantSessionId: execution.sessionId } }) || !destination) {
      throw new WorkflowDiscussionPublicationUnavailable();
    }
    if (progress.outcome.kind === 'answer' && 'publicationRef' in progress.outcome) return;
    if (progress.disposition === 'returned') return;
    if (progress.outcome.kind === 'declined') return;
    if (progress.returnPublication?.kind === 'approval_pending' && !params.observeApproval) {
      throw new WorkflowDiscussionPublicationUnavailable('discussions_unavailable', undefined,
        { kind: 'approval', artifactId: progress.returnPublication.artifactId });
    }
    if (progress.returnPublication?.kind === 'failed'
      && (!progress.returnPublication.failure.retryable || !params.retryFailedPublications)) {
      throw new WorkflowDiscussionPublicationUnavailable(progress.returnPublication.failure.code, progress.returnPublication.failure);
    }
    const retainedApproval = progress.returnPublication?.kind === 'approval_pending'
      ? { kind: 'approval' as const, artifactId: progress.returnPublication.artifactId } : undefined;
    const pass = !retainedApproval && progress.outcome.kind !== 'answer' ? await projectSessionMessageReplyOutcome({ credentials: params.credentials,
      serverId: params.origin.discussion.serverId, sessionId: execution.sessionId, localId: execution.localInputId,
      outcome: progress.outcome, ...(signal ? { signal } : {}) }) : undefined;
    if (!retainedApproval && progress.outcome.kind !== 'answer' && !pass) throw new WorkflowDiscussionPublicationUnavailable();
    await publish({ serverId: params.origin.discussion.serverId,
      requestSessionId: execution.sessionId, requestLocalId: execution.localInputId,
      ...(progress.acceptedTurnId ? { acceptedTurnId: progress.acceptedTurnId } : {}), discussion: destination, outcome: progress.outcome,
      workflow,
      ...(progress.actionRequestAttributionV1 ? { actionRequestAttributionV1: progress.actionRequestAttributionV1 } : {}),
      message: pass ? pass.message : typeof invocation.result === 'string' ? invocation.result : 'Workflow result',
      ...(!pass ? { content } : {}),
    }, signal, retainedApproval);
  };
}
