import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from "zod";

import { TeamIdSchema } from "../membership.js";
import { IdentityConnectionTestDiagnosticsV1Schema } from "../../identity/testDiagnostics.js";
import { HOME_IDENTITY_CONNECTION_USER_ACTION_IDS_V1, TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1 } from "./actionIds.js";
import { TeamIdentityConnectionIdSchema } from "./ids.js";
import { TeamAdmissionModeApplicabilityV1Schema } from "./admission.js";

const ExactIdSchema = lazyZodSchema(() => z.string().min(1).max(512));
const BoundedLabelSchema = lazyZodSchema(() => z.string().min(1).max(256));
const StringListSchema = lazyZodSchema(() => z.array(z.string().min(1).max(512)).max(500));

export const TeamIdentityProviderKindV1Schema = lazyZodSchema(() => z.enum([
  "oidc",
  "workos_sso",
  "github_app_identity",
]));
export type TeamIdentityProviderKindV1 = z.infer<typeof TeamIdentityProviderKindV1Schema>;

export { TeamIdentityConnectionIdSchema } from "./ids.js";

export const TeamIdentityConnectionExternalReferenceV1Schema = lazyZodSchema(() => z.discriminatedUnion("kind", [
  z.object({ v: z.literal(1), kind: z.literal("oidc") }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal("workos_sso"),
    organizationId: ExactIdSchema.nullable(),
    connectionId: ExactIdSchema.nullable(),
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal("github_app_identity"),
    installationId: ExactIdSchema,
  }).strict(),
]).superRefine((reference, ctx) => {
  if (
    reference.kind === "workos_sso"
    && reference.connectionId !== null
    && reference.organizationId === null
  ) {
    ctx.addIssue({ code: "custom", message: "A WorkOS SSO connection requires its organization" });
  }
}));
export type TeamIdentityConnectionExternalReferenceV1 = z.infer<typeof TeamIdentityConnectionExternalReferenceV1Schema>;

export const TeamIdentityOidcConnectionSettingsV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  kind: z.literal("oidc"),
  allowedUsers: StringListSchema,
  allowedEmailDomains: StringListSchema,
  groupsAny: StringListSchema,
  groupsAll: StringListSchema,
}).strict());
export type TeamIdentityOidcConnectionSettingsV1 = z.infer<typeof TeamIdentityOidcConnectionSettingsV1Schema>;

export const TeamIdentityConnectionSettingsV1Schema = lazyZodSchema(() => z.discriminatedUnion("kind", [
  TeamIdentityOidcConnectionSettingsV1Schema,
  z.object({ v: z.literal(1), kind: z.literal("workos_sso") }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal("github_app_identity"),
    organizationLogin: BoundedLabelSchema,
  }).strict(),
]));
export type TeamIdentityConnectionSettingsV1 = z.infer<typeof TeamIdentityConnectionSettingsV1Schema>;

export const TeamIdentityConnectionStateV1Schema = lazyZodSchema(() => z.enum([
  "unavailable",
  "prohibited",
  "not_configured",
  "setting_up",
  "connected",
  "needs_attention",
  "disabled",
]));
export type TeamIdentityConnectionStateV1 = z.infer<typeof TeamIdentityConnectionStateV1Schema>;

export const TeamIdentityWorkosPresentationV1Schema = lazyZodSchema(() => z.object({
  displayName: BoundedLabelSchema,
  strategy: BoundedLabelSchema,
  status: BoundedLabelSchema,
  lastCheckedAt: z.number().int(),
}).strict());

export const TeamIdentityConnectionObservationV1Schema = lazyZodSchema(() => z.discriminatedUnion("kind", [
  z.object({ v: z.literal(1), kind: z.literal("oidc") }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal("workos_sso"),
    presentation: TeamIdentityWorkosPresentationV1Schema.nullable(),
  }).strict(),
  z.object({ v: z.literal(1), kind: z.literal("github_app_identity") }).strict(),
]));
export type TeamIdentityConnectionObservationV1 = z.infer<typeof TeamIdentityConnectionObservationV1Schema>;

