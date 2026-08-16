import { randomUUID } from 'node:crypto';

import type {
  TerminalAttachmentId,
  TerminalHostAdapter,
  TerminalHostHandle,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputInjectionResult,
  TerminalInputState,
  TerminalPromptInput,
  TerminalPromptWriteBoundaryV1,
} from '../terminalHost/_types';
import { delay } from '@/utils/time';

import { createTmuxTerminalControlPort } from './control';
import { resolveTmuxPromptSubmitDelayMs } from './env';
import { evaluateTmuxPaneLiveness } from './paneLiveness';
import { TmuxUtilities } from './TmuxUtilities';
import { pasteTextViaTmuxBuffer } from './typeText';
import {
  resolveTerminalPromptSubmissionFailureReason,
  type TerminalPromptSubmitVerificationPolicy,
} from '../terminalHost/promptSubmitVerification';
import { resolveTerminalPromptWriteTimeoutMs } from '@/agent/runtime/terminal/injection/promptWriteTimeout';
import { createTmuxTerminalHostHandle } from './hostHandle';

/**
 * Stability sampling delay between the two full-pane captures used to detect that the user is
 * actively typing into the attached TUI. Mirrors zellij's `inputStabilityDelayMs` default.
 */
const INPUT_STABILITY_DELAY_MS = 50;

function targetFromHandle(handle: TerminalHostHandle): string {
  return handle.paneId ? `${handle.sessionName}:${handle.paneId}` : handle.sessionName;
}

export function resolveTmuxCommandEnvironmentForHostHandle(
  handle: TerminalHostHandle,
): Record<string, string> | undefined {
  const tmuxTmpDir = typeof handle.socketDir === 'string' ? handle.socketDir.trim() : '';
  return tmuxTmpDir ? { TMUX_TMPDIR: tmuxTmpDir } : undefined;
}

function createTmuxPromptBufferName(): string {
  return `happier_prompt_${randomUUID().replace(/-/g, '')}`;
}

function cursorPositionsEqual(
  first: Readonly<{ x: number; y: number }> | null,
  second: Readonly<{ x: number; y: number }> | null,
): boolean {
  if (first === null || second === null) return true;
  return first.x === second.x && first.y === second.y;
}

function scheduledDeferral(input: TerminalPromptInput): Extract<TerminalInputInjectionResult, { status: 'deferred' }> | null {
  const reason = input.scheduling.deferReason;
  if (!reason) return null;
  return {
    status: 'deferred',
    reason,
    ...(input.scheduling.retryAfterMs !== undefined ? { retryAfterMs: input.scheduling.retryAfterMs } : {}),
  };
}

function failedInjectionResult(params: Readonly<{
  reason: Extract<TerminalInputInjectionResult, { status: 'failed' }>['reason'];
  phase: TerminalInjectionFailurePhase;
  duplicateRisk: TerminalInjectionDuplicateRisk;
  recoverable: boolean;
}>): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
  return {
    status: 'failed',
    reason: params.reason,
    phase: params.phase,
    duplicateRisk: params.duplicateRisk,
    recoverable: params.recoverable,
  };
}

