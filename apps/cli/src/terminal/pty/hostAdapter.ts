import { Buffer } from 'node:buffer';

import {
  resolveTerminalPromptWriteTimeoutMs,
  type TerminalControlPort,
  type TerminalHostHandle,
  type TerminalHostKind,
  type TerminalHostLivenessV1,
  type TerminalInjectionDuplicateRisk,
  type TerminalInjectionFailurePhase,
  type TerminalInputInjectionResult,
  type TerminalInputState,
  type TerminalPromptInput,
  type TerminalSpecialKey,
} from '@happier-dev/agents';
import type { TerminalHostAdapter } from '@/integrations/terminal/host/_types';
import { encodeTerminalPasteInput } from '@happier-dev/protocol/terminal/inputEncoding';

import {
  createTerminalHostDeadline,
  remainingTerminalHostDeadlineMs,
} from '@/integrations/terminalHost/deadline';
import {
  resolveTerminalPromptSubmissionFailureReason,
  runTerminalPromptSubmission,
  type TerminalPromptSubmitVerificationPolicy,
} from '@/integrations/terminalHost/promptSubmitVerification';

import { buildTerminalControlCapture } from '@/integrations/terminalHost/controlCapture';
import { TERMINAL_SHIFT_TAB_SEQUENCE } from '@/integrations/terminalHost/controlTypes';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import { bindToHostedSessionScope, sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
import type { PtyProvider } from './provider';
import { delay } from '@/utils/time';
import { createTerminalScreen, loadTerminalScreenModel, type TerminalScreen } from './terminalScreen';
import { resolveSessionProcessPtyTarget, type SessionProcessPtyTarget } from '@/subprocess/supervision/sessionHolder';
import { startHeldAgentPtyProcess } from './holderProcess';
import { readDaemonTerminalPtyConfig } from './config';
import { createTerminalPtySessionManager, type TerminalPtySessionManager } from './sessions';
import { getAgentTerminalSessionManager } from './agentTerminals';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const INPUT_STABILITY_DELAY_MS = 50;
const POST_WRITE_LIVENESS_DELAY_MS = 25;

/** The host's view of one Agent terminal: its screen and exit. The PTY itself is the manager's. */
type PtyTerminalHostSession = {
  terminalId: string;
  screen: TerminalScreen;
  ended: boolean;
  exitCode?: number;
  signal?: number;
};

function handleFields(handle: TerminalHostHandle): Pick<
  Extract<TerminalInputInjectionResult, { status: 'failed' | 'injected' }>,
  'hostKind' | 'hostSessionName' | 'paneId'
> & { hostKind: TerminalHostKind; hostSessionName: string } {
  return {
    hostKind: handle.kind,
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
    ...handleFields(handle),
  };
}

function failedInjectionResult(params: Readonly<{
  handle: TerminalHostHandle;
  reason: Extract<TerminalInputInjectionResult, { status: 'failed' }>['reason'];
  phase: TerminalInjectionFailurePhase;
  duplicateRisk: TerminalInjectionDuplicateRisk;
  recoverable: boolean;
  observedAt: number;
}>): Extract<TerminalInputInjectionResult, { status: 'failed' }> {
  return {
    status: 'failed',
    reason: params.reason,
    phase: params.phase,
    duplicateRisk: params.duplicateRisk,
    recoverable: params.recoverable,
    observedAt: params.observedAt,
    ...handleFields(params.handle),
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

export function createPtyTerminalHostAdapter(params?: Readonly<{
  /** Tests: spawn Agents with this provider (in a private manager) instead of the Session holder. */
  ptyProvider?: PtyProvider;
  cols?: number;
  rows?: number;
  inputStabilityDelayMs?: number;
  postWriteLivenessDelayMs?: number;
  promptSubmitVerification?: TerminalPromptSubmitVerificationPolicy;
  now?: () => number;
  /** The terminal service retains the canonical lazy placement selected for this Session. */
  sessionTarget?: SessionProcessPtyTarget | null;
  /** This process's Agent terminal owner; tests that simulate two runners in one process give each its own. */
  terminals?: TerminalPtySessionManager;
}>): TerminalHostAdapter {
  const environment = sessionProcessEnvironment();
  const sessionTarget = params?.sessionTarget === undefined ? resolveSessionProcessPtyTarget() : params.sessionTarget;
  // The Agent is the Session holder's held primary Agent in a terminal (a POSIX pty, or the
  // Windows pseudoconsole), so it survives this runner.
  const heldAgent = sessionTarget !== null || !params?.ptyProvider;
  // Launches may run outside the registering Session's scope (its environment, placement, identity).
  const startHeldAgent = bindToHostedSessionScope(startHeldAgentPtyProcess);
  // Attach viewers find the Agent terminal by the Session it belongs to.
  const registeringScope = readHostedSessionScope();
  // One owner of PTY sessions per process (spawn or adopt, ring, readers, input, resize).
  const terminals: TerminalPtySessionManager = params?.terminals ?? (params?.ptyProvider
    ? createTerminalPtySessionManager({ ptyProvider: params.ptyProvider, config: readDaemonTerminalPtyConfig(process.env).sessionManager })
    : getAgentTerminalSessionManager());
  const cols = Math.max(2, Math.trunc(params?.cols ?? DEFAULT_COLS));
  const rows = Math.max(2, Math.trunc(params?.rows ?? DEFAULT_ROWS));
  const inputStabilityDelayMs = Math.max(0, Math.trunc(params?.inputStabilityDelayMs ?? INPUT_STABILITY_DELAY_MS));
  const postWriteLivenessDelayMs = Math.max(0, Math.trunc(params?.postWriteLivenessDelayMs ?? POST_WRITE_LIVENESS_DELAY_MS));
  const promptSubmitVerification = params?.promptSubmitVerification;
  const now = params?.now ?? (() => Date.now());
  const sessions = new Map<string, PtyTerminalHostSession>();

  function readSession(handle: TerminalHostHandle): PtyTerminalHostSession | null {
    const session = sessions.get(handle.sessionName);
    return session && !session.ended ? session : null;
  }

  function readEndedSession(handle: TerminalHostHandle): PtyTerminalHostSession | null {
    const session = sessions.get(handle.sessionName);
    return session?.ended ? session : null;
  }

  /** Ends the host's view and the manager's terminal (its retained output and exit go with it). */
  function closeSession(sessionName: string, session: PtyTerminalHostSession): void {
    if (sessions.get(sessionName) === session) sessions.delete(sessionName);
    terminals.close({ terminalId: session.terminalId });
    session.screen.dispose();
  }

  async function writeToSession(session: PtyTerminalHostSession, data: string): Promise<boolean> {
    if (session.ended) return false;
    return (await terminals.input({ terminalId: session.terminalId, data })).ok;
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
    const firstInput = await session.screen.capture();
    await delay(inputStabilityDelayMs);
    const currentInput = await session.screen.capture();
    return {
      stable: firstInput.text === currentInput.text
        && firstInput.cursor.x === currentInput.cursor.x
        && firstInput.cursor.y === currentInput.cursor.y,
      currentInput: currentInput.text,
      cursor: currentInput.cursor,
      observedAt: now(),
    };
  }

  function createControlPort(handle: TerminalHostHandle): TerminalControlPort {
    return {
      hostKind: 'windows_console',
      async sendLiteralText(text) {
        const session = readSession(handle);
        if (!session) return { status: 'host_dead', recoverable: !readEndedSession(handle) };
        return await writeToSession(session, text)
          ? { status: 'sent', at: now() }
          : { status: 'host_dead', recoverable: false };
      },
      async sendRawSequence(sequence) {
        const session = readSession(handle);
        if (!session) return { status: 'host_dead', recoverable: !readEndedSession(handle) };
        return await writeToSession(session, sequence)
          ? { status: 'sent', at: now() }
          : { status: 'host_dead', recoverable: false };
      },
      async sendSpecialKey(key) {
        const session = readSession(handle);
        if (!session) return { status: 'host_dead', recoverable: !readEndedSession(handle) };
        return await writeToSession(session, resolveSpecialKeyBytes(key))
          ? { status: 'sent', at: now() }
          : { status: 'host_dead', recoverable: false };
      },
      async captureScreen() {
        const session = readSession(handle);
        if (!session) return { status: 'host_dead', recoverable: !readEndedSession(handle) };
        const screen = await session.screen.capture();
        return {
          status: 'captured',
          capture: buildTerminalControlCapture({
            // The styled rows when any cell carries an attribute (SGR dim tells Claude's placeholder from a draft).
            rawText: screen.styledText ?? screen.text,
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
    nativePreambleTransport: 'pty',
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
      let stdinPreamble: Uint8Array | undefined;
      if (opts.prepareLaunch) {
        const launch = await opts.prepareLaunch();
        opts = { ...opts, ...launch };
        stdinPreamble = launch.stdinPreamble;
      }
      if (existing) closeSession(opts.sessionName, existing);

      const command = opts.spawnArgv[0];
      if (!command) {
        throw new Error('PTY terminal host requires a command to spawn');
      }
      const inheritedEnv = opts.isolatedEnv ? {} : environment;
      const spawnEnv = buildScopedProcessEnv({
        baseEnv: inheritedEnv,
        explicitEnv: opts.spawnEnv,
        unsetEnvKeys: opts.unsetEnvKeys,
      });
      const term = spawnEnv.TERM ?? 'xterm-256color';
      const screen = createTerminalScreen(await loadTerminalScreenModel(), { cols, rows });
      const session: PtyTerminalHostSession = { terminalId: '', screen, ended: false };
      const sessionId = readHostedSessionScope()?.sessionId ?? registeringScope?.sessionId;
      const opened = await terminals.ensure({
        terminalKey: opts.sessionName,
        ...(sessionId ? { sessionId } : {}),
        cwd: opts.workingDirectory,
        cols,
        rows,
        launchProcess: {
          file: command,
          args: opts.spawnArgv.slice(1),
          env: { ...spawnEnv, TERM: term },
          ...(opts.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        },
        agent: {
          ...(heldAgent ? { startHeld: startHeldAgent } : {}),
          ...(opts.requiredFiles ? { requiredFiles: opts.requiredFiles } : {}),
          ...(stdinPreamble ? { stdinPreamble } : {}),
          // Bytes: the screen model decodes UTF-8 itself, across chunk boundaries.
          onOutput: bytes => screen.write(bytes),
          onResize: (newCols, newRows) => screen.resize(newCols, newRows),
          onExit: (exit) => {
            session.ended = true;
            if (exit.exitCode !== null) session.exitCode = exit.exitCode;
            if (exit.signal !== null) session.signal = exit.signal;
          },
        },
      });
      if (!opened.ok) {
        screen.dispose();
        throw new Error(`PTY terminal host could not start the Agent: ${opened.error}`);
      }
      session.terminalId = opened.terminalId;
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
    async injectUserPrompt(handle, input) {
      const observedAt = now();
      const deferral = scheduledDeferral(handle, input, observedAt);
      if (deferral) return deferral;

      const session = readSession(handle);
      if (!session) {
        if (readEndedSession(handle)) {
          return failedInjectionResult({
            handle,
            reason: 'pane_dead',
            phase: 'liveness',
            duplicateRisk: 'none',
            recoverable: false,
            observedAt,
          });
        }
        return failedInjectionResult({
          handle,
          reason: 'no_target',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: true,
          observedAt,
        });
      }
      if (session.ended) {
        return failedInjectionResult({
          handle,
          reason: 'pane_dead',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: false,
          observedAt,
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
            ...handleFields(handle),
          };
        }
      }
      const shouldVerifyPrompt = promptSubmitVerification?.shouldVerifyAfterSubmit(input.text) === true;
      if (!shouldVerifyPrompt) {
        if (!await writeToSession(session, `${input.text}\r`)) {
          return failedInjectionResult({
            handle,
            reason: 'host_unreachable',
            phase: 'during_write',
            duplicateRisk: 'possible',
            recoverable: true,
            observedAt: now(),
          });
        }
        if (!await waitForPostWriteLiveness(session)) {
          return failedInjectionResult({
            handle,
            reason: 'host_unreachable',
            phase: 'after_enter_unknown',
            duplicateRisk: 'possible',
            recoverable: true,
            observedAt: now(),
          });
        }
        return {
          status: 'injected',
          injectedAt: now(),
          bytesWritten: Buffer.byteLength(input.text),
          ...handleFields(handle),
        };
      }
      const shouldStagePrompt = shouldVerifyPrompt;
      const deadline = createTerminalHostDeadline(
        input.scheduling.timeoutMs ?? resolveTerminalPromptWriteTimeoutMs(input.text),
      );
      const textToWrite = input.multiline && shouldStagePrompt
        ? encodeTerminalPasteInput(input.text, true)
        : input.text;
      if (!await writeToSession(session, textToWrite)) {
        return failedInjectionResult({
          handle,
          reason: 'host_unreachable',
          phase: 'during_write',
          duplicateRisk: 'possible',
          recoverable: true,
          observedAt: now(),
        });
      }
      const submissionDeadline = createTerminalHostDeadline(
        input.scheduling.timeoutMs ?? resolveTerminalPromptWriteTimeoutMs(input.text),
      );
      const submission = await runTerminalPromptSubmission({
        promptText: input.text,
        signal: input.signal,
        resolveDeliveryState: input.resolveDeliveryState,
        ...(shouldStagePrompt
          ? {
            verifyStagedBeforeSubmit: async ({ promptText }) => (
              promptSubmitVerification.verifyBeforeSubmitStaging
              ?? promptSubmitVerification.verifyAfterSubmit
            )({
              promptText,
              screenText: (await session.screen.capture()).text,
            }),
            verifyAfterSubmit: async ({ promptText }) => promptSubmitVerification.verifyAfterSubmit({
              promptText,
              screenText: (await session.screen.capture()).text,
            }),
          }
          : {}),
        submitEnter: async ({ remainingTimeoutMs }) => {
          if (remainingTimeoutMs === 0) return 'timeout';
          if (!await writeToSession(session, '\r')) return 'failed';
          return await waitForPostWriteLiveness(session) ? 'success' : 'failed';
        },
        remainingTimeoutMs: () => remainingTerminalHostDeadlineMs(submissionDeadline),
      });
      if (!submission.success) {
        return failedInjectionResult({
          handle,
          reason: resolveTerminalPromptSubmissionFailureReason(submission.reason),
          phase: submission.phase,
          duplicateRisk: submission.duplicateRisk,
          recoverable: submission.reason !== 'submit_failed',
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
    async interruptTurn(handle) {
      const session = readSession(handle);
      if (!session || !await writeToSession(session, '\u001b')) {
        throw new Error('Failed to interrupt PTY terminal host');
      }
    },
    async evaluateLiveness(handle): Promise<TerminalHostLivenessV1> {
      const session = sessions.get(handle.sessionName);
      if (!session) return { paneAlive: false, paneDead: true, observedAt: now() };
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
      const session = sessions.get(handle.sessionName);
      if (!session) return;
      // The Agent's tree (through its holder), then the terminal.
      if (!session.ended) await terminals.requestStop({ terminalId: session.terminalId });
      closeSession(handle.sessionName, session);
    },
  };
}
