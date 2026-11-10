import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from "../../zodRuntimePolicy.js";

import { TeamIdSchema } from "../membership.js";
import { IdentityConnectionTestDiagnosticsV1Schema } from "../../identity/testDiagnostics.js";
import { HOME_IDENTITY_CONNECTION_USER_ACTION_IDS_V1, TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1 } from "./actionIds.js";
import { TeamIdentityConnectionIdSchema } from "./ids.js";
import { TeamAdmissionModeApplicabilityV1Schema } from "./admission.js";

const ExactIdSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(512)));
const BoundedLabelSchema = lazyZodSchema(() => z.string().check(z.minLength(1), z.maxLength(256)));
const StringListSchema = lazyZodSchema(() => z.array(z.string().check(z.minLength(1), z.maxLength(512))).check(z.maxLength(500)));

export const TeamIdentityProviderKindV1Schema = lazyZodSchema(() => z.enum([
  "oidc",
  "workos_sso",
  "github_app_identity",
]));
export type TeamIdentityProviderKindV1 = z.infer<typeof TeamIdentityProviderKindV1Schema>;

export { TeamIdentityConnectionIdSchema } from "./ids.js";

export const TeamIdentityConnectionExternalReferenceV1Schema = lazyZodSchema(() => z.discriminatedUnion("kind", [
  z.strictObject({ v: z.literal(1), kind: z.literal("oidc") }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("workos_sso"),
    organizationId: z.nullable(ExactIdSchema),
    connectionId: z.nullable(ExactIdSchema),
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("github_app_identity"),
    installationId: ExactIdSchema,
  }),
]).check(z.superRefine((reference, ctx) => {
  if (
    reference.kind === "workos_sso"
    && reference.connectionId !== null
    && reference.organizationId === null
  ) {
    ctx.addIssue({ code: "custom", message: "A WorkOS SSO connection requires its organization" });
  }
})));
export type TeamIdentityConnectionExternalReferenceV1 = z.infer<typeof TeamIdentityConnectionExternalReferenceV1Schema>;

export const TeamIdentityOidcConnectionSettingsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  kind: z.literal("oidc"),
  allowedUsers: StringListSchema,
  allowedEmailDomains: StringListSchema,
  groupsAny: StringListSchema,
  groupsAll: StringListSchema,
}));
export type TeamIdentityOidcConnectionSettingsV1 = z.infer<typeof TeamIdentityOidcConnectionSettingsV1Schema>;

export const TeamIdentityConnectionSettingsV1Schema = lazyZodSchema(() => z.discriminatedUnion("kind", [
  TeamIdentityOidcConnectionSettingsV1Schema,
  z.strictObject({ v: z.literal(1), kind: z.literal("workos_sso") }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("github_app_identity"),
    organizationLogin: BoundedLabelSchema,
  }),
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

export const TeamIdentityWorkosPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  displayName: BoundedLabelSchema,
  strategy: BoundedLabelSchema,
  status: BoundedLabelSchema,
  lastCheckedAt: z.number().check(z.int()),
}));

export const TeamIdentityConnectionObservationV1Schema = lazyZodSchema(() => z.discriminatedUnion("kind", [
  z.strictObject({ v: z.literal(1), kind: z.literal("oidc") }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal("workos_sso"),
    presentation: z.nullable(TeamIdentityWorkosPresentationV1Schema),
  }),
  z.strictObject({ v: z.literal(1), kind: z.literal("github_app_identity") }),
]));
export type TeamIdentityConnectionObservationV1 = z.infer<typeof TeamIdentityConnectionObservationV1Schema>;

export const IdentityConnectionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  id: TeamIdentityConnectionIdSchema,
  teamId: z.nullable(TeamIdSchema),
  provider: z.strictObject({
    id: ExactIdSchema,
    kind: TeamIdentityProviderKindV1Schema,
    displayName: BoundedLabelSchema,
  }),
  externalReference: TeamIdentityConnectionExternalReferenceV1Schema,
  settings: TeamIdentityConnectionSettingsV1Schema,
  enabled: z.boolean(),
  firstEnabledAt: z.nullable(z.number().check(z.int())),
  revision: z.number().check(z.int(), z.positive()),
  state: TeamIdentityConnectionStateV1Schema,
  allowedActions: z.array(z.enum([...TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1, ...HOME_IDENTITY_CONNECTION_USER_ACTION_IDS_V1])).check(z.maxLength(TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1.length), z.refine((actions) => new Set(actions).size === actions.length, {
      message: "Connection allowed actions must be unique",
    })),
  lastObservation: z.nullable(TeamIdentityConnectionObservationV1Schema),
  lastSuccessfulTest: z.nullable(z.strictObject({
    at: z.number().check(z.int()),
    runtimeFingerprint: z.string().check(z.minLength(1), z.maxLength(1024)),
    current: z.boolean(),
  })),
  createdAt: z.number().check(z.int()),
  updatedAt: z.number().check(z.int()),
}).check(z.superRefine((value, ctx) => {
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
})));
export type IdentityConnectionV1 = z.infer<typeof IdentityConnectionV1Schema>;
export const TeamIdentityConnectionV1Schema = lazyZodSchema(() => z.safeExtend(IdentityConnectionV1Schema, {
  teamId: TeamIdSchema,
  allowedActions: z.array(z.enum(TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1)).check(z.maxLength(TEAM_IDENTITY_CONNECTION_USER_ACTION_IDS_V1.length), z.refine((actions) => new Set(actions).size === actions.length)),
}));
export type TeamIdentityConnectionV1 = z.infer<typeof TeamIdentityConnectionV1Schema>;

export const TeamIdentityConnectionRefInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  teamId: TeamIdSchema,
  connectionId: TeamIdentityConnectionIdSchema,
  expectedRevision: z.number().check(z.int(), z.positive()),
}));
export type TeamIdentityConnectionRefInputV1 = z.infer<typeof TeamIdentityConnectionRefInputV1Schema>;

export const TeamIdentityConnectionListInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  teamId: TeamIdSchema,
}));
export type TeamIdentityConnectionListInputV1 = z.infer<typeof TeamIdentityConnectionListInputV1Schema>;

export const IdentityEligibleProviderAvailabilityV1Schema = lazyZodSchema(() => z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    setupChoice: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("use_existing"),
        providerInstanceId: ExactIdSchema,
        connectionDraft: z.strictObject({
          externalReference: TeamIdentityConnectionExternalReferenceV1Schema,
          settings: TeamIdentityConnectionSettingsV1Schema,
        }),
      }),
      z.strictObject({
        kind: z.literal("create_managed"),
        actionId: z.enum([
          "identity.providers.create",
          "teams.identity.workos.connection.create",
          "home.identity.workos.connection.create",
          "identity.githubApps.manifestSetup.start",
        ]),
      }),
      z.strictObject({ kind: z.literal("contact_home_admin") }),
    ]),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    code: z.enum([
      "home_policy_unavailable",
      "home_policy_prohibited",
      "provider_disabled",
      "workos_platform_unavailable",
      "provider_setup_unavailable",
    ]),
  }),
]));
export type TeamIdentityEligibleProviderAvailabilityV1 = z.infer<typeof TeamIdentityEligibleProviderAvailabilityV1Schema>;
export const TeamIdentityEligibleProviderAvailabilityV1Schema = lazyZodSchema(() => IdentityEligibleProviderAvailabilityV1Schema.check(z.refine((value) => !(value.status === 'available' && value.setupChoice.kind === 'create_managed'
    && value.setupChoice.actionId === 'home.identity.workos.connection.create'))));

export const IdentityEligibleProviderV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  providerId: z.nullable(ExactIdSchema),
  providerKind: TeamIdentityProviderKindV1Schema,
  owner: z.enum(["home", "team"]),
  displayName: z.nullable(BoundedLabelSchema),
  availability: IdentityEligibleProviderAvailabilityV1Schema,
}).check(z.superRefine((value, ctx) => {
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
})));
export type IdentityEligibleProviderV1 = z.infer<typeof IdentityEligibleProviderV1Schema>;
export const TeamIdentityEligibleProviderV1Schema = lazyZodSchema(() => IdentityEligibleProviderV1Schema.check(z.refine((value) => !(value.availability.status === 'available'
    && value.availability.setupChoice.kind === 'create_managed'
    && value.availability.setupChoice.actionId === 'home.identity.workos.connection.create'))));
export type TeamIdentityEligibleProviderV1 = z.infer<typeof TeamIdentityEligibleProviderV1Schema>;

export const TeamIdentityConnectionListResultV1Schema = lazyZodSchema(() => z.strictObject({
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
  memberSignInUrl: z.nullable(z.string().check(z.url())),
}));
export type TeamIdentityConnectionListResultV1 = z.infer<typeof TeamIdentityConnectionListResultV1Schema>;

export const IdentityConnectionCreateInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  providerInstanceId: ExactIdSchema,
  externalReference: TeamIdentityConnectionExternalReferenceV1Schema,
  settings: TeamIdentityConnectionSettingsV1Schema,
}).check(z.superRefine((value, ctx) => {
  if (value.externalReference.kind !== value.settings.kind) {
    ctx.addIssue({ code: "custom", message: "Connection documents must have the same kind" });
  }
})));
export const TeamIdentityConnectionCreateInputV1Schema = lazyZodSchema(() => z.safeExtend(IdentityConnectionCreateInputV1Schema, { teamId: TeamIdSchema }));
export type TeamIdentityConnectionCreateInputV1 = z.infer<typeof TeamIdentityConnectionCreateInputV1Schema>;

