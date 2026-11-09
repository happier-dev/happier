import { ArtifactActionOutputSchemasV1 } from '../../artifacts/artifactActionsV1.js';
import { DocReadInputV1Schema, DocReadResultV1Schema, DocCommentReplyInputV1Schema, DocEditProposeInputV1Schema,
  DocEditProposeResolvedInputV1Schema, type DocEditProposeResolvedInputV1,
  prepareDocDiscussionMutationV1 } from '../../artifacts/artifactCollaborationActionsV1.js';
import { DocEditAcceptInputV1Schema, DocEditDeclineInputV1Schema, DocEditDecisionResultV1Schema,
  prepareDocEditAcceptanceV1 } from '../../artifacts/artifactCollaborationActionsV1.js';
import { DocPassageRefV1Schema, type DocPassageRefV1 } from '../../artifacts/artifactCollaborationV1.js';
import { DISCUSSION_ACTION_INPUT_SCHEMAS_V1, DiscussionCreateResultV1Schema, DiscussionPostResultV1Schema,
  DiscussionReadResultV1Schema, DiscussionListResultV1Schema,
  type DiscussionOpenedMessageV1 } from '../../discussions/actions.js';
import type { DiscussionMessageRefV1 } from '../../discussions/references.js';
import { createCanonicalJsonSigningInput } from '../../crypto/canonicalJson.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';
import { artifactSupportsProseCollaborationV1 } from '../../artifacts/artifactSharingV1.js';
import type { ActionExecutorContext, ActionExecutorDeps } from './types.js';
import type { ActionExecuteFailure, ActionExecuteResult } from '../actionExecutionResult.js';
import { areServerProfileIdentifiersEquivalent } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import { captureDocPassageV1, docPassageEditTargetV1, locateDocPassageThreadV1, selectDocPassageThreadAnchorMessageV1 } from '../../artifacts/artifactPassageV1.js';

type SameHome = (left: string | null | undefined, right: string | null | undefined) => boolean;

function refuse(errorCode: string): ActionExecuteFailure { return { ok: false, errorCode, error: errorCode }; }

/** Read through the existing authenticated Artifact transport; this owner never opens keys or decides grants. */
export async function executeDocReadV1(input: unknown, context: ActionExecutorContext,
  deps: Pick<ActionExecutorDeps, 'artifactAction' | 'discussionAction'>,
  sameHome: SameHome = areServerProfileIdentifiersEquivalent): Promise<ActionExecuteResult> {
  const request = DocReadInputV1Schema.parse(input);
  const read = deps.artifactAction;
  if (!read) return refuse('unsupported_action');
  if (!context.serverId) return refuse('server_target_required');
  if (request.ref.serverId !== undefined && !sameHome(request.ref.serverId, context.serverId)) return refuse('server_target_mismatch');
  context.signal?.throwIfAborted();
  const value = await read({ actionId: 'artifact.get', input: { artifactId: request.ref.artifactId }, readOnly: true, context,
    ...(context.signal ? { signal: context.signal } : {}) });
  context.signal?.throwIfAborted();
  const failure = readActionFailureEnvelope(value);
  if (failure) return failure;
  const parsed = ArtifactActionOutputSchemasV1['artifact.get'].safeParse(value);
  if (!parsed.success) return refuse('invalid_action_output');
  const artifact = parsed.data.artifact;
  if (!artifact) return refuse('not_found');
  if (artifact.artifactId !== request.ref.artifactId) return refuse('invalid_action_output');
  if (!artifactSupportsProseCollaborationV1(artifact)) return refuse('doc_kind_not_prose');
  if (request.revision && (request.revision.headerVersion !== artifact.revision.headerVersion
    || request.revision.bodyVersion !== artifact.revision.bodyVersion)) return refuse('version_mismatch');
  const ref = { ...request.ref, serverId: context.serverId };
  const openCommentCount = await countDocPassageThreadsV1(ref, context, deps.discussionAction, sameHome);
  return { ok: true, result: DocReadResultV1Schema.parse({ ref, artifact, openCommentCount }) };
}

