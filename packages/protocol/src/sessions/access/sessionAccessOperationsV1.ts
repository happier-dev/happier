import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { TeamCredentialRouteV1Schema } from '../../teams/credentials/resourceV1.js';
import { PrincipalRefV1Schema, TeamPrincipalRefV1Schema, GroupPrincipalRefV1Schema } from '../../teams/principal.js';
import { SessionAccessGrantV1Schema, SessionAccessLevelV1Schema, SessionGrantMutationV1Schema, type SessionAccessLevelV1 } from './sessionAccessGrantV1.js';
import { SessionAccessAccountSummaryV1Schema } from './sessionAccessPrincipalV1.js';
import { TeamExternalSharingPolicyV1Schema } from '../../teams/team.js';
import {
  gainsSessionAccessDelegationCapabilityV1,
  SessionEffectiveAccessV1Schema,
  type SessionAccessGrantCapabilityValueV1,
} from './sessionEffectiveAccessV1.js';
import {
  SESSION_RESPONSIBILITY_ASSIGNEE_UNAVAILABLE_V1,
  SESSION_RESPONSIBILITY_CANDIDATES_INVALID_CURSOR_V1,
} from './sessionResponsibilityV1.js';

export const SessionAccessErrorCodeV1Schema = lazyZodSchema(() => z.enum([
  'session_access_forbidden', 'session_access_session_not_found',
  'session_access_subject_not_found', 'session_access_subject_ineligible',
  'session_access_owner_grant_invalid', 'session_access_self_grant_invalid',
  'session_access_permission_delegation_forbidden', 'session_access_permission_delegation_requires_edit',
  'session_access_team_policy_required',
  'session_initial_access_creator_mismatch',
  'session_access_authentication_required',
  'session_access_authentication_unavailable',
  'session_access_external_sharing_requires_team_admin',
  'session_access_external_sharing_disabled',
  // The exact Home's `sharing.session` decision is not enabled, so it serves no
  // access-bearing operation. A Home configuration answer, never an update requirement.
  'session_access_sharing_unavailable',
  'session_access_invalid_recipient_envelope',
  SESSION_RESPONSIBILITY_ASSIGNEE_UNAVAILABLE_V1,
  SESSION_RESPONSIBILITY_CANDIDATES_INVALID_CURSOR_V1,
  'invalid_request', 'data_key_not_required',
  'recipient_envelope_required', 'recipient_key_unavailable',
]));
export type SessionAccessErrorCodeV1 = z.infer<typeof SessionAccessErrorCodeV1Schema>;

export const SessionAccessPrincipalSummaryV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  SessionAccessAccountSummaryV1Schema,
  TeamPrincipalRefV1Schema.extend({ name: z.string() }).strict(),
  GroupPrincipalRefV1Schema.extend({ name: z.string(), teamName: z.string() }).strict(),
]));
export type SessionAccessPrincipalSummaryV1 = z.infer<typeof SessionAccessPrincipalSummaryV1Schema>;

export const ResolveSessionAccessPrincipalsRequestV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  subjects: z.array(PrincipalRefV1Schema),
  /** Optional primary-Team decision needed by a restored New Session draft. */
  creationTeamId: z.string().min(1).optional(),
}).strict());
export type ResolveSessionAccessPrincipalsRequestV1 = z.infer<typeof ResolveSessionAccessPrincipalsRequestV1Schema>;

/**
 * The server-owned creation facts for one primary Team. This is deliberately a
 * narrow projection: the draft needs the already-admitted default/floor and
 * display identity, not a second copy of Team policy or a Team directory.
 */
export const SessionAccessCreationDecisionV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: z.string().min(1),
  teamName: z.string(),
  requiredByPolicy: z.boolean(),
  defaultGrant: z.object({ accessLevel: SessionAccessLevelV1Schema, canApprovePermissions: z.boolean() }).strict().nullable(),
  externalSharingPolicy: TeamExternalSharingPolicyV1Schema,
}).strict());
export type SessionAccessCreationDecisionV1 = z.infer<typeof SessionAccessCreationDecisionV1Schema>;

export const ResolveSessionAccessPrincipalsResponseV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  principals: z.array(SessionAccessPrincipalSummaryV1Schema),
  creationDecision: SessionAccessCreationDecisionV1Schema.nullable().optional(),
}).strict());
export type ResolveSessionAccessPrincipalsResponseV1 = z.infer<typeof ResolveSessionAccessPrincipalsResponseV1Schema>;

