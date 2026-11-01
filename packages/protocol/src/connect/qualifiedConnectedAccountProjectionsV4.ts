import * as zMini from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { MachineTargetV1Schema } from '../machines/machineAccessV1.js';
import { asProtocolZod } from "../plugins/actions/internalProtocolZodAdapter.js";

import {
  PluginContributionLocalIdSchema,
} from '../plugins/contributionIdentity.js';
import { StoredJsonContentEnvelopeSchema } from '../storage/storedJsonContentEnvelope.js';
import { SealedProviderAccountSubscriptionV1Schema } from './accountSubscription.js';
import { SealedProviderAccountUsageRecoveryCreditDetailsV1Schema } from './providerAccountUsagePrimitives.js';
import {
  ConnectedServiceAuthGroupIdSchema,
  ConnectedServiceAuthGroupMemberStateV1Schema,
  ConnectedServiceAuthGroupPolicyV1Schema,
  ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema,
  ConnectedServiceAuthGroupStateV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceCredentialHealthV1Schema,
  isConnectedServiceCredentialHealthStatusUsable,
} from './connectedServiceSchemas.js';
import {
  QualifiedConnectedAccountIdSchema,
  ConnectedAccountServiceIdentityV1Schema,
  QualifiedConnectedAccountRefSchema,
  sameQualifiedConnectedAccountRef,
} from './qualifiedConnectedAccountPersistence.js';
import type { PluginConnectedAccountAuthenticationV2 } from './pluginConnectedAccountAuthenticationV2.js';
import type { QualifiedConnectedAccountGroupV4, QualifiedConnectedAccountProfileV4 } from './qualifiedConnectedAccountsV4.js';

export const QualifiedConnectedAccountConfigurationRevisionV4Schema = lazyZodSchema(() => z
  .string().check(z.trim(), z.minLength(1), z.maxLength(128)));

export const QualifiedConnectedAccountModeIdV4Schema =
  PluginContributionLocalIdSchema;
const QualifiedConnectedAccountModeIdV4ZodSchema = asProtocolZod(
  QualifiedConnectedAccountModeIdV4Schema,
);

const QualifiedConnectedAccountRevisionedV4Shape = {
  revisionSemantics: z.literal('revisioned'),
  credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
} as const;

const QualifiedConnectedAccountLegacyUnfencedV4Shape = {
  revisionSemantics: z.literal('legacy_unfenced'),
  credentialRevision: z.null(),
} as const;

/**
 * V4 read projections publish the credential revision as a discriminated
 * authority boundary. A legacy stored row remains observable, but it cannot
 * supply a CAS/currentness token to any consumer.
 */
function createQualifiedConnectedAccountRevisionSemanticsV4Schema<
  Shape extends z.core.$ZodShape,
>(shape: Shape) {
  return z.discriminatedUnion('revisionSemantics', [
    z.strictObject({
      ...shape,
      ...QualifiedConnectedAccountRevisionedV4Shape,
    }),
    z.strictObject({
      ...shape,
      ...QualifiedConnectedAccountLegacyUnfencedV4Shape,
    }),
  ]);
}

export const QualifiedConnectedAccountServiceRefSchema = ConnectedAccountServiceIdentityV1Schema;
export const QualifiedConnectedServiceUsageSourceV4Schema = lazyZodSchema(() => z.discriminatedUnion('bindingKind', [
  z.strictObject({ ref: asProtocolZod(QualifiedConnectedAccountRefSchema), bindingKind: z.literal('account') }),
  z.strictObject({ ref: asProtocolZod(QualifiedConnectedAccountRefSchema), bindingKind: z.literal('group_member'), groupId: ConnectedServiceAuthGroupIdSchema, groupGeneration: z.optional(z.number().check(z.int(), z.nonnegative())) }),
]));
export const ProviderAccountUsageEncryptedContentV4Schema = lazyZodSchema(() => z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)), subscription: zMini.optional(SealedProviderAccountSubscriptionV1Schema), recoveryCreditDetails: zMini.optional(SealedProviderAccountUsageRecoveryCreditDetailsV1Schema) }));
export const QualifiedProviderAccountUsageRecordResponseV4Schema = lazyZodSchema(() => z.strictObject({
  content: z.discriminatedUnion('t', [StoredJsonContentEnvelopeSchema._zod.def.options[0], ProviderAccountUsageEncryptedContentV4Schema]),
  metadata: z.strictObject({ fetchedAt: z.number().check(z.int(), z.nonnegative()), staleAfterMs: z.number().check(z.int(), z.nonnegative()), status: z.enum(['ok', 'unavailable', 'estimated', 'error']), refreshRequestedAt: z.optional(z.number().check(z.int(), z.nonnegative())) }),
  sources: z.array(QualifiedConnectedServiceUsageSourceV4Schema),
}));
const QualifiedConnectedAccountServiceRefZodSchema = asProtocolZod(
  QualifiedConnectedAccountServiceRefSchema,
);

