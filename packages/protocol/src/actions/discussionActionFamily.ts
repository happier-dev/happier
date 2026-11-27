import { z } from '../zodRuntimePolicy.js';
export { readDiscussionCandidatesV1, bindDiscussionCandidatePeopleReadV1,
  projectDiscussionCandidateSessionQueryV1 } from './discussionCandidates.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import {
  DiscussionCreateRequestV1Schema,
  DiscussionListResponseV1Schema,
  DiscussionPostRequestV1Schema,
  DiscussionRenameRequestV1Schema,
} from '../discussions/api.js';
import { DISCUSSION_ACTION_INPUT_SCHEMAS_V1, DiscussionCreateInputV1Schema, type DiscussionCreateInputV1 } from '../discussions/actions.js';
import { internalTaskOwnerAccountIdV1, isInternalTaskReferenceV1, type TriageEntryRefV1 } from '../tasks/entryRefV1.js';
import type { DiscussionSummaryV1 } from '../discussions/models.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { computeCanonicalDomainSeparatedDigest } from '../crypto/canonicalDigest.js';
import { DiscussionIdSchema } from '../discussions/content.js';
import { DiscussionReplyTargetV1Schema } from '../discussions/replyTargets.js';
import { DiscussionInviteRequestV1Schema, DiscussionParticipantPolicySetRequestV1Schema } from '../discussions/participants.js';

import {
  isDiscussionActionIdV1,
  type DiscussionActionIdV1,
} from '../discussions/actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { bindHomeDomainHttpRequestV1, type HomeDomainHttpRequestV1 } from './homeDomainHttpBinding.js';
import type { ActionExecutorContext } from './executor/types.js';

/**
 * The Home Discussion family's transport and codec lookup.
 *
 * It lives in the Action layer for the same reason the Home and Session-access
 * families' lookups do: the Action id registry and the feature graph already
 * import each other, and pulling the registry into a domain schema leaf makes
 * that graph evaluate before the leaf finishes. Ids and schemas stay
 * dependency-light; the registry-aware lookup lives here.
 *
 * Transport and semantic codecs come from the registered Action row. Stored
 * content codecs compose the canonical HTTP schemas after client-side sealing;
 * this module holds no path or policy table of its own.
 */
export type { DiscussionActionIdV1 };

export { isDiscussionActionIdV1 };

/** Unbounded summary content cannot enter an addressed Agent's protected context. */
export function hasProtectedDiscussionActionContextV1(
  context: Pick<ActionExecutorContext, 'surface' | 'actionCaller' | 'sessionInputSource'>,
): boolean {
  const agentOrigin = context.surface === 'agent' || context.actionCaller?.kind === 'session';
  const source = context.sessionInputSource;
  return agentOrigin && source !== null && typeof source === 'object' && 'discussionAddressing' in source;
}

/** The strict semantic-plaintext input this intent declared on its Action row. */
export function discussionActionInputSchemaV1(
  actionId: DiscussionActionIdV1,
): z.ZodMiniType {
  return getActionSpec(actionId).inputSchema;
}

const DiscussionPostHttpWireInputV1Schema = lazyZodSchema(() => z.safeExtend(DiscussionPostRequestV1Schema, {
  discussionId: DiscussionIdSchema,
}));
const DiscussionReplyHttpWireInputV1Schema = lazyZodSchema(() => z.safeExtend(DiscussionPostHttpWireInputV1Schema, {
  replyTarget: DiscussionReplyTargetV1Schema,
}));
const DiscussionRenameHttpWireInputV1Schema = lazyZodSchema(() => z.safeExtend(DiscussionRenameRequestV1Schema, {
  discussionId: DiscussionIdSchema,
}));
const DiscussionInviteHttpWireInputV1Schema = lazyZodSchema(() => z.union(
  DiscussionInviteRequestV1Schema.def.options.map(schema => z.safeExtend(schema, { discussionId: DiscussionIdSchema })),
));
const DiscussionParticipantPolicySetHttpWireInputV1Schema = lazyZodSchema(() => z.safeExtend(
  DiscussionParticipantPolicySetRequestV1Schema, { discussionId: DiscussionIdSchema },
));

function discussionResolvedParticipantHttpInputSchemaV1(actionId: DiscussionActionIdV1): z.ZodMiniType | null {
  switch (actionId) {
    case 'discussion.invite': return DiscussionInviteHttpWireInputV1Schema;
    case 'discussion.participant.policy.set': return DiscussionParticipantPolicySetHttpWireInputV1Schema;
    default: return null;
  }
}

