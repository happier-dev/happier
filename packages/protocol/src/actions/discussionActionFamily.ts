import { z } from '../zodRuntimePolicy.js';
export { readDiscussionCandidatesV1, bindDiscussionCandidatePeopleReadV1,
  projectDiscussionCandidateSessionQueryV1 } from './discussionCandidates.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import {
  DiscussionCreateRequestV1Schema,
  DiscussionPostRequestV1Schema,
  DiscussionRenameRequestV1Schema,
} from '../discussions/api.js';
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

/** The closed post-sealing input, including metadata-bound route operands. */
export function discussionActionHttpWireInputSchemaV1(
  actionId: DiscussionActionIdV1,
): z.ZodMiniType {
  switch (actionId) {
    case 'discussion.create': return DiscussionCreateRequestV1Schema;
    case 'discussion.post': return DiscussionPostHttpWireInputV1Schema;
    case 'discussion.reply': return DiscussionReplyHttpWireInputV1Schema;
    case 'discussion.rename': return DiscussionRenameHttpWireInputV1Schema;
    case 'discussion.invite': return DiscussionInviteHttpWireInputV1Schema;
    case 'discussion.participant.policy.set': return DiscussionParticipantPolicySetHttpWireInputV1Schema;
    default: return discussionActionInputSchemaV1(actionId);
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
    inputSchema: actionId === 'discussion.invite' || actionId === 'discussion.participant.policy.set'
      ? discussionActionHttpWireInputSchemaV1(actionId) : spec.inputSchema,
    input,
  });
}
