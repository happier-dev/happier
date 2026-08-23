import { z } from 'zod';

export const BrowserAutomationErrorCodeV1Schema = z.enum([
  /**
   * A mutating automation action is already in flight for this view. This is the single-flight
   * denial and the only concurrency arbitration in the corridor; it replaced the `lease_*` codes
   * of the removed action-lease system, which no code path could ever mint.
   */
  'automation_busy',
  'blocked_by_policy',
  'cross_origin_frame_unavailable',
  'human_interrupted',
  'navigation_mismatch',
  'not_implemented',
  'owner_conflict',
  'owner_disconnected',
  'owner_mismatch',
  'page_thread_blocked',
  'policy_denied',
  'runtime_unavailable',
  'selector_not_found',
  'stale_navigation',
  'timed_out',
  'unsupported_action',
  'user_canceled',
  'view_closed',
]);
export type BrowserAutomationErrorCodeV1 = z.infer<typeof BrowserAutomationErrorCodeV1Schema>;
