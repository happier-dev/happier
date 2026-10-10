import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
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
import { ConnectedMetadataCleanupV1Schema } from './connectedAccountPresentationSchemasV1.js';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1 } from './configurationActionIdsV1.js';
import { ConnectedServiceQuotaGetInputV1Schema, ConnectedServiceQuotaGetResultV1Schema } from './providerAccountUsageHistorySchemasV1.js';
import { ConnectedServicePoolSelectionGetRequestV1Schema, ConnectedServicePoolSelectionGetResponseV1Schema } from './connectedServicePoolSelection.js';
import { QualifiedAcknowledgementSubjectSchema, QualifiedConnectedDisclosureSubjectSchema, QualifiedConnectedEntityRefSchema } from './connectedAccountPresentationSchemasV1.js';
import { ProviderAccountSubscriptionMonthlyPriceV1Schema } from './accountSubscription.js';
import { CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_INPUT_SCHEMAS, CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_OUTPUT_SCHEMAS } from './authenticationActionsV1.js';
import { QualifiedConnectedAccountPurposeV1Schema } from './connectedAccountPurposeIdentity.js';
import { QualifiedConnectedAccountPurposeBindingTargetV1Schema } from './connectedAccountPurposeBindings.js';
export { CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1 } from './configurationActionIdsV1.js';
export { CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_ID_BY_OPERATION } from './configurationActionIdsV1.js';

export const ConnectedServiceConfigurationActionIdV1Schema = lazyZodSchema(() => z.enum(CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1));
export type ConnectedServiceConfigurationActionIdV1 = z.infer<typeof ConnectedServiceConfigurationActionIdV1Schema>;

const Success = z.object({ applied: z.literal(true) }).strict();
const MetadataCleanupSuccess = Success.extend({ metadataCleanup: z.optional(ConnectedMetadataCleanupV1Schema) });
const RevokeActionResponse = lazyZodSchema(() => z.union([
  ConnectedAccountRevokeResponseV1Schema,
  ConnectedAccountRevokedResponseV1Schema.extend({ metadataCleanup: z.optional(ConnectedMetadataCleanupV1Schema) }),
]));
const ConfigurationTarget = ConnectedAccountServiceConfigurationEntryV1Schema.pick({ service: true, modeId: true });
const MachineConfigurationTarget = lazyZodSchema(() => z.object({
  machineId: z.string().trim().min(1),
  target: z.union([ConnectedAccountControlTargetSchema.options[1], ConnectedAccountControlTargetSchema.options[2]]),
}).strict());
const ConfigurationReplacement = z.object({ expectedRevision: z.string().min(1).max(256).nullable(),
  values: ConnectedAccountServiceConfigurationEntryV1Schema.shape.values,
  secretValues: z.record(z.string(), z.string().min(1).max(64 * 1024)) });
const ConfigurationView = z.object({ status: z.enum(['ready', 'configurationRequired']), revision: z.string().nullable(),
  values: ConnectedAccountServiceConfigurationEntryV1Schema.shape.values, configuredSecretFieldIds: z.array(z.string()),
  missingFieldIds: z.array(z.string()) }).strict();