export const IdentityConnectionV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  id: TeamIdentityConnectionIdSchema,
  teamId: TeamIdSchema.nullable(),
  provider: z.object({
    id: ExactIdSchema,
    kind: TeamIdentityProviderKindV1Schema,
    displayName: BoundedLabelSchema,
  }).strict(),
  externalReference: TeamIdentityConnectionExternalReferenceV1Schema,
  settings: TeamIdentityConnectionSettingsV1Schema,
  enabled: z.boolean(),
  firstEnabledAt: z.number().int().nullable(),
  revision: z.number().int().positive(),
  state: TeamIdentityConnectionStateV1Schema,
  allowedActions: z.array(z.enum([...TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1, ...HOME_IDENTITY_CONNECTION_USER_ACTION_IDS_V1]))
    .max(TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1.length)
    .refine((actions) => new Set(actions).size === actions.length, {
      message: "Connection allowed actions must be unique",
    }),
  lastObservation: TeamIdentityConnectionObservationV1Schema.nullable(),
  lastSuccessfulTest: z.object({
    at: z.number().int(),
    runtimeFingerprint: z.string().min(1).max(1024),
    current: z.boolean(),
  }).strict().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
}).strict().superRefine((value, ctx) => {
  if (
    value.externalReference.kind !== value.provider.kind
    || value.settings.kind !== value.provider.kind
    || (value.lastObservation !== null && value.lastObservation.kind !== value.provider.kind)
  ) {
    ctx.addIssue({ code: "custom", message: "Connection documents must match provider kind" });
  }
  if (value.allowedActions.some((id) => id.startsWith(value.teamId === null ? 'teams.' : 'home.'))) {
    ctx.addIssue({ code: 'custom', message: 'Connection actions must match the owning scope' });
  }
}));
export type IdentityConnectionV1 = z.infer<typeof IdentityConnectionV1Schema>;
export const TeamIdentityConnectionV1Schema = lazyZodSchema(() => IdentityConnectionV1Schema.safeExtend({
  teamId: TeamIdSchema,
  allowedActions: z.array(z.enum(TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1))
    .max(TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1.length)
    .refine((actions) => new Set(actions).size === actions.length),
}));
export type TeamIdentityConnectionV1 = z.infer<typeof TeamIdentityConnectionV1Schema>;

export const TeamIdentityConnectionRefInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  connectionId: TeamIdentityConnectionIdSchema,
  expectedRevision: z.number().int().positive(),
}).strict());
export type TeamIdentityConnectionRefInputV1 = z.infer<typeof TeamIdentityConnectionRefInputV1Schema>;

export const TeamIdentityConnectionListInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
}).strict());
export type TeamIdentityConnectionListInputV1 = z.infer<typeof TeamIdentityConnectionListInputV1Schema>;

export const IdentityEligibleProviderAvailabilityV1Schema = lazyZodSchema(() => z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    setupChoice: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("use_existing"),
        providerInstanceId: ExactIdSchema,
        connectionDraft: z.object({
          externalReference: TeamIdentityConnectionExternalReferenceV1Schema,
          settings: TeamIdentityConnectionSettingsV1Schema,
        }).strict(),
      }).strict(),
      z.object({
        kind: z.literal("create_managed"),
        actionId: z.enum([
          "identity.providers.create",
          "teams.identity.workos.connection.create",
          "home.identity.workos.connection.create",
          "identity.githubApps.manifestSetup.start",
        ]),
      }).strict(),
      z.object({ kind: z.literal("contact_home_admin") }).strict(),
    ]),
  }).strict(),
  z.object({
    status: z.literal("unavailable"),
    code: z.enum([
      "home_policy_unavailable",
      "home_policy_prohibited",
      "provider_disabled",
      "workos_platform_unavailable",
      "provider_setup_unavailable",
    ]),
  }).strict(),
]));
export type TeamIdentityEligibleProviderAvailabilityV1 = z.infer<typeof TeamIdentityEligibleProviderAvailabilityV1Schema>;
export const TeamIdentityEligibleProviderAvailabilityV1Schema = lazyZodSchema(() => IdentityEligibleProviderAvailabilityV1Schema.refine(
  (value) => !(value.status === 'available' && value.setupChoice.kind === 'create_managed'
    && value.setupChoice.actionId === 'home.identity.workos.connection.create'),
));

