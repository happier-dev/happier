import type {
  BackendTargetRefV1,
  ExecutionRunClass,
  ExecutionRunIntent,
  ExecutionRunIoMode,
  ExecutionRunRetentionPolicy,
  ExecutionRunStartRequest,
  ExecutionRunResultContractV1,
} from '@happier-dev/protocol';

/**
 * Bounds the complete raw task result retained in memory and returned by the
 * task profile. Individual runtime events use their own aggregate envelope.
 */
export const EXECUTION_RUN_TASK_RESULT_MAX_CODE_UNITS = 512 * 1_024;

export type ExecutionRunProfileStartParams = Readonly<{
  sessionId: string | null;
  runId: string;
  callId: string;
  sidechainId: string;
  intent: ExecutionRunIntent;
  backendId: string;
  backendTarget: BackendTargetRefV1;
  instructions: string;
  intentInput?: unknown;
  resultContract?: ExecutionRunResultContractV1;
  permissionMode: string;
  retentionPolicy: ExecutionRunRetentionPolicy;
  runClass: ExecutionRunClass;
  ioMode: ExecutionRunIoMode;
  startedAtMs: number;
  /** Existing host projection from authoritative native usage evidence. */
  effectiveEngine?: Readonly<{ agentId: string; modelId?: string }>;
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
  /** A distinct next input, admitted by the incumbent host on this same Run. */
  nextInput?: Readonly<{ instructions: string; intentInput: unknown; localId: string }>;
  updatedIntentInput?: unknown;
}>;

export type ExecutionRunProfileTurnCompleteParams = ExecutionRunProfileBoundedCompleteParams & Readonly<{
  turnId: string;
  inputIds?: readonly string[];
  previousStructuredMeta?: ExecutionRunStructuredMeta;
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
  /** Trusted host scope, independent of caller-authored intent input. */
  sessionId?: string | null;
  request: Omit<ExecutionRunStartRequest, 'backendTarget'> & Readonly<{
    backendTarget: ExecutionRunStartRequest['backendTarget'] | BackendTargetRefV1;
  }>;
  cwd: string;
  /** Offered-model truth from the host probe, never caller-authored intent input. */
  contextWindowTokens?: number;
}>;

export type ExecutionRunIntentProfile = Readonly<{
  intent: ExecutionRunIntent;
  transcriptMaterialization: 'full' | 'none';
  /**
   * Detached scope is an explicit profile capability. Existing Session-shaped
   * profiles retain their established Session semantics unless they opt in.
   */
  supportsDetached?: boolean;
  buildPrompt: (params: ExecutionRunProfileStartParams) => string;
  prepareStartParams?: (
    params: ExecutionRunProfilePrepareStartParams,
  ) => Promise<Readonly<Record<string, unknown>> | undefined> | Readonly<Record<string, unknown>> | undefined;
  onBoundedComplete: (params: ExecutionRunProfileBoundedCompleteParams) => ExecutionRunProfileBoundedCompleteResult;
  /** Publish an already prepared artifact after the retained runtime is established. */
  onStarted?: (params: ExecutionRunProfileBoundedCompleteParams) => ExecutionRunProfileBoundedCompleteResult | null | Promise<ExecutionRunProfileBoundedCompleteResult | null>;
  /** Bind output revisions through the existing input owner before any provider effect. */
  onBeforeRetainedInput?: (params: Readonly<{ start: ExecutionRunProfileStartParams; localId: string }>) => Promise<void>;
  /** Publish progress only after the incumbent Pending owner confirms acceptance. */
  onRetainedInputAdmitted?: (params: Readonly<{ start: ExecutionRunProfileStartParams; localId: string }>) =>
    Promise<ExecutionRunProfileBoundedCompleteResult | null>;
  buildInitialInputContext?: (params: Readonly<{ start: ExecutionRunProfileStartParams; structuredMeta?: ExecutionRunStructuredMeta }>) => string;
  onTerminal?: (params: Readonly<{ start: ExecutionRunProfileStartParams; status: 'failed' | 'cancelled';
    finishedAtMs: number; structuredMeta?: ExecutionRunStructuredMeta }>) =>
    Pick<ExecutionRunProfileBoundedCompleteResult, 'toolResultOutput' | 'structuredMeta'> | null |
    Promise<Pick<ExecutionRunProfileBoundedCompleteResult, 'toolResultOutput' | 'structuredMeta'> | null>;
  /** Valid structured output from a retained turn. Ordinary prose returns null. */
  onTurnComplete?: (params: ExecutionRunProfileTurnCompleteParams) =>
    ExecutionRunProfileBoundedCompleteResult | null | Promise<ExecutionRunProfileBoundedCompleteResult | null>;
  onTurnFailed?: (params: ExecutionRunProfileTurnCompleteParams & Readonly<{
    diagnostic: Readonly<{ code: string; message?: string }>;
  }>) => ExecutionRunProfileBoundedCompleteResult | null | Promise<ExecutionRunProfileBoundedCompleteResult | null>;
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
