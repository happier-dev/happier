import { randomUUID } from 'node:crypto';

import {
  resolveTerminalPromptWriteTimeoutMs,
  type TerminalHostAdapter,
  type TerminalHostHandle,
  type TerminalInjectionDuplicateRisk,
  type TerminalInjectionFailurePhase,
  type TerminalInputInjectionResult,
  type TerminalInputState,
  type TerminalPromptInput,
} from '@happier-dev/agents';
import {
  resolveTerminalPromptSubmissionFailureReason,
  type TerminalPromptSubmitVerificationPolicy,
} from '../terminalHost/promptSubmitVerification';

import { createTmuxTerminalControlPort } from './control';
import { resolveTmuxPromptSubmitDelayMs } from './env';
import { evaluateTmuxPaneLiveness } from './paneLiveness';
import { TmuxUtilities, type TmuxSpawnOptions } from './TmuxUtilities';
import { pasteTextViaTmuxBuffer } from './typeText';
import type { TmuxCommandResult, TmuxControlSequence } from './types';
import { createTmuxTerminalHostHandle } from './hostHandle';
import {
  normalizeCapturedScreen,
} from '../terminalHost/controlCapture';

export type TmuxTerminalHostUtility = Readonly<{
  executeTmuxCommand(
    cmd: readonly string[],
    session?: string,
    window?: string,
    pane?: string,
    socketPath?: string,
    stdin?: string,
    options?: Readonly<{ timeoutMs?: number }>,
  ): Promise<TmuxCommandResult | null>;
  spawnInTmux(
    args: string[],
    options?: TmuxSpawnOptions,
    env?: Record<string, string>,
  ): Promise<{ success: boolean; sessionId?: string; sessionName?: string; windowName?: string; pid?: number; error?: string }>;
  captureCurrentInput(session?: string, window?: string, pane?: string): Promise<string>;
  captureCursorPosition(session?: string, window?: string, pane?: string): Promise<Readonly<{ x: number; y: number }> | null>;
  sendKeys(keys: string | TmuxControlSequence, session?: string, window?: string, pane?: string): Promise<boolean>;
  killWindow(sessionIdentifier: string): Promise<boolean>;
}>;

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

function handleFields(handle: TerminalHostHandle): Pick<Extract<TerminalInputInjectionResult, { status: 'injected' }>, 'hostKind' | 'hostSessionName' | 'paneId'> {
  return {
    hostKind: 'tmux',
    hostSessionName: handle.sessionName,
    ...(handle.paneId ? { paneId: handle.paneId } : {}),
  };
}

function scheduledDeferral(
  handle: TerminalHostHandle,
  input: TerminalPromptInput,
  observedAt: number,
): Extract<TerminalInputInjectionResult, { status: 'deferred' }> | null {
  const reason = input.scheduling.deferReason;
  if (!reason) return null;
  return {
    status: 'deferred',
    reason,
    recoverable: true,
    observedAt,
    ...(input.scheduling.retryAfterMs !== undefined ? { retryAfterMs: input.scheduling.retryAfterMs } : {}),
    ...handleFields(handle),
  };
}

function failedInjectionResult(params: Readonly<{
  handle?: TerminalHostHandle;
  reason: Extract<TerminalInputInjectionResult, { status: 'failed' }>['reason'];
  phase: TerminalInjectionFailurePhase;
  duplicateRisk: TerminalInjectionDuplicateRisk;
  recoverable: boolean;
  observedAt: number;
  diagnostic?: string;
}>): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
  return {
    status: 'failed',
    reason: params.reason,
    phase: params.phase,
    duplicateRisk: params.duplicateRisk,
    recoverable: params.recoverable,
    observedAt: params.observedAt,
    ...(params.handle ? handleFields(params.handle) : {}),
    ...(params.diagnostic ? { diagnostic: params.diagnostic } : {}),
  };
}

const DEFAULT_INPUT_STABILITY_DELAY_MS = 50;

function cursorPositionsEqual(
  left: Readonly<{ x: number; y: number }> | null,
  right: Readonly<{ x: number; y: number }> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.x === right.x && left.y === right.y;
}

