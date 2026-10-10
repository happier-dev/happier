import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';

import { ImageRefSchema } from '../common/imageRef.js';
import { decodeBase64, encodeBase64 } from '../crypto/base64.js';
import {
  SessionHistoryAccessSchema,
  TeamIdSchema,
  TeamRoleSchema,
} from './membership.js';
import {
  TeamInvitationTokenV1Schema,
  type TeamInvitationTokenV1,
} from './invitationToken.js';
import {
  decodeTeamKeysetCursorV1,
  encodeTeamKeysetCursorV1,
  readTeamKeysetIdV1,
  readTeamKeysetTimeV1,
} from './cursor.js';

export {
  TEAM_INVITATION_TOKEN_LENGTH,
  TeamInvitationTokenV1Schema,
  type TeamInvitationTokenV1,
} from './invitationToken.js';

/**
 * One Team invitation is an offer to create one canonical `TeamMembership`.
 *
 * It is not a Home credential, a Team-scoped login, a placeholder membership, or a
 * generic bearer-capability framework. Everything here is transport and projection
 * vocabulary; the deciding transaction lives on the Home that owns the Team.
 */

/**
 * The ratified seven-day lifetime. Expiry is a bounded credential-security policy,
 * so it is one code-owned constant rather than an operator policy language or a
 * per-invitation TTL control. Reissue mints a fresh seven-day invitation.
 */
export const TEAM_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const TeamInvitationIdSchema = lazyZodSchema(() => z.string().min(1));

/**
 * Owner is absent by construction: owner promotion stays an explicit post-membership
 * governance operation with last-owner enforcement, so no link can mint one.
 */
export const TeamInvitationAdmissibleRoleV1Schema = lazyZodSchema(() => z.enum(['admin', 'member', 'guest']));
export type TeamInvitationAdmissibleRoleV1 = z.infer<typeof TeamInvitationAdmissibleRoleV1Schema>;

/** State is derived from timestamps; no second stored status machine exists. */
export const TeamInvitationStateV1Schema = lazyZodSchema(() => z.enum(['active', 'accepted', 'revoked', 'expired']));
export type TeamInvitationStateV1 = z.infer<typeof TeamInvitationStateV1Schema>;

export const TeamInvitationEmailDeliveryStatusV1Schema = lazyZodSchema(() => z.enum(['sent', 'failed']));

/**
 * The entire reloadable delivery history. `null` means no attempt result was
 * recorded and, after a crash, does not prove that no provider received the mail.
 * `sent` means the mail boundary accepted submission, never inbox delivery.
 */
export const TeamInvitationEmailDeliveryV1Schema = lazyZodSchema(() => z.object({
  status: TeamInvitationEmailDeliveryStatusV1Schema,
  attemptedAt: z.number().int(),
}).strict());
export type TeamInvitationEmailDeliveryV1 = z.infer<typeof TeamInvitationEmailDeliveryV1Schema>;

export type TeamInvitationTimestampsV1 = Readonly<{
  acceptedAt: number | null;
  revokedAt: number | null;
  expiresAt: number;
}>;

/**
 * The single derivation of invitation state, shared by server projections and client
 * rendering so a row cannot mean one thing on each side.
 *
 * Acceptance stays authoritative over a later revocation and over expiry: the
 * membership it produced is real, and presenting that row as revoked or expired would
 * misdescribe governance provenance.
 */
export function deriveTeamInvitationStateV1(
  timestamps: TeamInvitationTimestampsV1,
  nowMs: number,
): TeamInvitationStateV1 {
  if (timestamps.acceptedAt !== null) return 'accepted';
  if (timestamps.revokedAt !== null) return 'revoked';
  if (timestamps.expiresAt <= nowMs) return 'expired';
  return 'active';
}

/**
 * Masks the recipient so a manager list and an unauthenticated preview can identify
 * the intended person without republishing a full address to a link holder.
 */
export function maskTeamInvitationRecipientEmail(normalizedEmail: string | null): string | null {
  if (normalizedEmail === null) return null;
  const separator = normalizedEmail.lastIndexOf('@');
  if (separator <= 0) return '•••';
  const local = normalizedEmail.slice(0, separator);
  const domain = normalizedEmail.slice(separator);
  return local.length <= 1 ? `•••${domain}` : `${local[0]}•••${domain}`;
}

