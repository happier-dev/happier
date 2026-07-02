import type {
  TerminalHostAdapter,
  TerminalHostHandle,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputInjectionResult,
  TerminalInputState,
  TerminalPromptInput,
} from '@happier-dev/agents';

import { createTmuxTerminalControlPort } from './control';
import { resolveTmuxPromptSubmitDelayMs, resolveTmuxSendKeysChunkSize } from './env';
import { evaluateTmuxPaneLiveness } from './paneLiveness';
import { TmuxUtilities, type TmuxSpawnOptions } from './TmuxUtilities';
import { typeTextViaSendKeys } from './typeText';
import type { TmuxCommandResult, TmuxControlSequence } from './types';

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
  sendKeys(keys: string | TmuxControlSequence, session?: string, window?: string, pane?: string): Promise<boolean>;
  killWindow(sessionIdentifier: string): Promise<boolean>;
}>;

function targetFromHandle(handle: TerminalHostHandle): string {
  return handle.paneId ? `${handle.sessionName}:${handle.paneId}` : handle.sessionName;
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

export function createTmuxTerminalHostAdapter(params?: Readonly<{
  tmux?: TmuxTerminalHostUtility;
  now?: () => number;
  wait?: (delayMs: number) => Promise<void>;
}>): TerminalHostAdapter {
  const tmux = params?.tmux ?? new TmuxUtilities();
  const now = params?.now ?? Date.now;
  const wait = params?.wait ?? ((delayMs: number) => (delayMs <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, delayMs))));

  async function evaluateLiveness(handle: TerminalHostHandle) {
    return evaluateTmuxPaneLiveness({
      target: targetFromHandle(handle),
      executor: (args) => tmux.executeTmuxCommand([...args]),
    });
  }

  async function captureInputState(handle: TerminalHostHandle): Promise<TerminalInputState> {
    const target = targetFromHandle(handle);
    // Two full-pane captures with a short stability delay, mirroring the zellij adapter:
    // `stable` means the screen did not change between samples. Returns the FULL pane so the
    // multi-line steer-veto parser sees dialogs/prompts above the bottom composer. Replaces
    // the old captureCurrentInput + isUserTyping(50,2) path that did three captures and fed a
    // single line into the parser.
    const before = await tmux.captureCurrentInput(target);
    await wait(DEFAULT_INPUT_STABILITY_DELAY_MS);
    const after = await tmux.captureCurrentInput(target);
    return { stable: before === after, currentInput: after, observedAt: now() };
  }

  return {
    kind: 'tmux',
    async createOrAttachHost(opts) {
      const result = await tmux.spawnInTmux([...opts.spawnArgv], {
        sessionName: opts.sessionName,
        windowName: opts.sessionName,
        cwd: opts.workingDirectory,
      }, { ...opts.spawnEnv });
      if (!result.success) {
        throw new Error(result.error ?? 'Failed to create tmux terminal host');
      }
      return {
        kind: 'tmux',
        sessionName: result.sessionName ?? opts.sessionName,
        ...(result.windowName ? { paneId: result.windowName } : {}),
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'exclusive',
          locality: 'same_machine',
          maxClients: null,
          requiresLocalAttachmentInfo: true,
          liveProbe: 'required',
        },
      };
    },
    async injectUserPrompt(handle, input) {
      const observedAt = now();
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

      const typed = await typeTextViaSendKeys({
        target: targetFromHandle(handle),
        text: input.text,
        chunkSize: resolveTmuxSendKeysChunkSize(),
        submitDelayMs: resolveTmuxPromptSubmitDelayMs(),
        timeoutMs: input.scheduling.timeoutMs,
        executor: (args, options) => tmux.executeTmuxCommand(
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
        const reason = typed.reason === 'submit_failed'
          ? 'submit_failed'
          : typed.reason === 'timeout'
            ? 'timeout'
            : typed.reason === 'invalid_chunk_size'
              ? 'unsupported'
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
      const success = await tmux.sendKeys('Escape', targetFromHandle(handle));
      if (!success) throw new Error('Failed to interrupt tmux terminal host');
    },
    evaluateLiveness,
    captureInputState,
    createControlPort(handle) {
      return createTmuxTerminalControlPort({
        target: targetFromHandle(handle),
        executor: (args, options) => tmux.executeTmuxCommand(
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
      await tmux.killWindow(targetFromHandle(handle));
    },
  };
}
