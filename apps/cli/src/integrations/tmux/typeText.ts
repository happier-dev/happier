import type {
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
} from '@happier-dev/agents';

import type { TmuxCommandResult } from './types';
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
      reason: 'load_failed' | 'paste_failed' | 'verification_failed' | 'submit_failed' | 'timeout';
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

function failure(params: Readonly<{
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

function nativePasteFailure(params: Readonly<{
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

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function commandSucceeded(
  executor: TmuxCommandExecutor,
  args: readonly string[],
  options?: Readonly<{ stdin?: string; timeoutMs?: number }>,
): Promise<'success' | 'failed' | 'timeout'> {
  const result = await executor(args, options);
  if (result?.timedOut === true) return 'timeout';
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

async function runTimedCommand(
  executor: TmuxCommandExecutor,
  args: readonly string[],
  deadline: number | undefined,
): Promise<'success' | 'failed' | 'timeout'> {
  const timeoutMs = remainingTerminalHostDeadlineMs(deadline);
  if (timeoutMs === 0) return 'timeout';
  const result = await executor(args, timeoutMs !== undefined ? { timeoutMs } : undefined);
  if (result?.timedOut === true) return 'timeout';
  return result !== null && result.returncode === 0 ? 'success' : 'failed';
}

function duplicateRiskAfterWrite(progress: TmuxTypeTextProgress): TerminalInjectionDuplicateRisk {
  return progress.textMayHaveReachedPane || progress.newlineMayHaveReachedPane ? 'possible' : 'none';
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
  submitDelayMs?: number;
  submitRetryDelayMs?: number;
  timeoutMs?: number;
  wait?: (delayMs: number) => Promise<void>;
  verifyBeforeSubmit?: (params: Readonly<{ text: string; remainingTimeoutMs?: number }>) => Promise<boolean>;
  verifyAfterSubmit?: (params: Readonly<{ text: string; remainingTimeoutMs?: number }>) => Promise<boolean>;
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
    return nativePasteFailure({
      reason: 'timeout',
      phase: 'before_write',
      duplicateRisk: 'none',
      progress,
    });
  }
  if (loaded === 'failed') {
    return nativePasteFailure({
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
    return nativePasteFailure({
      reason: 'timeout',
      phase: 'before_write',
      duplicateRisk: 'none',
      progress,
    });
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
    return nativePasteFailure({
      reason: pasted === 'timeout' ? 'timeout' : 'paste_failed',
      phase: 'during_write',
      duplicateRisk: pasted === 'timeout' ? 'possible' : 'none',
      progress,
    });
  }
  progress.pasteMayHaveReachedPane = true;

  const submitDelayMs = params.submitDelayMs ?? 0;
  if (submitDelayMs > 0) {
    await (params.wait ?? defaultWait)(submitDelayMs);
  }

  async function sendSubmitEnter(): Promise<'success' | 'timeout' | 'failed'> {
    const submitDeadline = createTerminalHostDeadline(resolvePromptSubmitTimeoutMs({
      remainingTimeoutMs: remainingTerminalHostDeadlineMs(deadline),
      fallbackTimeoutMs: params.timeoutMs,
    }));
    return timedCommandSucceeded(params.executor, ['send-keys', '-t', params.target, 'C-m'], submitDeadline);
  }

  const submission = await runTerminalPromptSubmission({
    promptText: normalizedText,
    ...(params.verifyBeforeSubmit
      ? {
        verifyBeforeSubmit: async ({ promptText, remainingTimeoutMs }) => params.verifyBeforeSubmit?.({
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
    remainingTimeoutMs: () => remainingTerminalHostDeadlineMs(deadline),
    wait: params.wait ?? defaultWait,
    submitRetryDelayMs: params.submitRetryDelayMs ?? 0,
  });
  progress.submitMayHaveReachedPane = submission.success ? true : submission.submitMayHaveReachedPane;
  if (!submission.success) {
    return nativePasteFailure({
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
  submitDelayMs?: number;
  timeoutMs?: number;
  wait?: (delayMs: number) => Promise<void>;
}>): Promise<TmuxTypeTextResult> {
  const progress: TmuxTypeTextProgress = {
    textMayHaveReachedPane: false,
    newlineMayHaveReachedPane: false,
    submitMayHaveReachedPane: false,
  };

  if (!Number.isSafeInteger(params.chunkSize) || params.chunkSize <= 0) {
    return failure({
      reason: 'invalid_chunk_size',
      phase: 'before_write',
      duplicateRisk: 'none',
      progress,
    });
  }

  const deadline = createTerminalHostDeadline(params.timeoutMs);
  const lines = params.text.replace(/\r\n?/g, '\n').split('\n');

  for (const [lineIndex, line] of lines.entries()) {
    for (const chunk of splitStringByCodePoints(line, params.chunkSize)) {
      const written = await runTimedCommand(params.executor, ['send-keys', '-t', params.target, '-l', '--', chunk], deadline);
      if (written === 'timeout') {
        progress.textMayHaveReachedPane = true;
        return failure({
          reason: 'timeout',
          phase: 'during_write',
          duplicateRisk: 'possible',
          progress,
        });
      }
      if (written === 'failed') {
        return failure({
          reason: 'type_failed',
          phase: 'during_write',
          duplicateRisk: duplicateRiskAfterWrite(progress),
          progress,
        });
      }
      progress.textMayHaveReachedPane = true;
    }

    if (lineIndex < lines.length - 1) {
      const newline = await runTimedCommand(params.executor, ['send-keys', '-t', params.target, 'C-j'], deadline);
      if (newline === 'timeout') {
        progress.newlineMayHaveReachedPane = true;
        return failure({
          reason: 'timeout',
          phase: 'during_write',
          duplicateRisk: 'possible',
          progress,
        });
      }
      if (newline === 'failed') {
        return failure({
          reason: 'newline_failed',
          phase: 'during_write',
          duplicateRisk: duplicateRiskAfterWrite(progress),
          progress,
        });
      }
      progress.newlineMayHaveReachedPane = true;
    }
  }

  const submitDelayMs = params.submitDelayMs ?? 0;
  if (submitDelayMs > 0) {
    await (params.wait ?? defaultWait)(submitDelayMs);
  }

  const submitDeadline = createTerminalHostDeadline(resolvePromptSubmitTimeoutMs({
    remainingTimeoutMs: remainingTerminalHostDeadlineMs(deadline),
    fallbackTimeoutMs: params.timeoutMs,
  }));
  const submitted = await runTimedCommand(params.executor, ['send-keys', '-t', params.target, 'C-m'], submitDeadline);
  if (submitted === 'timeout') {
    progress.submitMayHaveReachedPane = true;
    return failure({
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      progress,
    });
  }
  if (submitted === 'failed') {
    return failure({
      reason: 'submit_failed',
      phase: 'after_enter_unknown',
      duplicateRisk: duplicateRiskAfterWrite(progress),
      progress,
    });
  }

  return { success: true };
}
