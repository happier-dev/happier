import type {
  BackendTargetRefV1,
  ExecutionRunClass,
  ExecutionRunIntent,
  ExecutionRunIoMode,
  ExecutionRunRetentionPolicy,
  ExecutionRunStartRequest,
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
  structuredOutputRecovery?: ExecutionRunStructuredOutputRecovery;
}>;

export type ExecutionRunStructuredMeta = Readonly<{ kind: string; payload: unknown }>;

export type ExecutionRunStructuredOutputRecovery = Readonly<{
  plan?: 'loose-sections' | 'none';
  delegate?: 'loose-deliverables' | 'loose-deliverables-with-single-fallback' | 'none';
}>;

export function resolveExecutionRunStructuredOutputRecovery(value: unknown): ExecutionRunStructuredOutputRecovery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Readonly<Record<string, unknown>>;
  const plan = record.plan === 'loose-sections' || record.plan === 'none' ? record.plan : undefined;
  const delegate =
    record.delegate === 'loose-deliverables'
      || record.delegate === 'loose-deliverables-with-single-fallback'
      || record.delegate === 'none'
      ? record.delegate
      : undefined;

  return plan || delegate
    ? {
      ...(plan ? { plan } : {}),
      ...(delegate ? { delegate } : {}),
    }
    : undefined;
}

export type ExecutionRunProfileBoundedCompleteParams = Readonly<{
  start: ExecutionRunProfileStartParams;
  rawText: string;
  finishedAtMs: number;
  structuredOutputRecovery?: ExecutionRunStructuredOutputRecovery;
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

export type ExecutionRunProfileSidechainTextParams = Readonly<{
  fullText: string;
}>;

export type ExecutionRunProfileInvalidOutputRepairPromptParams = Readonly<{
  start: ExecutionRunProfileStartParams;
  rawText: string;
}>;

export type ExecutionRunProfilePrepareStartParams = Readonly<{
  request: ExecutionRunStartRequest;
  cwd: string;
}>;

export type ExecutionRunIntentProfile = Readonly<{
  intent: ExecutionRunIntent;
  transcriptMaterialization: 'full' | 'none';
  buildPrompt: (params: ExecutionRunProfileStartParams) => string;
  prepareStartParams?: (
    params: ExecutionRunProfilePrepareStartParams,
  ) => Promise<Readonly<Record<string, unknown>> | undefined> | Readonly<Record<string, unknown>> | undefined;
  onBoundedComplete: (params: ExecutionRunProfileBoundedCompleteParams) => ExecutionRunProfileBoundedCompleteResult;
  computeSidechainStreamText?: (params: ExecutionRunProfileSidechainTextParams) => string;
  buildInvalidOutputRepairPrompt?: (params: ExecutionRunProfileInvalidOutputRepairPromptParams) => string;
  /**
   * Some intents want a final terminal prose line even when streaming already emitted
   * progress updates. Keep that choice in the profile so the bounded runtime stays generic.
   */
  emitFinalSidechainMessageWhenStreamed?: boolean;
  listAvailableActionIds?: (params: Readonly<{
    start: ExecutionRunProfileStartParams;
    structuredMeta?: ExecutionRunStructuredMeta | null;
    controllerKind?: string | null;
  }>) => readonly string[];
  applyAction?: (params: ExecutionRunProfileActionParams) => ExecutionRunProfileActionResult;
}>;
