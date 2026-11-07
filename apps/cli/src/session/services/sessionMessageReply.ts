import { createHash } from 'node:crypto';
import axios from '@/api/client/credentialAxios';
import { buildTrustedHostSessionInputAdmissionV1, SessionInputRequestV1Schema,
  type SessionMessageProvenance } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { deriveSessionMessageReplyReturnLocalIdV1, SessionMessageReplyReadResultV1Schema,
  SessionMessageReplyMutationResultV1Schema, SessionMessageReplyCapabilityV1Schema,
  SessionMessageReplyMachinePendingPageV1Schema,
  classifySessionMessageReplyPublicationFailureV1,
  type SessionMessageReplyPublicationV1,
  type SessionMessageReplyAccountMutationV1,
  type SessionMessageReplyMutationResultV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { SessionMessageRefV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageRefV1';
import { V2SessionByIdNotFoundSchema } from '@happier-dev/protocol/sessions/control/contract';
import type { SessionMessageReplyOutcomeV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageReplyV1';
import type { DiscussionAddressingV1 } from '@happier-dev/protocol/discussions/participants';
import type { DiscussionAgentPostResponseV1 } from '@happier-dev/protocol/discussions/api';
import type { ActionRequestAttributionV1 } from '@happier-dev/protocol/actions/actionRequestAttributionV1';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionMessageAdmissionTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { readNormalizedConnectionErrorCode } from '@/api/client/classifyServerEndpointError';
import { logger } from '@/ui/logger';
import { sendSessionMessage, waitForSessionInputResult } from './sendSessionMessage';

type ReplyPublisher = Pick<ApiSessionClient, 'mutateSessionMessageReply'>;
/** Original custody supplies every routing/correlation fact; Account composition supplies the resource codec. */
export type DiscussionSessionReplyReturnPublication = Readonly<{
  serverId: string;
  requestSessionId: string;
  requestLocalId: string;
  acceptedTurnId?: string;
  discussion: DiscussionAddressingV1;
  workflow?: NonNullable<import('@happier-dev/protocol/sessions/messages/sessionMessageReplyV1').SessionMessageDiscussionReplyReturnV1['workflow']>;
  outcome: SessionMessageReplyOutcomeV1;
  actionRequestAttributionV1?: ActionRequestAttributionV1;
  message: string;
  content?: import('@happier-dev/protocol/discussions/content').DiscussionMessageContentV1;
  sourceMessageRef?: SessionMessageRefV1;
}>;
export type DiscussionWorkflowReplyReturnPublication = Readonly<{
  kind: 'workflow_invocation'; serverId: string;
  workflow: NonNullable<DiscussionSessionReplyReturnPublication['workflow']>;
  discussion: import('@happier-dev/protocol/workflows/workflowDestinationsV1').WorkflowDiscussionOriginV1;
  producer: import('@happier-dev/protocol/discussions/content').DiscussionWorkflowProducerV1;
  content: import('@happier-dev/protocol/discussions/content').DiscussionMessageContentV1;
  expectedParentRevision?: number;
}>;
export type DiscussionReplyReturnPublication = DiscussionSessionReplyReturnPublication | DiscussionWorkflowReplyReturnPublication;
export type DiscussionReplyReturnPublicationResult = DiscussionAgentPostResponseV1
  | Readonly<{ v: 1; ok: false; error: string;
      failure: import('@happier-dev/protocol/sessions/messages/sessionMessageReplyV1').SessionMessageReplyPublicationFailureV1 }>
  | Readonly<{ v: 1; ok: false; error: 'discussions_unavailable';
      pending: Readonly<{ kind: 'approval'; artifactId: string }> }>;
export type DiscussionReplyReturnPublisher = (input: DiscussionReplyReturnPublication,
  options?: Readonly<{ signal?: AbortSignal }>) => Promise<DiscussionReplyReturnPublicationResult>;
type ReplyAddress = Readonly<{ credentials: Pick<StoredCredentials, 'token'>; sessionId: string; localId: string; signal?: AbortSignal;
  resolveAuthorizationHeaders?: (request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>;

function replyPath(input: Pick<ReplyAddress, 'sessionId' | 'localId'>): string {
  return `/v2/sessions/${encodeURIComponent(input.sessionId)}/messages/by-local-id/${encodeURIComponent(input.localId)}/reply`;
}

function requestOptions(input: Pick<ReplyAddress, 'credentials' | 'signal' | 'resolveAuthorizationHeaders'>,
  request?: Readonly<{ method: string; path: string; body?: unknown }>) {
  const scoped = request ? input.resolveAuthorizationHeaders?.(request) : undefined;
  if (request && input.resolveAuthorizationHeaders && !scoped) throw new Error('Session reply authorization unavailable');
  return { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
    ...(scoped ?? { Authorization: `Bearer ${input.credentials.token}` }) }, ...(input.signal ? { signal: input.signal } : {}) };
}

/** Only an authoritative capability response can prove support or its absence. */
export async function readSessionMessageReplyCapability(input: Omit<ReplyAddress, 'localId'> & Readonly<{
  resolveAuthorizationHeaders?: (request: Readonly<{ method: string; path: string }>) => Readonly<Record<string, string>> | null;
}>): Promise<'supported' | 'unsupported' | 'unavailable'> {
  const path = `/v2/sessions/${encodeURIComponent(input.sessionId)}/messages/reply-capability`;
  const headers = input.resolveAuthorizationHeaders?.({ method: 'GET', path })
    ?? (input.resolveAuthorizationHeaders ? null : requestOptions(input).headers);
  const unavailable = (diagnostic: Readonly<{ reason: string; httpStatus?: number; errorCode?: string | null }>) => {
    logger.infoFile('[SessionReply] Capability read unavailable', { sessionId: input.sessionId, path, ...diagnostic });
    return 'unavailable' as const;
  };
  if (!headers) return unavailable({ reason: 'authorization_unavailable' });
  try {
    const response = await axios.get(`${resolveServerHttpBaseUrl()}${path}`, {
      headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
    });
    // The current Home masks missing access with a Session-not-found response;
    // that resource failure does not establish an absent capability route.
    if (response.status === 404 && V2SessionByIdNotFoundSchema.safeParse(response.data).success) {
      return unavailable({ reason: 'session_unavailable', httpStatus: response.status });
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      logger.infoFile('[SessionReply] Capability unsupported', { sessionId: input.sessionId, path, httpStatus: response.status });
      return 'unsupported';
    }
    if (response.status !== 200) return unavailable({ reason: 'http_error', httpStatus: response.status });
    const parsed = SessionMessageReplyCapabilityV1Schema.safeParse(response.data);
    if (!parsed.success) return unavailable({ reason: 'invalid_response', httpStatus: response.status });
    return 'supported';
  } catch (error) {
    return unavailable({ reason: input.signal?.aborted ? 'cancelled' : 'transport', errorCode: readNormalizedConnectionErrorCode(error) });
  }
}

/** Current original-input custody only; this grants no access to the source transcript. */
export async function readSessionMessageReply(input: ReplyAddress) {
  const path = replyPath(input);
  const response = await axios.get(`${resolveServerHttpBaseUrl()}${path}`, requestOptions(input, { method: 'GET', path }));
  if (response.status !== 200) throw new Error('Session reply custody unavailable');
  return SessionMessageReplyReadResultV1Schema.parse(response.data);
}

/** One exact-result projection shared by recovery and the authenticated return publisher. */
export async function projectSessionMessageReplyOutcome(input: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  sessionId: string;
  localId: string;
  outcome: SessionMessageReplyOutcomeV1;
  signal?: AbortSignal;
}>): Promise<Readonly<{ message: string; sourceMessageRef?: SessionMessageRefV1 }> | null> {
  const outcome = input.outcome;
  if (outcome.kind === 'declined') return null;
  if ('result' in outcome) {
    // Reuse the exact input/result reader; never select a later assistant row.
    const result = await waitForSessionInputResult({ credentials: input.credentials, serverId: input.serverId,
      idOrPrefix: input.sessionId, localId: input.localId, ...(input.signal ? { signal: input.signal } : {}),
      observeReply: true, observation: { kind: 'absolute_deadline', deadlineMs: Date.now() } });
    if (!result.ok || result.result.kind !== (outcome.kind === 'answer' ? 'final_text' : 'cancelled')) return null;
    const resolved = result.result;
    if (resolved.kind !== 'final_text' && resolved.kind !== 'cancelled' || !resolved.messageRef
      || resolved.messageRef.session.sessionId !== outcome.result.sessionId
      || resolved.messageRef.messageId !== outcome.result.messageId) return null;
    const message = resolved.kind === 'final_text' ? resolved.text : resolved.partialText;
    return message === undefined ? null : { message, sourceMessageRef: resolved.messageRef };
  }
  if (outcome.kind === 'answer') return { message: `Reply published: ${JSON.stringify(outcome.publicationRef)}`,
    ...(outcome.publicationRef.kind === 'session' ? { sourceMessageRef: outcome.publicationRef } : {}) };
  return { message: { pass: 'The requested session passed without an answer.',
    failed: 'The requested session failed.', cancelled: 'The requested work was cancelled.',
    terminal_no_result: 'The requested session finished without an answer.' }[outcome.kind] };
}

/** Existing original-input mutation for observation or a non-publishing private review. */
export async function mutateSessionMessageReplyObservation(input: ReplyAddress & Readonly<{
  operation: 'inline' | 'release' | Extract<SessionMessageReplyAccountMutationV1, { kind: 'discussion_review' | 'discussion_publication' }>; sourceSession?: ReplyPublisher;
}>) {
  if (input.sourceSession && typeof input.operation === 'string') return input.sourceSession.mutateSessionMessageReply({
    requestSessionId: input.sessionId, requestLocalId: input.localId, operation: { kind: input.operation },
  }, input.signal ? { signal: input.signal } : undefined);
  const path = replyPath(input);
  const body = typeof input.operation === 'string' ? { kind: input.operation } : input.operation;
  const response = await axios.post(`${resolveServerHttpBaseUrl()}${path}`,
    body, requestOptions(input, { method: 'POST', path, body }));
  if (response.status !== 200) throw new Error('Session reply observation unavailable');
  return SessionMessageReplyMutationResultV1Schema.parse(response.data);
}

/** Retain publication state on the exact original, without changing the native answer. */
export function settleDiscussionReplyReturnPublication(input: Readonly<{
  credentials: Pick<StoredCredentials, 'token'>; requestSessionId: string; requestLocalId: string;
  discussion: DiscussionAddressingV1; acceptedTurnId?: string; publication: SessionMessageReplyPublicationV1; signal?: AbortSignal;
}>): Promise<SessionMessageReplyMutationResultV1> {
  return mutateSessionMessageReplyObservation({ credentials: input.credentials,
    sessionId: input.requestSessionId, localId: input.requestLocalId, ...(input.signal ? { signal: input.signal } : {}),
    operation: { kind: 'discussion_publication', discussionId: input.discussion.discussionId,
      messageId: input.discussion.messageId, ...(input.acceptedTurnId ? { acceptedTurnId: input.acceptedTurnId } : {}),
      publication: input.publication } });
}

/**
 * One host-only delivery entry point for original Session inputs and C1 questions.
 * Their respective owners supply the original destination and correlation; authored
 * metadata can never select either. Accepted custody is not provider consumption.
 */
export async function deliverSessionMessageReply(input: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  requestSessionId: string;
  requestLocalId: string;
  /** Pre-provider cancellation/failure has no accepted turn. */
  acceptedTurnId?: string;
  requestKind?: 'question' | 'session_input';
  recipient?: Parameters<typeof sendSessionMessage>[0]['recipient'];
  message: string;
  outcome: 'answer' | 'pass' | 'failed' | 'cancelled' | 'terminal_no_result';
  mode: 'wait' | 'continue';
  /** Actual answering Session from the question owner, not display attribution. */
  senderSessionId?: string;
  answeredBy?: SessionMessageProvenance;
  /** Original admitted cause from the question/input owner, never authored metadata. */
  actionRequestAttributionV1?: ActionRequestAttributionV1;
  sourceMessageRef?: SessionMessageRefV1;
  signal?: AbortSignal;
  machineAdmissionTransport?: Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport'];
  machineResumeTransport?: Parameters<typeof sendSessionMessage>[0]['machineResumeTransport'];
}>) {
  const localId = input.requestKind !== 'session_input' && input.acceptedTurnId === undefined
    ? `question-reply-v1:${createHash('sha256').update(JSON.stringify([
        'happier.question-answer.v1', input.requestSessionId, input.requestLocalId, input.sessionId,
      ])).digest('base64url')}`
    : deriveSessionMessageReplyReturnLocalIdV1({ sessionId: input.requestSessionId,
        localId: input.requestLocalId, acceptedTurnId: input.acceptedTurnId });
  const admission = buildTrustedHostSessionInputAdmissionV1('agent');
  const senderSessionId = input.requestKind === 'session_input' ? input.requestSessionId : input.senderSessionId;
  return sendSessionMessage({
    credentials: input.credentials, idOrPrefix: input.sessionId, message: input.message, localId,
    ...(input.recipient ? { recipient: input.recipient } : {}),
    wait: false, timeoutMs: resolveSessionMessageAdmissionTimeoutMs(),
    informationDelivery: 'returned_answer', requestedAction: { v: 1, kind: 'enqueue' },
    inputAdmission: { provenance: admission.provenance,
      request: SessionInputRequestV1Schema.parse({ ...admission.request,
        ...(input.actionRequestAttributionV1 ? { actionRequestAttributionV1: input.actionRequestAttributionV1 } : {}),
        returnedAnswer: {
        requestSessionId: input.requestSessionId, requestLocalId: input.requestLocalId,
        outcome: input.outcome, delivery: 'wake',
        ...(senderSessionId ? { senderSessionId } : {}),
        ...(input.answeredBy ? { answeredBy: input.answeredBy } : {}),
        ...(input.sourceMessageRef ? { sourceMessageRef: input.sourceMessageRef } : {}),
      } }) },
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.machineAdmissionTransport ? { machineAdmissionTransport: input.machineAdmissionTransport } : {}),
    ...(input.machineResumeTransport ? { machineResumeTransport: input.machineResumeTransport } : {}),
  });
}

/**
 * The installed Machine owns Account keys after a target Session exits. Original
 * input custody is the only recovery inventory; hints merely request another
 * finite read. The native result owner alone may fulfill an obligation.
 */
export async function recoverSessionMessageRepliesForMachine(input: Readonly<{
  machineId: string;
  serverId: string;
  credentials: StoredCredentials;
  signal: AbortSignal;
  isCurrent: () => Promise<boolean>;
  /** Requester custody is bound to one Session, not its Account-wide inventory. */
  requesterSessionId?: string;
  /** A new transport is an advancing recovery edge; duplicate hints are not. */
  retryFailedPublications?: boolean;
  /** A strict inventory response proves this Home understands the new capability. */
  onSupported?: () => Promise<void>;
  machineAdmissionTransport: NonNullable<Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']>;
  machineResumeTransport?: Parameters<typeof sendSessionMessage>[0]['machineResumeTransport'];
  /** Same trusted resource publisher; the Discussion append transaction settles original custody. */
  publishDiscussionReply?: DiscussionReplyReturnPublisher;
  markReturned: (request: Readonly<{ requestSessionId: string; requestLocalId: string;
    returnedInputLocalId: string }>) => Promise<SessionMessageReplyMutationResultV1>;
}>): Promise<void> {
  const current = async () => !input.signal.aborted && await input.isCurrent() && !input.signal.aborted;
  let after: { sessionId: string; localId: string } | null = null;
  do {
    if (!await current()) return;
    const path = `/v2/machines/${encodeURIComponent(input.machineId)}/session-message-replies/pending`;
    const response = await axios.get(`${resolveServerHttpBaseUrl()}${path}`, {
      ...requestOptions(input),
      ...(after ? { params: { afterSessionId: after.sessionId, afterLocalId: after.localId } } : {}),
    });
    const page = SessionMessageReplyMachinePendingPageV1Schema.parse(response.data);
    if (!after && await current()) await input.onSupported?.();
    for (const entry of page.entries) {
      if (input.requesterSessionId !== undefined && entry.requestSessionId !== input.requesterSessionId) continue;
      if (!await current()) return;
      const progress = entry.progress;
      // The hosted requester branch consumes C3's resource publisher only;
      // ordinary Session-return ACKs remain on their incumbent Machine authority.
      if (input.requesterSessionId !== undefined && !progress.discussion) continue;
      if (progress.mode !== 'return' || progress.disposition !== 'return_pending'
        || !progress.sourceSession && !progress.discussion && !progress.humanOrigin || !progress.outcome) continue;
      if (progress.returnPublication?.kind === 'approval_pending'
        || progress.returnPublication?.kind === 'failed'
          && (!progress.returnPublication.failure.retryable || !input.retryFailedPublications)) continue;
      if (!await current()) return;
      const outcome = progress.outcome;
      if (outcome.kind === 'declined') continue;
      const projection = await projectSessionMessageReplyOutcome({ credentials: input.credentials, serverId: input.serverId,
        sessionId: entry.requestSessionId, localId: entry.requestLocalId, outcome, signal: input.signal });
      if (!projection) continue;
      const { message, sourceMessageRef } = projection;
      if (!await current()) return;
      if (progress.discussion) {
        // A Discussion destination never falls back to its descriptive causal
        // source Session. Missing publisher custody leaves this original pending.
        if (!input.publishDiscussionReply) continue;
        const published = await input.publishDiscussionReply({ serverId: input.serverId,
          requestSessionId: entry.requestSessionId, requestLocalId: entry.requestLocalId,
          ...(progress.acceptedTurnId ? { acceptedTurnId: progress.acceptedTurnId } : {}),
          discussion: progress.discussion, outcome, message,
          ...(progress.actionRequestAttributionV1 ? { actionRequestAttributionV1: progress.actionRequestAttributionV1 } : {}),
          ...(sourceMessageRef ? { sourceMessageRef } : {}),
        }, { signal: input.signal });
        if (!published.ok && await current()) {
          let publication: SessionMessageReplyPublicationV1 | undefined;
          if ('pending' in published) publication = { kind: 'approval_pending', artifactId: published.pending.artifactId };
          else {
            const failure = 'failure' in published ? published.failure
              : classifySessionMessageReplyPublicationFailureV1(published.error, 'session_publisher');
            if (failure) publication = { kind: 'failed', failure };
          }
          if (publication) {
            const settled = await settleDiscussionReplyReturnPublication({ credentials: input.credentials,
              requestSessionId: entry.requestSessionId, requestLocalId: entry.requestLocalId, discussion: progress.discussion,
              ...(progress.acceptedTurnId ? { acceptedTurnId: progress.acceptedTurnId } : {}), publication, signal: input.signal });
            if (!settled.ok) {
              logger.warnLocalFile('[SessionReply] Original publication settlement refused', { errorCode: settled.error,
                requestSessionId: entry.requestSessionId, requestLocalId: entry.requestLocalId });
            }
          }
        }
        continue;
      }
      const destinationSessionId = progress.humanOrigin?.sessionId ?? progress.sourceSession?.sourceSessionId;
      if (!destinationSessionId) continue;
      let returnMachineId: string | undefined;
      const result = await deliverSessionMessageReply({ credentials: input.credentials,
        sessionId: destinationSessionId,
        requestSessionId: entry.requestSessionId, requestLocalId: entry.requestLocalId,
        requestKind: 'session_input', acceptedTurnId: progress.acceptedTurnId,
        ...(entry.returnRecipient ? { recipient: entry.returnRecipient } : {}),
        message, outcome: outcome.kind, mode: 'wait', signal: input.signal,
        answeredBy: { v: 1, kind: 'happierSession', sourceSessionId: entry.requestSessionId, via: 'action' },
        ...(progress.actionRequestAttributionV1 ? { actionRequestAttributionV1: progress.actionRequestAttributionV1 } : {}),
        ...(sourceMessageRef ? { sourceMessageRef } : {}),
        machineAdmissionTransport: async (request, options) => {
          if (!await current()) return { status: 'rejected', code: 'session_input_cancelled' };
          returnMachineId = request.targetMachineId;
          return input.machineAdmissionTransport(request, options);
        },
        machineResumeTransport: async (method, request, options) => {
          if (!await current()) throw new Error('Session reply Machine custody retired');
          if (input.machineResumeTransport) return input.machineResumeTransport(method, request, options);
          if (!returnMachineId) throw new Error('Session reply return target was not admitted');
          return callMachineRpc({ credentials: input.credentials, machineId: returnMachineId, method, request, ...options });
        },
      });
      const admission = result.admissionResult;
      // Hold after Stop is accepted Pending custody; suppression/drop is not.
      if (admission?.status !== 'accepted' && admission?.status !== 'alreadyAccepted') continue;
      if (!await current()) return;
      const returned = await input.markReturned({ requestSessionId: entry.requestSessionId,
        requestLocalId: entry.requestLocalId, returnedInputLocalId: admission.localId });
      if (!returned.ok) throw new Error(`Session reply return acknowledgment ${returned.error}`);
    }
    after = page.nextAfter;
  } while (after);
}
