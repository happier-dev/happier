import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/executionRunTypes';

export type FinishExecutionRunNext = Omit<
  ExecutionRunState,
  | 'runId'
  | 'callId'
  | 'sidechainId'
  | 'sessionId'
  | 'depth'
  | 'intent'
  | 'backendTarget'
  | 'backendId'
  | 'instructions'
  | 'permissionMode'
  | 'retentionPolicy'
  | 'runClass'
  | 'ioMode'
  | 'startedAtMs'
  | 'resumeHandle'
> & {
  status: ExecutionRunState['status'];
  finishedAtMs: number;
};

export type FinishExecutionRunToolResult = Readonly<{
  output: unknown;
  isError?: boolean;
  meta?: Record<string, unknown>;
}>;

export type FinishExecutionRun = (
  runId: string,
  next: FinishExecutionRunNext,
  toolResult: FinishExecutionRunToolResult,
  structuredMeta?: ExecutionRunStructuredMeta,
) => void | Promise<void>;
