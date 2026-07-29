const PRE_SUBMIT_VERIFY_POLL_INTERVAL_MS = 250;
const PRE_SUBMIT_VERIFY_TIMEOUT_MS = 15_000;
const DEFAULT_POST_SUBMIT_SETTLE_MS = 50;

export type TerminalPromptSubmitVerificationPolicy = Readonly<{
  shouldVerifyBeforeSubmit(promptText: string): boolean;
  verifyBeforeSubmit(params: Readonly<{
    promptText: string;
    screenText: string;
  }>): boolean;
  shouldVerifyAfterSubmit(promptText: string): boolean;
  verifyAfterSubmit(params: Readonly<{
    promptText: string;
    screenText: string;
  }>): boolean;
}>;

export type TerminalPromptSubmitCommandResult = 'success' | 'timeout' | 'failed';

export type TerminalPromptSubmissionResult =
  | Readonly<{ success: true }>
  | Readonly<{
    success: false;
    reason: 'verification_failed' | 'submit_failed' | 'timeout';
    phase: 'after_write_before_enter' | 'after_enter_unknown';
    duplicateRisk: 'possible' | 'likely';
    submitMayHaveReachedPane: boolean;
  }>;

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function waitForPromptPasteVerification(params: Readonly<{
  verify: (params: Readonly<{ remainingTimeoutMs?: number | undefined }>) => Promise<boolean>;
  remainingTimeoutMs?: (() => number | undefined) | undefined;
  wait?: ((delayMs: number) => Promise<void>) | undefined;
  maxPollMs?: number | undefined;
  pollIntervalMs?: number | undefined;
}>): Promise<boolean> {
  const configuredMaxPollMs = Math.max(
    0,
    Math.trunc(params.maxPollMs ?? PRE_SUBMIT_VERIFY_TIMEOUT_MS),
  );
  const initialRemainingMs = params.remainingTimeoutMs?.();
  const maxPollMs = Math.min(
    configuredMaxPollMs,
    initialRemainingMs ?? configuredMaxPollMs,
  );
  const pollIntervalMs = Math.max(
    1,
    Math.trunc(params.pollIntervalMs ?? PRE_SUBMIT_VERIFY_POLL_INTERVAL_MS),
  );
  const wait = params.wait ?? defaultWait;
  let waitedMs = 0;

  while (true) {
    let verified = false;
    try {
      verified = await params.verify({
        remainingTimeoutMs: params.remainingTimeoutMs?.(),
      });
    } catch {
      verified = false;
    }
    if (verified) return true;
    if (waitedMs >= maxPollMs) return false;

    const delayMs = Math.min(pollIntervalMs, maxPollMs - waitedMs);
    if (delayMs <= 0) return false;
    await wait(delayMs);
    waitedMs += delayMs;
  }
}

function normalizeSubmitResult(result: TerminalPromptSubmitCommandResult | void): TerminalPromptSubmitCommandResult {
  return result ?? 'success';
}

export async function runTerminalPromptSubmission(params: Readonly<{
  promptText: string;
  submitEnter: (params: Readonly<{ remainingTimeoutMs?: number | undefined }>) => Promise<TerminalPromptSubmitCommandResult | void>;
  verifyBeforeSubmit?: ((params: Readonly<{ promptText: string; remainingTimeoutMs?: number | undefined }>) => Promise<boolean>) | undefined;
  verifyAfterSubmit?: ((params: Readonly<{ promptText: string; remainingTimeoutMs?: number | undefined }>) => Promise<boolean>) | undefined;
  remainingTimeoutMs?: (() => number | undefined) | undefined;
  wait?: ((delayMs: number) => Promise<void>) | undefined;
  maxPreSubmitPollMs?: number | undefined;
  preSubmitPollIntervalMs?: number | undefined;
  submitRetryDelayMs?: number | undefined;
}>): Promise<TerminalPromptSubmissionResult> {
  if (params.verifyBeforeSubmit) {
    const verified = await waitForPromptPasteVerification({
      verify: async ({ remainingTimeoutMs }) => params.verifyBeforeSubmit?.({
        promptText: params.promptText,
        remainingTimeoutMs,
      }) ?? false,
      remainingTimeoutMs: params.remainingTimeoutMs,
      wait: params.wait,
      maxPollMs: params.maxPreSubmitPollMs,
      pollIntervalMs: params.preSubmitPollIntervalMs,
    });
    if (!verified) {
      return {
        success: false,
        reason: 'verification_failed',
        phase: 'after_write_before_enter',
        duplicateRisk: 'possible',
        submitMayHaveReachedPane: false,
      };
    }
  }

  const submitOnce = async (): Promise<TerminalPromptSubmitCommandResult> => normalizeSubmitResult(await params.submitEnter({
    remainingTimeoutMs: params.remainingTimeoutMs?.(),
  }));
  const postSubmitSettleMs = Math.max(
    0,
    Math.trunc(params.submitRetryDelayMs ?? DEFAULT_POST_SUBMIT_SETTLE_MS),
  );
  const waitForPostSubmitSettle = async (): Promise<void> => {
    if (postSubmitSettleMs <= 0) return;
    await (params.wait ?? defaultWait)(postSubmitSettleMs);
  };

  const submitted = await submitOnce();
  if (submitted === 'timeout') {
    return {
      success: false,
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      submitMayHaveReachedPane: true,
    };
  }
  if (submitted === 'failed') {
    return {
      success: false,
      reason: 'submit_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      submitMayHaveReachedPane: false,
    };
  }

  if (!params.verifyAfterSubmit) {
    return { success: true };
  }

  await waitForPostSubmitSettle();
  let stillPending = false;
  try {
    stillPending = await params.verifyAfterSubmit({
      promptText: params.promptText,
      remainingTimeoutMs: params.remainingTimeoutMs?.(),
    });
  } catch {
    stillPending = false;
  }
  if (!stillPending) {
    return { success: true };
  }

  await waitForPostSubmitSettle();
  const retried = await submitOnce();
  if (retried === 'timeout') {
    return {
      success: false,
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      submitMayHaveReachedPane: true,
    };
  }
  if (retried === 'failed') {
    return {
      success: false,
      reason: 'submit_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      submitMayHaveReachedPane: true,
    };
  }

  await waitForPostSubmitSettle();
  try {
    stillPending = await params.verifyAfterSubmit({
      promptText: params.promptText,
      remainingTimeoutMs: params.remainingTimeoutMs?.(),
    });
  } catch {
    stillPending = false;
  }
  if (stillPending) {
    return {
      success: false,
      reason: 'verification_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'possible',
      submitMayHaveReachedPane: true,
    };
  }

  return { success: true };
}