/**
 * The manager-visible invitation row. It is closed and carries no bearer field, so a
 * lost create response can never be answered by replaying a stored plaintext token.
 */
export const TeamInvitationRowV1Schema = lazyZodSchema(() => z.object({
  id: TeamInvitationIdSchema,
  teamId: TeamIdSchema,
  state: TeamInvitationStateV1Schema,
  role: TeamInvitationAdmissibleRoleV1Schema,
  historyAccess: SessionHistoryAccessSchema,
  recipientEmailMask: z.string().nullable(),
  expiresAt: z.number().int(),
  createdAt: z.number().int(),
  createdByAccountId: z.string().nullable(),
  acceptedByAccountId: z.string().nullable(),
  lastEmailDelivery: TeamInvitationEmailDeliveryV1Schema.nullable(),
}).strict());
export type TeamInvitationRowV1 = z.infer<typeof TeamInvitationRowV1Schema>;

/**
 * The bounded pre-authentication preview. It identifies the Home, the Team and the
 * person who invited you, and states the offered consequences; it omits the roster,
 * provider bindings, the raw or digested token, and every actor identifier. Preview
 * never consumes anything.
 */
export const TeamInvitationPreviewV1Schema = lazyZodSchema(() => z.object({
  home: z.object({
    serverId: z.string().min(1),
    /**
     * The Home's own published name. `null` means this Home publishes none yet:
     * the join screen then identifies the Home by its canonical address instead
     * of substituting the application origin, the inviter, or a guessed label,
     * none of which are the Home authority.
     */
    displayName: z.string().min(1).nullable(),
    /**
     * The effective storage disclosure, owned by the Homes storage/method policy
     * projection. `null` means this Home does not publish one yet: the join screen
     * then shows no disclosure rather than asserting a mode it cannot substantiate.
     */
    storageMode: z.enum(['plain', 'encrypted']).nullable(),
    /**
     * Who runs this Home, read from the runtime's own published purpose.
     * `personal` is a Home running on somebody's own computer, which is the one
     * consequence a person has to know before joining: it can be offline. A Home
     * that publishes no purpose is `null` and the join screen says nothing rather
     * than inferring hosting from a URL, a storage mode or the focused Home.
     *
     * Additive: a Home that predates this field simply omits it and reads as the
     * same "publishes no hosting" answer.
     */
    hosting: z.enum(['personal', 'shared']).nullable().optional().default(null),
  }).strict(),
  team: z.object({
    teamId: TeamIdSchema,
    name: z.string(),
    logo: ImageRefSchema.nullable(),
    /** Deterministic accent source; the Team id itself, never a persisted color. */
    accentSeed: z.string().min(1),
  }).strict(),
  role: TeamInvitationAdmissibleRoleV1Schema,
  historyAccess: SessionHistoryAccessSchema,
  state: TeamInvitationStateV1Schema,
  expiresAt: z.number().int(),
  recipientEmailMask: z.string().nullable(),
  /**
   * The inviter's short display label, the same one the invitation email already
   * shows this person. It is the whole disclosure: never an Account id, an
   * address, or any other actor field, so the preview still identifies nobody it
   * can be used to look up. `null` when the inviter's Account no longer resolves
   * or carries no name of its own, and the join screen then says nothing rather
   * than substituting the Team, the Home or a placeholder.
   *
   * Additive: a Home that predates this field simply omits it and reads as the
   * same "says nothing" answer.
   */
  inviterLabel: z.string().min(1).nullable().optional().default(null),
}).strict());
export type TeamInvitationPreviewV1 = z.infer<typeof TeamInvitationPreviewV1Schema>;

/** Bounded so an oversized address cannot become an unbounded lookup or log line. */
const RecipientEmailInputSchema = lazyZodSchema(() => z.string().min(3).max(320).nullable());

/**
 * `requestKey` reuses the existing domain idempotency composition: a retried create
 * returns the committed invitation's safe metadata rather than minting a second live
 * bearer. A reused key with different intent conflicts.
 */
