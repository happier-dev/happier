import { basename } from 'node:path';

import type {
  TerminalHostAdapter,
  TerminalHostHandle,
  TerminalHostLivenessV1,
  TerminalInjectionDuplicateRisk,
  TerminalInjectionFailurePhase,
  TerminalInputInjectionResult,
  TerminalInputState,
  TerminalPromptInput,
} from '@happier-dev/agents';
import type { TerminalPromptSubmitVerificationPolicy } from '../terminalHost/promptSubmitVerification';

import {
  defaultZellijActions,
  DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE,
  isZellijActionTimeoutError,
  resolveZellijActionPasteSafeBytes,
  type ZellijActions,
  type ZellijCommandResult,
  type ZellijPane,
} from './actions';
import {
  createTerminalHostDeadline,
  remainingTerminalHostDeadlineMs,
} from '../terminalHost/deadline';
import { normalizeCapturedScreen } from '../terminalHost/controlCapture';
import { sanitizeTerminalHostDiagnosticText } from '../terminalHost/sanitizeTerminalHostDiagnosticText';
import { TerminalHostStartupError } from '../terminal/host/errors';
import { createZellijTerminalControlPort } from './control';
import {
  inspectZellijSessionSocketPresence,
  type InspectZellijSessionSocketPresence,
} from './socketPresence';
import {
  runTerminalPromptSubmission,
} from '../terminalHost/promptSubmitVerification';

const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_INPUT_STABILITY_DELAY_MS = 50;
const MAX_LIVENESS_SCREEN_DUMP_CHARS = 2_000;
function wait(delayMs: number): Promise<void> {
  return delayMs <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, delayMs));
}

function baseEnv(socketDir: string): Readonly<Record<string, string>> {
  return { ZELLIJ_SOCKET_DIR: socketDir };
}

function normalizePaneId(paneId: string): string {
  return paneId.startsWith('terminal_') ? paneId : `terminal_${paneId}`;
}

function paneIdFromPane(pane: ZellijPane): string | null {
  const value = pane.pane_id ?? pane.id;
  return value === undefined || value === null ? null : normalizePaneId(String(value));
}

function paneMatches(pane: ZellijPane, paneId: string): boolean {
  return paneIdFromPane(pane) === normalizePaneId(paneId);
}

function isLiveTerminalPane(pane: ZellijPane): boolean {
  if (pane.is_plugin === true) return false;
  if (pane.exited === true) return false;
  if (pane.is_held === true) return false;
  return true;
}

function isLiveCommandPane(pane: ZellijPane): boolean {
  return isLiveTerminalPane(pane)
    && typeof pane.terminal_command === 'string'
    && pane.terminal_command.trim().length > 0;
}

type ResolvedZellijPaneTarget = Readonly<{
  pane: ZellijPane;
  paneId: string;
}>;

function isUniqueCommandProofFragment(value: string): boolean {
  return !value.startsWith('-') && (value.includes('/') || value.includes('\\'));
}

function buildExpectedCommandFragments(command: readonly string[]): readonly string[] {
  const primaryExecutable = typeof command[0] === 'string' ? command[0].trim() : '';
  const launcher = typeof command[1] === 'string' ? basename(command[1].trim()) : '';
  const uniqueProof = typeof command[2] === 'string' && isUniqueCommandProofFragment(command[2].trim())
    ? command[2].trim()
    : '';
  const fragments = [primaryExecutable, launcher, uniqueProof].filter((value) => value.length > 0);
  return [...new Set(fragments)];
}

function readExpectedCommandFragments(handle: TerminalHostHandle): readonly string[] {
  const value = handle.expectedCommandFragments;
  if (!Array.isArray(value)) return [];
  return value.filter((fragment) => typeof fragment === 'string' && fragment.trim().length > 0);
}

function commandIncludesExpectedFragment(command: string, fragment: string): boolean {
  return command.includes(fragment);
}

function commandHasExpectedProofFragment(command: string, expectedCommandFragments: readonly string[]): boolean {
  const proofFragments = expectedCommandFragments.length > 2
    ? expectedCommandFragments.slice(2)
    : expectedCommandFragments.length > 1
      ? expectedCommandFragments.slice(1)
      : expectedCommandFragments;
  return proofFragments.some((fragment) => commandIncludesExpectedFragment(command, fragment));
}

