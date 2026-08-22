import { z } from 'zod';

import type { PendingProviderAction } from './pendingProviderAction.js';
import type { PendingRequestedActionV1 } from './pendingRequestedActionV1.js';

export const PENDING_DELIVERY_BLOCKED_REASONS = [
  'terminal_composer_draft',
  'runtime_config_blocked',
  'delivery_outcome_uncertain',
  'provider_unavailable_before_acceptance',
  'ambiguous_terminal_delivery',
  'terminal_host_unreachable',
  'runtime_disposed_before_delivery',
  'invalid_prompt_text',
  'manual_user_handled',
  'attempt_expired_before_write',
  'provider_rejected_before_acceptance',
  'steering_unavailable',
  // Settlement-only signal: current servers atomically requeue the same conditional-steer row
  // and never persist this as a blocked reason. Older servers reject it before mutation.
  'conditional_steer_unavailable',
  'unsupported_action',
  'payload_too_large',
  'unknown',
] as const;

export const PendingDeliveryBlockedReasonSchema = z.enum(PENDING_DELIVERY_BLOCKED_REASONS);

export type PendingDeliveryBlockedReason = z.infer<typeof PendingDeliveryBlockedReasonSchema>;

export function isPendingDeliveryBlockedReason(value: unknown): value is PendingDeliveryBlockedReason {
  return PendingDeliveryBlockedReasonSchema.safeParse(value).success;
}

export function normalizePendingDeliveryBlockedReason(value: unknown): PendingDeliveryBlockedReason | null {
  const parsed = PendingDeliveryBlockedReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function isConditionalPendingSteerClaim(params: Readonly<{
  requestedAction: PendingRequestedActionV1 | null | undefined;
  providerAction: PendingProviderAction | null | undefined;
}>): boolean {
  return params.requestedAction?.kind === 'steer_if_active' && params.providerAction === 'steer';
}