export const TeamInvitationCreateInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  role: TeamInvitationAdmissibleRoleV1Schema,
  historyAccess: SessionHistoryAccessSchema,
  recipientEmail: RecipientEmailInputSchema,
  requestKey: z.string().min(1).max(200),
}).strict().superRefine((input, context) => {
  if (input.role === 'guest' && input.historyAccess !== 'from_membership') {
    context.addIssue({
      code: 'custom',
      path: ['historyAccess'],
      message: 'Guest invitations begin at membership time',
    });
  }
}));
export type TeamInvitationCreateInputV1 = z.infer<typeof TeamInvitationCreateInputV1Schema>;

export const TeamInvitationListInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  /** Absent means every retained state, including terminal governance provenance. */
  state: TeamInvitationStateV1Schema.nullable(),
  cursor: z.string().min(1).nullable(),
  limit: z.number().int().min(1).max(100),
}).strict());
export type TeamInvitationListInputV1 = z.infer<typeof TeamInvitationListInputV1Schema>;

/**
 * Invitation pages are ordered by immutable creation time and id. The query key
 * binds the position to the exact Team and derived state filter that produced it.
 */
export function teamInvitationsQueryKeyV1(input: Pick<TeamInvitationListInputV1, 'teamId' | 'state'>): string {
  return `v1:invitations:${input.teamId}:${input.state ?? 'all'}`;
}

export type TeamInvitationsCursorV1 = Readonly<{ createdAt: number; id: string }>;

export type TeamInvitationsCursorDecodeV1 =
  | Readonly<{ status: 'ok'; cursor: TeamInvitationsCursorV1 }>
  | Readonly<{ status: 'invalid' }>;

export function encodeTeamInvitationsCursorV1(input: Readonly<{
  queryKey: string;
  createdAt: number;
  id: string;
}>): string {
  return encodeTeamKeysetCursorV1({ queryKey: input.queryKey, parts: [input.createdAt, input.id] });
}

export function decodeTeamInvitationsCursorV1(value: string, queryKey: string): TeamInvitationsCursorDecodeV1 {
  const decoded = decodeTeamKeysetCursorV1(value, queryKey);
  if (decoded.status !== 'ok') return { status: 'invalid' };
  const createdAt = readTeamKeysetTimeV1(decoded.parts[0]);
  const id = readTeamKeysetIdV1(decoded.parts[1]);
  if (createdAt === null || id === null) return { status: 'invalid' };
  return { status: 'ok', cursor: { createdAt, id } };
}

export const TeamInvitationRevokeInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  invitationId: TeamInvitationIdSchema,
}).strict());
export type TeamInvitationRevokeInputV1 = z.infer<typeof TeamInvitationRevokeInputV1Schema>;

/**
 * Reissue conditionally revokes the current active invitation and creates a fresh one
 * with copied intent in the same transaction, optionally replacing the recipient
 * constraint. Retry and Change email are the same operation with different inputs.
 */
export const TeamInvitationReissueInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  invitationId: TeamInvitationIdSchema,
  /**
   * `null` is Retry: the same offer to the same person, so the invitation's
   * existing recipient constraint is preserved. A value is Change email and
   * replaces it. Retry deliberately cannot widen an email-bound invitation into
   * a transferable one — that is a different intent and has no input here.
   */
  recipientEmail: RecipientEmailInputSchema,
  requestKey: z.string().min(1).max(200),
}).strict());
export type TeamInvitationReissueInputV1 = z.infer<typeof TeamInvitationReissueInputV1Schema>;

/** Preview and accept receive the bearer in a strict versioned body, never in a URL. */
export const TeamInvitationPreviewInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  token: TeamInvitationTokenV1Schema,
}).strict());

export const TeamInvitationPostAuthContinuationV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal('post_auth_invitation'),
  reference: z.string().trim().min(8).max(256),
  teamId: TeamIdSchema,
}).strict());
export type TeamInvitationPostAuthContinuationV1 = z.infer<
  typeof TeamInvitationPostAuthContinuationV1Schema
>;

export const TeamInvitationAcceptInputV1Schema = lazyZodSchema(() => z.union([
  z.object({ v: z.literal(1), token: TeamInvitationTokenV1Schema }).strict(),
  z.object({
    v: z.literal(1),
    continuation: TeamInvitationPostAuthContinuationV1Schema,
  }).strict(),
]));

/**
 * Host-internal preparation for a deferred invitation acceptance.
 *
 * The authenticated Home exchanges the one-time bearer for the existing
 * Account-bound post-auth continuation before an Approval Artifact is written.
 * The result deliberately carries only the continuation and the same bounded
 * public preview; it never returns the bearer or its digest.
 */