/** Count active, currently readable passage roots using C3's write-time summary and batched admission. */
export async function countDocPassageThreadsV1(ref: DocPassageRefV1['ref'], context: ActionExecutorContext,
  discussionAction: ActionExecutorDeps['discussionAction'],
  sameHome: SameHome = areServerProfileIdentifiersEquivalent): Promise<number | null> {
  context.signal?.throwIfAborted();
  if (!discussionAction || !context.serverId || ref.serverId !== undefined && !sameHome(ref.serverId, context.serverId)) return null;
  const resources = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let count = 0;
  try {
    for (;;) {
      context.signal?.throwIfAborted();
      const value = await discussionAction({ actionId: 'discussion.list', input: { state: 'active',
        anchorDocArtifactId: ref.artifactId, ...(cursor === undefined ? {} : { cursor }) }, context,
        ...(context.signal ? { signal: context.signal } : {}) });
      context.signal?.throwIfAborted();
      const page = DiscussionListResultV1Schema.safeParse(value);
      if (!page.success || !sameHome(page.data.serverId, context.serverId)) return null;
      for (const summary of page.data.discussions) {
        if (summary.archivedAt !== null || summary.anchor?.kind !== 'doc'
          || summary.anchor.doc.ref.artifactId !== ref.artifactId || resources.has(summary.id)) continue;
        resources.add(summary.id);
        if (summary.firstMessage === undefined) return null;
        if (summary.firstMessage === null) continue;
        const root = summary.firstMessage;
        if (root.seq !== 1 || root.discussionId !== summary.id || root.messageRef.messageId !== root.id
          || root.messageRef.discussion.discussionId !== summary.id
          || !sameHome(root.messageRef.discussion.serverId, context.serverId)) return null;
        const passage = readPassageRootContent(root);
        if (!passage || passage.ref.artifactId !== ref.artifactId) return null;
        if (summary.openCommentCount == null || summary.openCommentCount < 1) return null;
        count = sumDocPassageOpenCommentCountsV1(count, summary.openCommentCount);
      }
      if (page.data.nextCursor === null) return count;
      if (cursors.has(page.data.nextCursor)) return null;
      cursor = page.data.nextCursor;
      cursors.add(cursor);
    }
  } catch {
    context.signal?.throwIfAborted();
    return null;
  }
}

/** One arithmetic owner for admitted Discussion summary counts on server and client projections. */
export function sumDocPassageOpenCommentCountsV1(current: number, next: number | null | undefined): number {
  if (next == null || !Number.isInteger(next) || next < 1) throw new RangeError('Unavailable Doc passage comment count');
  return current + next;
}

function readPassageRootContent(message: DiscussionOpenedMessageV1): DocPassageRefV1 | null {
  if (!message.content || message.replyTarget?.kind !== 'doc_passage') return null;
  const passage = 'kind' in message.content && message.content.kind === 'doc_passage_comment'
    ? message.content.passage : 'kind' in message.content && message.content.kind === 'doc_edit_proposal'
      ? message.content.proposal.target : null;
  return passage && passage.ref.artifactId === message.replyTarget.doc.ref.artifactId
    && passage.revision.headerVersion === message.replyTarget.doc.revision.headerVersion
    && passage.revision.bodyVersion === message.replyTarget.doc.revision.bodyVersion ? passage : null;
}