export const SessionAccessGrantTransitionsV1Schema = lazyZodSchema(() => z.object({
  accessLevels: z.array(SessionAccessLevelV1Schema),
  canChangePermissionDelegation: z.boolean(),
  canRemove: z.boolean(),
  reason: SessionAccessErrorCodeV1Schema.optional(),
}).strict());
export type SessionAccessGrantTransitionsV1 = z.infer<typeof SessionAccessGrantTransitionsV1Schema>;

const SESSION_ACCESS_LEVEL_ORDER: readonly SessionAccessLevelV1[] = SessionAccessLevelV1Schema.options;

/**
 * A grant increase is any transition that admits more access than the stored
 * grant: a first grant, a higher level, or newly gained permission delegation.
 * Tightening or withdrawing is never an increase, so it stays available under a
 * policy that has since become more restrictive.
 */
export function isSessionAccessGrantIncreaseV1(
  previous: SessionAccessGrantCapabilityValueV1 | null,
  next: SessionAccessGrantCapabilityValueV1,
): boolean {
  if (previous === null) return true;
  return SESSION_ACCESS_LEVEL_ORDER.indexOf(next.accessLevel) > SESSION_ACCESS_LEVEL_ORDER.indexOf(previous.accessLevel)
    || (!previous.canApprovePermissions && next.canApprovePermissions);
}

export type SessionAccessGrantTransitionsInputV1 = Readonly<{
  current: SessionAccessGrantCapabilityValueV1;
  /** The actor holds `managePermissionDelegation`, so transitions that create it are offered. */
  canDelegate: boolean;
  /** A Team-policy floor cannot be weakened to `view` or removed while the policy still requires it. */
  requiredByTeamPolicy: boolean;
  /**
   * The subject failed grant eligibility for a *change*: no level or delegation
   * transition is offered and the code explains why. It says nothing about
   * removal — the writer deliberately admits withdrawing a retained grant after
   * its subject is archived or deactivated, so `removalIneligible` carries that
   * separate verdict rather than this one standing in for it.
   */
  ineligible?: SessionAccessErrorCodeV1;
  /**
   * The subject fails eligibility even for removal — an identity the grant
   * writer refuses outright (an owner/self direct grant, a missing subject, a
   * Group whose claimed parent Team is not its own). Offering removal here would
   * be an affordance the writer rejects.
   */
  removalIneligible?: SessionAccessErrorCodeV1;
  /** The primary Team's external-sharing policy refuses this external subject any increase. */
  externalSharing?: SessionAccessErrorCodeV1;
}>;

/**
 * The one projection of which grant transitions a write would admit.
 *
 * Every input is a verdict already owned elsewhere (eligibility, Team-policy floor,
 * delegation authority, external-sharing policy); this function only composes them
 * into the affordances a client may offer, so a server inspection and a client
 * adapter for a released server cannot drift in what they let a manager attempt.
 */
export function projectSessionAccessGrantTransitionsV1(
  input: SessionAccessGrantTransitionsInputV1,
): SessionAccessGrantTransitionsV1 {
  const canRemove = !input.requiredByTeamPolicy && input.removalIneligible === undefined;
  if (input.ineligible) {
    return { accessLevels: [], canChangePermissionDelegation: false, canRemove, reason: input.ineligible };
  }
  const { current } = input;
  const admits = (next: SessionAccessGrantCapabilityValueV1) =>
    (input.canDelegate || !gainsSessionAccessDelegationCapabilityV1(current, next))
    && (!input.externalSharing || !isSessionAccessGrantIncreaseV1(current, next));
  const accessLevels = SESSION_ACCESS_LEVEL_ORDER.filter((accessLevel) =>
    (!input.requiredByTeamPolicy || accessLevel !== 'view' || current.accessLevel === 'view')
    && admits({ accessLevel, canApprovePermissions: accessLevel === 'view' ? false : current.canApprovePermissions }));
  const canChangePermissionDelegation = current.accessLevel !== 'view'
    && admits({ accessLevel: current.accessLevel, canApprovePermissions: !current.canApprovePermissions });
  const reason = input.externalSharing
    ?? (input.requiredByTeamPolicy ? ('session_access_team_policy_required' as const) : undefined);
  return {
    accessLevels,
    canChangePermissionDelegation,
    canRemove,
    ...(reason ? { reason } : {}),
  };
}

export const SessionAccessGrantRowV1Schema = lazyZodSchema(() => z.object({
  grant: SessionAccessGrantV1Schema,
  principal: SessionAccessPrincipalSummaryV1Schema,
  allowedTransitions: SessionAccessGrantTransitionsV1Schema,
}).strict());
export type SessionAccessGrantRowV1 = z.infer<typeof SessionAccessGrantRowV1Schema>;

export const SessionAccessGrantsListRequestV1Schema = lazyZodSchema(() => z.object({ sessionId: z.string().min(1) }).strict());
export type SessionAccessGrantsListRequestV1 = z.infer<typeof SessionAccessGrantsListRequestV1Schema>;