export const CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1 = {
  ...CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_INPUT_SCHEMAS,
  'connectedServices.configuration.get': lazyZodSchema(() => z.union([ConfigurationTarget, MachineConfigurationTarget])),
  'connectedServices.configuration.replace': lazyZodSchema(() => z.union([
    ConfigurationTarget.extend(ConfigurationReplacement.shape).strict(),
    MachineConfigurationTarget.extend(ConfigurationReplacement.shape).strict(),
  ])),
  'connectedServices.billing.open': z.object({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), machineId: z.string().trim().min(1) }).strict(),
  'connectedServices.subscription.price.set': z.object({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), price: ProviderAccountSubscriptionMonthlyPriceV1Schema.omit({ enteredAtMs: true }).nullable() }).strict(),
  'connectedServices.accounts.rename': z.object({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), label: z.string().nullable() }).strict(),
  'connectedServices.accounts.revoke': ConnectedAccountRevokeCommandV1Schema.omit({ operation: true }).extend({ machineId: z.string().trim().min(1) }),
  'connectedServices.accounts.default.set': z.object({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), agentId: z.string().trim().min(1), makeDefault: z.boolean(), machineId: z.string().trim().min(1).optional() }).strict(),
  'connectedServices.accounts.purposeDefault.set': z.object({
    agentId: z.string().trim().min(1), service: QualifiedConnectedAccountGroupRefSchema.shape.service,
    purpose: QualifiedConnectedAccountPurposeV1Schema.shape.purpose.optional(),
    selection: ConnectedServiceBindingSelectionV2Schema, teamId: z.string().trim().min(1).optional(),
    machineId: z.string().trim().min(1).optional(), onlyIfUnset: z.boolean().optional(),
  }).strict().superRefine((input, context) => {
    if (input.selection.source === 'team_resource' && !input.teamId) {
      context.addIssue({ code: 'custom', path: ['teamId'], message: 'Shared-resource defaults require their Team' });
    }
    if (input.selection.source !== 'team_resource' && input.teamId !== undefined) {
      context.addIssue({ code: 'custom', path: ['teamId'], message: 'Team belongs only to a shared-resource default' });
    }
  }),
  'connectedServices.purposes.default.set': z.object({
    machineId: z.string().trim().min(1), purpose: QualifiedConnectedAccountPurposeV1Schema,
    target: QualifiedConnectedAccountPurposeBindingTargetV1Schema,
  }).strict(),
  'connectedServices.pools.create': QualifiedConnectedAccountGroupCreateV4Schema.extend({ group: QualifiedConnectedAccountGroupCreateV4Schema.shape.group.omit({ state: true }) }),
  'connectedServices.pools.patch': QualifiedConnectedAccountGroupPatchV4Schema.omit({ state: true, overrideRuntimeCooldown: true }),
  'connectedServices.pools.delete': QualifiedConnectedAccountGroupDeleteV4Schema,
  'connectedServices.pools.members.add': QualifiedConnectedAccountGroupMemberMutationV4Schema.omit({ state: true }),
  'connectedServices.pools.members.patch': QualifiedConnectedAccountGroupMemberMutationV4Schema.omit({ state: true }),
  'connectedServices.pools.members.remove': QualifiedConnectedAccountGroupMemberDeleteV4Schema,
  'connectedServices.pools.switchNow': QualifiedConnectedAccountGroupActiveAccountV4Schema,
  'connectedServices.pools.reorder': z.union([
    z.object({ group: QualifiedConnectedAccountGroupRefSchema, accountIds: z.array(z.string().min(1)) }).strict(),
    z.object({ group: QualifiedConnectedAccountGroupRefSchema, move: z.object({ accountId: z.string().trim().min(1), position: AnchoredListPositionV1Schema }).strict() }).strict(),
  ]),
  'connectedServices.pools.default.set': z.object({ group: QualifiedConnectedAccountGroupRefSchema, agentId: z.string().trim().min(1), makeDefault: z.boolean(), machineId: z.string().trim().min(1).optional() }).strict(),
  'connectedServices.quota.reset': z.object({ machineId: z.string().trim().min(1), serviceId: ConnectedServiceIdSchema, profileId: ConnectedServiceProfileIdSchema, providerCreditId: z.string().trim().min(1).optional(), sourceSnapshotFetchedAtMs: z.number().int().nonnegative().nullable().optional() }).strict(),
  'connectedServices.quota.refresh': z.object({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), machineId: z.string().trim().min(1) }).strict(),
  'connectedServices.quota.get': ConnectedServiceQuotaGetInputV1Schema,
  'connectedServices.pools.selection.get': ConnectedServicePoolSelectionGetRequestV1Schema,
  'connectedServices.identityPrivacy.set': z.object({ hidden: z.boolean() }).strict(),
  'connectedServices.acknowledgements.set': z.object({ subject: QualifiedAcknowledgementSubjectSchema, acknowledged: z.boolean() }).strict(),
  'connectedServices.labels.set': z.object({ subject: QualifiedConnectedEntityRefSchema, label: z.string() }).strict(),
  'connectedServices.labels.reset': z.object({ subject: QualifiedConnectedEntityRefSchema }).strict(),
  'connectedServices.acknowledgements.reset': z.object({ subject: QualifiedAcknowledgementSubjectSchema }).strict(),
  'connectedServices.disclosure.set': z.object({ subject: QualifiedConnectedDisclosureSubjectSchema, collapsed: z.boolean() }).strict(),
  'connectedServices.disclosure.reset': z.object({ subject: QualifiedConnectedDisclosureSubjectSchema }).strict(),
} as const;
export const CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 = {
  ...CONNECTED_ACCOUNT_AUTHENTICATION_ACTION_OUTPUT_SCHEMAS,
  'connectedServices.configuration.get': z.object({ target: ConnectedAccountConfigurationTargetSchema,
    mode: PluginConnectedAccountAuthenticationModeV2Schema, configuration: ConfigurationView }).strict(),
  'connectedServices.configuration.replace': Success.extend({ revision: z.string().min(1).max(256) }),
  'connectedServices.billing.open': z.object({ opened: z.literal(true) }).strict(),
  'connectedServices.subscription.price.set': Success,
  'connectedServices.accounts.rename': Success,
  'connectedServices.accounts.revoke': RevokeActionResponse,
  'connectedServices.accounts.default.set': Success,
  'connectedServices.accounts.purposeDefault.set': Success.extend({ changed: z.literal(false).optional() }),
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