export const QualifiedConnectedAccountGroupRefSchema = lazyZodSchema(() => z.strictObject({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
}));
export type QualifiedConnectedAccountGroupRef = z.infer<
  typeof QualifiedConnectedAccountGroupRefSchema
>;

/** Canonical equality for the complete qualified group identity. */
export function sameQualifiedConnectedAccountGroupRef(
  left: QualifiedConnectedAccountGroupRef,
  right: QualifiedConnectedAccountGroupRef,
): boolean {
  return left.service.pluginId === right.service.pluginId
    && left.service.localId === right.service.localId
    && left.groupId === right.groupId;
}

/**
 * Opaque identity of one persisted group lifetime. Unlike generation and
 * runtime-state revision, it does not reset when a logical group id is
 * deleted and recreated.
 */
export const QualifiedConnectedAccountGroupIncarnationV4Schema = lazyZodSchema(() => z
  .string().check(z.trim(), z.minLength(1), z.maxLength(128)));

export const QualifiedConnectedAccountProviderIdentityV4Schema = lazyZodSchema(() => z.strictObject({
  accountId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256)))),
  email: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512)))),
  organizationId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256)))),
}));

const QualifiedConnectedAccountScopesV4Schema = lazyZodSchema(() => z._default(z
  .array(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))).check(z.maxLength(128), z.refine((scopes) => new Set(scopes).size === scopes.length, 'Qualified Connected Account scopes must be unique')), []));

/** Display evidence of an observed authentication, never inferred from import or refresh time. */
export const QualifiedConnectedAccountAuthenticationProvenanceV4Schema = lazyZodSchema(() => z.strictObject({
  authenticatedAt: z.number().check(z.int(), z.nonnegative()),
  /** serverId carries the portable Home server identity, not a device-local profile alias. */
  machine: MachineTargetV1Schema,
}));

export const QualifiedConnectedAccountPresentationMetadataV4Schema = lazyZodSchema(() => z.strictObject({
  providerIdentity: z.optional(QualifiedConnectedAccountProviderIdentityV4Schema),
  displayName: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
  scopes: QualifiedConnectedAccountScopesV4Schema,
  authenticationProvenance: z.optional(QualifiedConnectedAccountAuthenticationProvenanceV4Schema),
}));

const QualifiedConnectedAccountProfileV4Shape = {
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
  status: z.enum([
    'connected',
    'refreshing',
    'needs_reauth',
    'refresh_failed_retryable',
  ]),
  authenticationModeId: zMini.nullable(QualifiedConnectedAccountModeIdV4ZodSchema),
  configurationReady: z.boolean(),
  configurationRevision:
    z.nullable(QualifiedConnectedAccountConfigurationRevisionV4Schema),
  kind: z.optional(z.nullable(z.enum(['oauth', 'token']))),
  expiresAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
  lastUsedAt: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))),
  ...QualifiedConnectedAccountPresentationMetadataV4Schema.shape,
} as const;

export const QualifiedConnectedAccountProfileV4Schema =
  createQualifiedConnectedAccountRevisionSemanticsV4Schema(
    QualifiedConnectedAccountProfileV4Shape,
  );

/** Every account the Account holds for the service. */
export const QualifiedConnectedAccountListResponseV4Schema = lazyZodSchema(() => z.strictObject({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  accounts: z.array(QualifiedConnectedAccountProfileV4Schema),
}));

export const QualifiedConnectedAccountConfigurationTargetV4Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('account'),
  ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
}));

export const QualifiedConnectedAccountCredentialMetadataV4Schema =
  QualifiedConnectedAccountPresentationMetadataV4Schema;

export const QualifiedConnectedAccountConfigurationSnapshotV4Schema =
  createQualifiedConnectedAccountRevisionSemanticsV4Schema({
    target: QualifiedConnectedAccountConfigurationTargetV4Schema,
    authenticationModeId: zMini.nullable(QualifiedConnectedAccountModeIdV4ZodSchema),
    configurationRevision:
      QualifiedConnectedAccountConfigurationRevisionV4Schema,
    configurationContent: StoredJsonContentEnvelopeSchema,
  });

