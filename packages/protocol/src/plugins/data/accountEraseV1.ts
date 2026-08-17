import { z } from 'zod';

import { PluginIdSchema } from '../pluginId.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";

/**
 * The present-user Action may choose a plugin's Account-scoped data, but never
 * chooses an Account. The authenticated server route stamps that authority.
 */
export const PluginAccountDataEraseActionInputV1Schema = z.object({
  pluginId: asProtocolZod(PluginIdSchema),
}).strict();
export type PluginAccountDataEraseActionInputV1 = z.infer<typeof PluginAccountDataEraseActionInputV1Schema>;

export const PluginAccountDataEraseSettingsArmResultV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    changed: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal('pending'),
    reason: z.enum(['conflict', 'unavailable']),
  }).strict(),
  z.object({
    status: z.literal('failed'),
    reason: z.literal('unexpected'),
  }).strict(),
]);
export type PluginAccountDataEraseSettingsArmResultV1 = z.infer<typeof PluginAccountDataEraseSettingsArmResultV1Schema>;

export const PluginAccountDataEraseDataArmResultV1Schema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('completed'),
    changed: z.boolean(),
  }).strict(),
  z.object({
    status: z.literal('pending'),
    reason: z.enum(['unavailable', 'transition-cleanup']),
  }).strict(),
  z.object({
    status: z.literal('failed'),
    reason: z.enum(['account-not-found', 'request-rejected', 'invalid-response']),
  }).strict(),
]);
export type PluginAccountDataEraseDataArmResultV1 = z.infer<typeof PluginAccountDataEraseDataArmResultV1Schema>;

export const PluginAccountDataEraseActionOutputV1Schema = z.object({
  status: z.enum(['completed', 'partial', 'failed']),
  settings: PluginAccountDataEraseSettingsArmResultV1Schema,
  data: PluginAccountDataEraseDataArmResultV1Schema,
}).strict().superRefine((value, context) => {
  const armStatuses = [value.settings.status, value.data.status];
  const expectedStatus = armStatuses.every((status) => status === 'completed')
    ? 'completed'
    : armStatuses.every((status) => status === 'failed')
      ? 'failed'
      : 'partial';
  if (value.status !== expectedStatus) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['status'],
      message: 'Overall Account plugin data erase status must reflect both destination arms.',
    });
  }
});
export type PluginAccountDataEraseActionOutputV1 = z.infer<typeof PluginAccountDataEraseActionOutputV1Schema>;

/** One authenticated Data route; its caller never supplies an Account id. */
export const PLUGIN_ACCOUNT_DATA_ERASE_HTTP_PATH_V1 = '/v1/plugins/data/account-erase';

export const PluginAccountDataEraseServerOutputV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('erased'), changed: z.boolean() }).strict(),
  z.object({ status: z.literal('transition-cleanup-pending') }).strict(),
  z.object({ status: z.literal('account-not-found') }).strict(),
]);
export type PluginAccountDataEraseServerOutputV1 = z.infer<typeof PluginAccountDataEraseServerOutputV1Schema>;

export const PluginAccountDataEraseServerErrorV1Schema = z.discriminatedUnion('error', [
  z.object({
    error: z.literal('plugin_account_data_erase_invalid'),
  }).strict(),
  z.object({
    error: z.literal('plugin_account_data_erase_present_user_required'),
  }).strict(),
]);
export type PluginAccountDataEraseServerErrorV1 = z.infer<typeof PluginAccountDataEraseServerErrorV1Schema>;
