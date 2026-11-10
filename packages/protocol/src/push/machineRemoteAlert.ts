import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AttentionPreviewBehaviorSchema } from '../account/settings/attentionDeliveryPolicy.js';

/** Content-free Machine alert; names are enriched only by the authenticated device. */
export const MachineRemoteAlertV1Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('machine_alert'),
  v: z.literal(1),
  serverId: z.string().check(z.trim(), z.minLength(1)),
  accountId: z.string().check(z.trim(), z.minLength(1)),
  machineId: z.string().check(z.trim(), z.minLength(1)),
  phase: z.enum(['offline', 'recovered']),
  previewBehavior: AttentionPreviewBehaviorSchema,
}));
export type MachineRemoteAlertV1 = z.infer<typeof MachineRemoteAlertV1Schema>;

/** The existing notice is updated or dismissed on recovery, never a new alert. */
export function resolveMachineRemoteAlertNotificationIdV1(alert: MachineRemoteAlertV1): string {
  return `machine_alert:${alert.serverId}:${alert.accountId}:${alert.machineId}`;
}
