import type { ExecutionRunIoMode } from '@happier-dev/protocol';

export {
  EXECUTION_RUN_INTENT_POLICY_REGISTRY,
  isSafePermissionModeForIntent,
  validateExecutionRunStartIntentPolicy,
  resolveExecutionRunIntentPolicy,
  resolveExecutionRunStartBoundedTimeoutMs,
} from './intentPolicyRegistry';

export type ExecutionRunPolicy = Readonly<{
  maxConcurrentRuns: number | null;
  boundedTimeoutMs: number | null;
  reviewBoundedTimeoutMs: number | null;
  maxTurns: number | null;
  maxDepth: number;
  allowIoModes: ReadonlySet<ExecutionRunIoMode>;
}>;

export function resolveExecutionRunPolicy(params: Readonly<{
  defaults: Readonly<{
    maxConcurrentRuns: number | null;
    boundedTimeoutMs: number | null;
    reviewBoundedTimeoutMs: number | null;
    maxTurns: number | null;
    maxDepth: number;
  }>;
  override?: Readonly<{
    maxConcurrentRuns?: number | null;
    boundedTimeoutMs?: number | null;
    reviewBoundedTimeoutMs?: number | null;
    maxTurns?: number | null;
    maxDepth?: number;
  }>;
}>): ExecutionRunPolicy {
  const d = params.defaults;
  const o = params.override ?? {};

  const maxConcurrentRuns =
    o.maxConcurrentRuns === null
      ? null
      : typeof o.maxConcurrentRuns === 'number' && Number.isFinite(o.maxConcurrentRuns) && o.maxConcurrentRuns >= 1
      ? Math.floor(o.maxConcurrentRuns)
      : d.maxConcurrentRuns;
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
  const maxDepth =
    typeof o.maxDepth === 'number' && Number.isFinite(o.maxDepth) && o.maxDepth >= 0
      ? Math.floor(o.maxDepth)
      : d.maxDepth;

  return {
    maxConcurrentRuns,
    boundedTimeoutMs,
    reviewBoundedTimeoutMs,
    maxTurns,
    maxDepth,
    // Streaming is supported only for specific intents (e.g. voice_agent). Handlers enforce intent-level rules.
    allowIoModes: new Set<ExecutionRunIoMode>(['request_response', 'streaming']),
  };
}
