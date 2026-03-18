import type { ManagedConnectionTimingPolicy } from './managedConnectionTypes.js';

export const DEFAULT_MANAGED_CONNECTION_POLICY = {
  initialFastRetryDelayMs: 250,
  maxFastRetries: 1,
  backoffMinMs: 1_000,
  backoffMaxMs: 60_000,
  jitterRatio: 0.2,
} satisfies ManagedConnectionTimingPolicy;