export const TeamInvitationAcceptApprovalPrepareInputV1Schema = TeamInvitationPreviewInputV1Schema;
export const TeamInvitationAcceptApprovalPrepareResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('ok'),
    continuation: TeamInvitationPostAuthContinuationV1Schema,
    preview: TeamInvitationPreviewV1Schema,
  }).strict(),
  z.object({ outcome: z.literal('unavailable') }).strict(),
]));
export type TeamInvitationAcceptApprovalPrepareResultV1 = z.infer<
  typeof TeamInvitationAcceptApprovalPrepareResultV1Schema
>;

/**
 * `joinUrl` is the one confined delivery of the raw bearer to an authorized human
 * manager. It is explicitly `null` for an email-bound invitation, whose bearer reaches
 * only the mail boundary, and for any egress-restricted automated caller. It is
 * required rather than optional so omission is a deliberate, visible decision.
 */
export const TeamInvitationCreateResultV1Schema = lazyZodSchema(() => z.object({
  invitation: TeamInvitationRowV1Schema,
  joinUrl: z.string().min(1).nullable(),
}).strict());
export type TeamInvitationCreateResultV1 = z.infer<typeof TeamInvitationCreateResultV1Schema>;

/**
 * Every authenticated terminal state stays distinguishable so the join screen can
 * offer one useful next action instead of a generic error. `joined` and
 * `already_member` return the Team so the client can offer the explicit Open Team
 * transition without a second lookup.
 */
/**
 * Whether this Home can currently deliver an invitation by mail.
 *
 * Delivery needs two things that are separately unavailable: a ready mail
 * boundary, and an application origin to render the link the mail must carry.
 * The Home resolves both, so a client never infers readiness from its own
 * origin, its focused Home, or the presence of an address field.
 *
 * This gates an *offer*, not an authorization: the create and reissue
 * transactions recheck it and refuse an undeliverable email-bound invitation
 * regardless of what any client rendered.
 */
export const TeamInvitationEmailDeliveryAvailabilityV1Schema = lazyZodSchema(() => z.enum([
  'available',
  'unavailable',
]));
export type TeamInvitationEmailDeliveryAvailabilityV1 =
  z.infer<typeof TeamInvitationEmailDeliveryAvailabilityV1Schema>;

/**
 * `teams.invitations.list`. The repository's public page convention over the
 * safe invitation row; the bearer never appears, so a manager can review
 * outstanding invitations without the secret being readable anywhere but its
 * one confined delivery at creation.
 *
 * `emailDelivery` and `linkDelivery` ride here rather than on the Team summary
 * because this is the one authenticated read that has already proved invitation
 * authority, and because both are Home facts that would otherwise be repeated on
 * every Team row. They are required rather than optional so a Home that cannot
 * answer is a visible omission instead of a silent "available".
 *
 * They are separate answers: a Home that has published no shareable join target
 * can neither render a link nor mail one, while a Home with a join target but no
 * mail boundary can still share a link. `linkDelivery: 'unavailable'` is the only
 * state in which a created invitation has no way to reach anyone, which is why
 * the surface must be able to say so instead of offering a link to reissue.
 */
export const TeamInvitationsPageV1Schema = lazyZodSchema(() => z.object({
  items: z.array(TeamInvitationRowV1Schema),
  nextCursor: z.string().nullable(),
  emailDelivery: TeamInvitationEmailDeliveryAvailabilityV1Schema,
  linkDelivery: TeamInvitationEmailDeliveryAvailabilityV1Schema,
}).strict());
export type TeamInvitationsPageV1 = z.infer<typeof TeamInvitationsPageV1Schema>;

/**
 * `teams.invitations.revoke`. Answering with the row the Team now holds keeps a
 * repeated revocation truthful — the caller sees the current terminal state
 * rather than an error that would read as "the revocation did not happen".
 */
export const TeamInvitationRevokeResultV1Schema = TeamInvitationRowV1Schema;
export type TeamInvitationRevokeResultV1 = z.infer<typeof TeamInvitationRevokeResultV1Schema>;

/**
 * `teams.invitations.reissue`. Retry and Change email are the same operation, so
 * the result names both halves explicitly: the invitation that stopped working
 * and the fresh one that replaced it. `joinUrl` follows the same confined-bearer
 * rule as creation and is `null` for an email-bound or egress-restricted caller.
 */
