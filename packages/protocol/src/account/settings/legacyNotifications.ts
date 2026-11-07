import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

export const ForegroundBehaviorSchema = lazyZodSchema(() => z.enum(['full', 'silent', 'off']));
export type ForegroundBehavior = z.infer<typeof ForegroundBehaviorSchema>;

function normalizeNotificationsSettingsV1Input(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'connectedServiceQuotaRecovered')
    && record.connectedServiceQuotaBlocked === false) {
    return { ...record, connectedServiceQuotaRecovered: false };
  }
  return raw;
}

export const NotificationsSettingsV1Schema = lazyZodSchema(() => z.catch((<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform(normalizeNotificationsSettingsV1Input), z.object({
  v: z._default(z.literal(1), 1),
  pushEnabled: z._default(z.boolean(), true),
  mutePhoneWhenComputerFocused: z.catch(z.optional(z.boolean()), undefined),
  ready: z._default(z.boolean(), true),
  readyIncludeMessageText: z._default(z.boolean(), true),
  requestIncludeMessageText: z._default(z.boolean(), true),
  permissionRequest: z._default(z.boolean(), true),
  userActionRequest: z._default(z.boolean(), true),
  connectedServiceAccountSwitch: z._default(z.boolean(), true),
  connectedServiceQuotaBlocked: z._default(z.boolean(), true),
  connectedServiceQuotaRecovered: z._default(z.boolean(), true),
  foregroundBehavior: z._default(ForegroundBehaviorSchema, 'full'),
})), {
  v: 1,
  pushEnabled: true,
  ready: true,
  readyIncludeMessageText: true,
  requestIncludeMessageText: true,
  permissionRequest: true,
  userActionRequest: true,
  connectedServiceAccountSwitch: true,
  connectedServiceQuotaBlocked: true,
  connectedServiceQuotaRecovered: true,
  foregroundBehavior: 'full',
}));

export type NotificationsSettingsV1 = z.infer<typeof NotificationsSettingsV1Schema>;
export const DEFAULT_NOTIFICATIONS_SETTINGS_V1: NotificationsSettingsV1 = NotificationsSettingsV1Schema.parse({});