export const IdentityEligibleProviderV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  providerId: ExactIdSchema.nullable(),
  providerKind: TeamIdentityProviderKindV1Schema,
  owner: z.enum(["home", "team"]),
  displayName: BoundedLabelSchema.nullable(),
  availability: IdentityEligibleProviderAvailabilityV1Schema,
}).strict().superRefine((value, ctx) => {
  if (value.availability.status !== "available") return;
  if (value.availability.setupChoice.kind === "use_existing") {
    if (value.providerId !== value.availability.setupChoice.providerInstanceId) {
      ctx.addIssue({ code: "custom", message: "Existing provider choice must match the projected provider" });
    }
    if (
      value.availability.setupChoice.connectionDraft.externalReference.kind !== value.providerKind
      || value.availability.setupChoice.connectionDraft.settings.kind !== value.providerKind
    ) {
      ctx.addIssue({ code: "custom", message: "Connection draft must match the projected provider kind" });
    }
    return;
  }
  if (value.availability.setupChoice.kind === "create_managed") {
    const expectedAction = value.providerKind === "oidc"
      ? "identity.providers.create"
      : value.providerKind === "workos_sso"
        ? "teams.identity.workos.connection.create"
        : "identity.githubApps.manifestSetup.start";
    if (value.availability.setupChoice.actionId !== expectedAction
      && !(value.providerKind === 'workos_sso' && value.owner === 'home'
        && value.availability.setupChoice.actionId === 'home.identity.workos.connection.create')) {
      ctx.addIssue({ code: "custom", message: "Managed provider setup action must match the provider kind" });
    }
  }
  if (value.providerId !== null) {
    ctx.addIssue({ code: "custom", message: "Managed provider setup choices cannot identify an existing provider" });
  }
}));
export type IdentityEligibleProviderV1 = z.infer<typeof IdentityEligibleProviderV1Schema>;
export const TeamIdentityEligibleProviderV1Schema = lazyZodSchema(() => IdentityEligibleProviderV1Schema.refine(
  (value) => !(value.availability.status === 'available'
    && value.availability.setupChoice.kind === 'create_managed'
    && value.availability.setupChoice.actionId === 'home.identity.workos.connection.create'),
));
export type TeamIdentityEligibleProviderV1 = z.infer<typeof TeamIdentityEligibleProviderV1Schema>;

export const TeamIdentityConnectionListResultV1Schema = lazyZodSchema(() => z.object({
  // This endpoint intentionally returns the complete Team administration
  // projection. There is no pagination lifecycle for either collection, so an
  // arbitrary row-count validator would turn a valid 101st row into a response
  // serialization failure instead of preserving the authoritative list.
  items: z.array(TeamIdentityConnectionV1Schema),
  eligibleProviders: z.array(TeamIdentityEligibleProviderV1Schema),
  admissionModeApplicability: TeamAdmissionModeApplicabilityV1Schema,
  /**
   * The Team's ordinary member sign-in page, rendered by the Home because only
   * the Home knows its configured application origin and portable carrier. It
   * carries no bearer. `null` means this Home publishes neither, so no portable
   * link exists to hand a member — not that the Team refuses sign-in.
   */
  memberSignInUrl: z.string().url().nullable(),
}).strict());
export type TeamIdentityConnectionListResultV1 = z.infer<typeof TeamIdentityConnectionListResultV1Schema>;

export const IdentityConnectionCreateInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  providerInstanceId: ExactIdSchema,
  externalReference: TeamIdentityConnectionExternalReferenceV1Schema,
  settings: TeamIdentityConnectionSettingsV1Schema,
}).strict().superRefine((value, ctx) => {
  if (value.externalReference.kind !== value.settings.kind) {
    ctx.addIssue({ code: "custom", message: "Connection documents must have the same kind" });
  }
}));
export const TeamIdentityConnectionCreateInputV1Schema = lazyZodSchema(() => IdentityConnectionCreateInputV1Schema.safeExtend({ teamId: TeamIdSchema }));
export type TeamIdentityConnectionCreateInputV1 = z.infer<typeof TeamIdentityConnectionCreateInputV1Schema>;

export const TeamIdentityConnectionSettingsUpdateInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  connectionId: TeamIdentityConnectionIdSchema,
  expectedRevision: z.number().int().positive(),
  settings: TeamIdentityConnectionSettingsV1Schema,
}).strict());
export type TeamIdentityConnectionSettingsUpdateInputV1 = z.infer<typeof TeamIdentityConnectionSettingsUpdateInputV1Schema>;

export const IdentityConnectionMutationResultV1Schema = lazyZodSchema(() => z.object({
  connection: IdentityConnectionV1Schema,
}).strict());
export const TeamIdentityConnectionMutationResultV1Schema = lazyZodSchema(() => IdentityConnectionMutationResultV1Schema.safeExtend({ connection: TeamIdentityConnectionV1Schema }));
export type TeamIdentityConnectionMutationResultV1 = z.infer<typeof TeamIdentityConnectionMutationResultV1Schema>;