export const TeamInvitationReissueResultV1Schema = lazyZodSchema(() => z.object({
  previous: TeamInvitationRowV1Schema,
  replacement: TeamInvitationRowV1Schema,
  joinUrl: z.string().min(1).nullable(),
}).strict());
export type TeamInvitationReissueResultV1 = z.infer<typeof TeamInvitationReissueResultV1Schema>;

export const TeamInvitationAcceptResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('joined'), teamId: TeamIdSchema }).strict(),
  z.object({ outcome: z.literal('already_member'), teamId: TeamIdSchema }).strict(),
  z.object({ outcome: z.literal('not_found') }).strict(),
  z.object({ outcome: z.literal('expired') }).strict(),
  z.object({ outcome: z.literal('revoked') }).strict(),
  z.object({ outcome: z.literal('used') }).strict(),
  z.object({ outcome: z.literal('team_archived') }).strict(),
  z.object({ outcome: z.literal('account_inactive') }).strict(),
  z.object({ outcome: z.literal('email_mismatch') }).strict(),
  z.object({ outcome: z.literal('feature_unavailable') }).strict(),
]));
export type TeamInvitationAcceptResultV1 = z.infer<typeof TeamInvitationAcceptResultV1Schema>;

/**
 * The unauthenticated preview may intentionally collapse unknown and terminal states
 * when enumeration analysis requires it, so it has its own narrower result.
 */
export const TeamInvitationPreviewResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ok'), preview: TeamInvitationPreviewV1Schema }).strict(),
  z.object({ outcome: z.literal('unavailable') }).strict(),
  z.object({ outcome: z.literal('feature_unavailable') }).strict(),
]));
export type TeamInvitationPreviewResultV1 = z.infer<typeof TeamInvitationPreviewResultV1Schema>;

const TEAM_INVITATION_TARGET_BINDING_DOMAIN_V1 = new TextEncoder().encode(
  'happier.team-invitation.target-binding.v1',
);
const TEAM_INVITATION_TARGET_BINDING_BYTES_V1 = 32;

export const TeamInvitationTargetBindingV1Schema = lazyZodSchema(() => z.string().regex(
  /^[A-Za-z0-9_-]{43}$/u,
  'Expected an unpadded base64url SHA-256 binding',
));
export type TeamInvitationTargetBindingV1 = z.infer<typeof TeamInvitationTargetBindingV1Schema>;

function deriveTeamInvitationTargetBindingKeyV1(token: TeamInvitationTokenV1): Uint8Array {
  return hmac(
    sha256,
    new TextEncoder().encode(TeamInvitationTokenV1Schema.parse(token)),
    TEAM_INVITATION_TARGET_BINDING_DOMAIN_V1,
  );
}

function computeTeamInvitationTargetBindingBytesV1(input: Readonly<{
  token: TeamInvitationTokenV1;
  homeTarget: string;
}>): Uint8Array {
  return hmac(
    sha256,
    deriveTeamInvitationTargetBindingKeyV1(input.token),
    new TextEncoder().encode(input.homeTarget),
  );
}

/**
 * Authenticates the exact opaque Homes carrier before a Team consumer parses it.
 *
 * The invitation bearer deliberately remains transferable: anyone holding the
 * complete bearer can recompute this binding. The MAC prevents a party who can
 * rewrite only the public target from redirecting discovery or the later bearer;
 * it does not turn the descriptor or its public Home identity into a signature.
 */
export function createTeamInvitationTargetBindingV1(input: Readonly<{
  token: TeamInvitationTokenV1;
  homeTarget: string;
}>): TeamInvitationTargetBindingV1 {
  return TeamInvitationTargetBindingV1Schema.parse(encodeBase64(
    computeTeamInvitationTargetBindingBytesV1(input),
    'base64url',
  ));
}

