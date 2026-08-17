import { z } from 'zod';

/**
 * The currently published V3 state vocabulary. The additional terminal states
 * are intentionally accepted by the reader before their producer migration so
 * new clients can represent a current server without reinterpreting it.
 *
 * This portable leaf is also the canonical Host Event/update schema dependency;
 * those readers must not acquire the full Automation API and execution graph
 * merely to validate one state value.
 */
export const AutomationRunStateV3Schema = z.enum([
  'queued',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'dispatch_failed',
  'skipped',
  'missed',
  'outcome_uncertain',
]);
export type AutomationRunStateV3 = z.infer<typeof AutomationRunStateV3Schema>;