/** The closed post-sealing input, including metadata-bound route operands. */
export function discussionActionHttpWireInputSchemaV1(
  actionId: DiscussionActionIdV1,
): z.ZodMiniType {
  switch (actionId) {
    case 'discussion.create': return DiscussionCreateRequestV1Schema;
    case 'discussion.post': return DiscussionPostHttpWireInputV1Schema;
    case 'discussion.reply': return DiscussionReplyHttpWireInputV1Schema;
    case 'discussion.rename': return DiscussionRenameHttpWireInputV1Schema;
    default: return discussionResolvedParticipantHttpInputSchemaV1(actionId) ?? discussionActionInputSchemaV1(actionId);
  }
}

/** The strict opened result this intent declared on its Action row. */
export function discussionActionOutputSchemaV1(
  actionId: DiscussionActionIdV1,
): z.ZodMiniType {
  const outputSchema = getActionSpec(actionId).outputSchema;
  if (!outputSchema) {
    // A registered family row without a result schema is a registry defect, not
    // a runtime condition a caller could recover from.
    throw new TypeError(`Discussion Action declares no result schema: ${actionId}`);
  }
  return outputSchema;
}

/**
 * Binds one discussion intent to the exact HTTP request its row declared.
 *
 * Typed on the family id so a caller cannot bind an Action from another family
 * through this seam, and so the descriptor binder — not a client-side route
 * table — stays the only place that turns an Action id into a request address.
 *
 * Content remains strict semantic plaintext at this boundary. The executing
 * host seals it through the Discussion's own key before storage transport.
 */
export function bindDiscussionActionHttpRequestV1(
  actionId: DiscussionActionIdV1,
  input: unknown,
): HomeDomainHttpRequestV1 {
  const spec = getActionSpec(actionId);
  if (!spec.serverTransport) {
    throw new TypeError(`Discussion Action declares no server transport: ${actionId}`);
  }
  return bindHomeDomainHttpRequestV1({
    transport: spec.serverTransport,
    inputSchema: discussionResolvedParticipantHttpInputSchemaV1(actionId) ?? spec.inputSchema,
    input,
  });
}

export function matchesDiscussionTaskAnchorV1(anchor: DiscussionSummaryV1['anchor'], ref: TriageEntryRefV1, accountId: string): boolean {
  if (anchor?.kind !== 'task') return false;
  if (sameStrictJsonValue(anchor.entry, ref)) return true;
  return isInternalTaskReferenceV1(anchor.entry) && isInternalTaskReferenceV1(ref)
    && anchor.entry.entryId === ref.entryId
    && internalTaskOwnerAccountIdV1(anchor.entry, accountId) === internalTaskOwnerAccountIdV1(ref, accountId);
}

/** Resolve a qualified Task through the existing Discussion listing authority. */
export async function readDiscussionTaskAnchorV1(ref: TriageEntryRefV1, accountId: string,
  request: (bound: HomeDomainHttpRequestV1) => Promise<unknown>): Promise<DiscussionSummaryV1 | null> {
  const page = DiscussionListResponseV1Schema.parse(await request(bindDiscussionActionHttpRequestV1('discussion.list', { anchorTask: ref })));
  const row = page.discussions[0];
  if (!row) return null;
  if (page.discussions.length !== 1 || page.nextCursor !== null || !matchesDiscussionTaskAnchorV1(row.anchor, ref, accountId)) {
    throw Object.assign(new Error('discussion_content_unavailable'), { code: 'discussion_content_unavailable' });
  }
  return row;
}

/** One stable creation identity for the exact authored first comment. */
export function projectDiscussionTaskFirstPostV1(input: unknown, messageLocalId: string): DiscussionCreateInputV1 {
  const post = DISCUSSION_ACTION_INPUT_SCHEMAS_V1['discussion.post'].parse(input);
  if (!('anchorTask' in post)) throw new TypeError('Task comment requires an exact Task reference');
  const { anchorTask, attachmentSources, localId: _authoredId, ...message } = post;
  return DiscussionCreateInputV1Schema.parse({
    creationLocalId: computeCanonicalDomainSeparatedDigest('task.comment.discussion.v1', [anchorTask.source.pluginId,
      anchorTask.source.localId, anchorTask.kindId, anchorTask.collisionScope, anchorTask.entryId, messageLocalId]),
    title: isInternalTaskReferenceV1(anchorTask) ? 'Task comments' : 'Internal comments',
    anchor: { kind: 'task', entry: anchorTask },
    ...(attachmentSources ? { attachmentSources } : {}),
    firstMessage: { ...message, localId: messageLocalId },
  });
}