export const QualifiedConnectedAccountCredentialSnapshotV4Schema =
  createQualifiedConnectedAccountRevisionSemanticsV4Schema({
    ref: asProtocolZod(QualifiedConnectedAccountRefSchema),
    authenticationModeId: zMini.nullable(QualifiedConnectedAccountModeIdV4ZodSchema),
    configurationRevision:
      z.nullable(QualifiedConnectedAccountConfigurationRevisionV4Schema),
    content: StoredJsonContentEnvelopeSchema,
    // Health is server-owned and read-only here. Credential replacement metadata
    // stays presentation-only; health mutations use the fenced health endpoint.
    metadata: QualifiedConnectedAccountCredentialMetadataV4Schema,
    health: z.optional(ConnectedServiceCredentialHealthV1Schema),
  });

export const QualifiedConnectedAccountGroupMemberV4Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
  priority: z._default(z.number().check(z.int()), 100),
  enabled: z._default(z.boolean(), true),
  state: ConnectedServiceAuthGroupMemberStateV1Schema,
  createdAt: z.number().check(z.int(), z.nonnegative()),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
}));

export const QualifiedConnectedAccountGroupV4Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  ref: QualifiedConnectedAccountGroupRefSchema,
  incarnation: QualifiedConnectedAccountGroupIncarnationV4Schema,
  displayName: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  policy: ConnectedServiceAuthGroupPolicyV1Schema,
  activeConnectedAccountId: zMini.nullable(asProtocolZod(QualifiedConnectedAccountIdSchema)),
  generation: z.number().check(z.int(), z.nonnegative()),
  runtimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema,
  state: ConnectedServiceAuthGroupStateV1Schema,
  createdAt: z.number().check(z.int(), z.nonnegative()),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
  members: z._default(z.array(QualifiedConnectedAccountGroupMemberV4Schema), []),
}));

export const QualifiedConnectedAccountGroupListQueryV4Schema = lazyZodSchema(() => z.strictObject({
  service: QualifiedConnectedAccountServiceRefZodSchema,
}));

export const QualifiedConnectedAccountGroupCreateV4Schema = lazyZodSchema(() => z.strictObject({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  group: z.strictObject({
    groupId: ConnectedServiceAuthGroupIdSchema,
    displayName: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512)))),
    state: zMini.optional(ConnectedServiceAuthGroupStateV1Schema),
    policy: zMini.optional(ConnectedServiceAuthGroupPolicyV1Schema),
  }),
}));

export const QualifiedConnectedAccountGroupQueryV4Schema = lazyZodSchema(() => z.strictObject({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
  expectedRuntimeStateRevision: zMini.optional(ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema),
}));

export const QualifiedConnectedAccountGroupPatchV4Schema = lazyZodSchema(() => z.strictObject({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
  expectedGeneration: z.number().check(z.int(), z.nonnegative()),
  expectedIncarnation:
    z.optional(QualifiedConnectedAccountGroupIncarnationV4Schema),
  displayName: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512)))),
  state: zMini.optional(ConnectedServiceAuthGroupStateV1Schema._zod.def.innerType),
  policy: zMini.optional(ConnectedServiceAuthGroupPolicyV1Schema),
  expectedRuntimeStateRevision: zMini.optional(ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema),
  overrideRuntimeCooldown: z.optional(z.boolean()),
}));

export const QualifiedConnectedAccountGroupRuntimeStatePatchV4Schema = lazyZodSchema(() => z.strictObject({
  service: QualifiedConnectedAccountServiceRefZodSchema,
  groupId: ConnectedServiceAuthGroupIdSchema,
  expectedGeneration: z.number().check(z.int(), z.nonnegative()),
  expectedIncarnation:
    z.optional(QualifiedConnectedAccountGroupIncarnationV4Schema),
  expectedRuntimeStateRevision: ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema,
  runtimeState: z.strictObject({
    state: zMini.optional(ConnectedServiceAuthGroupStateV1Schema._zod.def.innerType),
    memberStates: z._default(z.array(z.strictObject({
      connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
      state: ConnectedServiceAuthGroupMemberStateV1Schema,
    })), []),
  }),
}));

export const QualifiedConnectedAccountGroupMemberMutationV4Schema = lazyZodSchema(() => z.strictObject({
  group: QualifiedConnectedAccountGroupRefSchema,
  expectedGeneration: z.number().check(z.int(), z.nonnegative()),
  expectedIncarnation:
    z.optional(QualifiedConnectedAccountGroupIncarnationV4Schema),
  connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
  priority: z.optional(z.number().check(z.int())),
  enabled: z.optional(z.boolean()),
  state:
    zMini.optional(ConnectedServiceAuthGroupMemberStateV1Schema._zod.def.innerType),
  expectedRuntimeStateRevision: zMini.optional(ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema),
}));