export const TeamIdentityConnectionRemoveResultV1Schema = lazyZodSchema(() => z.object({
  outcome: z.enum(["removed", "already_absent"]),
}).strict());
export type TeamIdentityConnectionRemoveResultV1 = z.infer<typeof TeamIdentityConnectionRemoveResultV1Schema>;

export const TeamIdentityConnectionRemovalBlockerV1Schema = lazyZodSchema(() => z.enum([
  "identity_connection_in_use",
  "team_authentication_policy_in_use",
  "team_authentication_policy_unavailable",
  "account_would_lose_login",
  "home_authentication_policy_unavailable",
  "directory_source_in_use",
  "external_group_binding_in_use",
  "managed_membership_in_use",
]));
export type TeamIdentityConnectionRemovalBlockerV1 = z.infer<typeof TeamIdentityConnectionRemovalBlockerV1Schema>;

export const IdentityConnectionRemovalPreflightV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  canRemove: z.boolean(),
  connection: IdentityConnectionV1Schema,
  impact: z.object({
    linkedAccounts: z.number().int().min(0),
    accountsRequiringAlternateLogin: z.number().int().min(0),
    directorySources: z.number().int().min(0),
    externalGroupBindings: z.number().int().min(0),
    managedMemberships: z.number().int().min(0),
  }).strict(),
  blockers: z.array(TeamIdentityConnectionRemovalBlockerV1Schema)
    .max(TeamIdentityConnectionRemovalBlockerV1Schema.options.length)
    .refine((blockers) => new Set(blockers).size === blockers.length, {
      message: "Connection removal blockers must be unique",
    }),
}).strict().superRefine((value, ctx) => {
  if (value.canRemove !== (value.blockers.length === 0)) {
    ctx.addIssue({ code: "custom", message: "Removal availability must match blockers" });
  }
  if (
    value.impact.accountsRequiringAlternateLogin > value.impact.linkedAccounts
  ) {
    ctx.addIssue({ code: "custom", message: "Alternate-login impact cannot exceed linked Accounts" });
  }
}));
export type IdentityConnectionRemovalPreflightV1 = z.infer<typeof IdentityConnectionRemovalPreflightV1Schema>;
export const TeamIdentityConnectionRemovalPreflightV1Schema = lazyZodSchema(() => IdentityConnectionRemovalPreflightV1Schema.safeExtend({ connection: TeamIdentityConnectionV1Schema }));
export type TeamIdentityConnectionRemovalPreflightV1 = z.infer<typeof TeamIdentityConnectionRemovalPreflightV1Schema>;

export const TeamIdentityConnectionTestStartInputV1Schema = TeamIdentityConnectionRefInputV1Schema;
export type TeamIdentityConnectionTestStartInputV1 = z.infer<typeof TeamIdentityConnectionTestStartInputV1Schema>;

export const TeamIdentityConnectionTestStartResultV1Schema = lazyZodSchema(() => z.object({
  authorizeUrl: z.url(),
  attemptId: ExactIdSchema,
}).strict());
export type TeamIdentityConnectionTestStartResultV1 = z.infer<typeof TeamIdentityConnectionTestStartResultV1Schema>;

export const TeamIdentityConnectionTestConsumeInputV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  teamId: TeamIdSchema,
  connectionId: TeamIdentityConnectionIdSchema,
  resultHandle: ExactIdSchema,
}).strict());
export type TeamIdentityConnectionTestConsumeInputV1 = z.infer<typeof TeamIdentityConnectionTestConsumeInputV1Schema>;

export const IdentityConnectionTestConsumeResultV1Schema = lazyZodSchema(() => z.object({
  connection: IdentityConnectionV1Schema,
  /** Absent when the tested connection's provider produced no sanitized diagnostics. */
  diagnostics: IdentityConnectionTestDiagnosticsV1Schema.optional(),
}).strict());
export type IdentityConnectionTestConsumeResultV1 = z.infer<typeof IdentityConnectionTestConsumeResultV1Schema>;
export const TeamIdentityConnectionTestConsumeResultV1Schema = lazyZodSchema(() => IdentityConnectionTestConsumeResultV1Schema.safeExtend({ connection: TeamIdentityConnectionV1Schema }));
export type TeamIdentityConnectionTestConsumeResultV1 =
  z.infer<typeof TeamIdentityConnectionTestConsumeResultV1Schema>;
