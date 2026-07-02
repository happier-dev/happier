import type {
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
} from '@happier-dev/agents';

import type { TmuxCommandResult } from './types';

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

type TmuxTypeTextProgress = {
  textMayHaveReachedPane: boolean;
  newlineMayHaveReachedPane: boolean;
  submitMayHaveReachedPane: boolean;
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

function defaultWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function splitByCodePoint(text: string, chunkSize: number): string[] {
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += chunkSize) {
    chunks.push(codePoints.slice(index, index + chunkSize).join(''));
  }
  return chunks;
}

function createDeadline(timeoutMs: number | undefined): number | undefined {
  return timeoutMs !== undefined && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
}

function remainingTimeoutMs(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  return Math.max(0, deadline - Date.now());
}

async function runTimedCommand(
  executor: TmuxCommandExecutor,
  args: readonly string[],
  deadline: number | undefined,
): Promise<'success' | 'failed' | 'timeout'> {
  const timeoutMs = remainingTimeoutMs(deadline);
  if (timeoutMs === 0) return 'timeout';
  const result = await executor(args, timeoutMs !== undefined ? { timeoutMs } : undefined);
  if (result?.timedOut === true) return 'timeout';
  return result !== null && result.returncode === 0 ? 'success' : 'failed';
}

function duplicateRiskAfterWrite(progress: TmuxTypeTextProgress): TerminalInjectionDuplicateRisk {
  return progress.textMayHaveReachedPane || progress.newlineMayHaveReachedPane ? 'possible' : 'none';
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

  const deadline = createDeadline(params.timeoutMs);
  const lines = params.text.replace(/\r\n?/g, '\n').split('\n');

  for (const [lineIndex, line] of lines.entries()) {
    for (const chunk of splitByCodePoint(line, params.chunkSize)) {
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
    const timeoutMs = remainingTimeoutMs(deadline);
    if (timeoutMs === 0 || (timeoutMs !== undefined && timeoutMs < submitDelayMs)) {
      if (timeoutMs !== undefined && timeoutMs > 0) {
        await (params.wait ?? defaultWait)(timeoutMs);
      }
      return failure({
        reason: 'timeout',
        phase: 'after_write_before_enter',
        duplicateRisk: duplicateRiskAfterWrite(progress),
        progress,
      });
    }
    await (params.wait ?? defaultWait)(submitDelayMs);
  }

  const submitted = await runTimedCommand(params.executor, ['send-keys', '-t', params.target, 'C-m'], deadline);
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
