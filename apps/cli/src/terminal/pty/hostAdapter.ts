import { Buffer } from 'node:buffer';

import type {
  TerminalControlPort,
  TerminalHostAdapter,
  TerminalHostHandle,
  TerminalHostKind,
  TerminalHostLivenessV1,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputInjectionResult,
  TerminalInputState,
  TerminalPromptInput,
  TerminalSpecialKey,
} from '@happier-dev/agents';

import { buildTerminalControlCapture } from '@/integrations/terminalHost/controlCapture';
import { TERMINAL_SHIFT_TAB_SEQUENCE } from '@/integrations/terminalHost/controlTypes';
import { buildScopedProcessEnv } from '@/utils/processEnv/buildScopedProcessEnv';
import type { Disposable, PtyProcess, PtyProvider } from './provider';
import { createNodePtyProvider } from './provider';
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
  disposed: boolean;
  exitCode?: number;
  signal?: number;
};

type PtyTerminalHostEndedSession = Readonly<{
  exitCode?: number;
  signal?: number;
}>;

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
  ptyProvider?: PtyProvider;
  cols?: number;
  rows?: number;
  inputStabilityDelayMs?: number;
  postWriteLivenessDelayMs?: number;
  now?: () => number;
}>): TerminalHostAdapter {
  const ptyProvider = params?.ptyProvider ?? createNodePtyProvider();
  const cols = Math.max(2, Math.trunc(params?.cols ?? DEFAULT_COLS));
  const rows = Math.max(2, Math.trunc(params?.rows ?? DEFAULT_ROWS));
  const inputStabilityDelayMs = Math.max(0, Math.trunc(params?.inputStabilityDelayMs ?? INPUT_STABILITY_DELAY_MS));
  const postWriteLivenessDelayMs = Math.max(0, Math.trunc(params?.postWriteLivenessDelayMs ?? POST_WRITE_LIVENESS_DELAY_MS));
  const now = params?.now ?? (() => Date.now());
  const sessions = new Map<string, PtyTerminalHostSession>();
  const endedSessions = new Map<string, PtyTerminalHostEndedSession>();

  function readSession(handle: TerminalHostHandle): PtyTerminalHostSession | null {
    return sessions.get(handle.sessionName) ?? null;
  }

  function readEndedSession(handle: TerminalHostHandle): PtyTerminalHostEndedSession | null {
    return endedSessions.get(handle.sessionName) ?? null;
  }

  function cleanupSession(
    sessionName: string,
    session: PtyTerminalHostSession,
    options: Readonly<{
      kill: boolean;
      retainExitState: boolean;
    }>,
  ): void {
    if (session.disposed) return;
    session.disposed = true;
    if (sessions.get(sessionName) === session) {
      sessions.delete(sessionName);
    }
    if (options.retainExitState) {
      endedSessions.set(sessionName, {
        ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
        ...(session.signal !== undefined ? { signal: session.signal } : {}),
      });
    } else {
      endedSessions.delete(sessionName);
    }
    if (options.kill && !session.ended) {
      try {
        session.pty.kill();
      } catch {
        // best-effort
      }
    }
    for (const disposable of session.disposables) {
      try {
        disposable.dispose();
      } catch {
        // best-effort
      }
    }
    session.disposables = [];
  }

  function writeToSession(session: PtyTerminalHostSession, data: string): boolean {
    if (session.ended || session.disposed) return false;
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
    return { stable: firstInput === currentInput, currentInput, observedAt: now() };
  }

  function createControlPort(handle: TerminalHostHandle): TerminalControlPort {
    return {
      hostKind: 'windows_console',
      async sendLiteralText(text) {
        const session = readSession(handle);
        if (!session) return { status: 'host_dead', recoverable: !readEndedSession(handle) };
        return writeToSession(session, text)
          ? { status: 'sent', at: now() }
          : { status: 'host_dead', recoverable: false };
      },
      async sendRawSequence(sequence) {
        const session = readSession(handle);
        if (!session) return { status: 'host_dead', recoverable: !readEndedSession(handle) };
        return writeToSession(session, sequence)
          ? { status: 'sent', at: now() }
          : { status: 'host_dead', recoverable: false };
      },
      async sendSpecialKey(key) {
        const session = readSession(handle);
        if (!session) return { status: 'host_dead', recoverable: !readEndedSession(handle) };
        return writeToSession(session, resolveSpecialKeyBytes(key))
          ? { status: 'sent', at: now() }
          : { status: 'host_dead', recoverable: false };
      },
      async captureScreen() {
        const session = readSession(handle);
        if (!session) return { status: 'host_dead', recoverable: !readEndedSession(handle) };
        if (session.ended) return { status: 'host_dead', recoverable: false };
        return {
          status: 'captured',
          capture: buildTerminalControlCapture({
            rawText: session.screen.capture(),
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
      if (existing) {
        cleanupSession(opts.sessionName, existing, { kill: false, retainExitState: true });
      }
      endedSessions.delete(opts.sessionName);

      const command = opts.spawnArgv[0];
      if (!command) {
        throw new Error('PTY terminal host requires a command to spawn');
      }
      const inheritedEnv = opts.isolatedEnv ? {} : process.env;
      const spawnEnv = buildScopedProcessEnv({
        baseEnv: inheritedEnv,
        explicitEnv: opts.spawnEnv,
        unsetEnvKeys: opts.unsetEnvKeys,
      });
      const term = spawnEnv.TERM ?? 'xterm-256color';
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
            ...spawnEnv,
            TERM: term,
          },
          encoding: 'utf8',
        },
      });
      const session: PtyTerminalHostSession = {
        pty,
        disposables: [],
        screen,
        ended: false,
        disposed: false,
      };
      session.disposables.push(pty.onData((data) => {
        screen.write(String(data ?? ''));
      }));
      session.disposables.push(pty.onExit((event) => {
        session.ended = true;
        session.exitCode = event.exitCode;
        if (typeof event.signal === 'number') session.signal = event.signal;
        cleanupSession(opts.sessionName, session, { kill: false, retainExitState: true });
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
      if (!writeToSession(session, `${input.text}\r`)) {
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
    },
    async interruptTurn(handle) {
      const session = readSession(handle);
      if (!session || !writeToSession(session, '\u001b')) {
        throw new Error('Failed to interrupt PTY terminal host');
      }
    },
    async evaluateLiveness(handle): Promise<TerminalHostLivenessV1> {
      const session = readSession(handle);
      if (session) {
        return {
          paneAlive: !session.ended,
          paneDead: session.ended,
          ...(session.exitCode !== undefined ? { paneExitStatus: session.exitCode } : {}),
          observedAt: now(),
        };
      }
      const endedSession = readEndedSession(handle);
      if (!endedSession) {
        return { paneAlive: false, paneDead: true, observedAt: now() };
      }
      return {
        paneAlive: false,
        paneDead: true,
        ...(endedSession.exitCode !== undefined ? { paneExitStatus: endedSession.exitCode } : {}),
        observedAt: now(),
      };
    },
    captureInputState,
    createControlPort,
    async dispose(handle) {
      const session = readSession(handle);
      if (session) {
        cleanupSession(handle.sessionName, session, { kill: true, retainExitState: false });
      }
      endedSessions.delete(handle.sessionName);
    },
  };
}