/**
 * One Team credential selection this Session keeps only while the named Team
 * still holds the standing it has now.
 *
 * `policy` says which standing: `team_visibility_required` ends when that Team's
 * grant is removed, `team_context_required` ends when the Session's context
 * moves off that Team. Carrying it lets one projection serve both edits without
 * either confirmation claiming a consequence the other one causes.
 *
 * It is a consequence preview, never an admission fact: the credential admission
 * repeats every decision in its own transaction and still fails closed. Only the
 * resource's display name travels, so an access edit can say what stops working
 * without disclosing the credential itself.
 */
export const SessionTeamCredentialBindingConsequenceV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
  teamId: z.string().min(1),
  displayName: z.string(),
  policy: z.enum(['team_visibility_required', 'team_context_required']),
}).strict());
export type SessionTeamCredentialBindingConsequenceV1 = z.infer<typeof SessionTeamCredentialBindingConsequenceV1Schema>;

const listFields = {
  owner: SessionAccessAccountSummaryV1Schema,
  effectiveAccess: SessionEffectiveAccessV1Schema,
  primaryTeamId: z.string().min(1).nullable(),
};
export const SessionAccessGrantsListResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('visibility', [
  z.object({
    ...listFields,
    visibility: z.literal('complete'),
    grants: z.array(SessionAccessGrantRowV1Schema),
    // Manager-only, and absent on a Home that publishes no consequence preview.
    // A viewer who cannot manage access can neither remove a grant nor change
    // the context, so the `self` projection carries nothing to preview.
    credentialBindingConsequences: z.array(SessionTeamCredentialBindingConsequenceV1Schema).optional(),
  }).strict(),
  z.object({ ...listFields, visibility: z.literal('self'), grants: z.tuple([]) }).strict(),
]));
export type SessionAccessGrantsListResponseV1 = z.infer<typeof SessionAccessGrantsListResponseV1Schema>;

/** Admission condition for explicitly consented Run credential visibility. */
export const RequiredSessionTeamCredentialV1Schema = lazyZodSchema(() => z.object({
  resourceId: z.string().min(1),
  expectedResourceRevision: z.number().int().nonnegative(),
  deliveryMode: TeamCredentialRouteV1Schema,
}).strict());
export type RequiredSessionTeamCredentialV1 = z.infer<typeof RequiredSessionTeamCredentialV1Schema>;

export const SetSessionAccessGrantRequestV1Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1),
  ...SessionGrantMutationV1Schema.options[0].shape,
  subject: PrincipalRefV1Schema,
  requiredTeamCredential: RequiredSessionTeamCredentialV1Schema.optional(),
}).strict().superRefine(({ sessionId: _sessionId, requiredTeamCredential: _requiredTeamCredential, ...grant }, ctx) => {
  const parsed = SessionGrantMutationV1Schema.safeParse(grant);
  if (!parsed.success) for (const issue of parsed.error.issues) {
    ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  }
}));
export type SetSessionAccessGrantRequestV1 = z.infer<typeof SetSessionAccessGrantRequestV1Schema>;
export const SetSessionAccessGrantResponseV1Schema = lazyZodSchema(() => z.object({
  changed: z.boolean(), grant: SessionAccessGrantV1Schema,
}).strict());
export type SetSessionAccessGrantResponseV1 = z.infer<typeof SetSessionAccessGrantResponseV1Schema>;

export const RemoveSessionAccessGrantRequestV1Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1), subject: PrincipalRefV1Schema,
}).strict());
export type RemoveSessionAccessGrantRequestV1 = z.infer<typeof RemoveSessionAccessGrantRequestV1Schema>;
export const RemoveSessionAccessGrantResponseV1Schema = lazyZodSchema(() => z.object({
  changed: z.boolean(), subject: PrincipalRefV1Schema,
}).strict());
export type RemoveSessionAccessGrantResponseV1 = z.infer<typeof RemoveSessionAccessGrantResponseV1Schema>;

export const SetSessionAccessContextRequestV1Schema = lazyZodSchema(() => z.object({
  sessionId: z.string().min(1), primaryTeamId: z.string().min(1).nullable(),
}).strict());
export type SetSessionAccessContextRequestV1 = z.infer<typeof SetSessionAccessContextRequestV1Schema>;
export const SetSessionAccessContextResponseV1Schema = lazyZodSchema(() => z.object({
  changed: z.boolean(), primaryTeamId: z.string().min(1).nullable(),
}).strict());
export type SetSessionAccessContextResponseV1 = z.infer<typeof SetSessionAccessContextResponseV1Schema>;
