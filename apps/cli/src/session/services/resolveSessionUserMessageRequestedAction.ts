import type { PendingRequestedActionV1 } from '@happier-dev/protocol';

type SessionUserMessageDeliveryIntent = 'ordinary' | 'runtime_bootstrap';

/**
 * Owns the mapping from CLI lifecycle intent to Pending delivery action.
 *
 * A prompt that starts an inactive runtime cannot wait for runtime-idle
 * evidence: some providers publish no Activity until that prompt is admitted.
 * Callers that only take durable custody remain ordinary and preserve the
 * requested queue/steer action.
 */
export function resolveSessionUserMessageRequestedAction(params: Readonly<{
  deliveryIntent?: SessionUserMessageDeliveryIntent;
  requestedAction?: PendingRequestedActionV1;
}>): PendingRequestedActionV1 {
  if (params.requestedAction?.kind === 'recover_execution_run') return params.requestedAction;
  if (params.deliveryIntent === 'runtime_bootstrap') {
    return { v: 1, kind: 'send_now' };
  }
  return params.requestedAction ?? { v: 1, kind: 'steer_if_active' };
}
