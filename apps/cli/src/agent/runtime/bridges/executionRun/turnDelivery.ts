import type { ExecutionRunSendDelivery } from '@/agent/executionRuns/controllers/types';
export function normalizeExecutionRunSendDelivery(input: unknown): ExecutionRunSendDelivery {
  if (input === 'prompt' || input === 'steer_if_supported' || input === 'interrupt') return input;
  return 'prompt';
}

export type InFlightDeliveryAction = 'busy' | 'steer' | 'cancel_and_send';

export function resolveInFlightDeliveryAction(args: Readonly<{
  delivery: ExecutionRunSendDelivery;
  hasSteer: boolean;
}>): InFlightDeliveryAction {
  if (args.delivery === 'prompt') return 'busy';
  if (args.delivery === 'steer_if_supported') return args.hasSteer ? 'steer' : 'cancel_and_send';
  return 'cancel_and_send';
}

export { isAbortLikeError } from '@/agent/runtime/lifecycle/classifyAbortLikeError';