function commandIsExecutableOnlyMatch(command: string, expectedCommandFragments: readonly string[]): boolean {
  const tokens = command.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length !== 1) return false;
  return expectedCommandFragments.some((fragment) => commandIncludesExpectedFragment(tokens[0], fragment));
}

function paneCommandIsCompatibleWithExpectedFragments(
  pane: ZellijPane,
  expectedCommandFragments: readonly string[],
): boolean {
  if (expectedCommandFragments.length === 0) return true;
  const command = pane.terminal_command;
  if (typeof command !== 'string' || command.trim().length === 0) return false;
  const normalizedCommand = command.trim();
  return commandHasExpectedProofFragment(normalizedCommand, expectedCommandFragments)
    || commandIsExecutableOnlyMatch(normalizedCommand, expectedCommandFragments);
}

function commandPaneMatchesExpectedFragments(
  pane: ZellijPane,
  expectedCommandFragments: readonly string[],
): boolean {
  const command = pane.terminal_command;
  return isLiveCommandPane(pane)
    && expectedCommandFragments.length > 0
    && typeof command === 'string'
    && commandHasExpectedProofFragment(command.trim(), expectedCommandFragments);
}

function resolveRuntimePaneTarget(params: Readonly<{
  panes: readonly ZellijPane[];
  paneId: string;
  expectedCommandFragments: readonly string[];
}>): ResolvedZellijPaneTarget | null {
  const exactPane = params.panes.find((pane) => paneMatches(pane, params.paneId));
  if (exactPane) {
    if (!paneCommandIsCompatibleWithExpectedFragments(exactPane, params.expectedCommandFragments)) return null;
    const exactPaneId = paneIdFromPane(exactPane);
    return exactPaneId === null ? null : { pane: exactPane, paneId: exactPaneId };
  }

  const liveCommandPanes = params.panes.filter((pane) => commandPaneMatchesExpectedFragments(
    pane,
    params.expectedCommandFragments,
  ));
  if (liveCommandPanes.length !== 1) return null;
  const replacementPaneId = paneIdFromPane(liveCommandPanes[0]);
  return replacementPaneId === null ? null : { pane: liveCommandPanes[0], paneId: replacementPaneId };
}

function paneDeadInjectionFailureIsRecoverable(params: Readonly<{
  panes: readonly ZellijPane[];
  target: ResolvedZellijPaneTarget | null;
}>): boolean {
  if (params.target !== null) return false;
  return !params.panes.some(isLiveCommandPane);
}

function truncateScreenDump(value: string): Readonly<{ text: string; truncated: boolean }> {
  if (value.length <= MAX_LIVENESS_SCREEN_DUMP_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_LIVENESS_SCREEN_DUMP_CHARS), truncated: true };
}

function summarizeDiagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeTerminalHostDiagnosticText(message).replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown_error';
}

function resolvePaneFromRunOutput(stdout: string): string | null {
  const value = stdout.trim();
  return /^(?:terminal_)?\d+$/.test(value) ? normalizePaneId(value) : null;
}

