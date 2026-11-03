import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { AnchoredListPositionV1Schema, resolveAnchoredListMoveV1, type AnchoredListPositionV1 } from '../actions/anchoredListOrderV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { QualifiedConnectedAccountRefSchema } from './qualifiedConnectedAccountPersistence.js';
import {
  QualifiedConnectedAccountGroupRefSchema, QualifiedConnectedAccountGroupActiveAccountV4Schema,
  QualifiedConnectedAccountGroupCreateV4Schema, QualifiedConnectedAccountGroupPatchV4Schema,
  QualifiedConnectedAccountGroupDeleteV4Schema, QualifiedConnectedAccountGroupMemberMutationV4Schema,
  QualifiedConnectedAccountGroupMemberDeleteV4Schema, QualifiedConnectedAccountGroupResponseV4Schema,
} from './qualifiedConnectedAccountProjectionsV4.js';
import { ConnectedServiceIdSchema, ConnectedServiceProfileIdSchema, ConnectedServiceBindingSelectionV2Schema } from './connectedServiceBindings.js';
import { ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema } from '../sessions/work/state/sessionWorkStateRpc.js';
import { ConnectedAccountRevokeCommandV1Schema, ConnectedAccountRevokeResponseV1Schema, ConnectedAccountRevokedResponseV1Schema,
  ConnectedAccountControlTargetSchema, ConnectedAccountConfigurationTargetSchema } from './connectedAccountDaemonRpcV1.js';
import { ConnectedAccountServiceConfigurationEntryV1Schema } from '../account/settings/connectedAccountServiceConfigurationsV1.js';
import { PluginConnectedAccountAuthenticationModeV2Schema } from './pluginConnectedAccountAuthenticationV2.js';
import { ConnectedAccountAuthenticationCommandSchemas } from './connectedAccountDaemonRpcV1.js';
import { ConnectedServiceCredentialRevisionV1Schema } from './connectedServiceSchemas.js';
import { ConnectedMetadataCleanupV1Schema } from './connectedAccountPresentationSchemasV1.js';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1 } from './configurationActionIdsV1.js';
import { ConnectedServiceQuotaGetInputV1Schema, ConnectedServiceQuotaGetResultV1Schema } from './providerAccountUsageHistorySchemasV1.js';
import { ConnectedServicePoolSelectionGetRequestV1Schema, ConnectedServicePoolSelectionGetResponseV1Schema } from './connectedServicePoolSelection.js';
import { QualifiedAcknowledgementSubjectSchema, QualifiedConnectedDisclosureSubjectSchema, QualifiedConnectedEntityRefSchema } from './connectedAccountPresentationSchemasV1.js';
import { ProviderAccountSubscriptionMonthlyPriceV1Schema } from './accountSubscription.js';
import { CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_INPUT_SCHEMAS, CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_OUTPUT_SCHEMAS } from './authenticationActionsV1.js';
import { QualifiedConnectedAccountPurposeV1Schema } from './connectedAccountPurposeIdentity.js';
import { QualifiedConnectedAccountPurposeBindingTargetV1Schema } from './connectedAccountPurposeBindings.js';
import { QualifiedConnectedAccountProfileV4Schema, QualifiedConnectedAccountGroupV4Schema } from './qualifiedConnectedAccountProjectionsV4.js';
import { ConnectedAccountUiProjectionEntryV1Schema } from './connectedAccountUiProjectionV1.js';
import { ProviderGatewayContributionV1Schema } from '../providers/gatewayContributionsV1.js';
export { CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1 } from './configurationActionIdsV1.js';
export { CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION } from './configurationActionIdsV1.js';

export const ConnectedServiceConfigurationActionIdV1Schema = lazyZodSchema(() => z.enum(CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1));
export type ConnectedServiceConfigurationActionIdV1 = z.infer<typeof ConnectedServiceConfigurationActionIdV1Schema>;

const Success = z.strictObject({ applied: z.literal(true) });
const MetadataCleanupSuccess = z.extend(Success, { metadataCleanup: z.optional(ConnectedMetadataCleanupV1Schema) });
const RevokeActionResponse = lazyZodSchema(() => z.union([
  ConnectedAccountRevokeResponseV1Schema,
  z.extend(ConnectedAccountRevokedResponseV1Schema, { metadataCleanup: z.optional(ConnectedMetadataCleanupV1Schema) }),
]));
const ConfigurationTarget = lazyZodSchema(() => z.pick(ConnectedAccountServiceConfigurationEntryV1Schema, { service: true, modeId: true }));
const MachineConfigurationTarget = lazyZodSchema(() => z.strictObject({
  machineId: z.string().check(z.trim(), z.minLength(1)),
  target: z.union([ConnectedAccountControlTargetSchema._zod.def.options[1], ConnectedAccountControlTargetSchema._zod.def.options[2]]),
}));
const ConfigurationReplacement = z.object({ expectedRevision: z.nullable(z.string().check(z.minLength(1), z.maxLength(256))),
  values: ConnectedAccountServiceConfigurationEntryV1Schema.shape.values,
  secretValues: z.record(z.string(), z.string().check(z.minLength(1), z.maxLength(64 * 1024))) });