export const TeamIdentityConnectionSettingsUpdateInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  teamId: TeamIdSchema,
  connectionId: TeamIdentityConnectionIdSchema,
  expectedRevision: z.number().check(z.int(), z.positive()),
  settings: TeamIdentityConnectionSettingsV1Schema,
}));
export type TeamIdentityConnectionSettingsUpdateInputV1 = z.infer<typeof TeamIdentityConnectionSettingsUpdateInputV1Schema>;

export const IdentityConnectionMutationResultV1Schema = lazyZodSchema(() => z.strictObject({
  connection: IdentityConnectionV1Schema,
}));
export const TeamIdentityConnectionMutationResultV1Schema = lazyZodSchema(() => z.safeExtend(IdentityConnectionMutationResultV1Schema, { connection: TeamIdentityConnectionV1Schema }));
export type TeamIdentityConnectionMutationResultV1 = z.infer<typeof TeamIdentityConnectionMutationResultV1Schema>;

export const TeamIdentityConnectionRemoveResultV1Schema = lazyZodSchema(() => z.strictObject({
  outcome: z.enum(["removed", "already_absent"]),
}));
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

export const IdentityConnectionRemovalPreflightV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  canRemove: z.boolean(),
  connection: IdentityConnectionV1Schema,
  impact: z.strictObject({
    linkedAccounts: z.number().check(z.int(), z.minimum(0)),
    accountsRequiringAlternateLogin: z.number().check(z.int(), z.minimum(0)),
    directorySources: z.number().check(z.int(), z.minimum(0)),
    externalGroupBindings: z.number().check(z.int(), z.minimum(0)),
    managedMemberships: z.number().check(z.int(), z.minimum(0)),
  }),
  blockers: z.array(TeamIdentityConnectionRemovalBlockerV1Schema).check(z.maxLength(TeamIdentityConnectionRemovalBlockerV1Schema.options.length), z.refine((blockers) => new Set(blockers).size === blockers.length, {
      message: "Connection removal blockers must be unique",
    })),
}).check(z.superRefine((value, ctx) => {
  if (value.canRemove !== (value.blockers.length === 0)) {
    ctx.addIssue({ code: "custom", message: "Removal availability must match blockers" });
  }
  if (
    value.impact.accountsRequiringAlternateLogin > value.impact.linkedAccounts
  ) {
    ctx.addIssue({ code: "custom", message: "Alternate-login impact cannot exceed linked Accounts" });
  }
})));
export type IdentityConnectionRemovalPreflightV1 = z.infer<typeof IdentityConnectionRemovalPreflightV1Schema>;
export const TeamIdentityConnectionRemovalPreflightV1Schema = lazyZodSchema(() => z.safeExtend(IdentityConnectionRemovalPreflightV1Schema, { connection: TeamIdentityConnectionV1Schema }));
export type TeamIdentityConnectionRemovalPreflightV1 = z.infer<typeof TeamIdentityConnectionRemovalPreflightV1Schema>;

export const TeamIdentityConnectionTestStartInputV1Schema = TeamIdentityConnectionRefInputV1Schema;
export type TeamIdentityConnectionTestStartInputV1 = z.infer<typeof TeamIdentityConnectionTestStartInputV1Schema>;

export const TeamIdentityConnectionTestStartResultV1Schema = lazyZodSchema(() => z.strictObject({
  authorizeUrl: z.url(),
  attemptId: ExactIdSchema,
}));
export type TeamIdentityConnectionTestStartResultV1 = z.infer<typeof TeamIdentityConnectionTestStartResultV1Schema>;

export const TeamIdentityConnectionTestConsumeInputV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  teamId: TeamIdSchema,
  connectionId: TeamIdentityConnectionIdSchema,
  resultHandle: ExactIdSchema,
}));
export type TeamIdentityConnectionTestConsumeInputV1 = z.infer<typeof TeamIdentityConnectionTestConsumeInputV1Schema>;

export const IdentityConnectionTestConsumeResultV1Schema = lazyZodSchema(() => z.strictObject({
  connection: IdentityConnectionV1Schema,
  /** Absent when the tested connection's provider produced no sanitized diagnostics. */
  diagnostics: z.optional(IdentityConnectionTestDiagnosticsV1Schema),
}));
export type IdentityConnectionTestConsumeResultV1 = z.infer<typeof IdentityConnectionTestConsumeResultV1Schema>;
export const TeamIdentityConnectionTestConsumeResultV1Schema = lazyZodSchema(() => z.safeExtend(IdentityConnectionTestConsumeResultV1Schema, { connection: TeamIdentityConnectionV1Schema }));
export type TeamIdentityConnectionTestConsumeResultV1 =
  z.infer<typeof TeamIdentityConnectionTestConsumeResultV1Schema>;
