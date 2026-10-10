import { z } from 'zod';

import { AccountDisplayProfileV1Schema } from '../account/accountDisplayProfileV1.js';
import { AccountEncryptionModeSchema } from '../features/payload/capabilities/encryptionCapabilities.js';
import {
  FEATURES_RESPONSE_MAX_UTF8_BYTES_V1,
  HomeSignInServicePolicyV1Schema,
} from '../features/payload/featuresResponseSchema.js';
import { TeamInvitationPostAuthContinuationV1Schema, TeamInvitationPreviewV1Schema, TeamInvitationTokenV1Schema } from '../teams/invitation.js';
import { TeamIdentityProviderKindV1Schema } from '../teams/identity/connection.js';
import { AuthEntryMethodIdV1Schema } from './methodId.js';
import { NativeAuthOneTimeBearerV1Schema } from './nativeAuthOneTimeOperation.js';
import { normalizeVerifiedEmail } from './verifiedEmail.js';

export * from './teamAuthenticationPolicy.js';
export { AuthEntryMethodIdV1Schema } from './methodId.js';

/** The shared public pre-auth metadata resource ceiling. */
export const AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1 = FEATURES_RESPONSE_MAX_UTF8_BYTES_V1;
const AUTH_ENTRY_UTF8_ENCODER = new TextEncoder();

function boundedAuthEntryString(schema: z.ZodString): z.ZodType<string> {
  return schema
    .max(AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1)
    .superRefine((value, context) => {
      if (AUTH_ENTRY_UTF8_ENCODER.encode(value).byteLength > AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Auth entry string exceeds response byte budget' });
      }
    });
}


const HomeAuthEntryScopeV1Schema = z.object({ kind: z.literal('home') }).strict();
const TeamAuthEntryRequestScopeV1Schema = z.object({
  kind: z.literal('team'),
  teamId: TeamInvitationPreviewV1Schema.shape.team.shape.teamId,
}).strict();
const TeamAuthEntryProjectionScopeV1Schema = z.object({ kind: z.literal('team') }).strict();
const InvitationAuthEntryRequestScopeV1Schema = z.union([z.object({
  kind: z.literal('invitation'),
  token: TeamInvitationTokenV1Schema,
}).strict(), z.object({
  kind: z.literal('invitation'),
  continuation: TeamInvitationPostAuthContinuationV1Schema,
}).strict()]);
const NativeEmailVerificationAuthEntryRequestScopeV1Schema = z.object({
  kind: z.literal('native_email_verification'),
  token: NativeAuthOneTimeBearerV1Schema,
}).strict();
const InvitationAuthEntryProjectionScopeV1Schema = z.object({ kind: z.literal('invitation') }).strict();

export const AuthEntryRequestV1Schema = z.union([
  z.object({
    v: z.literal(1),
    scope: HomeAuthEntryScopeV1Schema,
    purpose: z.enum(['home', 'account_service']).optional(),
    /** Syntax-only company routing hint; never Account identity or admission evidence. */
    email: z.string().refine((value) => normalizeVerifiedEmail(value) !== null).optional(),
  }).strict(),
  z.object({
    v: z.literal(1),
    scope: TeamAuthEntryRequestScopeV1Schema,
    purpose: z.literal('home').optional(),
  }).strict(),
  z.object({
    v: z.literal(1),
    scope: InvitationAuthEntryRequestScopeV1Schema,
    purpose: z.literal('home').optional(),
  }).strict(),
  z.object({
    v: z.literal(1),
    scope: NativeEmailVerificationAuthEntryRequestScopeV1Schema,
    purpose: z.literal('home').optional(),
  }).strict(),
]);
export type AuthEntryRequestV1 = z.infer<typeof AuthEntryRequestV1Schema>;

/**
 * The safe public descriptor of one provider choice (teams-lane-03/01 §10.2).
 * These are the Home's own projected values: a client renders them and never
 * recreates or discards them for a dynamic provider. Internal catalog source,
 * ownership, revisions, secret health and permissions are never carried.
 */
export const AuthEntryProviderPresentationV1Schema = z.object({
  displayName: boundedAuthEntryString(z.string().trim().min(1)),
  iconHint: boundedAuthEntryString(z.string().trim().min(1)).nullable().optional(),
  /** Present only for an identity provider from the catalog; native methods have none. */
  providerKind: TeamIdentityProviderKindV1Schema.optional(),
  connectButtonColor: boundedAuthEntryString(z.string().trim().min(1)).nullable().optional(),
  supportsProfileBadge: z.boolean().optional(),
}).strict();
export type AuthEntryProviderPresentationV1 = z.infer<typeof AuthEntryProviderPresentationV1Schema>;

/**
 * Why an accepted provider choice cannot be used right now, said at the level a
 * public Team page may say it. It never names configuration, secrets or health.
 */