const ConfigurationView = z.strictObject({ status: z.enum(['ready', 'configurationRequired']), revision: z.nullable(z.string()),
  values: ConnectedAccountServiceConfigurationEntryV1Schema.shape.values, configuredSecretFieldIds: z.array(z.string()),
  missingFieldIds: z.array(z.string()) });
export const CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1 = {
  ...CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_INPUT_SCHEMAS,
  'connectedServices.accounts.list': z.strictObject({ service: z.optional(QualifiedConnectedAccountGroupRefSchema.shape.service) }),
  'connectedServices.accounts.credentials.save': z.strictObject({
    account: asProtocolZod(QualifiedConnectedAccountRefSchema), modeId: ConnectedAccountServiceConfigurationEntryV1Schema.shape.modeId,
    fields: ConnectedAccountAuthenticationCommandSchemas.submitManual.shape.fields,
    selectedSecrets: ConnectedAccountAuthenticationCommandSchemas.submitManual.shape.selectedSecrets,
    displayName: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
    /** Convert on edit: replace this exact existing credential with one held by its Saved Secret record. */
    expectedCredentialRevision: z.optional(ConnectedServiceCredentialRevisionV1Schema),
  }),
  'connectedServices.catalog.list': z.strictObject({}),
  'connectedServices.configuration.get': lazyZodSchema(() => z.union([ConfigurationTarget, MachineConfigurationTarget])),
  'connectedServices.configuration.replace': lazyZodSchema(() => z.union([
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(ConfigurationTarget, ConfigurationReplacement.shape)),
    (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MachineConfigurationTarget, ConfigurationReplacement.shape)),
  ])),
  'connectedServices.billing.open': z.strictObject({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), machineId: z.string().check(z.trim(), z.minLength(1)) }),
  'connectedServices.subscription.price.set': z.strictObject({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), price: lazyZodSchema(() => z.nullable(z.omit(ProviderAccountSubscriptionMonthlyPriceV1Schema, { enteredAtMs: true }))) }),
  'connectedServices.accounts.rename': z.strictObject({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), label: z.nullable(z.string()) }),
  'connectedServices.accounts.revoke': lazyZodSchema(() => z.extend(z.omit(ConnectedAccountRevokeCommandV1Schema, { operation: true }), { machineId: z.string().check(z.trim(), z.minLength(1)) })),
  'connectedServices.accounts.default.set': z.strictObject({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), agentId: z.string().check(z.trim(), z.minLength(1)), makeDefault: z.boolean(), machineId: z.optional(z.string().check(z.trim(), z.minLength(1))) }),
  'connectedServices.accounts.purposeDefault.set': z.strictObject({
    agentId: z.string().check(z.trim(), z.minLength(1)), service: QualifiedConnectedAccountGroupRefSchema.shape.service,
    purpose: z.optional(QualifiedConnectedAccountPurposeV1Schema.shape.purpose),
    selection: ConnectedServiceBindingSelectionV2Schema, teamId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    machineId: z.optional(z.string().check(z.trim(), z.minLength(1))), onlyIfUnset: z.optional(z.boolean()),
  }).check(z.superRefine((input, context) => {
    if (input.selection.source === 'team_resource' && !input.teamId) {
      context.addIssue({ code: 'custom', path: ['teamId'], message: 'Shared-resource defaults require their Team' });
    }
    if (input.selection.source !== 'team_resource' && input.teamId !== undefined) {
      context.addIssue({ code: 'custom', path: ['teamId'], message: 'Team belongs only to a shared-resource default' });
    }
  })),
  'connectedServices.purposes.default.set': z.strictObject({
    machineId: z.optional(z.string().check(z.trim(), z.minLength(1))), purpose: QualifiedConnectedAccountPurposeV1Schema,
    target: QualifiedConnectedAccountPurposeBindingTargetV1Schema,
  }),
  'connectedServices.pools.create': lazyZodSchema(() => z.extend(QualifiedConnectedAccountGroupCreateV4Schema, { group: z.omit(QualifiedConnectedAccountGroupCreateV4Schema.shape.group, { state: true }) })),
  'connectedServices.pools.patch': lazyZodSchema(() => z.omit(QualifiedConnectedAccountGroupPatchV4Schema, { state: true, overrideRuntimeCooldown: true })),
  'connectedServices.pools.delete': QualifiedConnectedAccountGroupDeleteV4Schema,
  'connectedServices.pools.members.add': lazyZodSchema(() => z.omit(QualifiedConnectedAccountGroupMemberMutationV4Schema, { state: true })),
  'connectedServices.pools.members.patch': lazyZodSchema(() => z.omit(QualifiedConnectedAccountGroupMemberMutationV4Schema, { state: true })),
  'connectedServices.pools.members.remove': QualifiedConnectedAccountGroupMemberDeleteV4Schema,
  'connectedServices.pools.switchNow': QualifiedConnectedAccountGroupActiveAccountV4Schema,
  'connectedServices.pools.reorder': z.union([
    z.strictObject({ group: QualifiedConnectedAccountGroupRefSchema, accountIds: z.array(z.string().check(z.minLength(1))) }),
    z.strictObject({ group: QualifiedConnectedAccountGroupRefSchema, move: z.strictObject({ accountId: z.string().check(z.trim(), z.minLength(1)), position: AnchoredListPositionV1Schema }) }),
  ]),
  'connectedServices.pools.default.set': z.strictObject({ group: QualifiedConnectedAccountGroupRefSchema, agentId: z.string().check(z.trim(), z.minLength(1)), makeDefault: z.boolean(), machineId: z.optional(z.string().check(z.trim(), z.minLength(1))) }),
  'connectedServices.quota.reset': z.strictObject({ machineId: z.string().check(z.trim(), z.minLength(1)), serviceId: ConnectedServiceIdSchema, profileId: ConnectedServiceProfileIdSchema, providerCreditId: z.optional(z.string().check(z.trim(), z.minLength(1))), sourceSnapshotFetchedAtMs: z.optional(z.nullable(z.number().check(z.int(), z.nonnegative()))) }),
  'connectedServices.quota.refresh': z.strictObject({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), machineId: z.string().check(z.trim(), z.minLength(1)) }),
  'connectedServices.quota.get': ConnectedServiceQuotaGetInputV1Schema,
  'connectedServices.pools.selection.get': ConnectedServicePoolSelectionGetRequestV1Schema,
  'connectedServices.identityPrivacy.set': z.strictObject({ hidden: z.boolean() }),
  'connectedServices.acknowledgements.set': z.strictObject({ subject: QualifiedAcknowledgementSubjectSchema, acknowledged: z.boolean() }),
  'connectedServices.labels.set': z.strictObject({ subject: QualifiedConnectedEntityRefSchema, label: z.string() }),
  'connectedServices.labels.reset': z.strictObject({ subject: QualifiedConnectedEntityRefSchema }),
  'connectedServices.acknowledgements.reset': z.strictObject({ subject: QualifiedAcknowledgementSubjectSchema }),
  'connectedServices.disclosure.set': z.strictObject({ subject: QualifiedConnectedDisclosureSubjectSchema, collapsed: z.boolean() }),
  'connectedServices.disclosure.reset': z.strictObject({ subject: QualifiedConnectedDisclosureSubjectSchema }),
} as const;
export const CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 = {
  ...CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_OUTPUT_SCHEMAS,
  'connectedServices.accounts.credentials.save': z.strictObject({ applied: z.literal(true), account: asProtocolZod(QualifiedConnectedAccountRefSchema) }),
  'connectedServices.accounts.list': lazyZodSchema(() => z.strictObject({
    accounts: z.array(z.strictObject({ account: QualifiedConnectedAccountProfileV4Schema, health: z.enum(['healthy', 'attention', 'error']) })),
    pools: z.array(z.strictObject({ pool: QualifiedConnectedAccountGroupV4Schema, health: z.nullable(z.enum(['healthy', 'attention', 'error'])) })),
    source: z.strictObject({ completeness: z.literal('complete'), observedAtMs: z.nullable(z.number().check(z.int(), z.nonnegative())) }),
    healthBasis: z.literal('credentials'),
  })),
  'connectedServices.catalog.list': lazyZodSchema(() => z.strictObject({
    status: z.enum(['ready', 'partial', 'unavailable']),
    services: z.array(z.strictObject({ service: QualifiedConnectedAccountGroupRefSchema.shape.service,
      descriptor: z.nullable(ConnectedAccountUiProjectionEntryV1Schema), canAdd: z.boolean(), reason: z.nullable(z.string()),
    })),
    gateways: z.array(ProviderGatewayContributionV1Schema),
  })),
  'connectedServices.configuration.get': z.strictObject({ target: ConnectedAccountConfigurationTargetSchema,
    mode: PluginConnectedAccountAuthenticationModeV2Schema, configuration: ConfigurationView }),
  'connectedServices.configuration.replace': z.extend(Success, { revision: z.string().check(z.minLength(1), z.maxLength(256)) }),
  'connectedServices.billing.open': z.strictObject({ opened: z.literal(true) }),
  'connectedServices.subscription.price.set': Success,
  'connectedServices.accounts.rename': Success,
  'connectedServices.accounts.revoke': RevokeActionResponse,
  'connectedServices.accounts.default.set': Success,
  'connectedServices.accounts.purposeDefault.set': z.extend(Success, { changed: z.optional(z.literal(false)) }),
  'connectedServices.purposes.default.set': Success,
  'connectedServices.pools.create': QualifiedConnectedAccountGroupResponseV4Schema,
  'connectedServices.pools.patch': QualifiedConnectedAccountGroupResponseV4Schema,
  'connectedServices.pools.delete': MetadataCleanupSuccess,
  'connectedServices.pools.members.add': QualifiedConnectedAccountGroupResponseV4Schema,
  'connectedServices.pools.members.patch': QualifiedConnectedAccountGroupResponseV4Schema,
  'connectedServices.pools.members.remove': QualifiedConnectedAccountGroupResponseV4Schema,
  'connectedServices.pools.switchNow': Success,
  'connectedServices.pools.reorder': Success,
  'connectedServices.pools.default.set': Success,
  'connectedServices.quota.reset': ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema,
  'connectedServices.quota.refresh': Success,
  'connectedServices.quota.get': ConnectedServiceQuotaGetResultV1Schema,
  'connectedServices.pools.selection.get': ConnectedServicePoolSelectionGetResponseV1Schema,
  'connectedServices.identityPrivacy.set': Success,
  'connectedServices.acknowledgements.set': Success,
  'connectedServices.labels.set': Success,
  'connectedServices.labels.reset': Success,
  'connectedServices.acknowledgements.reset': Success,
  'connectedServices.disclosure.set': Success,
  'connectedServices.disclosure.reset': Success,
} as const;

