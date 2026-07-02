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

import {
  defaultZellijActions,
  DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE,
  isZellijActionTimeoutError,
  type ZellijActions,
  type ZellijPane,
} from './actions';
import { sanitizeTerminalHostDiagnosticText } from '../terminalHost/sanitizeTerminalHostDiagnosticText';
import { createZellijTerminalControlPort } from './control';

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

function resolvePostCleanupCommandPaneId(params: Readonly<{
  previousPaneId: string;
  panes: readonly ZellijPane[];
  replacementPaneIds: ReadonlySet<string>;
  expectedCommandFragments: readonly string[];
}>): string | null {
  const previousPane = params.panes.find((pane) => paneMatches(pane, params.previousPaneId));
  if (previousPane) return isLiveTerminalPane(previousPane) ? paneIdFromPane(previousPane) : null;

  const commandPanes = params.panes.filter((pane) => {
    const paneId = paneIdFromPane(pane);
    return paneId !== null
      && params.replacementPaneIds.has(paneId)
      && commandPaneMatchesExpectedFragments(pane, params.expectedCommandFragments);
  });
  if (commandPanes.length !== 1) return null;
  return paneIdFromPane(commandPanes[0]);
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

function createDeadline(timeoutMs: number | undefined): number | undefined {
  return timeoutMs !== undefined && timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
}

function remainingTimeoutMs(deadline: number | undefined): number | undefined {
  if (deadline === undefined) return undefined;
  return Math.max(0, deadline - Date.now());
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
  wait?: (delayMs: number) => Promise<void>;
}>): TerminalHostAdapter {
  const actions = params.actions ?? defaultZellijActions;
  const now = params.now ?? Date.now;
  const actionTimeoutMs = params.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  const writeChunkSize = params.writeChunkSize ?? DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE;
  const waitFn = params.wait ?? wait;

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

  async function closeLivePanesExcept(
    panes: readonly ZellijPane[],
    targetPaneId: string,
  ): Promise<Readonly<{ panes: readonly ZellijPane[]; closedPaneIds: ReadonlySet<string> }>> {
    const extras = panes
      .filter(isLiveTerminalPane)
      .map(paneIdFromPane)
      .filter((paneId): paneId is string => paneId !== null && !paneMatches({ id: paneId }, targetPaneId));
    await Promise.all(extras.map((paneId) => actions.closePane({
      zellijBinary: params.zellijBinary,
      env: baseEnv(params.socketDir),
      paneId,
      timeoutMs: actionTimeoutMs,
    })));
    return { panes: await listSessionPanes(), closedPaneIds: new Set(extras) };
  }

  async function inspectLiveness(handle: TerminalHostHandle): Promise<Readonly<{
    liveness: TerminalHostLivenessV1;
    targetPaneId?: string;
    paneDeadRecoverable?: boolean;
  }>> {
    const observedAt = now();
    const trackedPaneId = handle.paneId;
    if (!trackedPaneId) return { liveness: { paneAlive: false, paneDead: true, observedAt }, paneDeadRecoverable: true };
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

  return {
    kind: 'zellij',
    async createOrAttachHost(opts) {
      const env = baseEnv(params.socketDir);
      const attachResult = await actions.attachCreateBackground({
        zellijBinary: params.zellijBinary,
        env,
        sessionName: opts.sessionName,
        cwd: opts.workingDirectory,
        timeoutMs: actionTimeoutMs,
      });
      if (attachResult.exitCode !== 0) {
        throw new Error(`zellij attach failed: ${attachResult.stderr || attachResult.stdout}`);
      }
      try {
        const runResult = await actions.runCommand({
          zellijBinary: params.zellijBinary,
          env: {
            ...opts.spawnEnv,
            ...env,
          },
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
        if (paneId === null) throw new Error('zellij launch produced no terminal target pane');
        const expectedCommandFragments = buildExpectedCommandFragments(opts.spawnArgv);
        const cleanupResult = await closeLivePanesExcept(panes, paneId);
        const currentPaneId = resolvePostCleanupCommandPaneId({
          previousPaneId: paneId,
          panes: cleanupResult.panes,
          replacementPaneIds: cleanupResult.closedPaneIds,
          expectedCommandFragments,
        });
        if (currentPaneId === null) throw new Error('zellij launched terminal pane disappeared after cleanup');
        return {
          kind: 'zellij',
          sessionName: opts.sessionName,
          paneId: currentPaneId,
          socketDir: params.socketDir,
          expectedCommandFragments,
          attachMetadata: {
            attachStrategy: 'terminal_host',
            topology: 'exclusive',
            locality: 'same_machine',
            maxClients: null,
            requiresLocalAttachmentInfo: true,
            liveProbe: 'required',
          },
        };
      } catch (error) {
        await killManagedSession(opts.sessionName);
        throw error;
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
      } catch (error) {
        return failedInjectionResult({
          handle,
          reason: 'host_unreachable',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: true,
          observedAt,
          diagnostic: error instanceof Error ? error.message : String(error),
        });
      }
      if (!liveness.paneAlive || !trustedTargetPaneId) {
        return failedInjectionResult({
          handle,
          reason: 'pane_dead',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: paneDeadRecoverable,
          observedAt: liveness.observedAt,
        });
      }

      const deadline = createDeadline(input.scheduling.timeoutMs);
      const remainingForWrite = remainingTimeoutMs(deadline);
      const textToWrite = input.text;
      try {
        await actions.writeBytesChunked({
          zellijBinary: params.zellijBinary,
          env: baseEnv(params.socketDir),
          paneId,
          text: textToWrite,
          chunkSize: writeChunkSize,
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

      const remainingForEnter = remainingTimeoutMs(deadline);
      try {
        await actions.sendEnter({
          zellijBinary: params.zellijBinary,
          env: baseEnv(params.socketDir),
          paneId,
          timeoutMs: remainingForEnter,
        });
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
    async captureInputState(handle): Promise<TerminalInputState> {
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
    },
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