function handleFields(handle: TerminalHostHandle): Pick<Extract<TerminalInputInjectionResult, { status: 'injected' }>, 'hostKind' | 'hostSessionName' | 'paneId'> {
  return {
    hostKind: 'zellij',
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

function livenessUncertainDeferral(
  handle: TerminalHostHandle,
  input: TerminalPromptInput,
  observedAt: number,
): Extract<TerminalInputInjectionResult, { status: 'deferred' }> {
  return {
    status: 'deferred',
    reason: 'liveness_uncertain',
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

function resolveLivePaneId(params: Readonly<{
  paneIdFromRun: string | null;
  panes: readonly ZellijPane[];
}>): string | null {
  const paneIdFromRun = params.paneIdFromRun;
  if (paneIdFromRun) {
    const matchingPane = params.panes.find((pane) => paneMatches(pane, paneIdFromRun));
    if (matchingPane && isLiveTerminalPane(matchingPane)) return normalizePaneId(paneIdFromRun);
  }
  const livePanes = params.panes.filter(isLiveTerminalPane);
  return livePanes.length === 1 ? paneIdFromPane(livePanes[0]) : null;
}

export function createZellijTerminalHostAdapter(params: Readonly<{
  zellijBinary: string;
  socketDir: string;
  actions?: ZellijActions;
  now?: () => number;
  actionTimeoutMs?: number;
  writeChunkSize?: number;
  pasteMaxBytes?: number;
  wait?: (delayMs: number) => Promise<void>;
  promptSubmitVerification?: TerminalPromptSubmitVerificationPolicy;
  inspectSocketPresence?: InspectZellijSessionSocketPresence;
}>): TerminalHostAdapter {
  const actions = params.actions ?? defaultZellijActions;
  const now = params.now ?? Date.now;
  const actionTimeoutMs = params.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const writeChunkSize = params.writeChunkSize ?? DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE;
  const pasteMaxBytes = Math.max(0, Math.trunc(params.pasteMaxBytes ?? resolveZellijActionPasteSafeBytes()));
  const waitFn = params.wait ?? wait;
  const inspectSocketPresence = params.inspectSocketPresence ?? inspectZellijSessionSocketPresence;

  // Positive death evidence before any client action: a zellij server is the sole owner of the
  // session's IPC socket, so an absent socket means no server holds the session and a `list-panes`
  // client would block forever waiting for a socket that will never appear. Consulting the socket
  // first converts that indefinite hang into a conclusive, fast `paneDead` verdict, while a present
  // (or undeterminable) socket falls through to the normal probe so a wedged-but-alive host still
  // times out into an inconclusive observation rather than being falsely declared dead.
  async function socketProvesSessionGone(sessionName: string): Promise<boolean> {
    try {
      return (await inspectSocketPresence({ socketDir: params.socketDir, sessionName })) === 'absent';
    } catch {
      // Presence inspection must never break liveness; treat an unexpected failure as undeterminable.
      return false;
    }
  }

  async function listSessionPanes(): Promise<ZellijPane[]> {
    return actions.listPanes({
      zellijBinary: params.zellijBinary,
      env: baseEnv(params.socketDir),
      timeoutMs: actionTimeoutMs,
    });
  }

  async function killManagedSession(sessionName: string): Promise<void> {
    try {
      await actions.killSession({
        zellijBinary: params.zellijBinary,
        env: baseEnv(params.socketDir),
        sessionName,
        timeoutMs: actionTimeoutMs,
      });
    } catch {
      // Best-effort cleanup must not mask the launch failure that triggered it.
    }
  }

  function normalizeStartupError(error: unknown, sessionName: string): unknown {
    if (!isZellijActionTimeoutError(error)) return error;
    return new TerminalHostStartupError({
      hostKind: 'zellij',
      reason: 'startup_action_timeout',
      message: `zellij startup action timed out: ${error.message}`,
      diagnostics: {
        action: error.action,
        sessionName,
        timeoutMs: actionTimeoutMs,
      },
    });
  }

  function createPaneDiscoveryStartupError(sessionName: string): TerminalHostStartupError {
    return new TerminalHostStartupError({
      hostKind: 'zellij',
      reason: 'startup_action_timeout',
      message: 'zellij launch produced no terminal target pane',
      diagnostics: {
        action: 'pane_discovery',
        sessionName,
        timeoutMs: actionTimeoutMs,
      },
    });
  }

  async function cleanupManagedSessionAndThrowStartupError(sessionName: string, error: unknown): Promise<never> {
    await killManagedSession(sessionName);
    throw normalizeStartupError(error, sessionName);
  }

  async function inspectLiveness(handle: TerminalHostHandle): Promise<Readonly<{
    liveness: TerminalHostLivenessV1;
    targetPaneId?: string;
    paneDeadRecoverable?: boolean;
  }>> {
    const observedAt = now();
    const trackedPaneId = handle.paneId;
    if (!trackedPaneId) return { liveness: { paneAlive: false, paneDead: true, observedAt }, paneDeadRecoverable: true };
    if (await socketProvesSessionGone(handle.sessionName)) {
      // The owning zellij server is gone: conclusive death reached via the authoritative socket
      // artifact, without spawning a `list-panes` client that would hang on the absent socket. Not
      // recoverable — there is no live pane to retarget.
      return { liveness: { paneAlive: false, paneDead: true, observedAt }, paneDeadRecoverable: false };
    }
    const panes = await listSessionPanes();
    const target = resolveRuntimePaneTarget({
      panes,
      paneId: trackedPaneId,
      expectedCommandFragments: readExpectedCommandFragments(handle),
    });
    const exactPane = panes.find((candidate) => !candidate.is_plugin && paneMatches(candidate, trackedPaneId));
    const pane = target?.pane ?? exactPane;
    const paneAlive = Boolean(pane && isLiveTerminalPane(pane));
    const liveness: {
      paneAlive: boolean;
      paneDead: boolean;
      paneCurrentCommand?: string;
      paneExitStatus?: number;
      paneScreenDumpCaptured?: boolean;
      paneScreenDumpTruncated?: boolean;
      paneScreenDumpError?: string;
      observedAt: number;
    } = {
      paneAlive,
      paneDead: !paneAlive,
      ...(pane?.terminal_command ? { paneCurrentCommand: sanitizeTerminalHostDiagnosticText(pane.terminal_command) } : {}),
      ...(typeof pane?.exit_status === 'number' ? { paneExitStatus: pane.exit_status } : {}),
      observedAt,
    };

    if (!paneAlive && pane) {
      const diagnosticPaneId = target?.paneId ?? paneIdFromPane(pane);
      if (diagnosticPaneId) {
        try {
          const rawDump = await actions.dumpScreen({
            zellijBinary: params.zellijBinary,
            env: baseEnv(params.socketDir),
            paneId: diagnosticPaneId,
            timeoutMs: actionTimeoutMs,
          });
          const dump = truncateScreenDump(sanitizeTerminalHostDiagnosticText(rawDump));
          liveness.paneScreenDumpCaptured = true;
          liveness.paneScreenDumpTruncated = dump.truncated;
        } catch (error) {
          liveness.paneScreenDumpError = summarizeDiagnosticError(error);
        }
      }
    }

    return {
      liveness,
      ...(paneAlive && target ? { targetPaneId: target.paneId } : {}),
      ...(!paneAlive || !target ? { paneDeadRecoverable: paneDeadInjectionFailureIsRecoverable({ panes, target: target ?? null }) } : {}),
    };
  }

  async function evaluateLiveness(handle: TerminalHostHandle): Promise<TerminalHostLivenessV1> {
    return (await inspectLiveness(handle)).liveness;
  }

  async function captureInputState(handle: TerminalHostHandle): Promise<TerminalInputState> {
    if (!handle.paneId) return { stable: false, currentInput: '', observedAt: now() };
    const inspection = await inspectLiveness(handle);
    if (!inspection.liveness.paneAlive || !inspection.targetPaneId) {
      throw new Error('zellij terminal pane is not alive');
    }
    const before = await actions.dumpScreen({
      zellijBinary: params.zellijBinary,
      env: baseEnv(params.socketDir),
      paneId: inspection.targetPaneId,
      timeoutMs: actionTimeoutMs,
    });
    await waitFn(DEFAULT_INPUT_STABILITY_DELAY_MS);
    const after = await actions.dumpScreen({
      zellijBinary: params.zellijBinary,
      env: baseEnv(params.socketDir),
      paneId: inspection.targetPaneId,
      timeoutMs: actionTimeoutMs,
    });
    return { stable: before === after, currentInput: after, observedAt: now() };
  }

  return {
    kind: 'zellij',
    async createOrAttachHost(opts) {
      const env = baseEnv(params.socketDir);
      let attachResult: ZellijCommandResult;
      try {
        attachResult = await actions.attachCreateBackground({
          zellijBinary: params.zellijBinary,
          env,
          unsetEnvKeys: opts.unsetEnvKeys,
          sessionName: opts.sessionName,
          cwd: opts.workingDirectory,
          timeoutMs: actionTimeoutMs,
        });
      } catch (error) {
        return cleanupManagedSessionAndThrowStartupError(opts.sessionName, error);
      }
      if (attachResult.exitCode !== 0) {
        return cleanupManagedSessionAndThrowStartupError(
          opts.sessionName,
          new Error(`zellij attach failed: ${attachResult.stderr || attachResult.stdout}`),
        );
      }
      try {
        const runResult = await actions.runCommand({
          zellijBinary: params.zellijBinary,
          env: {
            ...opts.spawnEnv,
            ...env,
          },
          unsetEnvKeys: opts.unsetEnvKeys,
          sessionName: opts.sessionName,
          cwd: opts.workingDirectory,
          command: opts.spawnArgv,
          timeoutMs: actionTimeoutMs,
        });
        if (runResult.exitCode !== 0) {
          throw new Error(`zellij run failed: ${runResult.stderr || runResult.stdout}`);
        }
        const panes = await listSessionPanes();
        const paneId = resolveLivePaneId({
          paneIdFromRun: resolvePaneFromRunOutput(runResult.stdout),
          panes,
        });
        if (paneId === null) throw createPaneDiscoveryStartupError(opts.sessionName);
        const expectedCommandFragments = buildExpectedCommandFragments(opts.spawnArgv);
        const hasUnprovenLivePanes = panes.some((pane) =>
          isLiveTerminalPane(pane) && !paneMatches(pane, paneId),
        );
        return {
          kind: 'zellij',
          sessionName: opts.sessionName,
          paneId,
          socketDir: params.socketDir,
          expectedCommandFragments,
          attachMetadata: {
            attachStrategy: 'terminal_host',
            // A colliding named zellij session can contain foreign panes. The adapter has no
            // registry-backed ownership proof for them, so it must surface shared topology rather
            // than destroying an unproven terminal.
            topology: hasUnprovenLivePanes ? 'shared' : 'exclusive',
            locality: 'same_machine',
            maxClients: null,
            requiresLocalAttachmentInfo: true,
            liveProbe: 'required',
          },
        };
      } catch (error) {
        return cleanupManagedSessionAndThrowStartupError(opts.sessionName, error);
      }
    },
    async injectUserPrompt(handle, input): Promise<TerminalInputInjectionResult> {
      const observedAt = now();
      const deferral = scheduledDeferral(handle, input, observedAt);
      if (deferral) return deferral;
      if (!handle.paneId) {
        return failedInjectionResult({
          handle,
          reason: 'no_target',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: true,
          observedAt,
        });
      }
      let paneId: string;
      let liveness;
      let trustedTargetPaneId: string | undefined;
      let paneDeadRecoverable = false;
      try {
        const inspection = await inspectLiveness(handle);
        liveness = inspection.liveness;
        trustedTargetPaneId = inspection.targetPaneId;
        paneDeadRecoverable = inspection.paneDeadRecoverable === true;
        paneId = trustedTargetPaneId ?? handle.paneId;
      } catch {
        return livenessUncertainDeferral(handle, input, observedAt);
      }
      if (!liveness.paneAlive || !trustedTargetPaneId) {
        if (paneDeadRecoverable) {
          return livenessUncertainDeferral(handle, input, liveness.observedAt);
        }
        return failedInjectionResult({
          handle,
          reason: 'pane_dead',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: paneDeadRecoverable,
          observedAt: liveness.observedAt,
        });
      }

      if (input.scheduling.deferredUntilQuietMs !== undefined && input.scheduling.deferredUntilQuietMs > 0) {
        let inputState: TerminalInputState;
        try {
          inputState = await captureInputState(handle);
        } catch {
          return livenessUncertainDeferral(handle, input, observedAt);
        }
        if (!inputState.stable) {
          return {
            status: 'deferred',
            reason: input.scheduling.deferReason ?? 'user_typing',
            recoverable: true,
            observedAt: inputState.observedAt,
            retryAfterMs: input.scheduling.deferredUntilQuietMs,
            ...handleFields(handle),
          };
        }
      }

      const deadline = createTerminalHostDeadline(input.scheduling.timeoutMs);
      const remainingForWrite = remainingTerminalHostDeadlineMs(deadline);
      const textToWrite = input.text;
      if (Buffer.byteLength(textToWrite, 'utf8') > pasteMaxBytes) {
        return failedInjectionResult({
          handle,
          reason: 'payload_too_large',
          phase: 'before_write',
          duplicateRisk: 'none',
          recoverable: true,
          observedAt: now(),
        });
      }
      try {
        await actions.pasteText({
          zellijBinary: params.zellijBinary,
          env: baseEnv(params.socketDir),
          paneId,
          text: textToWrite,
          timeoutMs: remainingForWrite,
        });
      } catch (error) {
        return failedInjectionResult({
          handle,
          reason: isZellijActionTimeoutError(error) ? 'timeout' : 'write_failed',
          phase: 'during_write',
          duplicateRisk: 'possible',
          recoverable: true,
          observedAt: now(),
        });
      }

      try {
        const submission = await runTerminalPromptSubmission({
          promptText: textToWrite,
          ...(params.promptSubmitVerification?.shouldVerifyBeforeSubmit(textToWrite)
            ? {
              verifyBeforeSubmit: async ({ promptText, remainingTimeoutMs }) => {
                const screenText = await actions.dumpScreen({
                  zellijBinary: params.zellijBinary,
                  env: baseEnv(params.socketDir),
                  paneId,
                  timeoutMs: remainingTimeoutMs ?? actionTimeoutMs,
                });
                return params.promptSubmitVerification?.verifyBeforeSubmit({
                  promptText,
                  screenText: normalizeCapturedScreen(screenText),
                }) ?? false;
              },
            }
            : {}),
          submitEnter: async ({ remainingTimeoutMs }) => {
            await actions.sendEnter({
              zellijBinary: params.zellijBinary,
              env: baseEnv(params.socketDir),
              paneId,
              timeoutMs: remainingTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
            });
            return 'success';
          },
          ...(params.promptSubmitVerification?.shouldVerifyAfterSubmit(textToWrite)
            ? {
              verifyAfterSubmit: async ({ promptText, remainingTimeoutMs }) => {
                const screenText = await actions.dumpScreen({
                  zellijBinary: params.zellijBinary,
                  env: baseEnv(params.socketDir),
                  paneId,
                  timeoutMs: remainingTimeoutMs ?? actionTimeoutMs,
                });
                return params.promptSubmitVerification?.verifyAfterSubmit({
                  promptText,
                  screenText: normalizeCapturedScreen(screenText),
                }) ?? false;
              },
            }
            : {}),
          remainingTimeoutMs: () => remainingTerminalHostDeadlineMs(deadline),
          wait: waitFn,
        });
        if (!submission.success) {
          return failedInjectionResult({
            handle,
            reason: submission.reason === 'timeout' ? 'timeout' : submission.reason === 'submit_failed' ? 'submit_failed' : 'host_unreachable',
            phase: submission.phase,
            duplicateRisk: submission.duplicateRisk,
            recoverable: submission.reason !== 'submit_failed',
            observedAt: now(),
          });
        }
      } catch (error) {
        return failedInjectionResult({
          handle,
          reason: isZellijActionTimeoutError(error) ? 'timeout' : 'submit_failed',
          phase: 'after_enter_unknown',
          duplicateRisk: 'likely',
          recoverable: false,
          observedAt: now(),
        });
      }

      return {
        status: 'injected',
        injectedAt: now(),
        bytesWritten: Buffer.byteLength(textToWrite),
        ...handleFields(handle),
      };
    },
    async interruptTurn(handle): Promise<void> {
      if (!handle.paneId) throw new Error('Cannot interrupt zellij terminal host without a pane id');
      const inspection = await inspectLiveness(handle);
      if (!inspection.liveness.paneAlive || !inspection.targetPaneId) {
        throw new Error('Cannot interrupt zellij terminal host because the pane is not alive');
      }
      await actions.sendEscape({
        zellijBinary: params.zellijBinary,
        env: baseEnv(params.socketDir),
        paneId: inspection.targetPaneId,
        timeoutMs: actionTimeoutMs,
      });
    },
    evaluateLiveness,
    captureInputState,
    createControlPort(handle) {
      return createZellijTerminalControlPort({
        actions,
        zellijBinary: params.zellijBinary,
        env: baseEnv(params.socketDir),
        sessionName: handle.sessionName,
        ...(handle.paneId !== undefined ? { paneId: handle.paneId } : {}),
        chunkSize: writeChunkSize,
        timeoutMs: actionTimeoutMs,
        nowMs: now,
      });
    },
    async dispose(handle): Promise<void> {
      if (!handle.paneId) return;
      let paneId = handle.paneId;
      try {
        paneId = (await inspectLiveness(handle)).targetPaneId ?? paneId;
      } catch {
        // Best-effort cleanup should still try the originally tracked pane.
      }
      await actions.closePane({
        zellijBinary: params.zellijBinary,
        env: baseEnv(params.socketDir),
        paneId,
        timeoutMs: actionTimeoutMs,
      });
    },
  };
}
