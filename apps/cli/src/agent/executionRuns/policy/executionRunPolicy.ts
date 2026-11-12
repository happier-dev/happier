import type { ExecutionRunIoMode } from '@happier-dev/protocol';

export {
  EXECUTION_RUN_INTENT_POLICY_REGISTRY,
  isSafePermissionModeForIntent,
  validateExecutionRunStartIntentPolicy,
  resolveExecutionRunIntentPolicy,
  resolveExecutionRunStartBoundedTimeoutMs,
} from './intentPolicyRegistry';

export type ExecutionRunPolicy = Readonly<{
  boundedTimeoutMs: number | null;
  reviewBoundedTimeoutMs: number | null;
  maxTurns: number | null;
  allowIoModes: ReadonlySet<ExecutionRunIoMode>;
}>;

export function resolveExecutionRunPolicy(params: Readonly<{
  defaults?: Readonly<{
    boundedTimeoutMs: number | null;
    reviewBoundedTimeoutMs: number | null;
    maxTurns: number | null;
  }>;
  override?: Readonly<{
    boundedTimeoutMs?: number | null;
    reviewBoundedTimeoutMs?: number | null;
    maxTurns?: number | null;
  }>;
}> = {}): ExecutionRunPolicy {
  const d = params.defaults ?? {
    boundedTimeoutMs: null,
    reviewBoundedTimeoutMs: null,
    maxTurns: null,
  };
  const o = params.override ?? {};
  const boundedTimeoutMs =
    o.boundedTimeoutMs === null
      ? null
      : typeof o.boundedTimeoutMs === 'number' && Number.isFinite(o.boundedTimeoutMs) && o.boundedTimeoutMs >= 1
      ? Math.floor(o.boundedTimeoutMs)
      : d.boundedTimeoutMs;
  const reviewBoundedTimeoutMs =
    o.reviewBoundedTimeoutMs === null
      ? null
      : typeof o.reviewBoundedTimeoutMs === 'number' && Number.isFinite(o.reviewBoundedTimeoutMs) && o.reviewBoundedTimeoutMs >= 1
      ? Math.floor(o.reviewBoundedTimeoutMs)
      : d.reviewBoundedTimeoutMs;
  const maxTurns =
    o.maxTurns === null
      ? null
      : typeof o.maxTurns === 'number' && Number.isFinite(o.maxTurns) && o.maxTurns >= 1
      ? Math.floor(o.maxTurns)
      : d.maxTurns;

  return {
    boundedTimeoutMs,
    reviewBoundedTimeoutMs,
    maxTurns,
    // Streaming is supported only for specific intents (e.g. voice_agent). Handlers enforce intent-level rules.
    allowIoModes: new Set<ExecutionRunIoMode>(['request_response', 'streaming']),
  };
}
