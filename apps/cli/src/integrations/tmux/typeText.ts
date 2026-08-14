import type { TmuxCommandResult } from './types';
import type {
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
} from '../terminalHost/_types';
import { splitStringByCodePoints } from '../terminalHost/chunks';
import {
  createTerminalHostDeadline,
  remainingTerminalHostDeadlineMs,
} from '../terminalHost/deadline';
import { runTerminalPromptSubmission } from '../terminalHost/promptSubmitVerification';
import { resolvePromptSubmitTimeoutMs } from '../terminalHost/promptSubmitTimeout';

export type TmuxCommandExecutor = (
  args: readonly string[],
  options?: Readonly<{ stdin?: string; timeoutMs?: number }>,
) => Promise<TmuxCommandResult | null>;

export type TmuxTypeTextResult =
  | Readonly<{ success: true }>
  | Readonly<{
      success: false;
      reason: 'invalid_chunk_size' | 'type_failed' | 'newline_failed' | 'submit_failed' | 'timeout';
      phase: TerminalInjectionFailurePhase;
      duplicateRisk: TerminalInjectionDuplicateRisk;
      progress: Readonly<{
        textMayHaveReachedPane: boolean;
        newlineMayHaveReachedPane: boolean;
        submitMayHaveReachedPane: boolean;
      }>;
    }>;

export type TmuxNativePasteTextResult =
  | Readonly<{ success: true }>
  | Readonly<{
    success: false;
    reason: 'load_failed' | 'write_not_authorized' | 'paste_failed' | 'verification_failed' | 'submit_failed' | 'timeout';
    phase: TerminalInjectionFailurePhase;
    duplicateRisk: TerminalInjectionDuplicateRisk;
    progress: Readonly<{
      bufferLoaded: boolean;
      pasteMayHaveReachedPane: boolean;
      submitMayHaveReachedPane: boolean;
      cleanupAttempted: boolean;
      cleanupSucceeded?: boolean;
    }>;
  }>;

type TmuxTypeTextProgress = {
  textMayHaveReachedPane: boolean;
  newlineMayHaveReachedPane: boolean;
  submitMayHaveReachedPane: boolean;
};

type TmuxNativePasteProgress = {
  bufferLoaded: boolean;
  pasteMayHaveReachedPane: boolean;
  submitMayHaveReachedPane: boolean;
  cleanupAttempted: boolean;
  cleanupSucceeded?: boolean;
};

function failedResult(params: Readonly<{
  reason: Extract<TmuxTypeTextResult, { success: false }>['reason'];
  phase: TerminalInjectionFailurePhase;
  duplicateRisk: TerminalInjectionDuplicateRisk;
  progress: TmuxTypeTextProgress;
}>): Extract<TmuxTypeTextResult, { success: false }> {
  return {
    success: false,
    reason: params.reason,
    phase: params.phase,
    duplicateRisk: params.duplicateRisk,
    progress: params.progress,
  };
}

function failedNativePasteResult(params: Readonly<{
  reason: Extract<TmuxNativePasteTextResult, { success: false }>['reason'];
  phase: TerminalInjectionFailurePhase;
  duplicateRisk: TerminalInjectionDuplicateRisk;
  progress: TmuxNativePasteProgress;
}>): Extract<TmuxNativePasteTextResult, { success: false }> {
  return {
    success: false,
    reason: params.reason,
    phase: params.phase,
    duplicateRisk: params.duplicateRisk,
    progress: params.progress,
  };
}

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function commandSucceeded(
  executor: TmuxCommandExecutor,
  args: readonly string[],
  options?: Readonly<{ stdin?: string; timeoutMs?: number }>,
): Promise<'success' | 'failed' | 'timeout'> {
  const result = await executor(args, options);
  if (result?.timedOut) return 'timeout';
  return result !== null && result.returncode === 0 ? 'success' : 'failed';
}

