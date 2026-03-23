import type {
  BackendTargetRefV1,
  ExecutionRunClass,
  ExecutionRunIntent,
  ExecutionRunIoMode,
  ExecutionRunRetentionPolicy,
} from '@happier-dev/protocol';

export type ExecutionRunProfileStartParams = Readonly<{
  sessionId: string;
  runId: string;
  callId: string;
  sidechainId: string;
  intent: ExecutionRunIntent;
  backendId: string;
  backendTarget: BackendTargetRefV1;
  instructions: string;
  intentInput?: unknown;
  permissionMode: string;
  retentionPolicy: ExecutionRunRetentionPolicy;
  runClass: ExecutionRunClass;
  ioMode: ExecutionRunIoMode;
  startedAtMs: number;
}>;

export type ExecutionRunStructuredMeta = Readonly<{ kind: string; payload: unknown }>;

export type ExecutionRunProfileBoundedCompleteParams = Readonly<{
  start: ExecutionRunProfileStartParams;
  rawText: string;
  finishedAtMs: number;
}>;

export type ExecutionRunProfileBoundedCompleteResult = Readonly<{
  status: 'succeeded' | 'failed';
  summary: string;
  toolResultOutput: unknown;
  toolResultMeta?: Record<string, unknown>;
  structuredMeta?: ExecutionRunStructuredMeta;
}>;

export type ExecutionRunProfileActionParams = Readonly<{
  start: ExecutionRunProfileStartParams;
  actionId: string;
  input?: unknown;
  structuredMeta?: ExecutionRunStructuredMeta | null;
}>;

export type ExecutionRunProfileActionResult = Readonly<{
  ok: boolean;
  errorCode?: string;
  error?: string;
  updatedToolResultOutput?: unknown;
  updatedToolResultMeta?: Record<string, unknown>;
  updatedStructuredMeta?: ExecutionRunStructuredMeta;
}>;

export type ExecutionRunIntentProfile = Readonly<{
  intent: ExecutionRunIntent;
  transcriptMaterialization: 'full' | 'none';
  buildPrompt: (params: ExecutionRunProfileStartParams) => string;
  onBoundedComplete: (params: ExecutionRunProfileBoundedCompleteParams) => ExecutionRunProfileBoundedCompleteResult;
  listAvailableActionIds?: (params: Readonly<{
    start: ExecutionRunProfileStartParams;
    structuredMeta?: ExecutionRunStructuredMeta | null;
  }>) => readonly string[];
  applyAction?: (params: ExecutionRunProfileActionParams) => ExecutionRunProfileActionResult;
}>;
