export type RecoverableTurnFailurePromptMode = 'activity_aware' | 'continue' | 'retry_original' | 'off';

export type RecoverableTurnFailureRetryDecision =
  | Readonly<{
    action: 'await_provider_retry';
    retryAfterMs: number | null;
    suppressBackendError: true;
    consumeRetryBudget: false;
  }>
  | Readonly<{
    action: 'retry';
    prompt: string;
    promptKind: 'original' | 'continuation';
    retryAfterMs: number | null;
    suppressBackendError: true;
    consumeRetryBudget: true;
  }>
  | Readonly<{
    action: 'disabled';
    suppressBackendError: false;
    consumeRetryBudget: false;
  }>
  | Readonly<{
    action: 'budget_exhausted';
    suppressBackendError: false;
    consumeRetryBudget: false;
  }>;

export type RecoverableTurnFailureSecondFailureDecision = Readonly<{
  action: 'surface_original_failure';
  failure: Error;
  suppressLatestFailure: true;
}>;

export function resolveRecoverableTurnFailureRetryDecision(input: Readonly<{
  attemptCount: number;
  maxRetries: number;
  providerWillRetry?: boolean | null;
  failureRetryAfterMs?: number | null;
  failedTurnHadMeaningfulActivity: boolean;
  promptMode: RecoverableTurnFailurePromptMode;
  originalPrompt: string;
  continuationPrompt: string;
}>): RecoverableTurnFailureRetryDecision {
  const retryAfterMs = normalizeRetryAfterMs(input.failureRetryAfterMs);
  if (input.providerWillRetry === true) {
    return {
      action: 'await_provider_retry',
      retryAfterMs,
      suppressBackendError: true,
      consumeRetryBudget: false,
    };
  }

  if (input.promptMode === 'off') {
    return {
      action: 'disabled',
      suppressBackendError: false,
      consumeRetryBudget: false,
    };
  }

  if (normalizeAttemptCount(input.attemptCount) >= normalizeMaxRetries(input.maxRetries)) {
    return {
      action: 'budget_exhausted',
      suppressBackendError: false,
      consumeRetryBudget: false,
    };
  }

  const promptKind = resolveRecoverableTurnFailurePromptKind({
    mode: input.promptMode,
    failedTurnHadMeaningfulActivity: input.failedTurnHadMeaningfulActivity,
  });
  return {
    action: 'retry',
    prompt: promptKind === 'continuation' ? input.continuationPrompt : input.originalPrompt,
    promptKind,
    retryAfterMs,
    suppressBackendError: true,
    consumeRetryBudget: true,
  };
}

export function resolveRecoverableTurnFailureSecondFailure(input: Readonly<{
  originalFailure: Error;
  latestFailure: Error;
}>): RecoverableTurnFailureSecondFailureDecision {
  void input.latestFailure;
  return {
    action: 'surface_original_failure',
    failure: input.originalFailure,
    suppressLatestFailure: true,
  };
}

function resolveRecoverableTurnFailurePromptKind(input: Readonly<{
  mode: Exclude<RecoverableTurnFailurePromptMode, 'off'>;
  failedTurnHadMeaningfulActivity: boolean;
}>): 'original' | 'continuation' {
  if (input.mode === 'continue') return 'continuation';
  if (input.mode === 'retry_original') return 'original';
  return input.failedTurnHadMeaningfulActivity ? 'continuation' : 'original';
}

function normalizeAttemptCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeMaxRetries(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function normalizeRetryAfterMs(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}
