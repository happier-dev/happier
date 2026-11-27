import { UsersSearchResponseSchema } from '../social/friends.js';
import { SessionListQueryV1Schema } from '../sessions/listing/query.js';
import { SessionListQueryResponseV1Schema } from '../sessions/listing/response.js';
import { SessionAccessAccountSummaryV1Schema } from '../sessions/access/sessionAccessPrincipalV1.js';
import type { SessionEffectiveAccessV1 } from '../sessions/access/sessionEffectiveAccessV1.js';
import { DiscussionCandidatesListInputV1Schema, DiscussionCandidatesListResultV1Schema,
  projectDiscussionInviteCandidatesV1, type DiscussionCandidatesListInputV1,
  type DiscussionCandidatesListResultV1 } from '../discussions/candidates.js';
import { DiscussionParticipantsListResponseV1Schema } from '../discussions/participants.js';
import { DISCUSSION_HTTP_PATHS_V1 } from '../discussions/api.js';

/** Exactly the ordinary accessible Session page, with no attention/history hydration. */
export function projectDiscussionCandidateSessionQueryV1(input: Extract<DiscussionCandidatesListInputV1, { source: 'sessions' }>) {
  return SessionListQueryV1Schema.parse({ v: 1, storage: 'active', includeInactive: true, scope: 'all_accessible',
    attention: 'any', audiences: { include: [], exclude: [] }, tagIds: { include: [], exclude: [] }, includeAttention: false, ...(input.cursor ? { cursor: input.cursor } : {}) });
}

export function bindDiscussionCandidatePeopleReadV1(input: Extract<DiscussionCandidatesListInputV1, { source: 'people' }>) {
  const query = new URLSearchParams({ query: input.query, purpose: 'collaboration' });
  if (input.cursor) query.set('cursor', input.cursor);
  return `/v1/user/search?${query}`;
}

/** HTTP is supplied by the captured Account host; inventories and authorization remain their existing owners. */
export async function readDiscussionCandidatesV1(input: Readonly<{
  scope: Readonly<{ serverId: string; accountId: string }>;
  request: (request: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>) => Promise<unknown>;
  args: DiscussionCandidatesListInputV1;
  signal?: AbortSignal;
  isSameHome?: (serverId: string) => boolean;
}>): Promise<DiscussionCandidatesListResultV1> {
  input.signal?.throwIfAborted();
  const args = DiscussionCandidatesListInputV1Schema.parse(input.args);
  const roster = args.discussionId ? DiscussionParticipantsListResponseV1Schema.parse(await input.request({ method: 'GET',
    path: DISCUSSION_HTTP_PATHS_V1.participants.replace(':discussionId', encodeURIComponent(args.discussionId)) })) : null;
  input.signal?.throwIfAborted();
  if (roster && roster.discussionId !== args.discussionId) throw Object.assign(new Error('discussion_not_found'), { code: 'discussion_not_found' });
  let candidates: Parameters<typeof projectDiscussionInviteCandidatesV1>[0]['candidates'];
  const sessionAccess = new Map<string, Pick<SessionEffectiveAccessV1, 'capabilities'>>();
  let nextCursor: string | null = null;
  if (args.source === 'people') {
    const page = UsersSearchResponseSchema.parse(await input.request({ method: 'GET', path: bindDiscussionCandidatePeopleReadV1(args) }));
    nextCursor = page.nextCursor ?? null;
    candidates = page.users.map(profile => ({ kind: 'account' as const,
      participant: { kind: 'account' as const, accountId: profile.id },
      profile: SessionAccessAccountSummaryV1Schema.parse({ kind: 'account', accountId: profile.id,
        name: profile.name, username: profile.username, firstName: profile.firstName, lastName: profile.lastName,
        avatarUrl: profile.avatar?.url ?? null }) }));
  } else if (args.source === 'sessions') {
    const page = SessionListQueryResponseV1Schema.parse(await input.request({ method: 'POST', path: '/v2/sessions/query',
      body: projectDiscussionCandidateSessionQueryV1(args) }));
    nextCursor = page.nextCursor;
    for (const row of page.sessions) sessionAccess.set(row.id, row.effectiveAccess);
    candidates = page.sessions.map(row => ({ kind: 'session' as const,
      selection: { kind: 'session' as const, session: { serverId: input.scope.serverId, sessionId: row.id } }, label: null }));
  } else {
    candidates = args.options.map(option => ({ kind: 'model' as const, selection: option.selection, label: option.label,
      availability: option.readiness ?? null, repair: option.repair ?? null }));
  }
  input.signal?.throwIfAborted();
  return DiscussionCandidatesListResultV1Schema.parse({ v: 1, serverId: input.scope.serverId, source: args.source,
    candidates: projectDiscussionInviteCandidatesV1({ scope: input.scope, candidates, roster, sessionAccess,
      isSameHome: input.isSameHome }), nextCursor });
}
