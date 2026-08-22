import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ExecutionRunState } from './executionRunTypes';

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
    | 'profileId'
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
  },
  toolResult: { output: any; isError?: boolean; meta?: Record<string, unknown> },
  structuredMeta?: ExecutionRunStructuredMeta,
) => Promise<void>;
