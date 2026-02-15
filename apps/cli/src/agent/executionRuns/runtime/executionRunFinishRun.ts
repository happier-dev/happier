import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunState } from '@/agent/executionRuns/runtime/ExecutionRunManager';

export type FinishExecutionRun = (
  runId: string,
  next: Omit<
    ExecutionRunState,
    | 'runId'
    | 'callId'
    | 'sidechainId'
    | 'sessionId'
    | 'depth'
    | 'intent'
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
  },
  toolResult: { output: any; isError?: boolean; meta?: Record<string, unknown> },
  structuredMeta?: ExecutionRunStructuredMeta,
) => void;