export function createTmuxTerminalHostAdapter(params?: Readonly<{
  tmux?: TmuxTerminalHostUtility;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
  promptSubmitVerification?: TerminalPromptSubmitVerificationPolicy;
}>): TerminalHostAdapter {
  const tmux = params?.tmux ?? new TmuxUtilities();
  const now = params?.now ?? Date.now;
  const wait = params?.wait ?? ((delayMs: number) => (delayMs <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, delayMs))));
  const tmuxForHandle = (handle: TerminalHostHandle): TmuxTerminalHostUtility => {
    if (params?.tmux) return params.tmux;
    const environment = resolveTmuxCommandEnvironmentForHostHandle(handle);
    return environment ? new TmuxUtilities(undefined, environment) : tmux;
  };

  async function evaluateLiveness(handle: TerminalHostHandle) {
    const handleTmux = tmuxForHandle(handle);
    return evaluateTmuxPaneLiveness({
      target: targetFromHandle(handle),
      executor: (args) => handleTmux.executeTmuxCommand([...args]),
      observedAt: now(),
    });
  }

  async function captureInputState(handle: TerminalHostHandle): Promise<TerminalInputState> {
    const target = targetFromHandle(handle);
    const handleTmux = tmuxForHandle(handle);
    // Two full-pane captures with a short stability delay, mirroring the zellij adapter:
    // `stable` means the screen did not change between samples. Returns the FULL pane so the
    // multi-line steer-veto parser sees dialogs/prompts above the bottom composer. Replaces
    // the old captureCurrentInput + isUserTyping(50,2) path that did three captures and fed a
    // single line into the parser.
    try {
      const before = await handleTmux.captureCurrentInput(target);
      const beforeCursor = await handleTmux.captureCursorPosition(target);
      await wait(DEFAULT_INPUT_STABILITY_DELAY_MS);
      const after = await handleTmux.captureCurrentInput(target);
      const cursor = await handleTmux.captureCursorPosition(target);
      return {
        stable: before === after && cursorPositionsEqual(beforeCursor, cursor),
        currentInput: after,
        ...(cursor !== null ? { cursor } : {}),
        observedAt: now(),
      };
    } catch {
      return {
        stable: false,
        currentInput: '',
        observedAt: now(),
      };
    }
  }

  return {
    kind: 'tmux',
    async createOrAttachHost(opts) {
      const result = await tmux.spawnInTmux([...opts.spawnArgv], {
        sessionName: opts.sessionName,
        windowName: opts.sessionName,
        cwd: opts.workingDirectory,
        unsetEnvKeys: opts.unsetEnvKeys,
        requireNewSession: true,
      }, { ...opts.spawnEnv });
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to create tmux terminal host');
      }
      return createTmuxTerminalHostHandle({
        sessionName: result.sessionName ?? opts.sessionName,
        windowName: result.windowName,
        topology: 'exclusive',
      });
    },
    async injectUserPrompt(handle, input) {
      const observedAt = now();
      const handleTmux = tmuxForHandle(handle);
      const deferral = scheduledDeferral(handle, input, observedAt);
      if (deferral) return deferral;

      if (handle.sessionName.trim().length === 0) {
        return failedInjectionResult({
          handle,
          reason: 'no_target',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: true,
          observedAt,
        });
      }

      const liveness = await evaluateLiveness(handle);
      if (!liveness.paneAlive) {
        if (liveness.paneDead !== true) {
          return {
            status: 'deferred',
            reason: 'liveness_uncertain',
            recoverable: true,
            observedAt: liveness.observedAt,
            ...handleFields(handle),
          };
        }
        return failedInjectionResult({
          handle,
          reason: 'pane_dead',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: false,
          observedAt: liveness.observedAt,
        });
      }

      if (input.scheduling.deferredUntilQuietMs !== undefined && input.scheduling.deferredUntilQuietMs > 0) {
        const inputState = await captureInputState(handle);
        if (!inputState.stable) {
          return {
            status: 'deferred',
            reason: 'user_typing',
            recoverable: true,
            observedAt: inputState.observedAt,
            retryAfterMs: input.scheduling.deferredUntilQuietMs,
            ...handleFields(handle),
          };
        }
      }

      const typed = await pasteTextViaTmuxBuffer({
        target: targetFromHandle(handle),
        text: input.text,
        bufferName: createTmuxPromptBufferName(),
        submitDelayMs: resolveTmuxPromptSubmitDelayMs(),
        submitRetryDelayMs: resolveTmuxPromptSubmitDelayMs(),
        timeoutMs: input.scheduling.timeoutMs ?? resolveTerminalPromptWriteTimeoutMs(input.text),
        wait,
        ...(params?.promptSubmitVerification?.shouldVerifyAfterSubmit(input.text)
          ? {
              verifyStagedBeforeSubmit: async ({ text }) => (
                params.promptSubmitVerification?.verifyBeforeSubmitStaging
                ?? params.promptSubmitVerification?.verifyAfterSubmit
              )?.({
                promptText: text,
                screenText: normalizeCapturedScreen(await handleTmux.captureCurrentInput(targetFromHandle(handle))),
              }) ?? false,
              verifyAfterSubmit: async ({ text }) => params.promptSubmitVerification?.verifyAfterSubmit({
                promptText: text,
                screenText: normalizeCapturedScreen(await handleTmux.captureCurrentInput(targetFromHandle(handle))),
              }) ?? false,
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

      if (!typed.success) {
        const reason = typed.reason === 'verification_failed'
          ? resolveTerminalPromptSubmissionFailureReason(typed.reason)
          : typed.reason === 'submit_failed'
            ? 'submit_failed'
            : typed.reason === 'timeout'
              ? 'timeout'
              : 'write_failed';
        return failedInjectionResult({
          handle,
          reason,
          phase: typed.phase,
          duplicateRisk: typed.duplicateRisk,
          recoverable: typed.duplicateRisk !== 'likely',
          observedAt: now(),
        });
      }

      return {
        status: 'injected',
        injectedAt: now(),
        bytesWritten: Buffer.byteLength(input.text),
        ...handleFields(handle),
      };
    },
    async interruptTurn(handle): Promise<void> {
      const success = await tmuxForHandle(handle).sendKeys('Escape', targetFromHandle(handle));
      if (!success) throw new Error('Failed to interrupt tmux terminal host');
    },
    evaluateLiveness,
    captureInputState,
    createControlPort(handle) {
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
        nowMs: now,
      });
    },
    async dispose(handle): Promise<void> {
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