export function createTmuxTerminalHostAdapter(params?: Readonly<{
  tmux?: TmuxUtilities;
  promptSubmitVerification?: TerminalPromptSubmitVerificationPolicy | undefined;
}>): TerminalHostAdapter {
  const tmux = params?.tmux ?? new TmuxUtilities();
  const promptSubmitVerification = params?.promptSubmitVerification;
  const tmuxForHandle = (handle: TerminalHostHandle): TmuxUtilities => {
    if (params?.tmux) return params.tmux;
    const environment = resolveTmuxCommandEnvironmentForHostHandle(handle);
    return environment ? new TmuxUtilities(undefined, environment) : tmux;
  };

  async function evaluateLiveness(handle: TerminalHostHandle) {
    const handleTmux = tmuxForHandle(handle);
    return evaluateTmuxPaneLiveness({
      target: targetFromHandle(handle),
      executor: (args) => handleTmux.executeTmuxCommand([...args]),
    });
  }

  async function captureInputState(handle: TerminalHostHandle): Promise<TerminalInputState> {
    // R-E1/R-E3: two FULL-pane normalized captures (matching the zellij adapter) give the multi-line
    // `parseClaudeScreenState` parser the whole screen AND a real stability signal in one path. The
    // previous `captureCurrentInput` + `isUserTyping(50, 2)` combination did 3 captures (the first
    // `isUserTyping` sample re-read what `captureCurrentInput` had just read) and fed the parser only
    // the bottom line.
    const target = targetFromHandle(handle);
    const handleTmux = tmuxForHandle(handle);
    try {
      const firstInput = await handleTmux.captureCurrentInput(target);
      const firstCursor = await handleTmux.captureCursorPosition(target);
      await delay(INPUT_STABILITY_DELAY_MS);
      const currentInput = await handleTmux.captureCurrentInput(target);
      const cursor = await handleTmux.captureCursorPosition(target);
      return {
        stable: firstInput === currentInput && cursorPositionsEqual(firstCursor, cursor),
        currentInput,
        ...(cursor !== null ? { cursor } : {}),
        observedAt: Date.now(),
      };
    } catch {
      return {
        stable: false,
        currentInput: '',
        observedAt: Date.now(),
      };
    }
  }

  const createOrAttachHost: TerminalHostAdapter['createOrAttachHost'] = async (opts) => {
    const result = await tmux.spawnInTmux([...opts.spawnArgv], {
      sessionName: opts.sessionName,
      windowName: opts.sessionName,
      cwd: opts.workingDirectory,
      requireNewSession: true,
    }, { ...opts.spawnEnv });
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to create tmux terminal host');
    }
    return createTmuxTerminalHostHandle({
      attachmentId: randomUUID() as TerminalAttachmentId,
      sessionName: result.sessionName ?? opts.sessionName,
      windowName: result.windowName,
      topology: 'exclusive',
    });
  };

  return {
    kind: 'tmux',
    createOrAttachHost,
    async adoptExistingHost(handle: TerminalHostHandle): Promise<TerminalHostHandle> {
      const liveness = await evaluateLiveness(handle);
      if (!liveness.paneAlive) {
        throw new Error('Cannot adopt tmux terminal host because the target pane is not alive');
      }
      return handle;
    },
    async injectUserPrompt(
      handle: TerminalHostHandle,
      input: TerminalPromptInput,
      writeBoundary?: TerminalPromptWriteBoundaryV1,
    ): Promise<TerminalInputInjectionResult> {
      const deferral = scheduledDeferral(input);
      if (deferral) return deferral;
      const handleTmux = tmuxForHandle(handle);

      if (handle.sessionName.trim().length === 0) {
        return failedInjectionResult({
          reason: 'no_target',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: true,
        });
      }

      const liveness = await evaluateLiveness(handle);
      if (!liveness.paneAlive) {
        if (liveness.paneDead !== true) {
          return {
            status: 'deferred',
            reason: 'pane_initializing',
            ...(input.scheduling.retryAfterMs !== undefined ? { retryAfterMs: input.scheduling.retryAfterMs } : {}),
          };
        }
        return failedInjectionResult({
          reason: 'pane_dead',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: false,
        });
      }
      if (input.scheduling.deferredUntilQuietMs !== undefined && input.scheduling.deferredUntilQuietMs > 0) {
        const inputState = await captureInputState(handle);
        if (!inputState.stable) {
          return {
            status: 'deferred',
            reason: 'user_typing',
            retryAfterMs: input.scheduling.deferredUntilQuietMs,
          };
        }
      }
      let writeAuthorized = false;
      const result = await pasteTextViaTmuxBuffer({
        target: targetFromHandle(handle),
        text: input.text,
        bufferName: createTmuxPromptBufferName(),
        submitDelayMs: resolveTmuxPromptSubmitDelayMs(),
        submitRetryDelayMs: resolveTmuxPromptSubmitDelayMs(),
        timeoutMs: input.scheduling.timeoutMs ?? resolveTerminalPromptWriteTimeoutMs(input.text),
        ...(writeBoundary
          ? {
              authorizeBeforeWrite: async () => {
                const authorized = await writeBoundary.authorizeBeforeWrite();
                writeAuthorized = authorized;
                return authorized;
              },
            }
          : {}),
        ...(promptSubmitVerification?.shouldVerifyAfterSubmit(input.text)
          ? {
            verifyStagedBeforeSubmit: async ({ text }) => promptSubmitVerification.isPromptStagedBeforeSubmit({
              promptText: text,
              screenText: await handleTmux.captureCurrentInput(targetFromHandle(handle)),
            }),
            verifyAfterSubmit: async ({ text }) => promptSubmitVerification.isPromptStillPendingAfterSubmit({
              promptText: text,
              screenText: await handleTmux.captureCurrentInput(targetFromHandle(handle)),
            }),
          }
          : {}),
        executor: (args, options) => handleTmux.executeTmuxCommand(
          [...args],
          undefined,
          undefined,
          undefined,
          undefined,
          options?.stdin,
          options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined,
        ),
      });
      if (!result.success) {
        if (result.reason === 'write_not_authorized') {
          return failedInjectionResult({
            reason: 'no_target',
            phase: 'before_write',
            duplicateRisk: 'none',
            recoverable: false,
          });
        }
        return failedInjectionResult({
          reason: resolveTerminalPromptSubmissionFailureReason(result.reason),
          phase: writeAuthorized && result.phase === 'before_write' ? 'during_write' : result.phase,
          duplicateRisk: writeAuthorized && result.duplicateRisk === 'none' ? 'possible' : result.duplicateRisk,
          recoverable: true,
        });
      }
      return { status: 'injected', at: Date.now(), bytesWritten: Buffer.byteLength(input.text) };
    },
    async interruptTurn(handle: TerminalHostHandle): Promise<void> {
      const success = await tmuxForHandle(handle).sendKeys('Escape', targetFromHandle(handle));
      if (!success) {
        throw new Error('Failed to interrupt tmux terminal host');
      }
    },
    evaluateLiveness,
    captureInputState,
    createControlPort(handle: TerminalHostHandle) {
      if (handle.sessionName.trim().length === 0) return null;
      const handleTmux = tmuxForHandle(handle);
      return createTmuxTerminalControlPort({
        target: targetFromHandle(handle),
        executor: (args, options) => handleTmux.executeTmuxCommand(
          [...args],
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined,
        ),
      });
    },
    async dispose(handle: TerminalHostHandle) {
      const handleTmux = tmuxForHandle(handle);
      if (handle.attachMetadata.topology === 'exclusive') {
        const result = await handleTmux.executeTmuxCommand(['kill-session'], handle.sessionName);
        if (!result || result.returncode !== 0) {
          throw new Error(`Failed to destroy owned tmux session ${handle.sessionName}`);
        }
        return;
      }
      if (!handle.paneId?.trim()) {
        throw new Error('Cannot destroy shared tmux terminal host without its owned window id');
      }
      const removed = await handleTmux.killWindow(targetFromHandle(handle));
      if (!removed) {
        throw new Error(`Failed to destroy owned tmux window ${targetFromHandle(handle)}`);
      }
    },
  };
}
