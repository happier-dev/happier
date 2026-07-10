import { z } from 'zod';

export const BrowserAutomationErrorCodeV1Schema = z.enum([
  'blocked_by_policy',
  'control_epoch_mismatch',
  'cross_origin_frame_unavailable',
  'human_interrupted',
  'lease_conflict',
  'lease_expired',
  'lease_required',
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
