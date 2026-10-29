import { ACCOUNT_LIFECYCLE_ACTION_IDS } from './accountLifecycleActionIdsV1.js';
export { ACCOUNT_LIFECYCLE_ACTION_IDS } from './accountLifecycleActionIdsV1.js';
import { z } from 'zod/mini';
export type AccountLifecycleActionId = typeof ACCOUNT_LIFECYCLE_ACTION_IDS[number];
const target = z.strictObject({ serverId: z.string().check(z.trim(), z.minLength(1)), accountId: z.string().check(z.trim(), z.minLength(1)) });
export const ACCOUNT_LIFECYCLE_ACTION_INPUT_SCHEMAS = {
  'account.signOut': target,
  'account.credentials.forgetAll': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(target, { scope: z.literal('all-credentials') })),
  'account.delete': target,
} as const;
export const ACCOUNT_LIFECYCLE_ACTION_OUTPUT_SCHEMAS = {
  'account.signOut': z.strictObject({ status: z.enum(['signed_out', 'cancelled']) }),
  'account.credentials.forgetAll': z.strictObject({ status: z.enum(['forgotten', 'cancelled']) }),
  'account.delete': z.strictObject({ status: z.enum(['deleted', 'deleted_cleanup_pending', 'cancelled']) }),
} as const;
export type AccountLifecycleActionInput = z.infer<(typeof ACCOUNT_LIFECYCLE_ACTION_INPUT_SCHEMAS)[AccountLifecycleActionId]>;
export function isAccountLifecycleActionId(id: string): id is AccountLifecycleActionId {
  return (ACCOUNT_LIFECYCLE_ACTION_IDS as readonly string[]).includes(id);
}
