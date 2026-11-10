import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { PluginIdSchema } from '../pluginId.js';
import { asProtocolZod } from "../actions/internalProtocolZodAdapter.js";
import { ManagedResourceDependencyV1Schema, ManagedResourceDispositionV1Schema } from '../../machines/managed/managedDependencyV1.js';

/**
 * The present-user Action may choose a plugin's Account-scoped data, but never
 * chooses an Account. The authenticated server route stamps that authority.
 */
export const PluginAccountDataEraseActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  pluginId: asProtocolZod(PluginIdSchema),
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
}));
export type PluginAccountDataEraseActionInputV1 = z.infer<typeof PluginAccountDataEraseActionInputV1Schema>;

export const PluginAccountDataEraseSettingsArmResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('completed'),
    changed: z.boolean(),
  }),
  z.strictObject({
    status: z.literal('pending'),
    reason: z.enum(['conflict', 'unavailable', 'outcome-unknown']),
  }),
  z.strictObject({
    status: z.literal('failed'),
    reason: z.literal('unexpected'),
  }),
]));
export type PluginAccountDataEraseSettingsArmResultV1 = z.infer<typeof PluginAccountDataEraseSettingsArmResultV1Schema>;

export const PluginAccountDataEraseDataArmResultV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('reviewRequired'),
    resources: z.array(ManagedResourceDependencyV1Schema),
  }),
  z.strictObject({
    status: z.literal('completed'),
    changed: z.boolean(),
  }),
  z.strictObject({
    status: z.literal('pending'),
    reason: z.enum(['unavailable', 'transition-cleanup', 'outcome-unknown']),
  }),
  z.strictObject({
    status: z.literal('failed'),
    reason: z.enum(['account-not-found', 'request-rejected', 'invalid-response']),
  }),
]));
export type PluginAccountDataEraseDataArmResultV1 = z.infer<typeof PluginAccountDataEraseDataArmResultV1Schema>;

export const PluginAccountDataEraseActionOutputV1Schema = lazyZodSchema(() => z.union([z.strictObject({
  status: z.enum(['completed', 'partial', 'failed']),
  settings: PluginAccountDataEraseSettingsArmResultV1Schema,
  data: PluginAccountDataEraseDataArmResultV1Schema,
}).check(z.superRefine((value, context) => {
  if (value.data.status === 'reviewRequired') {
    context.addIssue({
      code: "custom",
      path: ['data'],
      message: 'Managed resource review must settle before the Settings erase arm starts.',
    });
  }
  const armStatuses = [value.settings.status, value.data.status];
  const expectedStatus = armStatuses.every((status) => status === 'completed')
    ? 'completed'
    : armStatuses.every((status) => status === 'failed')
      ? 'failed'
      : 'partial';
  if (value.status !== expectedStatus) {
    context.addIssue({
      code: "custom",
      path: ['status'],
      message: 'Overall Account plugin data erase status must reflect both destination arms.',
    });
  }
})), z.strictObject({
  status: z.literal('reviewRequired'),
  resources: z.array(ManagedResourceDependencyV1Schema),
})]));
export type PluginAccountDataEraseActionOutputV1 = z.infer<typeof PluginAccountDataEraseActionOutputV1Schema>;

/** One authenticated Data route; its caller never supplies an Account id. */
export const PLUGIN_ACCOUNT_DATA_ERASE_HTTP_PATH_V1 = '/v1/plugins/data/account-erase';

export const PluginAccountDataEraseServerOutputV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('erased'), changed: z.boolean() }),
  z.strictObject({ status: z.literal('transition-cleanup-pending') }),
  z.strictObject({ status: z.literal('account-not-found') }),
]));
export type PluginAccountDataEraseServerOutputV1 = z.infer<typeof PluginAccountDataEraseServerOutputV1Schema>;

export const PluginAccountDataEraseServerErrorV1Schema = lazyZodSchema(() => z.discriminatedUnion('error', [
  z.strictObject({
    error: z.literal('managed_resources_review_required'),
    resources: z.array(ManagedResourceDependencyV1Schema),
  }),
  z.strictObject({
    error: z.literal('plugin_account_data_erase_invalid'),
  }),
  z.strictObject({
    error: z.literal('plugin_account_data_erase_present_user_required'),
  }),
]));
export type PluginAccountDataEraseServerErrorV1 = z.infer<typeof PluginAccountDataEraseServerErrorV1Schema>;
