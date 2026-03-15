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

export function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && !Array.isArray(error)) {
    const name = (error as any).name;
    if (typeof name === 'string' && name === 'AbortError') return true;
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const lowered = String(message ?? '').toLowerCase();
  if (!lowered) return false;
  return lowered.includes('abort') || lowered.includes('cancel');
}