/** Bind once before review; replay publishes the reviewed passage rather than reading a new basis. */
export async function prepareDocEditProposalInputV1(input: unknown, context: ActionExecutorContext,
  deps: Pick<ActionExecutorDeps, 'discussionAction' | 'artifactAction'>,
  sameHome: SameHome = areServerProfileIdentifiersEquivalent): Promise<
    { ok: true; input: DocEditProposeResolvedInputV1 } | ActionExecuteFailure> {
  const request = DocEditProposeInputV1Schema.parse(input);
  if ('target' in request) return { ok: true, input: request };
  const { discussionAction } = deps;
  if (!discussionAction) return refuse('unsupported_action');
  if (!context.serverId) return refuse('server_target_required');
  if (!sameHome(request.discussionRef.serverId, context.serverId)) return refuse('server_target_mismatch');
  let anchor: DiscussionOpenedMessageV1 | null = null;
  const messages: DiscussionOpenedMessageV1[] = [];
  let beforeSeq: number | undefined;
  while (!anchor) {
    context.signal?.throwIfAborted();
    const value = await discussionAction({ actionId: 'discussion.read',
      input: { discussionId: request.discussionRef.discussionId, ...(beforeSeq === undefined ? {} : { beforeSeq }) }, context,
      ...(context.signal ? { signal: context.signal } : {}) });
    context.signal?.throwIfAborted();
    const failure = readActionFailureEnvelope(value);
    if (failure) return failure;
    const opened = DiscussionReadResultV1Schema.safeParse(value);
    if (!opened.success || !sameHome(opened.data.serverId, context.serverId)
      || opened.data.discussionId !== request.discussionRef.discussionId) return refuse('invalid_action_output');
    messages.push(...opened.data.messages);
    anchor = selectDocPassageThreadAnchorMessageV1(opened.data.messages);
    if (anchor) break;
    if (!opened.data.hasMoreOlder) return refuse(opened.data.messages.some(message => message.content !== null)
      ? 'doc_passage_mismatch' : 'content_unavailable');
    const oldest = Math.min(...opened.data.messages.map(message => message.seq));
    if (!Number.isFinite(oldest) || beforeSeq !== undefined && oldest >= beforeSeq) return refuse('invalid_action_output');
    beforeSeq = oldest;
  }
  if (!anchor?.content) return refuse('content_unavailable');
  if (anchor.discussionId !== request.discussionRef.discussionId || anchor.messageRef.messageId !== anchor.id
    || anchor.messageRef.discussion.discussionId !== request.discussionRef.discussionId
    || !sameHome(anchor.messageRef.discussion.serverId, context.serverId)) return refuse('invalid_action_output');
  const passage = readPassageRootContent(anchor);
  if (!passage) return refuse('doc_passage_mismatch');
  // Stored Home labels belong to the creator's device; the opened resource supplies routing identity.
  const ref = { ...passage.ref, serverId: request.discussionRef.serverId };
  const read = await executeDocReadV1({ ref }, context, deps, sameHome);
  if (!read.ok) return read;
  const { artifact } = DocReadResultV1Schema.parse(read.result);
  if (typeof artifact.body !== 'string') return refuse('content_unavailable');
  const { location } = locateDocPassageThreadV1({ target: passage, source: artifact.body,
    revision: artifact.revision, messages, purpose: 'propose' });
  if (location.state === 'detached') return refuse('doc_passage_mismatch');
  const target = docPassageEditTargetV1(captureDocPassageV1({ ref, revision: artifact.revision,
    source: artifact.body, range: location.range }));
  return { ok: true, input: { ...request, target,
    baseRevision: target.revision, before: target.quote, reason: request.reason ?? '' } };
}

/** Reads one committed message through C3's current access and projection owner. */
export async function readCommittedDiscussionMessage(parent: DiscussionMessageRefV1 | Readonly<{
  kind: 'discussion'; discussion: DiscussionMessageRefV1['discussion']; localId: string;
}>, context: ActionExecutorContext,
  discussionAction: NonNullable<ActionExecutorDeps['discussionAction']>, options?: Readonly<{ throughSeq: number }>,
  sameHome: SameHome = areServerProfileIdentifiersEquivalent): Promise<
    { ok: true; message: DiscussionOpenedMessageV1 } | ActionExecuteFailure> {
  context.signal?.throwIfAborted();
  const result = await discussionAction({ actionId: 'discussion.read',
    input: { discussionId: parent.discussion.discussionId,
      ...('messageId' in parent ? { messageId: parent.messageId } : { localId: parent.localId }),
      ...(options ? { throughSeq: options.throughSeq } : {}) }, context,
    ...(context.signal ? { signal: context.signal } : {}) });
  const failure = readActionFailureEnvelope(result);
  if (failure) return failure;
  const page = DiscussionReadResultV1Schema.safeParse(result);
  if (!page.success || !sameHome(page.data.serverId, context.serverId)
    || page.data.discussionId !== parent.discussion.discussionId) return refuse('invalid_action_output');
  const message = page.data.messages.find(item => 'messageId' in parent ? item.id === parent.messageId : item.localId === parent.localId);
  if (!message) return refuse(page.data.incomplete ? 'content_unavailable' : 'not_found');
  if (options && message.seq > options.throughSeq
    || message.discussionId !== parent.discussion.discussionId
    || !sameHome(message.messageRef.discussion.serverId, parent.discussion.serverId)) return refuse('invalid_action_output');
  return { ok: true, message };
}