export const AuthEntryProviderUnavailableReasonV1Schema = z.enum([
  /** The administrator turned this sign-in off. */
  'provider_disabled',
  /** The administrator has not finished setting this sign-in up. */
  'provider_setup_incomplete',
  /** The Home cannot run this sign-in right now. */
  'provider_unavailable',
]);
export type AuthEntryProviderUnavailableReasonV1 = z.infer<typeof AuthEntryProviderUnavailableReasonV1Schema>;

/** An accepted provider choice shown, with its safe reason, but not startable. */
export const AuthEntryProviderUnavailableActionV1Schema = z.object({
  kind: z.literal('provider_unavailable'),
  methodId: AuthEntryMethodIdV1Schema,
  origin: z.enum(['home', 'team']),
  presentation: AuthEntryProviderPresentationV1Schema,
  reason: AuthEntryProviderUnavailableReasonV1Schema,
}).strict();

export const AuthEntryAuthenticationActionV1Schema = z.object({
  kind: z.literal('authenticate'),
  methodId: AuthEntryMethodIdV1Schema,
  action: z.enum(['login', 'provision', 'connect']),
  mode: z.enum(['keyed', 'keyless', 'either']),
  origin: z.enum(['home', 'team']),
  /**
   * The Home's own recommendation for a new Account's protection, carried only
   * on a `provision` action whose `mode` leaves the choice open. It is the
   * effective-method owner's answer (deployment default narrowed by the Home
   * governance document), so a chooser seeds from it instead of re-deriving a
   * default from the permitted set. Absent means the Home states no preference.
   */
  recommendedProvisionMode: AccountEncryptionModeSchema.nullable().optional(),
  /**
   * Carried only on the `email_password` `login` action, and only when this
   * server can mail a password-reset link right now. Absent means a
   * forgotten-password link cannot arrive, so a client must not offer it.
   * Mail availability is a deployment fact, never an Account fact.
   */
  passwordReset: z.literal('email').optional(),
  presentation: AuthEntryProviderPresentationV1Schema,
}).strict();

/**
 * The methodless control an already-admitted member gets instead of a login.
 * It carries no provider, mode, or membership fact: continuing re-asks the
 * canonical admission and authorization owners rather than replaying anything
 * this response said.
 */
export const AuthEntryContinueActionV1Schema = z.object({ kind: z.literal('continue') }).strict();

export const AuthEntryActionV1Schema = z.discriminatedUnion('kind', [
  AuthEntryAuthenticationActionV1Schema,
  AuthEntryContinueActionV1Schema,
  AuthEntryProviderUnavailableActionV1Schema,
  z.object({ kind: z.literal('switch_account') }).strict(),
]);
export type AuthEntryActionV1 = z.infer<typeof AuthEntryActionV1Schema>;

const InvitationAuthEntryActionV1Schema = z.discriminatedUnion('kind', [
  AuthEntryAuthenticationActionV1Schema,
  AuthEntryProviderUnavailableActionV1Schema,
  z.object({ kind: z.literal('switch_account') }).strict(),
]);

const AuthEntryAutoRedirectV1Schema = z.object({
  methodId: AuthEntryMethodIdV1Schema,
  action: z.enum(['login', 'provision']),
  mode: z.enum(['keyed', 'keyless', 'either']),
}).strict().nullable();

const HomeProjectionBaseV1Schema = z.object({
  v: z.literal(1),
  scope: HomeAuthEntryScopeV1Schema,
  signInService: HomeSignInServicePolicyV1Schema.optional(),
  autoRedirect: AuthEntryAutoRedirectV1Schema,
}).strict();

const HomeReadyProjectionV1Schema = HomeProjectionBaseV1Schema.extend({
  state: z.literal('ready'),
  actions: z.array(AuthEntryAuthenticationActionV1Schema).max(AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1),
});
const HomeTerminalProjectionV1Schema = HomeProjectionBaseV1Schema.extend({
  state: z.enum(['denied', 'unavailable', 'update_required']),
  reason: z.enum([
    'entry_not_available',
    'authentication_policy_unavailable',
    'client_update_required',
    'not_account_service',
  ]),
  autoRedirect: z.null(),
});

const InvitationAuthEntryTeamV1Schema = z.object({
  teamId: TeamInvitationPreviewV1Schema.shape.team.shape.teamId,
  name: boundedAuthEntryString(z.string().trim().min(1)),
  logo: TeamInvitationPreviewV1Schema.shape.team.shape.logo,
}).strict();

// Reuse the Home-owned invitation/join presentation verbatim. Auth entry must
// not invent another Home label or storage-mode projection.
const AuthEntryHomePresentationV1Schema = TeamInvitationPreviewV1Schema.shape.home;

