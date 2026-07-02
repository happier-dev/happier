import {
  DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE,
  SessionPendingQueueDrainModeSchema,
  type AccountSettings,
  type SessionPendingQueueDrainMode,
} from '@happier-dev/protocol';

export const PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE = 1;
export const PENDING_QUEUE_DRAIN_ALL_MAX_POP_PER_WAKE = 25;

export function resolveSessionPendingQueueDrainMode(
  settings: Pick<AccountSettings, 'sessionPendingQueueDrainMode'> | null | undefined,
): SessionPendingQueueDrainMode {
  const parsed = SessionPendingQueueDrainModeSchema.safeParse(settings?.sessionPendingQueueDrainMode);
  return parsed.success ? parsed.data : DEFAULT_SESSION_PENDING_QUEUE_DRAIN_MODE;
}

export function resolveSessionPendingQueueMaxPopPerWake(
  settings: Pick<AccountSettings, 'sessionPendingQueueDrainMode'> | null | undefined,
): number {
  return resolveSessionPendingQueueDrainMode(settings) === 'drain_all'
    ? PENDING_QUEUE_DRAIN_ALL_MAX_POP_PER_WAKE
    : PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE;
}
