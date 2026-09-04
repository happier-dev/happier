import { Buffer } from 'node:buffer';

import type {
  TerminalControlPort,
  TerminalSpecialKey,
} from '@happier-dev/agents';

import type {
  TerminalHostAdapter,
  TerminalHostHandle,
  TerminalHostLiveness,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputInjectionResult,
  TerminalInputState,
  TerminalPromptInput,
  TerminalPromptWriteBoundaryV1,
} from '../terminalHost/_types';
import { buildTerminalControlCapture } from '../terminalHost/controlCapture';
import { TERMINAL_SHIFT_TAB_SEQUENCE } from '../terminalHost/controlTypes';
import {
  createTerminalHostDeadline,
  remainingTerminalHostDeadlineMs,
} from '../terminalHost/deadline';
import {
  runTerminalPromptSubmission,
  resolveTerminalPromptSubmissionFailureReason,
  type TerminalPromptSubmitVerificationPolicy,
} from '../terminalHost/promptSubmitVerification';
import { wrapBracketedPaste } from '@/agent/runtime/terminal/injection/bracketedPaste';
import { resolveTerminalPromptWriteTimeoutMs } from '@/agent/runtime/terminal/injection/promptWriteTimeout';
import type { Disposable, PtyProcess, PtyProvider } from '@/integrations/pty/ptyProvider';
import { createNodePtyProvider } from '@/integrations/pty/ptyProvider';
import { delay } from '@/utils/time';
import { createVirtualTerminalScreen, type VirtualTerminalScreen } from './virtualTerminalScreen';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const INPUT_STABILITY_DELAY_MS = 50;
const POST_WRITE_LIVENESS_DELAY_MS = 25;

type PtyTerminalHostSession = {
  pty: PtyProcess;
  disposables: Disposable[];
  screen: VirtualTerminalScreen;
  ended: boolean;
  exitCode?: number;
  signal?: number;
};

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

function resolveSpecialKeyBytes(key: TerminalSpecialKey): string {
  switch (key) {
    case 'Enter':
      return '\r';
    case 'Escape':
      return '\u001b';
    case 'ArrowUp':
      return '\u001b[A';
    case 'ArrowDown':
      return '\u001b[B';
    case 'Tab':
      return '\t';
    case 'ShiftTab':
      return TERMINAL_SHIFT_TAB_SEQUENCE;
    case 'CtrlC':
      return '\u0003';
    case 'Backspace':
      return '\u007f';
  }
}

function disposeSession(session: PtyTerminalHostSession): void {
  try {
    session.pty.kill();
  } catch {
    // best-effort
  }
  for (const disposable of session.disposables) {
    try {
      disposable.dispose();
    } catch {
      // best-effort
    }
  }
}