/** Service configuration is Account-owned; account/attempt targets stay on their exact daemon. */
export function isConnectedServiceConfigurationMachineRequiredV1(
  actionId: 'connectedServices.configuration.get' | 'connectedServices.configuration.replace', input: unknown,
): boolean {
  return 'target' in CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
}

/** The member ladder shared by add, UI drag/keyboard reorder and Action reorder. */
export const CONNECTED_SERVICE_POOL_MEMBER_PRIORITY_STEP = 100;

/** Both presentation and semantic moves use the same deterministic priority ladder. */
export function compareConnectedServicePoolMemberOrderV1(
  left: Readonly<{ accountId: string; priority: number }>,
  right: Readonly<{ accountId: string; priority: number }>,
): number {
  return left.priority - right.priority || left.accountId.localeCompare(right.accountId);
}

export async function reorderConnectedServicePoolMembersV1<TGroup>(input: Readonly<{
  group: TGroup;
  members(group: TGroup): readonly Readonly<{ accountId: string; priority: number }>[];
  patch(group: TGroup, accountId: string, priority: number): Promise<TGroup | null>;
}> & (Readonly<{ accountIds: readonly string[] }> | Readonly<{ move: Readonly<{ accountId: string; position: AnchoredListPositionV1 }> }>)): Promise<TGroup | null> {
  const members = input.members(input.group);
  const accountIds = 'move' in input
    ? resolveAnchoredListMoveV1([...members].sort(compareConnectedServicePoolMemberOrderV1).map(member => member.accountId), input.move.accountId, input.move.position)
    : input.accountIds;
  const ids = new Set(accountIds);
  if (!accountIds || ids.size !== accountIds.length || ids.size !== members.length || members.some((member) => !ids.has(member.accountId))) {
    throw Object.assign(new Error('invalid_pool_member_order'), { code: 'invalid_pool_member_order' });
  }
  let current = input.group;
  for (const [index, accountId] of accountIds.entries()) {
    const priority = (index + 1) * CONNECTED_SERVICE_POOL_MEMBER_PRIORITY_STEP;
    if (input.members(current).find((member) => member.accountId === accountId)?.priority === priority) continue;
    const next = await input.patch(current, accountId, priority);
    if (!next) return null;
    current = next;
  }
  return current;
}
