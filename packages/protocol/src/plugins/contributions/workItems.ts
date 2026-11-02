import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginNoticePageV1Schema } from '../../activity/accountNoticePageV1.js';
import { PluginClientExecutionPlatformsV1Schema, PluginClientExecutionReferenceV1Schema } from './clientExecution.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

/** V1 development author contract. All identity, routing and runtime objects are closed. */
export const PLUGIN_WORK_ITEMS_LOCAL_ID_V1 = 'work-items' as const;
const ItemId = lazyZodSchema(() => z.string().check(z.minLength(1)));
export const PluginWorkItemCategoryV1Schema = lazyZodSchema(() => z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled']));
export type PluginWorkItemCategoryV1 = z.infer<typeof PluginWorkItemCategoryV1Schema>;
export const PluginWorkItemsContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: z.literal(PLUGIN_WORK_ITEMS_LOCAL_ID_V1),
  client: PluginClientExecutionReferenceV1Schema,
  platforms: PluginClientExecutionPlatformsV1Schema,
  /** Same-plugin named Action; invocation still passes ordinary Action policy. */
  transitionAction: z.optional(asProtocolZod(PluginContributionLocalIdSchema)),
}));
export type PluginWorkItemsContributionV1 = z.infer<typeof PluginWorkItemsContributionV1Schema>;
export const PluginWorkItemV1Schema = lazyZodSchema(() => z.strictObject({
  title: z.string().check(z.minLength(1)),
  category: z.nullable(PluginWorkItemCategoryV1Schema),
  categoryLabel: z.optional(z.string().check(z.minLength(1))),
  parentItemId: z.optional(ItemId),
  parentTitle: z.optional(z.string().check(z.minLength(1))),
  linkedSessions: z.readonly(z.array(z.readonly(z.strictObject({ serverId: ItemId, sessionId: ItemId })))),
  page: z.optional(PluginNoticePageV1Schema),
  transitions: z.optional(z.readonly(z.array(z.readonly(z.strictObject({ id: ItemId, label: ItemId, category: PluginWorkItemCategoryV1Schema }))))),
}));
export type PluginWorkItemV1 = z.infer<typeof PluginWorkItemV1Schema>;
export const PluginWorkItemsResolveRequestV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({ serverId: ItemId, itemIds: z.readonly(z.array(ItemId)) })));
export type PluginWorkItemsResolveRequestV1 = z.infer<typeof PluginWorkItemsResolveRequestV1Schema>;
export const PluginWorkItemsResolveResultV1Schema = lazyZodSchema(() => z.record(ItemId, z.nullable(PluginWorkItemV1Schema)));
export type PluginWorkItemsResolveResultV1 = z.infer<typeof PluginWorkItemsResolveResultV1Schema>;
export const PluginWorkItemsFindLinkedRequestV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({ serverId: ItemId, sessionIds: z.readonly(z.array(ItemId)) })));
export type PluginWorkItemsFindLinkedRequestV1 = z.infer<typeof PluginWorkItemsFindLinkedRequestV1Schema>;
export const PluginWorkItemsFindLinkedResultV1Schema = lazyZodSchema(() => z.array(ItemId));
export const PluginWorkItemsWatchRequestV1Schema = lazyZodSchema(() => z.readonly(z.strictObject({ serverId: ItemId, itemIds: z.readonly(z.array(ItemId)), sessionIds: z.optional(z.readonly(z.array(ItemId))) })));
export type PluginWorkItemsWatchRequestV1 = z.infer<typeof PluginWorkItemsWatchRequestV1Schema>;
export const PluginWorkItemTransitionInputV1Schema = lazyZodSchema(() => z.strictObject({ serverId: ItemId, itemId: ItemId, transitionId: ItemId }));
export type PluginWorkItemTransitionInputV1 = z.infer<typeof PluginWorkItemTransitionInputV1Schema>;
