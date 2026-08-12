const DEFAULT_POST_SUBMIT_SETTLE_MS = 50;
const DEFAULT_PRE_SUBMIT_POLL_MS = 25;

export type TerminalPromptSubmitVerificationPolicy = Readonly<{
  shouldVerifyAfterSubmit(promptText: string): boolean;
  isPromptStagedBeforeSubmit(params: Readonly<{
    promptText: string;
    screenText: string;
  }>): boolean;
  isPromptStillPendingAfterSubmit(params: Readonly<{
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

function normalizeSubmitResult(result: TerminalPromptSubmitCommandResult | void): TerminalPromptSubmitCommandResult {
  return result ?? 'success';
}

export async function runTerminalPromptSubmission(params: Readonly<{
  promptText: string;
  verifyStagedBeforeSubmit?: ((params: Readonly<{ promptText: string; remainingTimeoutMs?: number | undefined }>) => Promise<boolean>) | undefined;
  submitEnter: (params: Readonly<{ remainingTimeoutMs?: number | undefined }>) => Promise<TerminalPromptSubmitCommandResult | void>;
  verifyAfterSubmit?: ((params: Readonly<{ promptText: string; remainingTimeoutMs?: number | undefined }>) => Promise<boolean>) | undefined;
  remainingTimeoutMs?: (() => number | undefined) | undefined;
  wait?: ((delayMs: number) => Promise<void>) | undefined;
  stagingPollIntervalMs?: number | undefined;
  submitRetryDelayMs?: number | undefined;
}>): Promise<TerminalPromptSubmissionResult> {
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

  if (params.verifyStagedBeforeSubmit) {
    const stagingPollIntervalMs = Math.max(
      1,
      Math.trunc(params.stagingPollIntervalMs ?? DEFAULT_PRE_SUBMIT_POLL_MS),
    );
    while (true) {
      const remainingTimeoutMs = params.remainingTimeoutMs?.();
      if (remainingTimeoutMs === 0) {
        return {
          success: false,
          reason: 'timeout',
          phase: 'after_write_before_enter',
          duplicateRisk: 'possible',
          submitMayHaveReachedPane: false,
        };
      }
      try {
        if (await params.verifyStagedBeforeSubmit({
          promptText: params.promptText,
          remainingTimeoutMs,
        })) {
          break;
        }
      } catch {
        return {
          success: false,
          reason: 'verification_failed',
          phase: 'after_write_before_enter',
          duplicateRisk: 'possible',
          submitMayHaveReachedPane: false,
        };
      }
      if (remainingTimeoutMs === undefined) {
        return {
          success: false,
          reason: 'verification_failed',
          phase: 'after_write_before_enter',
          duplicateRisk: 'possible',
          submitMayHaveReachedPane: false,
        };
      }
      await (params.wait ?? defaultWait)(Math.min(stagingPollIntervalMs, remainingTimeoutMs));
    }
  }

  const verifyStillPending = async (): Promise<boolean | null> => {
    try {
      return await params.verifyAfterSubmit?.({
        promptText: params.promptText,
        remainingTimeoutMs: params.remainingTimeoutMs?.(),
      }) ?? false;
    } catch {
      return null;
    }
  };

  const verifyStableAbsence = async (): Promise<'cleared' | 'pending' | 'failed'> => {
    const first = await verifyStillPending();
    if (first === null) return 'failed';
    if (first) return 'pending';
    await waitForPostSubmitSettle();
    const confirmation = await verifyStillPending();
    if (confirmation === null) return 'failed';
    return confirmation ? 'pending' : 'cleared';
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
  let verification = await verifyStableAbsence();
  if (verification === 'failed') {
    return {
      success: false,
      reason: 'verification_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      submitMayHaveReachedPane: true,
    };
  }
  if (verification === 'cleared') {
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
  verification = await verifyStableAbsence();
  if (verification === 'failed') {
    return {
      success: false,
      reason: 'verification_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      submitMayHaveReachedPane: true,
    };
  }
  if (verification === 'pending') {
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
