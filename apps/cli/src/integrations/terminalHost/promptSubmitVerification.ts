import type { TerminalPromptInput } from '@happier-dev/agents';
import type { AgentTerminalPromptSubmitVerificationPolicyV1 } from '@happier-dev/plugin-sdk/agents/runtime';

const DEFAULT_POST_SUBMIT_SETTLE_MS = 50;
const DEFAULT_PRE_SUBMIT_POLL_MS = 250;

export type TerminalPromptSubmitVerificationPolicy = AgentTerminalPromptSubmitVerificationPolicyV1;

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

export function resolveTerminalPromptSubmissionFailureReason(
  reason: Extract<TerminalPromptSubmissionResult, { success: false }>['reason'],
): 'verification_failed' | 'submit_failed' | 'timeout' {
  return reason;
}

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
  signal?: AbortSignal | undefined;
  resolveDeliveryState?: TerminalPromptInput['resolveDeliveryState'];
  wait?: ((delayMs: number) => Promise<void>) | undefined;
  stagingPollIntervalMs?: number | undefined;
  postSubmitSettleMs?: number | undefined;
}>): Promise<TerminalPromptSubmissionResult> {
  let stagingWasProvenAtDeadline = false;
  const remainingOperationTimeoutMs = (): number | undefined => (
    params.signal || stagingWasProvenAtDeadline ? undefined : params.remainingTimeoutMs?.()
  );
  let submitMayHaveReachedPane = false;
  const settledResult = (): TerminalPromptSubmissionResult | null => {
    const deliveryState = params.resolveDeliveryState?.();
    if (deliveryState === 'accepted') return { success: true };
    if (!params.signal?.aborted && deliveryState !== 'retired') return null;
    return {
      success: false,
      reason: 'verification_failed',
      phase: submitMayHaveReachedPane ? 'after_enter_unknown' : 'after_write_before_enter',
      duplicateRisk: 'possible',
      submitMayHaveReachedPane,
    };
  };
  // The session owns provider readiness. A successful write can sit in the provider's input
  // queue while its event loop is busy; the write-command budget cannot decide its outcome.
  // Callers without a session lifetime retain their explicitly bounded operation contract.
  const submitOnce = async (): Promise<TerminalPromptSubmitCommandResult> => normalizeSubmitResult(await params.submitEnter({
    remainingTimeoutMs: remainingOperationTimeoutMs(),
  }));
  const postSubmitSettleMs = Math.max(
    0,
    Math.trunc(params.postSubmitSettleMs ?? DEFAULT_POST_SUBMIT_SETTLE_MS),
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
      const settled = settledResult();
      if (settled) return settled;
      const remainingTimeoutMs = remainingOperationTimeoutMs();
      try {
        if (await params.verifyStagedBeforeSubmit({
          promptText: params.promptText,
          remainingTimeoutMs: remainingTimeoutMs === 0 ? undefined : remainingTimeoutMs,
        })) {
          // Staging and Enter are separate terminal operations. If the exact prompt became
          // observable at the boundary, let the adapter apply its normal bounded Enter/capture
          // timeout instead of passing an already exhausted staging budget.
          stagingWasProvenAtDeadline = remainingTimeoutMs === 0;
          break;
        }
      } catch {
        const settled = settledResult();
        if (settled) return settled;
        return {
          success: false,
          reason: 'verification_failed',
          phase: 'after_write_before_enter',
          duplicateRisk: 'possible',
          submitMayHaveReachedPane: false,
        };
      }
      const settledAfterCapture = settledResult();
      if (settledAfterCapture) return settledAfterCapture;
      if (remainingTimeoutMs === 0) {
        return {
          success: false,
          reason: 'timeout',
          phase: 'after_write_before_enter',
          duplicateRisk: 'possible',
          submitMayHaveReachedPane: false,
        };
      }
      if (remainingTimeoutMs === undefined && !params.signal) {
        return {
          success: false,
          reason: 'verification_failed',
          phase: 'after_write_before_enter',
          duplicateRisk: 'possible',
          submitMayHaveReachedPane: false,
        };
      }
      await (params.wait ?? defaultWait)(Math.min(stagingPollIntervalMs, remainingTimeoutMs ?? stagingPollIntervalMs));
    }
  }

  const verifyStillPending = async (): Promise<boolean | null> => {
    try {
      return await params.verifyAfterSubmit?.({
        promptText: params.promptText,
        remainingTimeoutMs: remainingOperationTimeoutMs(),
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

  const settledBeforeEnter = settledResult();
  if (settledBeforeEnter) return settledBeforeEnter;
  const submitted = await submitOnce();
  submitMayHaveReachedPane = submitted !== 'failed';
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
  while (true) {
    const settled = settledResult();
    if (settled) return settled;
    const verification = await verifyStableAbsence();
    const settledAfterCapture = settledResult();
    if (settledAfterCapture) return settledAfterCapture;
    if (verification === 'failed') {
      return {
        success: false,
        reason: 'verification_failed',
        phase: 'after_enter_unknown',
        duplicateRisk: 'likely',
        submitMayHaveReachedPane: true,
      };
    }
    if (verification === 'cleared') return { success: true };

    // The screen can lag behind provider acceptance. Re-observe under the caller's
    // session lifetime (or its explicit operation budget); another Enter based on a stale draft is not
    // evidence-backed and can act on a different composer by the time it arrives.
    const remainingTimeoutMs = remainingOperationTimeoutMs();
    if ((remainingTimeoutMs === undefined && !params.signal) || remainingTimeoutMs === 0) {
      return {
        success: false,
        reason: 'verification_failed',
        phase: 'after_enter_unknown',
        duplicateRisk: 'possible',
        submitMayHaveReachedPane: true,
      };
    }
    await (params.wait ?? defaultWait)(Math.min(
      DEFAULT_PRE_SUBMIT_POLL_MS,
      remainingTimeoutMs ?? DEFAULT_PRE_SUBMIT_POLL_MS,
    ));
  }
}