async function timedCommandSucceeded(
  executor: TmuxCommandExecutor,
  args: readonly string[],
  deadline: number | undefined,
  options?: Readonly<{ stdin?: string }>,
): Promise<'success' | 'failed' | 'timeout'> {
  const timeoutMs = remainingTerminalHostDeadlineMs(deadline);
  if (timeoutMs === 0) return 'timeout';
  return commandSucceeded(executor, args, {
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

async function cleanupTmuxBuffer(
  executor: TmuxCommandExecutor,
  bufferName: string,
  deadline: number | undefined,
): Promise<boolean> {
  return (await timedCommandSucceeded(executor, ['delete-buffer', '-b', bufferName], deadline)) === 'success';
}

export async function pasteTextViaTmuxBuffer(params: Readonly<{
  executor: TmuxCommandExecutor;
  target: string;
  text: string;
  bufferName: string;
  submitDelayMs?: number | undefined;
  submitRetryDelayMs?: number | undefined;
  timeoutMs?: number | undefined;
  wait?: ((delayMs: number) => Promise<void>) | undefined;
  verifyStagedBeforeSubmit?: ((params: Readonly<{ text: string; remainingTimeoutMs?: number | undefined }>) => Promise<boolean>) | undefined;
  verifyAfterSubmit?: ((params: Readonly<{ text: string; remainingTimeoutMs?: number | undefined }>) => Promise<boolean>) | undefined;
  authorizeBeforeWrite?: (() => boolean | Promise<boolean>) | undefined;
}>): Promise<TmuxNativePasteTextResult> {
  const progress: TmuxNativePasteProgress = {
    bufferLoaded: false,
    pasteMayHaveReachedPane: false,
    submitMayHaveReachedPane: false,
    cleanupAttempted: false,
  };
  const deadline = createTerminalHostDeadline(params.timeoutMs);
  const normalizedText = params.text.replace(/\r\n?/g, '\n');

  const loaded = await timedCommandSucceeded(
    params.executor,
    ['load-buffer', '-b', params.bufferName, '-'],
    deadline,
    { stdin: normalizedText },
  );
  if (loaded === 'timeout') {
    return failedNativePasteResult({
      reason: 'timeout',
      phase: 'before_write',
      duplicateRisk: 'none',
      progress,
    });
  }
  if (loaded === 'failed') {
    return failedNativePasteResult({
      reason: 'load_failed',
      phase: 'before_write',
      duplicateRisk: 'none',
      progress,
    });
  }
  progress.bufferLoaded = true;

  if (remainingTerminalHostDeadlineMs(deadline) === 0) {
    progress.cleanupAttempted = true;
    progress.cleanupSucceeded = (await commandSucceeded(params.executor, ['delete-buffer', '-b', params.bufferName])) === 'success';
    return failedNativePasteResult({
      reason: 'timeout',
      phase: 'before_write',
      duplicateRisk: 'none',
      progress,
    });
  }

  if (params.authorizeBeforeWrite) {
    let authorized = false;
    try {
      authorized = await params.authorizeBeforeWrite();
    } catch {
      authorized = false;
    }
    if (!authorized) {
      progress.cleanupAttempted = true;
      progress.cleanupSucceeded = await cleanupTmuxBuffer(params.executor, params.bufferName, deadline);
      return failedNativePasteResult({
        reason: 'write_not_authorized',
        phase: 'before_write',
        duplicateRisk: 'none',
        progress,
      });
    }
  }

  const pasted = await timedCommandSucceeded(params.executor, [
    'paste-buffer',
    '-p',
    '-r',
    '-d',
    '-b',
    params.bufferName,
    '-t',
    params.target,
  ], deadline);
  if (pasted === 'timeout' || pasted === 'failed') {
    progress.pasteMayHaveReachedPane = pasted === 'timeout';
    progress.cleanupAttempted = true;
    progress.cleanupSucceeded = await cleanupTmuxBuffer(params.executor, params.bufferName, deadline);
    return failedNativePasteResult({
      reason: pasted === 'timeout' ? 'timeout' : 'paste_failed',
      phase: 'during_write',
      duplicateRisk: pasted === 'timeout' ? 'possible' : 'none',
      progress,
    });
  }
  progress.pasteMayHaveReachedPane = true;

  const submitDelayMs = params.submitDelayMs ?? 0;
  if (submitDelayMs > 0) {
    await (params.wait ?? waitFor)(submitDelayMs);
  }

  // Loading/pasting and submitting are independent terminal operations. A successful slow
  // paste must not leave staging verification and Enter with only the remainder of its clock.
  const submissionDeadline = createTerminalHostDeadline(params.timeoutMs);

  async function sendSubmitEnter(): Promise<'success' | 'timeout' | 'failed'> {
    const submitDeadline = createTerminalHostDeadline(resolvePromptSubmitTimeoutMs({
      remainingTimeoutMs: remainingTerminalHostDeadlineMs(submissionDeadline),
      fallbackTimeoutMs: params.timeoutMs,
    }));
    return timedCommandSucceeded(params.executor, ['send-keys', '-t', params.target, 'C-m'], submitDeadline);
  }

  const submission = await runTerminalPromptSubmission({
    promptText: normalizedText,
    ...(params.verifyStagedBeforeSubmit
      ? {
        verifyStagedBeforeSubmit: async ({ promptText, remainingTimeoutMs }) => params.verifyStagedBeforeSubmit?.({
          text: promptText,
          remainingTimeoutMs,
        }) ?? false,
      }
      : {}),
    submitEnter: sendSubmitEnter,
    ...(params.verifyAfterSubmit
      ? {
        verifyAfterSubmit: async ({ promptText, remainingTimeoutMs }) => params.verifyAfterSubmit?.({
          text: promptText,
          remainingTimeoutMs,
        }) ?? false,
      }
      : {}),
    remainingTimeoutMs: () => remainingTerminalHostDeadlineMs(submissionDeadline),
    wait: params.wait ?? waitFor,
    submitRetryDelayMs: params.submitRetryDelayMs ?? 0,
  });
  progress.submitMayHaveReachedPane = submission.success ? true : submission.submitMayHaveReachedPane;
  if (!submission.success) {
    return failedNativePasteResult({
      reason: submission.reason,
      phase: submission.phase,
      duplicateRisk: submission.duplicateRisk,
      progress,
    });
  }

  return { success: true };
}

export async function typeTextViaSendKeys(params: Readonly<{
  executor: TmuxCommandExecutor;
  target: string;
  text: string;
  chunkSize: number;
  submitDelayMs?: number | undefined;
  timeoutMs?: number | undefined;
  wait?: ((delayMs: number) => Promise<void>) | undefined;
}>): Promise<TmuxTypeTextResult> {
  const progress: TmuxTypeTextProgress = {
    textMayHaveReachedPane: false,
    newlineMayHaveReachedPane: false,
    submitMayHaveReachedPane: false,
  };

  if (!Number.isSafeInteger(params.chunkSize) || params.chunkSize <= 0) {
    return failedResult({
      reason: 'invalid_chunk_size',
      phase: 'before_write',
      duplicateRisk: 'none',
      progress,
    });
  }

  const deadline = createTerminalHostDeadline(params.timeoutMs);
  const normalizedLines = params.text.replace(/\r\n?/g, '\n').split('\n');
  for (const [lineIndex, line] of normalizedLines.entries()) {
    if (line.length > 0) {
      for (const chunk of splitStringByCodePoints(line, params.chunkSize)) {
        const typed = await timedCommandSucceeded(params.executor, [
          'send-keys',
          '-t',
          params.target,
          '-l',
          '--',
          chunk,
        ], deadline);
        if (typed === 'timeout') {
          progress.textMayHaveReachedPane = true;
          return failedResult({
            reason: 'timeout',
            phase: 'during_write',
            duplicateRisk: 'possible',
            progress,
          });
        }
        if (typed === 'failed') {
          return failedResult({
            reason: 'type_failed',
            phase: 'during_write',
            duplicateRisk: progress.textMayHaveReachedPane || progress.newlineMayHaveReachedPane ? 'possible' : 'none',
            progress,
          });
        }
        progress.textMayHaveReachedPane = true;
      }
    }

    if (lineIndex < normalizedLines.length - 1) {
      const insertedNewline = await timedCommandSucceeded(params.executor, ['send-keys', '-t', params.target, 'C-j'], deadline);
      if (insertedNewline === 'timeout') {
        progress.newlineMayHaveReachedPane = true;
        return failedResult({
          reason: 'timeout',
          phase: 'during_write',
          duplicateRisk: 'possible',
          progress,
        });
      }
      if (insertedNewline === 'failed') {
        return failedResult({
          reason: 'newline_failed',
          phase: 'during_write',
          duplicateRisk: progress.textMayHaveReachedPane ? 'possible' : 'none',
          progress,
        });
      }
      progress.newlineMayHaveReachedPane = true;
    }
  }

  const submitDelayMs = params.submitDelayMs ?? 0;
  if (submitDelayMs > 0) {
    await (params.wait ?? waitFor)(submitDelayMs);
  }

  const submitDeadline = createTerminalHostDeadline(resolvePromptSubmitTimeoutMs({
    remainingTimeoutMs: remainingTerminalHostDeadlineMs(deadline),
    fallbackTimeoutMs: params.timeoutMs,
  }));
  const submitted = await timedCommandSucceeded(params.executor, ['send-keys', '-t', params.target, 'C-m'], submitDeadline);
  if (submitted === 'timeout') {
    progress.submitMayHaveReachedPane = true;
    return failedResult({
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      progress,
    });
  }
  if (submitted === 'failed') {
    return failedResult({
      reason: 'submit_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: progress.textMayHaveReachedPane || progress.newlineMayHaveReachedPane ? 'possible' : 'none',
      progress,
    });
  }

  return { success: true };
}