/** Parent refs identify a committed passage root, never a caller-authored substitute anchor. */
async function readPassageRoot(parent: DiscussionMessageRefV1, context: ActionExecutorContext,
  discussionAction: NonNullable<ActionExecutorDeps['discussionAction']>, sameHome: SameHome): Promise<
    { ok: true; passage: DocPassageRefV1 } | ActionExecuteFailure> {
  const read = await readCommittedDiscussionMessage(parent, context, discussionAction, undefined, sameHome);
  if (!read.ok) return read;
  const { message } = read;
  if (!message.content) return refuse('content_unavailable');
  if (message.replyTarget?.kind !== 'doc_passage') return refuse('doc_passage_mismatch');
  const passage = readPassageRootContent(message);
  if (!passage || (passage.ref.serverId !== undefined
    && !sameHome(passage.ref.serverId, message.replyTarget.doc.ref.serverId))) return refuse('doc_passage_mismatch');
  // This is an internal comparison projection of the exact admitted root, not
  // a rewrite of its sealed passage or the next mutation's authored payload.
  return { ok: true, passage: { ...passage, ref: { ...passage.ref, serverId: message.messageRef.discussion.serverId } } };
}

/** Present-person admission is generic Action policy; the server rechecks person, thread and Doc authority in its transaction. */
export async function executeDocEditDecisionV1(actionId: 'doc.edit.accept' | 'doc.edit.decline', input: unknown,
  context: ActionExecutorContext, deps: Pick<ActionExecutorDeps, 'artifactAction' | 'discussionAction'>,
  sameHome: SameHome = areServerProfileIdentifiersEquivalent): Promise<ActionExecuteResult> {
  if (!deps.artifactAction) return refuse('unsupported_action');
  if (!context.serverId) return refuse('server_target_required');
  const request = actionId === 'doc.edit.accept' ? DocEditAcceptInputV1Schema.parse(input) : DocEditDeclineInputV1Schema.parse(input);
  if (!sameHome(request.proposalRef.discussion.serverId, context.serverId)) return refuse('server_target_mismatch');
  let result: unknown;
  if (actionId === 'doc.edit.accept') {
    if (!deps.discussionAction) return refuse('unsupported_action');
    const accept = DocEditAcceptInputV1Schema.parse(request);
    const read = await readCommittedDiscussionMessage(accept.proposalRef, context, deps.discussionAction, undefined, sameHome);
    if (!read.ok) return read;
    const { message } = read;
    let sameProposalHome = sameHome;
    let artifact: ReturnType<typeof ArtifactActionOutputSchemasV1['artifact.get']['parse']>['artifact'] = null;
    if (message.docEditProposalDispositionV1?.state === 'open') {
      if (!message.content || !('kind' in message.content) || message.content.kind !== 'doc_edit_proposal') return refuse('doc_edit_proposal_invalid');
      const target = message.content.proposal.target.ref;
      // The exact C3 row was read under this Home's current source admission.
      // Its immutable Doc label can belong to the creator's device, unlike the
      // freshly qualified messageRef. Bind only that stored label for this
      // preparation; public input labels still use ordinary Home admission.
      const storedHome = target.serverId;
      const openedHome = message.messageRef.discussion.serverId;
      sameProposalHome = (left, right) => sameHome(
        storedHome && left === storedHome ? openedHome : left,
        storedHome && right === storedHome ? openedHome : right,
      );
      if (!sameProposalHome(target.serverId, context.serverId)) return refuse('server_target_mismatch');
      const value = await deps.artifactAction({ actionId: 'artifact.get', input: { artifactId: target.artifactId }, readOnly: true, context,
        ...(context.signal ? { signal: context.signal } : {}) });
      const failure = readActionFailureEnvelope(value);
      if (failure) return failure;
      const opened = ArtifactActionOutputSchemasV1['artifact.get'].safeParse(value);
      if (!opened.success) return refuse('invalid_action_output');
      if (!opened.data.artifact) return refuse('not_found');
      artifact = opened.data.artifact;
    }
    let prepared;
    try { prepared = prepareDocEditAcceptanceV1({ ...accept, message, ...(artifact ? { artifact } : {}) }, sameProposalHome); }
    catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'doc_edit_proposal_invalid';
      return refuse(code);
    }
    context.signal?.throwIfAborted();
    result = await deps.artifactAction({ actionId, input: prepared, context, ...(context.signal ? { signal: context.signal } : {}) });
  } else {
    context.signal?.throwIfAborted();
    result = await deps.artifactAction({ actionId, input: DocEditDeclineInputV1Schema.parse(request), context,
      ...(context.signal ? { signal: context.signal } : {}) });
  }
  context.signal?.throwIfAborted();
  const failure = readActionFailureEnvelope(result);
  if (failure) return failure;
  const settled = DocEditDecisionResultV1Schema.safeParse(result);
  if (!settled.success || settled.data.proposalRef.messageId !== request.proposalRef.messageId
    || settled.data.proposalRef.discussion.discussionId !== request.proposalRef.discussion.discussionId
    || !sameHome(settled.data.proposalRef.discussion.serverId, request.proposalRef.discussion.serverId)) return refuse('invalid_action_output');
  return { ok: true, result: settled.data };
}

