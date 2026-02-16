import type { ExecutionRunIntent, ExecutionRunIoMode } from '@happier-dev/protocol';

export type ExecutionRunPolicy = Readonly<{
  maxConcurrentRuns: number;
  boundedTimeoutMs: number | null;
  maxTurns: number | null;
  maxDepth: number;
  allowIoModes: ReadonlySet<ExecutionRunIoMode>;
}>;

export function resolveExecutionRunPolicy(params: Readonly<{
  defaults: Readonly<{
    maxConcurrentRuns: number;
    boundedTimeoutMs: number | null;
    maxTurns: number | null;
    maxDepth: number;
  }>;
  override?: Readonly<{
    maxConcurrentRuns?: number;
    boundedTimeoutMs?: number;
    maxTurns?: number;
    maxDepth?: number;
  }>;
}>): ExecutionRunPolicy {
  const d = params.defaults;
  const o = params.override ?? {};

  const maxConcurrentRuns =
    typeof o.maxConcurrentRuns === 'number' && Number.isFinite(o.maxConcurrentRuns) && o.maxConcurrentRuns >= 1
      ? Math.floor(o.maxConcurrentRuns)
      : d.maxConcurrentRuns;
  const boundedTimeoutMs =
    typeof o.boundedTimeoutMs === 'number' && Number.isFinite(o.boundedTimeoutMs) && o.boundedTimeoutMs >= 1
      ? Math.floor(o.boundedTimeoutMs)
      : d.boundedTimeoutMs;
  const maxTurns =
    typeof o.maxTurns === 'number' && Number.isFinite(o.maxTurns) && o.maxTurns >= 1
      ? Math.floor(o.maxTurns)
      : d.maxTurns;
  const maxDepth =
    typeof o.maxDepth === 'number' && Number.isFinite(o.maxDepth) && o.maxDepth >= 0
      ? Math.floor(o.maxDepth)
      : d.maxDepth;

  return {
    maxConcurrentRuns,
    boundedTimeoutMs,
    maxTurns,
    maxDepth,
    // Streaming is supported only for specific intents (e.g. voice_agent). Handlers enforce intent-level rules.
    allowIoModes: new Set<ExecutionRunIoMode>(['request_response', 'streaming']),
  };
}

export function isSafePermissionModeForIntent(intent: ExecutionRunIntent, permissionModeRaw: string): boolean {
  const mode = permissionModeRaw.trim();
  if (intent === 'review' || intent === 'plan' || intent === 'voice_agent' || intent === 'memory_hints') {
    return mode === 'no_tools' || mode === 'read_only';
  }
  return true;
}