export const QualifiedConnectedAccountGroupMemberDeleteV4Schema = lazyZodSchema(() => z.strictObject({
  group: QualifiedConnectedAccountGroupRefSchema,
  expectedGeneration: z.number().check(z.int(), z.nonnegative()),
  expectedIncarnation:
    z.optional(QualifiedConnectedAccountGroupIncarnationV4Schema),
  connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
  expectedRuntimeStateRevision: zMini.optional(ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema),
}));

export const QualifiedConnectedAccountGroupActiveAccountV4Schema = lazyZodSchema(() => z.strictObject({
  group: QualifiedConnectedAccountGroupRefSchema,
  expectedIncarnation:
    z.optional(QualifiedConnectedAccountGroupIncarnationV4Schema),
  connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
  expectedGeneration: z.number().check(z.int(), z.nonnegative()),
  expectedRuntimeStateRevision: zMini.optional(ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema),
  expectedSource: z.optional(z.strictObject({
    connectedAccountId: asProtocolZod(QualifiedConnectedAccountIdSchema),
    credentialRevision: ConnectedServiceCredentialRevisionV1Schema,
    configurationRevision: z.nullable(QualifiedConnectedAccountConfigurationRevisionV4Schema),
  })),
  overrideRuntimeCooldown: z.optional(z.boolean()),
  switchReason: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));

export const QualifiedConnectedAccountGroupDeleteV4Schema = lazyZodSchema(() => z.strictObject({
  group: QualifiedConnectedAccountGroupRefSchema,
  expectedGeneration: z.number().check(z.int(), z.nonnegative()),
  expectedIncarnation: QualifiedConnectedAccountGroupIncarnationV4Schema,
  expectedRuntimeStateRevision:
    zMini.optional(ConnectedServiceAuthGroupRuntimeStateRevisionV1Schema),
}));

/** Every group the Account holds. */
export const QualifiedConnectedAccountGroupListResponseV4Schema = lazyZodSchema(() => z.strictObject({
  groups: z.array(QualifiedConnectedAccountGroupV4Schema),
}));

export const QualifiedConnectedAccountGroupResponseV4Schema = lazyZodSchema(() => z.strictObject({
  group: QualifiedConnectedAccountGroupV4Schema,
}));

/**
 * A V4 account is eligible to authorize a current purpose only while its
 * revision-fenced credential is usable and unexpired. Direct targets and
 * group targets share this exact policy.
 */
export function isQualifiedConnectedAccountProfileActiveV4(
  account: QualifiedConnectedAccountProfileV4,
  now: number,
): boolean {
  return isConnectedServiceCredentialHealthStatusUsable(account.status)
    && account.revisionSemantics === 'revisioned'
    && (typeof account.expiresAt !== 'number' || account.expiresAt > now);
}

/**
 * Determines whether a current V4 credential can be used for a purpose under
 * the exact descriptor mode that created it. `configurationReady` remains a
 * projection fact: it gates only modes whose configuration is account-scoped.
 */
export function isQualifiedConnectedAccountProfileUsableV4(input: Readonly<{
  profile: QualifiedConnectedAccountProfileV4;
  authentication: PluginConnectedAccountAuthenticationV2;
  now: number;
}>): boolean {
  if (!isQualifiedConnectedAccountProfileActiveV4(input.profile, input.now)) {
    return false;
  }
  const authenticationModeId = input.profile.authenticationModeId;
  if (authenticationModeId === null) return false;
  const mode = input.authentication.modes.find((candidate) => (
    candidate.id === authenticationModeId
  ));
  if (!mode) return false;
  return mode.configuration?.scope !== 'account'
    || input.profile.configurationReady;
}

/**
 * Resolve the one account that makes a qualified group passively usable.
 * Group runtime status is diagnostic state; authority comes from the active,
 * enabled member and a current usable revisioned account projection.
 */
export function resolveQualifiedConnectedAccountGroupActiveAccountV4(input: Readonly<{
  group: QualifiedConnectedAccountGroupV4;
  accounts: readonly QualifiedConnectedAccountProfileV4[];
  authentication: PluginConnectedAccountAuthenticationV2;
  now: number;
}>): QualifiedConnectedAccountProfileV4 | null {
  const activeAccountId = input.group.activeConnectedAccountId;
  if (!activeAccountId) return null;
  if (!input.group.members.some((member) => (
    member.connectedAccountId === activeAccountId
    && member.enabled !== false
  ))) return null;
  const activeAccountRef = {
    service: input.group.ref.service,
    accountId: activeAccountId,
  };
  return input.accounts.find((account) => (
    sameQualifiedConnectedAccountRef(account.ref, activeAccountRef)
    && isQualifiedConnectedAccountProfileUsableV4({
      profile: account,
      authentication: input.authentication,
      now: input.now,
    })
  )) ?? null;
}
