import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsersSearchQueryV1Schema } from '../social/friends.js';
import { SessionListQueryV1Schema } from '../sessions/listing/query.js';
import { SessionReadinessV1Schema, SessionReadinessRepairV1Schema } from '../sessions/control/sessionReadinessV1.js';
import { SessionAccessAccountSummaryV1Schema } from '../sessions/access/sessionAccessPrincipalV1.js';
import type { SessionEffectiveAccessV1 } from '../sessions/access/sessionEffectiveAccessV1.js';
import { ExecutableModelParticipantSelectionV1Schema, ExecutableSessionParticipantSelectionV1Schema,
  type ExecutableParticipantSelectionV1 } from './executableParticipants.js';
import { DiscussionAccountParticipantRefV1Schema, DiscussionIdSchema } from './references.js';
import type { DiscussionParticipantsListResponseV1 } from './participants.js';

const ModelSelectionSchema = ExecutableModelParticipantSelectionV1Schema;
const SessionSelectionSchema = ExecutableSessionParticipantSelectionV1Schema;

/** These are already-selected ordinary authoring options, not a model discovery request. */
export const DiscussionCandidateModelOptionV1Schema = lazyZodSchema(() => z.strictObject({
  selection: ModelSelectionSchema,
  label: z.string(),
  readiness: z.optional(SessionReadinessV1Schema),
  repair: z.optional(z.nullable(SessionReadinessRepairV1Schema)),
}));

/** Each source retains its own native continuation; New Discussion has no resource id yet. */
export const DiscussionCandidatesListInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('people'), discussionId: z.optional(DiscussionIdSchema),
    query: UsersSearchQueryV1Schema.shape.query, cursor: UsersSearchQueryV1Schema.shape.cursor }),
  z.strictObject({ source: z.literal('sessions'), discussionId: z.optional(DiscussionIdSchema),
    cursor: SessionListQueryV1Schema.shape.cursor }),
  z.strictObject({ source: z.literal('models'), discussionId: z.optional(DiscussionIdSchema),
    options: z.array(DiscussionCandidateModelOptionV1Schema) }),
]));
export type DiscussionCandidatesListInputV1 = z.infer<typeof DiscussionCandidatesListInputV1Schema>;

export const DiscussionInviteCandidateV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('account'), key: z.string(), participant: DiscussionAccountParticipantRefV1Schema,
    profile: SessionAccessAccountSummaryV1Schema }),
  z.strictObject({ kind: z.literal('session'), key: z.string(), selection: SessionSelectionSchema,
    label: z.nullable(z.string()) }),
  z.strictObject({ kind: z.literal('model'), key: z.string(), selection: ModelSelectionSchema, label: z.string(),
    // Supplied setup diagnostics are never launch authority. Omission stays unknown.
    availability: z.nullable(SessionReadinessV1Schema), repair: z.nullable(SessionReadinessRepairV1Schema) }),
]));
export type DiscussionInviteCandidateV1 = z.infer<typeof DiscussionInviteCandidateV1Schema>;
export const DiscussionCandidatesListResultV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), serverId: z.string().check(z.minLength(1)), source: z.enum(['people', 'sessions', 'models']),
  candidates: z.array(DiscussionInviteCandidateV1Schema), nextCursor: z.nullable(z.string()),
}));
export type DiscussionCandidatesListResultV1 = z.infer<typeof DiscussionCandidatesListResultV1Schema>;

type CandidateIdentity =
  | Readonly<{ kind: 'account'; participant: Readonly<{ kind: 'account'; accountId: string }> }>
  | Readonly<{ kind: 'session' | 'model'; selection: ExecutableParticipantSelectionV1 }>;

/** The one exclusion/deduplication projection for public Actions and the mounted Invite picker. */
export function projectDiscussionInviteCandidatesV1<T extends CandidateIdentity>(input: Readonly<{
  scope: Readonly<{ serverId: string; accountId: string }>;
  candidates: readonly T[];
  roster?: DiscussionParticipantsListResponseV1 | null;
  sessionAccess?: ReadonlyMap<string, Pick<SessionEffectiveAccessV1, 'capabilities'> | null>;
  /** Local Home aliases are resolved by the existing host profile owner. */
  isSameHome?: (serverId: string) => boolean;
}>): readonly (T & Readonly<{ key: string }>)[] {
  const accounts = new Set([input.scope.accountId, ...(input.roster ? [input.roster.ownerAccountId] : [])]);
  for (const row of input.roster?.grants ?? []) if (row.principal.kind === 'account') accounts.add(row.principal.accountId);
  const sessions = new Set((input.roster?.participants ?? []).flatMap(row => row.participant.kind === 'session'
    ? [row.participant.sessionId] : 'sessionId' in row && row.sessionId ? [row.sessionId] : []));
  const modelKeys = new Set<string>();
  const result: (T & Readonly<{ key: string }>)[] = [];
  const sameHome = input.isSameHome ?? ((serverId: string) => serverId === input.scope.serverId);
  for (const candidate of input.candidates) {
    let key: string;
    if (candidate.kind === 'account') {
      if (accounts.has(candidate.participant.accountId)) continue;
      accounts.add(candidate.participant.accountId);
      key = JSON.stringify(['account', input.scope.serverId, candidate.participant.accountId]);
    } else if (candidate.selection.kind === 'session') {
      const session = candidate.selection.session;
      if (!sameHome(session.serverId) || sessions.has(session.sessionId)
        || input.sessionAccess?.get(session.sessionId)?.capabilities.submitAgentInput !== true) continue;
      sessions.add(session.sessionId);
      key = JSON.stringify(['session', input.scope.serverId, session.sessionId]);
    } else {
      if (!sameHome(candidate.selection.launch.executionTarget.serverId)) continue;
      key = JSON.stringify(['model', input.scope.serverId, candidate.selection.launch]);
      if (modelKeys.has(key)) continue;
      modelKeys.add(key);
    }
    result.push({ ...candidate, key });
  }
  return result;
}