export function createPtyTerminalHostAdapter(params?: Readonly<{
  ptyProvider?: PtyProvider;
  cols?: number;
  rows?: number;
  inputStabilityDelayMs?: number;
  postWriteLivenessDelayMs?: number;
  promptSubmitVerification?: TerminalPromptSubmitVerificationPolicy | undefined;
  now?: () => number;
}>): TerminalHostAdapter {
  const ptyProvider = params?.ptyProvider ?? createNodePtyProvider();
  const cols = Math.max(2, Math.trunc(params?.cols ?? DEFAULT_COLS));
  const rows = Math.max(2, Math.trunc(params?.rows ?? DEFAULT_ROWS));
  const inputStabilityDelayMs = Math.max(0, Math.trunc(params?.inputStabilityDelayMs ?? INPUT_STABILITY_DELAY_MS));
  const postWriteLivenessDelayMs = Math.max(0, Math.trunc(params?.postWriteLivenessDelayMs ?? POST_WRITE_LIVENESS_DELAY_MS));
  const promptSubmitVerification = params?.promptSubmitVerification;
  const now = params?.now ?? (() => Date.now());
  const sessions = new Map<string, PtyTerminalHostSession>();

  function readSession(handle: TerminalHostHandle): PtyTerminalHostSession | null {
    return sessions.get(handle.sessionName) ?? null;
  }

  function writeToSession(session: PtyTerminalHostSession, data: string): boolean {
    if (session.ended) return false;
    try {
      session.pty.write(data);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForPostWriteLiveness(session: PtyTerminalHostSession): Promise<boolean> {
    if (postWriteLivenessDelayMs > 0) {
      await delay(postWriteLivenessDelayMs);
    } else {
      await Promise.resolve();
    }
    return !session.ended;
  }

  async function captureInputState(handle: TerminalHostHandle): Promise<TerminalInputState> {
    const session = readSession(handle);
    if (!session || session.ended) {
      throw new Error('PTY terminal host is not alive');
    }
    const firstInput = session.screen.capture();
    await delay(inputStabilityDelayMs);
    const currentInput = session.screen.capture();
    return {
      stable:
        firstInput.text === currentInput.text
        && firstInput.cursor.x === currentInput.cursor.x
        && firstInput.cursor.y === currentInput.cursor.y,
      currentInput: currentInput.text,
      cursor: currentInput.cursor,
      observedAt: now(),
    };
  }

  function createControlPort(handle: TerminalHostHandle): TerminalControlPort | null {
    if (!readSession(handle)) return null;
    return {
      hostKind: 'windows_console',
      async sendLiteralText(text) {
        const session = readSession(handle);
        if (!session) return { status: 'host_dead', recoverable: true };
        return writeToSession(session, text)
          ? { status: 'sent', at: now() }
          : { status: 'host_dead', recoverable: false };
      },
      async sendRawSequence(sequence) {
        const session = readSession(handle);
        if (!session) return { status: 'host_dead', recoverable: true };
        return writeToSession(session, sequence)
          ? { status: 'sent', at: now() }
          : { status: 'host_dead', recoverable: false };
      },
      async sendSpecialKey(key) {
        const session = readSession(handle);
        if (!session) return { status: 'host_dead', recoverable: true };
        return writeToSession(session, resolveSpecialKeyBytes(key))
          ? { status: 'sent', at: now() }
          : { status: 'host_dead', recoverable: false };
      },
      async captureScreen() {
        const session = readSession(handle);
        if (!session) return { status: 'host_dead', recoverable: true };
        if (session.ended) return { status: 'host_dead', recoverable: false };
        const screen = session.screen.capture();
        return {
          status: 'captured',
          capture: buildTerminalControlCapture({
            rawText: screen.text,
            cursor: screen.cursor,
            hostKind: 'windows_console',
            capturedAtMs: now(),
          }),
        };
      },
    };
  }

  return {
    kind: 'windows_console',
    async createOrAttachHost(opts) {
      const existing = sessions.get(opts.sessionName);
      if (existing && !existing.ended) {
        return {
          kind: 'windows_console',
          sessionName: opts.sessionName,
          paneId: opts.sessionName,
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'shared',
            locality: 'same_machine',
            maxClients: null,
            requiresLocalAttachmentInfo: false,
            liveProbe: 'required',
          },
        };
      }

      const command = opts.spawnArgv[0];
      if (!command) {
        throw new Error('PTY terminal host requires a command to spawn');
      }
      const screen = createVirtualTerminalScreen({ cols, rows });
      const pty = ptyProvider.spawn({
        file: command,
        args: [...opts.spawnArgv.slice(1)],
        options: {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: opts.workingDirectory,
          env: {
            ...process.env,
            ...opts.spawnEnv,
            TERM: opts.spawnEnv.TERM ?? process.env.TERM ?? 'xterm-256color',
          },
          encoding: 'utf8',
        },
      });
      const session: PtyTerminalHostSession = {
        pty,
        disposables: [],
        screen,
        ended: false,
      };
      session.disposables.push(pty.onData((data) => {
        screen.write(String(data ?? ''));
      }));
      session.disposables.push(pty.onExit((event) => {
        session.ended = true;
        session.exitCode = event.exitCode;
        if (typeof event.signal === 'number') session.signal = event.signal;
      }));
      sessions.set(opts.sessionName, session);

      return {
        kind: 'windows_console',
        sessionName: opts.sessionName,
        paneId: opts.sessionName,
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          maxClients: null,
          requiresLocalAttachmentInfo: false,
          liveProbe: 'required',
        },
      };
    },
    async injectUserPrompt(handle, input, writeBoundary?: TerminalPromptWriteBoundaryV1) {
      const deferral = scheduledDeferral(input);
      if (deferral) return deferral;

      const session = readSession(handle);
      if (!session) {
        return failedInjectionResult({
          reason: 'no_target',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: true,
        });
      }
      if (session.ended) {
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
      if (writeBoundary) {
        let authorized = false;
        try {
          authorized = await writeBoundary.authorizeBeforeWrite();
        } catch {
          authorized = false;
        }
        if (!authorized) {
          return failedInjectionResult({
            reason: 'no_target',
            phase: 'before_write',
            duplicateRisk: 'none',
            recoverable: false,
          });
        }
      }
      const shouldStagePrompt = promptSubmitVerification?.shouldVerifyAfterSubmit(input.text) === true;
      const textToWrite = input.multiline && shouldStagePrompt ? wrapBracketedPaste(input.text) : input.text;
      if (!writeToSession(session, textToWrite)) {
        return failedInjectionResult({
          reason: 'host_unreachable',
          phase: 'during_write',
          duplicateRisk: 'possible',
          recoverable: true,
        });
      }
      // Writing and submitting are independent PTY operations. Preserve the bounded timeout for
      // each phase instead of letting a slow successful write exhaust staging/Enter verification.
      const submissionDeadline = createTerminalHostDeadline(
        input.scheduling.timeoutMs ?? resolveTerminalPromptWriteTimeoutMs(input.text),
      );
      const submission = await runTerminalPromptSubmission({
        promptText: input.text,
        ...(shouldStagePrompt
          ? {
            verifyStagedBeforeSubmit: async ({ promptText }) => promptSubmitVerification.isPromptStagedBeforeSubmit({
              promptText,
              screenText: session.screen.capture().text,
            }),
            verifyAfterSubmit: async ({ promptText }) => promptSubmitVerification.isPromptStillPendingAfterSubmit({
              promptText,
              screenText: session.screen.capture().text,
            }),
          }
          : {}),
        submitEnter: async ({ remainingTimeoutMs }) => {
          if (remainingTimeoutMs === 0) return 'timeout';
          if (!writeToSession(session, '\r')) return 'failed';
          return await waitForPostWriteLiveness(session) ? 'success' : 'failed';
        },
        remainingTimeoutMs: () => remainingTerminalHostDeadlineMs(submissionDeadline),
      });
      if (!submission.success) {
        return failedInjectionResult({
          reason: resolveTerminalPromptSubmissionFailureReason(submission.reason),
          phase: submission.phase,
          duplicateRisk: submission.duplicateRisk,
          recoverable: true,
        });
      }
      return { status: 'injected', at: now(), bytesWritten: Buffer.byteLength(input.text) };
    },
    async interruptTurn(handle) {
      const session = readSession(handle);
      if (!session || !writeToSession(session, '\u001b')) {
        throw new Error('Failed to interrupt PTY terminal host');
      }
    },
    async evaluateLiveness(handle): Promise<TerminalHostLiveness> {
      const session = readSession(handle);
      if (!session) {
        return { paneAlive: false, paneDead: true, observedAt: now() };
      }
      return {
        paneAlive: !session.ended,
        paneDead: session.ended,
        ...(session.exitCode !== undefined ? { paneExitStatus: session.exitCode } : {}),
        observedAt: now(),
      };
    },
    captureInputState,
    createControlPort,
    async dispose(handle) {
      const session = readSession(handle);
      if (!session) return;
      disposeSession(session);
      sessions.delete(handle.sessionName);
    },
  };
}
