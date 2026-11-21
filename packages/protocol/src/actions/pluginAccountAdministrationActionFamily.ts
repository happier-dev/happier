import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginIdSchema } from '../plugins/pluginId.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginAccountPluginIntentV1Schema, PluginProjectScopeV1Schema } from '../plugins/availability/accountIntentV1.js';
import { PluginReleaseRefV1Schema } from '../plugins/availability/releaseRefV1.js';
import { PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_IDS, PLUGIN_PROJECT_SCOPE_SET_ACTION_ID } from './pluginAccountAdministrationActionIds.js';
export { PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_IDS } from './pluginAccountAdministrationActionIds.js';
export type { PluginAccountAdministrationActionId } from './pluginAccountAdministrationActionIds.js';

export const PluginAccountAdministrationActionIdSchema = lazyZodSchema(() => z.enum(PLUGIN_ACCOUNT_ADMINISTRATION_ACTION_IDS));

const pluginId = asProtocolZod(PluginIdSchema);
const target = lazyZodSchema(() => z.strictObject({ pluginId }));
// An optional exact daemon source is only a candidate. Availability's existing
// selector validates its release/materialization correspondence before use.
const daemon = lazyZodSchema(() => z.strictObject({
  serverId: z.nullable(z.string().check(z.minLength(1))),
  serverIdentityId: z.nullable(z.string().check(z.minLength(1))),
  machineId: z.nullable(z.string().check(z.minLength(1))),
}));
export const PluginAccountAdministrationActionInputSchemas = {
  'plugins.account.release.select': lazyZodSchema(() => z.strictObject({ pluginId,
    version: PluginReleaseRefV1Schema.shape.version, daemon: z.optional(daemon) })),
  'plugins.account.hosting.set': lazyZodSchema(() => z.strictObject({ pluginId, enabled: z.boolean() })),
  'plugins.account.hosting.remove': target,
  'plugins.account.cache.clear': target,
  [PLUGIN_PROJECT_SCOPE_SET_ACTION_ID]: lazyZodSchema(() => z.strictObject({
    pluginId, projectScope: z.nullable(PluginProjectScopeV1Schema),
    expectedRevision: z.nullable(PluginAccountPluginIntentV1Schema.shape.revision),
  })),
} as const;

const hostingResult = lazyZodSchema(() => z.strictObject({ kind: z.enum(['updated', 'conflict', 'unavailable']) }));
export const PluginAccountAdministrationActionOutputSchemas = {
  'plugins.account.release.select': lazyZodSchema(() => z.union([
    z.strictObject({ kind: z.literal('selected'), intent: PluginAccountPluginIntentV1Schema }),
    z.strictObject({ kind: z.literal('cancelled') }),
    z.strictObject({ kind: z.literal('conflict'), code: z.literal('intent_revision_conflict') }),
    z.strictObject({ kind: z.literal('unavailable'), code: z.enum([
      'target_release_unavailable', 'source_release_unavailable', 'source_release_changed',
      'target_contract_mismatch', 'candidate_preparation_unavailable', 'intent_set_unavailable',
    ]) }),
    z.strictObject({ kind: z.literal('rejected'), code: z.literal('intent_set_rejected') }),
  ])),
  'plugins.account.hosting.set': hostingResult,
  'plugins.account.hosting.remove': hostingResult,
  'plugins.account.cache.clear': lazyZodSchema(() => z.strictObject({ kind: z.enum(['updated', 'unavailable']) })),
  [PLUGIN_PROJECT_SCOPE_SET_ACTION_ID]: lazyZodSchema(() => z.strictObject({
    kind: z.enum(['updated', 'conflict', 'unavailable', 'rejected']),
  })),
} as const;
