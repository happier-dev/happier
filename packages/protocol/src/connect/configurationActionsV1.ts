import { z } from 'zod';
import { AnchoredListPositionV1Schema, resolveAnchoredListMoveV1, type AnchoredListPositionV1 } from '../actions/anchoredListOrderV1.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { QualifiedConnectedAccountRefSchema } from './qualifiedConnectedAccountPersistence.js';
import {
  QualifiedConnectedAccountGroupRefSchema, QualifiedConnectedAccountGroupActiveAccountV4Schema,
  QualifiedConnectedAccountGroupCreateV4Schema, QualifiedConnectedAccountGroupPatchV4Schema,
  QualifiedConnectedAccountGroupDeleteV4Schema, QualifiedConnectedAccountGroupMemberMutationV4Schema,
  QualifiedConnectedAccountGroupMemberDeleteV4Schema, QualifiedConnectedAccountGroupResponseV4Schema,
} from './qualifiedConnectedAccountsV4.js';
import { ConnectedServiceIdSchema, ConnectedServiceProfileIdSchema } from './connectedServiceBindings.js';
import { ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema } from '../sessions/work/state/sessionWorkStateRpc.js';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1 } from './configurationActionIdsV1.js';
export { CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1 } from './configurationActionIdsV1.js';

export const ConnectedServiceConfigurationActionIdV1Schema = z.enum(CONNECTED_SERVICE_CONFIGURATION_ACTION_IDS_V1);
export type ConnectedServiceConfigurationActionIdV1 = z.infer<typeof ConnectedServiceConfigurationActionIdV1Schema>;

const Success = z.object({ applied: z.literal(true) }).strict();
export const CONNECTED_SERVICE_CONFIGURATION_ACTION_INPUT_SCHEMAS_V1 = {
  'connectedServices.accounts.rename': z.object({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), label: z.string().nullable() }).strict(),
  'connectedServices.accounts.default.set': z.object({ account: asProtocolZod(QualifiedConnectedAccountRefSchema), agentId: z.string().trim().min(1), makeDefault: z.boolean(), machineId: z.string().trim().min(1).optional() }).strict(),
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
  'connectedServices.identityPrivacy.set': z.object({ hidden: z.boolean() }).strict(),
} as const;
export const CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 = {
  'connectedServices.accounts.rename': Success,
  'connectedServices.accounts.default.set': Success,
  'connectedServices.pools.create': QualifiedConnectedAccountGroupResponseV4Schema,
  'connectedServices.pools.patch': QualifiedConnectedAccountGroupResponseV4Schema,
  'connectedServices.pools.delete': Success,
  'connectedServices.pools.members.add': QualifiedConnectedAccountGroupResponseV4Schema,
  'connectedServices.pools.members.patch': QualifiedConnectedAccountGroupResponseV4Schema,
  'connectedServices.pools.members.remove': QualifiedConnectedAccountGroupResponseV4Schema,
  'connectedServices.pools.switchNow': Success,
  'connectedServices.pools.reorder': Success,
  'connectedServices.pools.default.set': Success,
  'connectedServices.quota.reset': ConnectedServiceQuotaRecoveryCreditConsumeResponseV1Schema,
  'connectedServices.quota.refresh': Success,
  'connectedServices.identityPrivacy.set': Success,
} as const;

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