/** Constant-time verification after strict canonical base64url decoding. */
export function verifyTeamInvitationTargetBindingV1(input: Readonly<{
  token: string;
  homeTarget: string;
  binding: string;
}>): boolean {
  const token = TeamInvitationTokenV1Schema.safeParse(input.token);
  const binding = TeamInvitationTargetBindingV1Schema.safeParse(input.binding);
  if (!token.success || !binding.success || typeof input.homeTarget !== 'string') return false;
  try {
    const received = decodeBase64(binding.data, 'base64url');
    if (
      received.length !== TEAM_INVITATION_TARGET_BINDING_BYTES_V1
      || encodeBase64(received, 'base64url') !== binding.data
    ) return false;
    const expected = computeTeamInvitationTargetBindingBytesV1({
      token: token.data,
      homeTarget: input.homeTarget,
    });
    let difference = 0;
    for (let index = 0; index < expected.length; index += 1) {
      difference |= received[index]! ^ expected[index]!;
    }
    return difference === 0;
  } catch {
    return false;
  }
}

export type BuildTeamJoinUrlInput = Readonly<{
  /** Configured application origin. It is a renderer, never the Home authority. */
  applicationOrigin: string;
  token: TeamInvitationTokenV1;
  /**
   * The opaque explicit-Home target carrier produced by the Homes link owner. It is
   * nonsecret and survives log redaction so an operator can still tell which Home a
   * redacted link addressed. A join link without this carrier is not portable and
   * must not be issued.
   */
  homeTarget: string;
}>;

/**
 * Composes the one Team join link shape: the bearer in the path, the Home target in
 * the query.
 *
 * This is a thin wrapper over the Homes-owned explicit-target carrier, not a second
 * link codec: it neither encodes nor parses the descriptor, and the value must come
 * from the Homes producer. Keeping the bearer in the path is what lets the shared
 * capability redactor template it in server logs, Fastify errors, Sentry, and client
 * navigation logging.
 */
export function buildTeamJoinUrl(input: BuildTeamJoinUrlInput): string {
  const token = TeamInvitationTokenV1Schema.parse(input.token);
  const base = teamPublicLinkBase(input.applicationOrigin, 'Team join URL');
  const target = portableHomeTargetOrThrow(input.homeTarget, 'Team join URL');
  const targetBinding = createTeamInvitationTargetBindingV1({ token, homeTarget: target });
  return `${base}/join/${token}?target=${encodeURIComponent(target)}&targetBinding=${targetBinding}`;
}

export type BuildTeamMemberSignInUrlInput = Readonly<{
  /** Configured application origin. It is a renderer, never the Home authority. */
  applicationOrigin: string;
  /** Umbrella L03-R15: Team links address the immutable Team id, never a slug. */
  teamId: string;
  /** The same nonsecret explicit-Home carrier a join link uses. */
  homeTarget: string;
}>;

/**
 * Composes the one ordinary member sign-in link for a Team.
 *
 * This is the join link's sibling, not a second link codec: the same Homes-owned
 * explicit-target carrier decides which Home the page talks to, so a member link
 * and an invitation link resolve to the identical Home. The difference is what
 * the path carries — an invitation carries a live bearer, and an ordinary member
 * link deliberately carries none, so it is safe to publish in an internal wiki
 * or hand out at a desk without granting anything.
 */
export function buildTeamMemberSignInUrl(input: BuildTeamMemberSignInUrlInput): string {
  const teamId = typeof input.teamId === 'string' ? input.teamId.trim() : '';
  if (teamId.length === 0) {
    throw new Error('Team member sign-in URL requires a Team');
  }
  const base = teamPublicLinkBase(input.applicationOrigin, 'Team member sign-in URL');
  const target = portableHomeTargetOrThrow(input.homeTarget, 'Team member sign-in URL');
  return `${base}/teams/${encodeURIComponent(teamId)}/sign-in?target=${encodeURIComponent(target)}`;
}

/** The renderer origin, rejected outright when it already carries authority. */
function teamPublicLinkBase(applicationOrigin: string, label: string): string {
  const origin = new URL(applicationOrigin);
  if (origin.username || origin.password) {
    throw new Error(`${label} origin must not carry credentials`);
  }
  if (origin.search || origin.hash) {
    throw new Error(`${label} origin must not carry a query or fragment`);
  }
  return `${origin.origin}${origin.pathname.replace(/\/+$/, '')}`;
}

/** A link without the portable carrier only works on devices that already know the Home. */
function portableHomeTargetOrThrow(homeTarget: string, label: string): string {
  if (typeof homeTarget !== 'string' || homeTarget.trim().length === 0) {
    throw new Error(`${label} requires a portable Home target`);
  }
  return homeTarget;
}