const TeamReadyProjectionV1Schema = z.object({
  v: z.literal(1),
  state: z.literal('admission_required'),
  scope: TeamAuthEntryProjectionScopeV1Schema,
  home: AuthEntryHomePresentationV1Schema,
  account: AccountDisplayProfileV1Schema.optional(),
  team: InvitationAuthEntryTeamV1Schema,
  /**
   * Shares the invitation action union: signing in as the wrong Account is the
   * same dead end on a Team link as on an invitation, and `switch_account` is
   * the only remedy for it. A reader that predates this widening already
   * ignores every non-`authenticate` action here, so the offer simply does not
   * appear on it.
   */
  actions: z.array(InvitationAuthEntryActionV1Schema).max(AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1),
  signInService: HomeSignInServicePolicyV1Schema.optional(),
  autoRedirect: z.null(),
}).strict();

/**
 * The Team result for a caller whose own current credential already proves an
 * effective membership under the Team's current authentication policy.
 *
 * Only `continue` is valid here: offering a login to somebody already admitted
 * would be untruthful, and any richer payload would turn this public endpoint
 * into a membership oracle. Because the server only reaches this state for the
 * exact authenticated Account, an anonymous or restricted credential keeps
 * receiving the ordinary admission projection and learns nothing.
 */
const TeamAlreadyMemberProjectionV1Schema = z.object({
  v: z.literal(1),
  state: z.literal('already_member'),
  scope: z.union([
    TeamAuthEntryProjectionScopeV1Schema,
    InvitationAuthEntryProjectionScopeV1Schema,
  ]),
  home: AuthEntryHomePresentationV1Schema,
  account: AccountDisplayProfileV1Schema,
  team: InvitationAuthEntryTeamV1Schema,
  actions: z.tuple([AuthEntryContinueActionV1Schema]),
  autoRedirect: z.null(),
}).strict();

/**
 * Why a Team or invitation destination cannot be entered right now.
 *
 * `entry_not_available` stays the non-enumerating default: it is the answer for
 * anything a visitor must not be able to probe (a Team that may not exist, an
 * archived Team, an unreadable policy). The other reasons are only ever sent to
 * a request that already proved it may see this destination, so the client can
 * say what to do next instead of "not found". This enum is deliberately small
 * and additive: a reader that meets an unknown reason has no projection to
 * render, so producers only widen it together with the destination copy.
 */
const TeamEntryUnavailableReasonV1Schema = z.enum([
  'entry_not_available',
  /** The Team accepts only a sign-in method the visitor did not use. */
  'sso_required',
  /** The proven identity is not the one this destination expects. */
  'wrong_account',
  /** Directory-sourced access exists upstream but has not arrived yet. */
  'directory_delayed',
  /** The invitation itself is expired, revoked or already used. */
  'invitation_unavailable',
]);
export type TeamEntryUnavailableReasonV1 = z.infer<typeof TeamEntryUnavailableReasonV1Schema>;

const TeamUnavailableProjectionV1Schema = z.object({
  v: z.literal(1),
  state: z.literal('unavailable'),
  scope: TeamAuthEntryProjectionScopeV1Schema,
  reason: TeamEntryUnavailableReasonV1Schema,
  autoRedirect: z.null(),
}).strict();

const InvitationReadyProjectionV1Schema = z.object({
  v: z.literal(1),
  state: z.literal('admission_required'),
  scope: InvitationAuthEntryProjectionScopeV1Schema,
  home: AuthEntryHomePresentationV1Schema,
  account: AccountDisplayProfileV1Schema.optional(),
  team: InvitationAuthEntryTeamV1Schema,
  /** The same bounded offer, resolved without disclosing a held bearer. */
  preview: TeamInvitationPreviewV1Schema.optional(),
  actions: z.array(InvitationAuthEntryActionV1Schema).max(AUTH_ENTRY_RESPONSE_MAX_UTF8_BYTES_V1),
  /** Whether native fresh-Account provisioning must first prove mailbox control. */
  invitationEmailVerificationRequired: z.boolean(),
  /**
   * Present only when this invitation is email-bound and the request carried an
   * Account principal. This is a display/choice fact, not admission authority:
   * the acceptance transaction rechecks the invitation and either retains the
   * existing mailbox evidence or atomically attaches the invitation's exact
   * normalized recipient to the Account that wins the one-time bearer.
   */
  currentAccountRecipientStatus: z.enum(['already_verified', 'verification_required']).optional(),
  signInService: HomeSignInServicePolicyV1Schema.optional(),
  autoRedirect: z.null(),
}).strict();

const InvitationUnavailableProjectionV1Schema = z.object({
  v: z.literal(1),
  state: z.literal('unavailable'),
  scope: InvitationAuthEntryProjectionScopeV1Schema,
  reason: TeamEntryUnavailableReasonV1Schema,
  autoRedirect: z.null(),
}).strict();

export const AuthEntryProjectionV1Schema = z.union([
  HomeReadyProjectionV1Schema,
  HomeTerminalProjectionV1Schema,
  TeamReadyProjectionV1Schema,
  TeamAlreadyMemberProjectionV1Schema,
  TeamUnavailableProjectionV1Schema,
  InvitationReadyProjectionV1Schema,
  InvitationUnavailableProjectionV1Schema,
]);
export type AuthEntryProjectionV1 = z.infer<typeof AuthEntryProjectionV1Schema>;