/** One consumed adapter into C3's create/post/reply owners and incumbent resource codec. */
export async function executeDocDiscussionWriteV1(actionId: 'doc.comment.reply' | 'doc.edit.propose', input: unknown,
  context: ActionExecutorContext, discussionAction: ActionExecutorDeps['discussionAction'],
  sameHome: SameHome = areServerProfileIdentifiersEquivalent): Promise<ActionExecuteResult> {
  if (!discussionAction) return refuse('unsupported_action');
  if (!context.serverId) return refuse('server_target_required');
  const request = actionId === 'doc.comment.reply' ? DocCommentReplyInputV1Schema.parse(input) : DocEditProposeResolvedInputV1Schema.parse(input);
  const isComment = 'content' in request;
  const parent = isComment ? request.parentMessageRef : request.replyTo;
  const discussion = request.discussionRef ?? parent?.discussion;
  if ((request.target.ref.serverId !== undefined && !sameHome(request.target.ref.serverId, context.serverId))
    || (discussion !== undefined && !sameHome(discussion.serverId, context.serverId))
    || (parent !== undefined && !sameHome(parent.discussion.serverId, context.serverId))) return refuse('server_target_mismatch');
  // Keep an authored, admitted Home identifier: it participates in the existing creation retry identity.
  const target = DocPassageRefV1Schema.parse({ ...request.target, ref: { ...request.target.ref,
    serverId: request.target.ref.serverId ?? context.serverId } });
  if (parent) {
    const root = await readPassageRoot(parent, context, discussionAction, sameHome);
    if (!root.ok) return root;
    if (root.passage.ref.artifactId !== target.ref.artifactId || !sameHome(root.passage.ref.serverId, target.ref.serverId)
      || (isComment && createCanonicalJsonSigningInput({ ...root.passage, ref: target.ref }) !== createCanonicalJsonSigningInput(target))) {
      return refuse('doc_passage_mismatch');
    }
  }
  const mutation = prepareDocDiscussionMutationV1(actionId, { ...request, target }, context.serverId);
  context.signal?.throwIfAborted();
  const result = await discussionAction({ ...mutation, context, ...(context.signal ? { signal: context.signal } : {}) });
  const failure = readActionFailureEnvelope(result);
  if (failure) return failure;
  if (mutation.actionId === 'discussion.create') {
    const created = DiscussionCreateResultV1Schema.safeParse(result);
    if (!created.success || !sameHome(created.data.serverId, context.serverId)
      || created.data.firstMessage.discussionId !== created.data.discussion.id) return refuse('invalid_action_output');
    return { ok: true, result: DiscussionPostResultV1Schema.parse({ v: created.data.v, serverId: created.data.serverId,
      message: created.data.firstMessage, messageSeq: created.data.discussion.messageSeq }) };
  }
  const posted = DiscussionPostResultV1Schema.safeParse(result);
  if (!posted.success || !sameHome(posted.data.serverId, context.serverId)
    || posted.data.message.discussionId !== mutation.input.discussionId) return refuse('invalid_action_output');
  return { ok: true, result: posted.data };
}
