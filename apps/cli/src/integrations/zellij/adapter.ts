import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';

import { recordTerminalHostKillAudit } from '@/daemon/sessionKillAudit';
import { logger } from '@/ui/logger';

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
import {
  createTerminalHostDeadline,
  remainingTerminalHostDeadlineMs,
} from '../terminalHost/deadline';
import { TerminalHostStartupError, isTerminalHostStartupError } from '../terminalHost/errors';
import {
  defaultZellijActions,
  DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE,
  isZellijActionTimeoutError,
  resolveZellijActionPasteSafeBytes,
  type ZellijCommandResult,
  type ZellijActions,
  type ZellijDetachedCommandHandle,
  type ZellijPane,
} from './actions';
import { sanitizeTerminalHostDiagnosticText } from '../terminalHost/sanitizeTerminalHostDiagnosticText';
import { createZellijTerminalControlPort } from './control';
import { prepareZellijSocketDir, resolveZellijSocketDir } from './socketDir';
import {
  inspectZellijSessionSocketPresence,
  type InspectZellijSessionSocketPresence,
} from './socketPresence';
import {
  resolveTerminalPromptSubmissionFailureReason,
  runTerminalPromptSubmission,
  type TerminalPromptSubmitVerificationPolicy,
} from '../terminalHost/promptSubmitVerification';
import { resolveTerminalPromptWriteTimeoutMs } from '@/agent/runtime/terminal/injection/promptWriteTimeout';

const DEFAULT_INPUT_STABILITY_DELAY_MS = 50;
/**
 * R-E2: freshness window for reusing a `listPanes`-backed liveness inspection across the
 * readiness/liveness bridges' back-to-back `evaluateLiveness` + `captureInputState` calls within one
 * poll tick. Short enough that injection/control paths still observe near-current pane state.
 */
const LIVENESS_INSPECTION_FRESHNESS_MS = 100;
const DEFAULT_ACTION_TIMEOUT_MS = 15_000;
const DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS = 50;
const DEFAULT_SESSION_DISCOVERY_ACTION_TIMEOUT_MS = 1_000;
const MAX_LIVENESS_SCREEN_DUMP_CHARS = 2_000;

export type ZellijForegroundClientLaunchParams = Readonly<{
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  cwd?: string;
  defaultShell?: string;
  timeoutMs: number;
}>;

export type ZellijLaunchStrategy =
  | Readonly<{ type: 'background' }>
  | Readonly<{
    type: 'foregroundAttached';
    launchClient(params: ZellijForegroundClientLaunchParams): Promise<void>;
  }>;

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function sessionEnv(baseEnv: Readonly<Record<string, string>>, sessionName: string): Readonly<Record<string, string>> {
  return {
    ...baseEnv,
    ZELLIJ_SESSION_NAME: sessionName,
  };
}

/**
 * A saved zellij handle can outlive the Happier home that created it. Its socket root is therefore
 * host identity, not a current-process setting: only a persisted, non-empty root authorizes socket
 * absence as death evidence. Legacy markers have no such proof and must remain inconclusive.
 */
function socketRootFromHandle(handle: TerminalHostHandle): string | null {
  const socketDir = typeof handle.socketDir === 'string' ? handle.socketDir.trim() : '';
  return socketDir || null;
}

function livenessEnvForHandle(
  baseEnv: Readonly<Record<string, string>>,
  handle: TerminalHostHandle,
): Readonly<Record<string, string>> {
  const socketDir = socketRootFromHandle(handle);
  return socketDir === null ? baseEnv : { ...baseEnv, ZELLIJ_SOCKET_DIR: socketDir };
}

function resolvePaneId(pane: ZellijPane): string | null {
  const value = pane.pane_id ?? pane.id;
  if (value === undefined || value === null) return null;
  return String(value);
}

function resolvePaneIdFromRunOutput(stdout: string): string | null {
  const value = stdout.trim();
  return /^(?:terminal_)?\d+$/.test(value) ? value : null;
}

function resolveLaunchedTerminalPaneId(params: Readonly<{
  paneIdFromRun: string | null;
  preExistingPaneIds: ReadonlySet<string>;
  panes: readonly ZellijPane[];
}>): string | null {
  const paneIdFromRun = params.paneIdFromRun;
  if (paneIdFromRun !== null) {
    const matchingPane = params.panes.find((pane) => terminalPaneMatches(pane, paneIdFromRun));
    const normalizedPaneId = normalizePaneActionId(paneIdFromRun);
    if (
      matchingPane
      && isTerminalPaneAlive(matchingPane)
      && !isBootstrapTerminalPane(matchingPane, normalizedPaneId, params.preExistingPaneIds)
    ) {
      return normalizedPaneId;
    }
  }

  const liveTerminalPanes = params.panes.filter((pane) => {
    const paneId = resolveTerminalPaneActionId(pane);
    return paneId !== null && isTerminalPaneAlive(pane) && !isBootstrapTerminalPane(pane, paneId, params.preExistingPaneIds);
  });
  if (liveTerminalPanes.length === 1) {
    const paneId = resolveTerminalPaneActionId(liveTerminalPanes[0]);
    if (paneId !== null) return paneId;
  }

  return null;
}

function normalizePaneActionId(paneId: string): string {
  return paneId.startsWith('terminal_') ? paneId : `terminal_${paneId}`;
}

function resolveTerminalPaneActionId(pane: ZellijPane): string | null {
  if (pane.is_plugin) return null;
  const paneId = resolvePaneId(pane);
  return paneId === null ? null : normalizePaneActionId(paneId);
}

function isBootstrapTerminalPane(pane: ZellijPane, paneId: string, preExistingPaneIds: ReadonlySet<string>): boolean {
  return preExistingPaneIds.has(paneId) || pane.terminal_command === null;
}

function paneMatches(pane: ZellijPane, paneId: string): boolean {
  const resolvedPaneId = resolvePaneId(pane);
  return resolvedPaneId === paneId || (resolvedPaneId !== null && `terminal_${resolvedPaneId}` === paneId);
}

function terminalPaneMatches(pane: ZellijPane, paneId: string): boolean {
  return !pane.is_plugin && paneMatches(pane, paneId);
}

function isTerminalPaneAlive(pane: ZellijPane): boolean {
  if (pane.exited === true) return false;
  if (pane.is_held === true) return false;
  return true;
}

function isLaunchedCommandPane(pane: ZellijPane): boolean {
  return !pane.is_plugin
    && isTerminalPaneAlive(pane)
    && typeof pane.terminal_command === 'string'
    && pane.terminal_command.trim().length > 0;
}

function isProvenReplacementCommandPane(params: Readonly<{
  pane: ZellijPane;
  paneId: string;
  replacementPaneIds: ReadonlySet<string>;
  expectedCommandFragments: readonly string[];
}>): boolean {
  return params.replacementPaneIds.has(params.paneId)
    && commandPaneMatchesExpectedFragments(params.pane, params.expectedCommandFragments);
}

function resolvePostCleanupCommandPaneId(params: Readonly<{
  previousPaneId: string;
  panes: readonly ZellijPane[];
  replacementPaneIds: ReadonlySet<string>;
  expectedCommandFragments: readonly string[];
}>): string | null {
  const previousPane = params.panes.find((pane) => terminalPaneMatches(pane, params.previousPaneId));
  if (previousPane) {
    return isTerminalPaneAlive(previousPane) ? resolveTerminalPaneActionId(previousPane) : null;
  }

  const commandPanes = params.panes.filter((pane) => {
    const paneId = resolveTerminalPaneActionId(pane);
    return paneId !== null
      && params.replacementPaneIds.has(paneId)
      && commandPaneMatchesExpectedFragments(pane, params.expectedCommandFragments);
  });
  if (commandPanes.length !== 1) return null;
  return resolveTerminalPaneActionId(commandPanes[0]);
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
  return isLaunchedCommandPane(pane)
    && expectedCommandFragments.length > 0
    && typeof command === 'string'
    && commandHasExpectedProofFragment(command.trim(), expectedCommandFragments);
}

function resolveRuntimePaneTarget(params: Readonly<{
  panes: readonly ZellijPane[];
  paneId: string;
  expectedCommandFragments: readonly string[];
}>): ResolvedZellijPaneTarget | null {
  const exactPane = params.panes.find((pane) => terminalPaneMatches(pane, params.paneId));
  if (exactPane) {
    if (!paneCommandIsCompatibleWithExpectedFragments(exactPane, params.expectedCommandFragments)) return null;
    const exactPaneId = resolveTerminalPaneActionId(exactPane);
    return exactPaneId === null ? null : { pane: exactPane, paneId: exactPaneId };
  }

  const liveCommandPanes = params.panes.filter((pane) => commandPaneMatchesExpectedFragments(
    pane,
    params.expectedCommandFragments,
  ));
  if (liveCommandPanes.length !== 1) return null;
  const replacementPaneId = resolveTerminalPaneActionId(liveCommandPanes[0]);
  return replacementPaneId === null ? null : { pane: liveCommandPanes[0], paneId: replacementPaneId };
}

function paneDeadInjectionFailureIsRecoverable(params: Readonly<{
  panes: readonly ZellijPane[];
  target: ResolvedZellijPaneTarget | null;
}>): boolean {
  if (params.target !== null) return false;
  return !params.panes.some(isLaunchedCommandPane);
}

function truncateScreenDump(value: string): Readonly<{ text: string; truncated: boolean }> {
  if (value.length <= MAX_LIVENESS_SCREEN_DUMP_CHARS) return { text: value, truncated: false };
  return { text: value.slice(0, MAX_LIVENESS_SCREEN_DUMP_CHARS), truncated: true };
}

function summarizeDiagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeTerminalHostDiagnosticText(message).replace(/\s+/g, ' ').trim().slice(0, 240) || 'unknown_error';
}

function isInactiveZellijSessionError(error: unknown): boolean {
  const message = summarizeDiagnosticError(error);
  return /\bThere is no active session\b/i.test(message)
    || /\bEXITED\b.*\battach to resurrect\b/i.test(message);
}

function isZellijCollisionSessionConfirmedDead(panes: readonly ZellijPane[]): boolean {
  const terminalPanes = panes.filter((pane) => pane.is_plugin !== true);
  return terminalPanes.length > 0 && terminalPanes.every((pane) => !isTerminalPaneAlive(pane));
}

let collisionSessionSequence = 0;

function createZellijCollisionSessionName(sessionName: string): string {
  collisionSessionSequence += 1;
  return `${sessionName}-collision-${process.pid}-${Date.now()}-${collisionSessionSequence}`;
}

function resolvePaneExitStatus(pane: ZellijPane | undefined): number | undefined {
  const value = pane?.exit_status;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

function paneInitializingDeferral(input: TerminalPromptInput): Extract<TerminalInputInjectionResult, { status: 'deferred' }> {
  return {
    status: 'deferred',
    reason: 'pane_initializing',
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

function createZellijStartupTimeoutError(params: Readonly<{
  action: string;
  sessionName: string;
  actionTimeoutMs: number;
  message: string;
  lastError?: unknown;
}>): TerminalHostStartupError {
  const lastError = params.lastError instanceof Error
    ? params.lastError.message
    : params.lastError === undefined
      ? undefined
      : String(params.lastError);
  return new TerminalHostStartupError({
    hostKind: 'zellij',
    reason: 'startup_action_timeout',
    message: params.message,
    diagnostics: {
      action: params.action,
      sessionName: params.sessionName,
      timeoutMs: params.actionTimeoutMs,
      ...(lastError ? { lastError } : {}),
    },
  });
}

function buildZellijAttachCreateBackgroundCmd(params: Readonly<{
  zellijBinary: string;
  sessionName: string;
  cwd?: string | undefined;
  defaultShell?: string | undefined;
}>): readonly string[] {
  const cmd = [params.zellijBinary, 'attach', '--create-background', params.sessionName];
  if (params.cwd || params.defaultShell) {
    cmd.push('options');
    if (params.cwd) {
      cmd.push('--default-cwd', params.cwd);
    }
    if (params.defaultShell) {
      cmd.push('--default-shell', params.defaultShell);
    }
  }
  return cmd;
}

function buildZellijRunCommandCmd(params: Readonly<{
  zellijBinary: string;
  sessionName: string;
  cwd?: string | undefined;
  command: readonly string[];
}>): readonly string[] {
  const cmd = [params.zellijBinary, '-s', params.sessionName, 'run'];
  if (params.cwd) {
    cmd.push('--cwd', params.cwd);
  }
  cmd.push('--', ...params.command);
  return cmd;
}

function createZellijStartupActionFailedError(params: Readonly<{
  action: string;
  sessionName: string;
  actionTimeoutMs: number;
  cmd: readonly string[];
  cwd?: string | undefined;
  result: ZellijCommandResult;
}>): TerminalHostStartupError {
  const detail = params.result.stderr || params.result.stdout || `exit code ${params.result.exitCode}`;
  return new TerminalHostStartupError({
    hostKind: 'zellij',
    reason: 'startup_action_failed',
    message: `zellij ${params.action} failed: ${detail}`,
    diagnostics: {
      action: params.action,
      sessionName: params.sessionName,
      timeoutMs: params.actionTimeoutMs,
      cmd: params.cmd,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      exitCode: params.result.exitCode,
      stderr: params.result.stderr,
      stdout: params.result.stdout,
    },
  });
}

function isZellijMissingSessionOutput(output: string, sessionName: string): boolean {
  const normalizedOutput = output.toLowerCase();
  const normalizedSessionName = sessionName.toLowerCase();
  return normalizedOutput.includes(`no session named "${normalizedSessionName}" found`);
}

function isZellijSessionAlreadyExistsOutput(output: string): boolean {
  return /\bsession\b[^\r\n]*\balready\s+exists\b/i.test(stripAnsiCodes(output));
}

function stripAnsiCodes(input: string): string {
  return input.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function zellijSessionListContains(output: string, sessionName: string): boolean {
  const cleanOutput = stripAnsiCodes(output);
  return cleanOutput.split(/\r?\n/).some((line) => {
    const [listedName] = line.trimStart().split(/\s+/, 1);
    return listedName === sessionName;
  });
}

async function waitForListedZellijSession(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
}>): Promise<void> {
  if (!params.actions.listSessions) return;

  const deadline = createTerminalHostDeadline(params.actionTimeoutMs);
  let lastError: unknown;
  while (true) {
    const remainingMs = remainingTerminalHostDeadlineMs(deadline);
    if (remainingMs !== undefined && remainingMs <= 0) {
      const message = lastError instanceof Error ? lastError.message : String(lastError ?? `zellij session "${params.sessionName}" was not listed`);
      throw createZellijStartupTimeoutError({
        action: 'session_listing',
        sessionName: params.sessionName,
        actionTimeoutMs: params.actionTimeoutMs,
        message: `zellij session was not listed before addressability probing: ${message}`,
        lastError,
      });
    }

    const timeoutMs = remainingMs === undefined
      ? DEFAULT_SESSION_DISCOVERY_ACTION_TIMEOUT_MS
      : Math.max(1, Math.min(remainingMs, DEFAULT_SESSION_DISCOVERY_ACTION_TIMEOUT_MS));
    try {
      const result = await params.actions.listSessions({
        zellijBinary: params.zellijBinary,
        env: params.env,
        timeoutMs,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      if (result.exitCode === 0 && zellijSessionListContains(output, params.sessionName)) {
        return;
      }
      lastError = new Error(
        result.exitCode === 0
          ? `zellij session "${params.sessionName}" was not listed`
          : `zellij list-sessions failed: ${result.stderr || result.stdout}`,
      );
    } catch (error) {
      lastError = error;
    }

    const nextRemainingMs = remainingTerminalHostDeadlineMs(deadline);
    if (nextRemainingMs !== undefined && nextRemainingMs <= 0) {
      continue;
    }
    await wait(Math.min(DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS, nextRemainingMs ?? DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS));
  }
}

type ZellijSessionDisposeAudit = Readonly<{
  actor: string;
  reason: string;
  sessionId: string | null;
  runnerPid: number | null;
  callSite: string;
}>;

export type ZellijSessionDisposeResult = Readonly<{
  killCompleted: boolean;
  deleteCompleted: boolean;
}>;

export async function disposeZellijSession(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
  audit?: ZellijSessionDisposeAudit;
}>): Promise<ZellijSessionDisposeResult> {
  const audit = params.audit ?? {
    actor: 'zellij.adapter',
    reason: 'dispose',
    sessionId: null,
    runnerPid: process.pid,
    callSite: 'integrations.zellij.adapter.dispose',
  };
  const warn = (action: 'kill-session' | 'delete-session', error: unknown): void => {
    logger.warn(`[zellij teardown] ${action} failed; continuing best-effort teardown`, {
      action,
      actor: audit.actor,
      reason: audit.reason,
      callSite: audit.callSite,
      sessionId: audit.sessionId,
      runnerPid: audit.runnerPid,
      sessionName: params.sessionName,
      error,
    });
  };
  const recordAudit = (action: 'kill-session' | 'delete-session'): void => {
    try {
      recordTerminalHostKillAudit({
        ...audit,
        zellijName: params.sessionName,
        signal: action,
      });
    } catch (error) {
      warn(action, error);
    }
  };
  const runAction = async (
    action: 'kill-session' | 'delete-session',
    execute: () => Promise<ZellijCommandResult>,
  ): Promise<boolean> => {
    recordAudit(action);
    try {
      const result = await execute();
      if (result.exitCode === 0) return true;
      const output = `${result.stderr}\n${result.stdout}`;
      if (isZellijMissingSessionOutput(output, params.sessionName)) return true;
      warn(action, new Error(result.stderr || result.stdout || `exit code ${result.exitCode}`));
      return false;
    } catch (error) {
      warn(action, error);
      return false;
    }
  };

  const killCompleted = await runAction('kill-session', () => params.actions.killSession({
    zellijBinary: params.zellijBinary,
    env: params.env,
    sessionName: params.sessionName,
    timeoutMs: params.actionTimeoutMs,
  }));
  const deleteCompleted = await runAction('delete-session', () => params.actions.deleteSession({
    zellijBinary: params.zellijBinary,
    env: params.env,
    sessionName: params.sessionName,
    timeoutMs: params.actionTimeoutMs,
  }));
  return { killCompleted, deleteCompleted };
}

function normalizeZellijStartupError(params: Readonly<{
  error: unknown;
  sessionName: string;
  actionTimeoutMs: number;
  action?: string;
}>): unknown {
  if (isTerminalHostStartupError(params.error)) return params.error;
  if (!isZellijActionTimeoutError(params.error)) {
    const message = params.error instanceof Error ? params.error.message : String(params.error);
    return new TerminalHostStartupError({
      hostKind: 'zellij',
      reason: 'startup_action_failed',
      message: `zellij startup action failed: ${message}`,
      diagnostics: {
        action: params.action ?? 'startup',
        sessionName: params.sessionName,
        timeoutMs: params.actionTimeoutMs,
        error: message,
      },
    });
  }
  return new TerminalHostStartupError({
    hostKind: 'zellij',
    reason: 'startup_action_timeout',
    message: `zellij startup action timed out: ${params.error.message}`,
    diagnostics: {
      action: params.error.action,
      sessionName: params.sessionName,
      timeoutMs: params.actionTimeoutMs,
    },
  });
}

async function cleanupZellijSessionAndRethrowStartupError(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
  error: unknown;
}>): Promise<never> {
  const startupError = normalizeZellijStartupError({
    error: params.error,
    sessionName: params.sessionName,
    actionTimeoutMs: params.actionTimeoutMs,
  });
  await disposeZellijSession({
    actions: params.actions,
    zellijBinary: params.zellijBinary,
    env: params.env,
    sessionName: params.sessionName,
    actionTimeoutMs: params.actionTimeoutMs,
    audit: {
      actor: 'zellij.adapter',
      reason: 'startup-cleanup',
      sessionId: null,
      runnerPid: process.pid,
      callSite: 'integrations.zellij.adapter.startupCleanup',
    },
  });
  throw startupError;
}

async function closePaneIfStillPresent(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  paneId: string;
  actionTimeoutMs: number;
}>): Promise<void> {
  try {
    await params.actions.closePane({
      zellijBinary: params.zellijBinary,
      env: params.env,
      paneId: params.paneId,
      timeoutMs: params.actionTimeoutMs,
    });
  } catch (error) {
    const panes = await params.actions.listPanes({
      zellijBinary: params.zellijBinary,
      env: params.env,
      timeoutMs: params.actionTimeoutMs,
    }).catch(() => null);
    if (panes !== null && !panes.some((pane) => terminalPaneMatches(pane, params.paneId))) {
      return;
    }
    throw error;
  }
}

async function closeBootstrapTerminalPanes(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  paneId: string | null;
  preExistingPaneIds: ReadonlySet<string>;
  replacementPaneIds: ReadonlySet<string>;
  expectedCommandFragments: readonly string[];
  panesAfterLaunch: readonly ZellijPane[];
  actionTimeoutMs: number;
}>): Promise<Set<string>> {
  const activePaneId = params.paneId ? normalizePaneActionId(params.paneId) : null;
  const paneIdsToClose = new Set<string>();
  for (const pane of params.panesAfterLaunch) {
    const paneId = resolveTerminalPaneActionId(pane);
    if (
      paneId === null
      || paneId === activePaneId
      || isProvenReplacementCommandPane({
        pane,
        paneId,
        replacementPaneIds: params.replacementPaneIds,
        expectedCommandFragments: params.expectedCommandFragments,
      })
      || !isBootstrapTerminalPane(pane, paneId, params.preExistingPaneIds)
    ) {
      continue;
    }
    paneIdsToClose.add(paneId);
  }
  for (const paneId of paneIdsToClose) {
    await closePaneIfStillPresent({
      actions: params.actions,
      zellijBinary: params.zellijBinary,
      env: params.env,
      paneId,
      actionTimeoutMs: params.actionTimeoutMs,
    });
  }
  return paneIdsToClose;
}

function resolveBootstrapTerminalPaneIds(params: Readonly<{
  paneId: string;
  preExistingPaneIds: ReadonlySet<string>;
  replacementPaneIds: ReadonlySet<string>;
  expectedCommandFragments: readonly string[];
  panes: readonly ZellijPane[];
}>): Set<string> {
  const activePaneId = normalizePaneActionId(params.paneId);
  const bootstrapPaneIds = new Set<string>();
  for (const pane of params.panes) {
    const paneId = resolveTerminalPaneActionId(pane);
    if (
      paneId !== null
      && paneId !== activePaneId
      && !isProvenReplacementCommandPane({
        pane,
        paneId,
        replacementPaneIds: params.replacementPaneIds,
        expectedCommandFragments: params.expectedCommandFragments,
      })
      && isBootstrapTerminalPane(pane, paneId, params.preExistingPaneIds)
    ) {
      bootstrapPaneIds.add(paneId);
    }
  }
  return bootstrapPaneIds;
}

async function closeBootstrapTerminalPanesUntilStable(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  paneId: string;
  preExistingPaneIds: ReadonlySet<string>;
  initialPanes: readonly ZellijPane[];
  expectedCommandFragments: readonly string[];
  actionTimeoutMs: number;
}>): Promise<Readonly<{ panes: readonly ZellijPane[]; closedPaneIds: ReadonlySet<string> }>> {
  const deadline = createTerminalHostDeadline(params.actionTimeoutMs);
  const closedPaneIds = new Set<string>();
  let panesAfterLaunch = params.initialPanes;

  function throwBootstrapCleanupDidNotConverge(): never {
    throw new TerminalHostStartupError({
      hostKind: 'zellij',
      reason: 'bootstrap_cleanup_did_not_converge',
      message: 'zellij bootstrap pane cleanup did not converge',
      diagnostics: {
        paneId: params.paneId,
        closedPaneIds: [...closedPaneIds],
        actionTimeoutMs: params.actionTimeoutMs,
      },
    });
  }

  while (true) {
    const remainingMs = remainingTerminalHostDeadlineMs(deadline);
    if (remainingMs !== undefined && remainingMs <= 0) {
      throwBootstrapCleanupDidNotConverge();
    }
    const closedThisPass = await closeBootstrapTerminalPanes({
      actions: params.actions,
      zellijBinary: params.zellijBinary,
      env: params.env,
      paneId: params.paneId,
      preExistingPaneIds: params.preExistingPaneIds,
      replacementPaneIds: closedPaneIds,
      expectedCommandFragments: params.expectedCommandFragments,
      panesAfterLaunch,
      actionTimeoutMs: params.actionTimeoutMs,
    });
    for (const paneId of closedThisPass) closedPaneIds.add(paneId);
    const listTimeoutMs = remainingTerminalHostDeadlineMs(deadline);
    if (listTimeoutMs !== undefined && listTimeoutMs <= 0) {
      throwBootstrapCleanupDidNotConverge();
    }
    panesAfterLaunch = await params.actions.listPanes({
      zellijBinary: params.zellijBinary,
      env: params.env,
      timeoutMs: listTimeoutMs === undefined ? params.actionTimeoutMs : Math.max(1, listTimeoutMs),
    });
    const remainingBootstrapPaneIds = resolveBootstrapTerminalPaneIds({
      paneId: params.paneId,
      preExistingPaneIds: params.preExistingPaneIds,
      replacementPaneIds: closedPaneIds,
      expectedCommandFragments: params.expectedCommandFragments,
      panes: panesAfterLaunch,
    });
    if (remainingBootstrapPaneIds.size === 0) return { panes: panesAfterLaunch, closedPaneIds };
    const waitMs = remainingTerminalHostDeadlineMs(deadline);
    if (waitMs !== undefined && waitMs <= 0) {
      throwBootstrapCleanupDidNotConverge();
    }
    await wait(Math.min(DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS, waitMs ?? DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS));
  }
}

async function waitForLaunchedTerminalPane(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  paneIdFromRun: string | null;
  preExistingPaneIds: ReadonlySet<string>;
  actionTimeoutMs: number;
}>): Promise<{ paneId: string; panes: readonly ZellijPane[] }> {
  const deadline = createTerminalHostDeadline(params.actionTimeoutMs);
  while (true) {
    const timeoutMs = remainingTerminalHostDeadlineMs(deadline);
    const panes = await params.actions.listPanes({
      zellijBinary: params.zellijBinary,
      env: sessionEnv(params.env, params.sessionName),
      timeoutMs: timeoutMs === undefined ? params.actionTimeoutMs : Math.max(1, timeoutMs),
    });
    const paneId = resolveLaunchedTerminalPaneId({
      paneIdFromRun: params.paneIdFromRun,
      panes,
      preExistingPaneIds: params.preExistingPaneIds,
    });
    if (paneId !== null) return { paneId, panes };

    const remainingMs = remainingTerminalHostDeadlineMs(deadline);
    if (remainingMs === undefined || remainingMs <= 0) {
      throw createZellijStartupTimeoutError({
        action: 'pane_discovery',
        sessionName: params.sessionName,
        actionTimeoutMs: params.actionTimeoutMs,
        message: 'zellij launch produced no terminal target pane before startup deadline',
      });
    }
    await wait(Math.min(DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS, remainingMs));
  }
}

async function waitForAddressableZellijSession(params: Readonly<{
  actions: ZellijActions;
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
  sessionName: string;
  actionTimeoutMs: number;
}>): Promise<readonly ZellijPane[]> {
  await waitForListedZellijSession(params);

  const deadline = createTerminalHostDeadline(params.actionTimeoutMs);
  let lastError: unknown;
  while (true) {
    const timeoutMs = remainingTerminalHostDeadlineMs(deadline);
    try {
      return await params.actions.listPanes({
        zellijBinary: params.zellijBinary,
        env: sessionEnv(params.env, params.sessionName),
        timeoutMs: timeoutMs === undefined ? params.actionTimeoutMs : Math.max(1, timeoutMs),
      });
    } catch (error) {
      lastError = error;
    }

    const remainingMs = remainingTerminalHostDeadlineMs(deadline);
    if (remainingMs === undefined || remainingMs <= 0) {
      const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
      throw createZellijStartupTimeoutError({
        action: 'session_addressability',
        sessionName: params.sessionName,
        actionTimeoutMs: params.actionTimeoutMs,
        message: `zellij session did not become addressable before startup deadline: ${message}`,
        lastError,
      });
    }
    await wait(Math.min(DEFAULT_LAUNCH_PANE_DISCOVERY_POLL_MS, remainingMs));
  }
}

export function createZellijTerminalHostAdapter(params: Readonly<{
  zellijBinary: string;
  happyHomeDir: string;
  defaultShell?: string | undefined;
  actions?: ZellijActions;
  launchStrategy?: ZellijLaunchStrategy;
  chunkSize?: number;
  pasteMaxBytes?: number;
  inputStabilityDelayMs?: number;
  actionTimeoutMs?: number;
  promptSubmitVerification?: TerminalPromptSubmitVerificationPolicy | undefined;
  prepareSocketDir?: ((socketDir: string) => Promise<void>) | undefined;
  inspectSocketPresence?: InspectZellijSessionSocketPresence | undefined;
}>): TerminalHostAdapter {
  const actions = params.actions ?? defaultZellijActions;
  const prepareSocketDir = params.prepareSocketDir ?? prepareZellijSocketDir;
  const inspectSocketPresence = params.inspectSocketPresence ?? inspectZellijSessionSocketPresence;
  const actionTimeoutMs = Math.max(1, Math.trunc(params.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS));
  const pasteMaxBytes = Math.max(0, Math.trunc(params.pasteMaxBytes ?? resolveZellijActionPasteSafeBytes()));
  const promptSubmitVerification = params.promptSubmitVerification;
  const env: Readonly<Record<string, string>> = {
    ZELLIJ_SOCKET_DIR: resolveZellijSocketDir(params.happyHomeDir),
  };

  type LivenessInspection = Readonly<{
    liveness: TerminalHostLiveness;
    targetPaneId?: string;
    paneDeadRecoverable?: boolean;
    probeError?: unknown;
  }>;
  // R-E2: within-tick memo of the last inspection per pane, keyed by session + tracked pane id.
  const livenessInspectionCache = new Map<string, Readonly<{ atMs: number; value: LivenessInspection }>>();

  async function inspectLiveness(handle: TerminalHostHandle): Promise<LivenessInspection> {
    const cacheKey = `${handle.sessionName}\u0000${handle.paneId ?? ''}\u0000${socketRootFromHandle(handle) ?? ''}`;
    const cached = livenessInspectionCache.get(cacheKey);
    const nowMs = Date.now();
    if (cached && nowMs - cached.atMs <= LIVENESS_INSPECTION_FRESHNESS_MS) {
      return cached.value;
    }
    const value = await inspectLivenessUncached(handle);
    livenessInspectionCache.set(cacheKey, { atMs: Date.now(), value });
    return value;
  }

  async function inspectLivenessUncached(handle: TerminalHostHandle): Promise<LivenessInspection> {
    const observedAt = Date.now();
    const trackedPaneId = handle.paneId;
    if (!trackedPaneId) return { liveness: { paneAlive: false, paneDead: true, observedAt }, paneDeadRecoverable: true };
    const attachedSocketDir = socketRootFromHandle(handle);
    const livenessEnv = livenessEnvForHandle(env, handle);
    // Positive death evidence, consulted BEFORE any client action. A gone zellij server leaves no
    // socket for the session; a `list-panes` client against it blocks forever (incident cmrdazlqm).
    // Socket absence is conclusive death — it both avoids the hang and lets recovery dispose the
    // husk and relaunch. Presence / an unknown result falls through to the normal client probe, so
    // a wedged-but-alive host still times out into an *inconclusive* observation (never false-dead).
    const socketPresence = attachedSocketDir === null
      ? 'unknown'
      : await inspectSocketPresence({
          socketDir: attachedSocketDir,
          sessionName: handle.sessionName,
        }).catch(() => 'unknown' as const);
    if (socketPresence === 'absent') {
      return {
        liveness: {
          paneAlive: false,
          paneDead: true,
          paneScreenDumpError: 'zellij session socket is absent (server gone)',
          observedAt,
        },
        paneDeadRecoverable: false,
      };
    }
    let panes: ZellijPane[];
    try {
      panes = await actions.listPanes({
        zellijBinary: params.zellijBinary,
        env: sessionEnv(livenessEnv, handle.sessionName),
        timeoutMs: actionTimeoutMs,
      });
    } catch (error) {
      if (isInactiveZellijSessionError(error)) {
        return {
          liveness: {
            paneAlive: false,
            paneDead: true,
            paneScreenDumpError: summarizeDiagnosticError(error),
            observedAt,
          },
          paneDeadRecoverable: false,
        };
      }
      return {
        liveness: {
          paneAlive: false,
          probeInconclusive: true,
          paneScreenDumpError: summarizeDiagnosticError(error),
          observedAt,
        },
        paneDeadRecoverable: true,
        probeError: error,
      };
    }
    const target = resolveRuntimePaneTarget({
      panes,
      paneId: trackedPaneId,
      expectedCommandFragments: readExpectedCommandFragments(handle),
    });
    const exactPane = panes.find((candidate) => terminalPaneMatches(candidate, trackedPaneId));
    const pane = target?.pane ?? exactPane;
    const paneAlive = Boolean(pane && isTerminalPaneAlive(pane));
    const paneExitStatus = resolvePaneExitStatus(pane);
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
      ...(paneExitStatus !== undefined ? { paneExitStatus } : {}),
      observedAt,
    };

    if (!paneAlive) {
      const diagnosticPaneId = pane ? (target?.paneId ?? resolveTerminalPaneActionId(pane)) : null;
      if (diagnosticPaneId) {
        try {
          const rawDump = await actions.dumpScreen({
            zellijBinary: params.zellijBinary,
            env: sessionEnv(livenessEnv, handle.sessionName),
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

  async function evaluateLiveness(handle: TerminalHostHandle): Promise<TerminalHostLiveness> {
    return (await inspectLiveness(handle)).liveness;
  }

  async function captureInputState(handle: TerminalHostHandle): Promise<TerminalInputState> {
    if (!handle.paneId) return { stable: false, currentInput: '', observedAt: Date.now() };
    const inspection = await inspectLiveness(handle);
    if (!inspection.liveness.paneAlive || !inspection.targetPaneId) {
      throw new Error('zellij terminal pane is not alive');
    }
    const firstInput = await actions.dumpScreen({
      zellijBinary: params.zellijBinary,
      env: sessionEnv(env, handle.sessionName),
      paneId: inspection.targetPaneId,
      timeoutMs: actionTimeoutMs,
    });
    await wait(Math.max(0, Math.trunc(params.inputStabilityDelayMs ?? DEFAULT_INPUT_STABILITY_DELAY_MS)));
    const currentInput = await actions.dumpScreen({
      zellijBinary: params.zellijBinary,
      env: sessionEnv(env, handle.sessionName),
      paneId: inspection.targetPaneId,
      timeoutMs: actionTimeoutMs,
    });
    return { stable: firstInput === currentInput, currentInput, observedAt: Date.now() };
  }

  const createOrAttachHost: TerminalHostAdapter['createOrAttachHost'] = async (opts) => {
    await prepareSocketDir(env.ZELLIJ_SOCKET_DIR);
    const launchStrategy = params.launchStrategy ?? { type: 'background' };
    let activeSessionName = opts.sessionName;
    let collisionMayBelongToAnotherRunner = false;
    try {
      if (launchStrategy.type === 'background') {
        const attachCreateBackground = () => actions.attachCreateBackground({
          zellijBinary: params.zellijBinary,
          env,
          sessionName: activeSessionName,
          cwd: opts.workingDirectory,
          ...(params.defaultShell ? { defaultShell: params.defaultShell } : {}),
          timeoutMs: actionTimeoutMs,
        });
        let result = await attachCreateBackground();
        if (
          result.exitCode !== 0
          && isZellijSessionAlreadyExistsOutput(`${result.stderr}\n${result.stdout}`)
        ) {
          let collisionConfirmedDead = false;
          try {
            const panes = await actions.listPanes({
              zellijBinary: params.zellijBinary,
              env: sessionEnv(env, activeSessionName),
              timeoutMs: actionTimeoutMs,
            });
            collisionConfirmedDead = isZellijCollisionSessionConfirmedDead(panes);
          } catch (error) {
            collisionConfirmedDead = isInactiveZellijSessionError(error);
          }
          if (collisionConfirmedDead) {
            const staleSessionCleanup = await disposeZellijSession({
              actions,
              zellijBinary: params.zellijBinary,
              env,
              sessionName: activeSessionName,
              actionTimeoutMs,
              audit: {
                actor: 'zellij.adapter',
                reason: 'stale-session-name-collision',
                sessionId: null,
                runnerPid: process.pid,
                callSite: 'integrations.zellij.adapter.acquireHost',
              },
            });
            if (staleSessionCleanup.deleteCompleted) {
              result = await attachCreateBackground();
            }
          }
          if (
            result.exitCode !== 0
            && isZellijSessionAlreadyExistsOutput(`${result.stderr}\n${result.stdout}`)
          ) {
            activeSessionName = createZellijCollisionSessionName(opts.sessionName);
            result = await attachCreateBackground();
            collisionMayBelongToAnotherRunner = result.exitCode !== 0
              && isZellijSessionAlreadyExistsOutput(`${result.stderr}\n${result.stdout}`);
          }
        }
        if (result.exitCode !== 0) {
          const startupError = createZellijStartupActionFailedError({
            action: 'attach',
            sessionName: activeSessionName,
            actionTimeoutMs,
            cmd: buildZellijAttachCreateBackgroundCmd({
              zellijBinary: params.zellijBinary,
              sessionName: activeSessionName,
              cwd: opts.workingDirectory,
              ...(params.defaultShell ? { defaultShell: params.defaultShell } : {}),
            }),
            cwd: opts.workingDirectory,
            result,
          });
          if (collisionMayBelongToAnotherRunner) throw startupError;
          return cleanupZellijSessionAndRethrowStartupError({
            actions,
            zellijBinary: params.zellijBinary,
            env,
            sessionName: activeSessionName,
            actionTimeoutMs,
            error: startupError,
          });
        }
      } else {
        await launchStrategy.launchClient({
          zellijBinary: params.zellijBinary,
          env,
          sessionName: activeSessionName,
          cwd: opts.workingDirectory,
          ...(params.defaultShell ? { defaultShell: params.defaultShell } : {}),
          timeoutMs: actionTimeoutMs,
        });
      }
    } catch (error) {
      if (collisionMayBelongToAnotherRunner) throw error;
      return cleanupZellijSessionAndRethrowStartupError({
        actions,
        zellijBinary: params.zellijBinary,
        env,
        sessionName: activeSessionName,
        actionTimeoutMs,
        error,
      });
    }
    let preExistingPaneIds: ReadonlySet<string>;
    try {
      preExistingPaneIds = new Set(
        (await waitForAddressableZellijSession({
          actions,
          zellijBinary: params.zellijBinary,
          env,
          sessionName: activeSessionName,
          actionTimeoutMs,
        })).flatMap((pane) => {
          const paneId = resolveTerminalPaneActionId(pane);
          return paneId === null ? [] : [paneId];
        }),
      );
    } catch (error) {
      return cleanupZellijSessionAndRethrowStartupError({
        actions,
        zellijBinary: params.zellijBinary,
        env,
        sessionName: activeSessionName,
        actionTimeoutMs,
        error,
      });
    }
    let paneId: string | null;
    const expectedCommandFragments = buildExpectedCommandFragments(opts.spawnArgv);
    try {
      let paneIdFromRun: string | null = null;
      let detachedCommandHandle: ZellijDetachedCommandHandle | null = null;
      if (launchStrategy.type === 'background') {
        let runResult: ZellijCommandResult;
        try {
          runResult = await actions.runCommand({
            zellijBinary: params.zellijBinary,
            env: {
              ...env,
              ...opts.spawnEnv,
            },
            sessionName: activeSessionName,
            cwd: opts.workingDirectory,
            command: opts.spawnArgv,
            timeoutMs: actionTimeoutMs,
          });
        } catch (error) {
          return cleanupZellijSessionAndRethrowStartupError({
            actions,
            zellijBinary: params.zellijBinary,
            env,
            sessionName: activeSessionName,
            actionTimeoutMs,
            error,
          });
        }
        if (runResult.exitCode !== 0) {
          return cleanupZellijSessionAndRethrowStartupError({
            actions,
            zellijBinary: params.zellijBinary,
            env,
            sessionName: activeSessionName,
            actionTimeoutMs,
            error: createZellijStartupActionFailedError({
              action: 'run',
              sessionName: activeSessionName,
              actionTimeoutMs,
              cmd: buildZellijRunCommandCmd({
                zellijBinary: params.zellijBinary,
                sessionName: activeSessionName,
                cwd: opts.workingDirectory,
                command: opts.spawnArgv,
              }),
              cwd: opts.workingDirectory,
              result: runResult,
            }),
          });
        }
        paneIdFromRun = resolvePaneIdFromRunOutput(runResult.stdout);
      } else {
        if (!actions.startCommandDetached) {
          throw new Error('zellij detached command launcher is unavailable');
        }
        detachedCommandHandle = await actions.startCommandDetached({
          zellijBinary: params.zellijBinary,
          env: {
            ...env,
            ...opts.spawnEnv,
          },
          sessionName: activeSessionName,
          cwd: opts.workingDirectory,
          command: opts.spawnArgv,
          timeoutMs: actionTimeoutMs,
        });
      }
      let launchedPane: { paneId: string; panes: readonly ZellijPane[] };
      try {
        launchedPane = await waitForLaunchedTerminalPane({
          actions,
          zellijBinary: params.zellijBinary,
          env,
          sessionName: activeSessionName,
          paneIdFromRun,
          preExistingPaneIds,
          actionTimeoutMs,
        });
      } finally {
        detachedCommandHandle?.dispose();
      }
      paneId = launchedPane.paneId;
      const bootstrapCleanup = await closeBootstrapTerminalPanesUntilStable({
        actions,
        zellijBinary: params.zellijBinary,
        env: sessionEnv(env, activeSessionName),
        paneId,
        preExistingPaneIds,
        initialPanes: launchedPane.panes,
        expectedCommandFragments,
        actionTimeoutMs,
      });
      const currentPaneId = resolvePostCleanupCommandPaneId({
        previousPaneId: paneId,
        panes: bootstrapCleanup.panes,
        replacementPaneIds: bootstrapCleanup.closedPaneIds,
        expectedCommandFragments,
      });
      if (currentPaneId === null) {
        throw new TerminalHostStartupError({
          hostKind: 'zellij',
          reason: 'pane_disappeared_after_bootstrap_cleanup',
          message: 'zellij launched terminal pane disappeared after bootstrap cleanup',
          diagnostics: {
            previousPaneId: paneId,
            closedPaneIds: [...bootstrapCleanup.closedPaneIds],
            expectedCommandFragments,
          },
        });
      }
      paneId = currentPaneId;
    } catch (error) {
      return cleanupZellijSessionAndRethrowStartupError({
        actions,
        zellijBinary: params.zellijBinary,
        env,
        sessionName: activeSessionName,
        actionTimeoutMs,
        error,
      });
    }
    return {
      attachmentId: randomUUID() as TerminalHostHandle['attachmentId'],
      kind: 'zellij',
      sessionName: activeSessionName,
      ...(paneId ? { paneId } : {}),
      socketDir: env.ZELLIJ_SOCKET_DIR,
      expectedCommandFragments,
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        maxClients: null,
        requiresLocalAttachmentInfo: true,
        liveProbe: 'required',
      },
    };
  };

  return {
    kind: 'zellij',
    createOrAttachHost,
    async adoptExistingHost(handle: TerminalHostHandle): Promise<TerminalHostHandle> {
      try {
        const inspection = await inspectLiveness(handle);
        if (inspection.probeError !== undefined) throw inspection.probeError;
        if (!inspection.liveness.paneAlive) {
          throw new TerminalHostStartupError({
            hostKind: 'zellij',
            reason: 'startup_action_failed',
            message: 'Cannot adopt zellij terminal host because the target pane is not alive',
            diagnostics: {
              action: 'adopt',
              sessionName: handle.sessionName,
              timeoutMs: actionTimeoutMs,
            },
          });
        }
        return handle;
      } catch (error) {
        throw normalizeZellijStartupError({
          error,
          sessionName: handle.sessionName,
          actionTimeoutMs,
          action: 'adopt',
        });
      }
    },
    async injectUserPrompt(
      handle: TerminalHostHandle,
      input: TerminalPromptInput,
      writeBoundary?: TerminalPromptWriteBoundaryV1,
    ): Promise<TerminalInputInjectionResult> {
      const deferral = scheduledDeferral(input);
      if (deferral) return deferral;

      if (!handle.paneId) {
        return failedInjectionResult({
          reason: 'no_target',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: true,
        });
      }
      let paneId: string;
      let liveness: TerminalHostLiveness;
      let trustedTargetPaneId: string | undefined;
      let paneDeadRecoverable = false;
      try {
        const inspection = await inspectLiveness(handle);
        liveness = inspection.liveness;
        trustedTargetPaneId = inspection.targetPaneId;
        paneDeadRecoverable = inspection.paneDeadRecoverable === true;
        if (trustedTargetPaneId) {
          paneId = trustedTargetPaneId;
        } else {
          paneId = handle.paneId;
        }
      } catch {
        return paneInitializingDeferral(input);
      }
      if (!liveness.paneAlive || !trustedTargetPaneId) {
        if (paneDeadRecoverable) {
          return paneInitializingDeferral(input);
        }
        return failedInjectionResult({
          reason: 'pane_dead',
          phase: 'liveness',
          duplicateRisk: 'none',
          recoverable: paneDeadRecoverable,
        });
      }

      if (input.scheduling.deferredUntilQuietMs !== undefined && input.scheduling.deferredUntilQuietMs > 0) {
        let inputState: TerminalInputState;
        try {
          inputState = await captureInputState(handle);
        } catch {
          return failedInjectionResult({
            reason: 'host_unreachable',
            phase: 'readiness',
            duplicateRisk: 'none',
            recoverable: true,
          });
        }
        if (!inputState.stable) {
          return {
            status: 'deferred',
            reason: 'user_typing',
            retryAfterMs: input.scheduling.deferredUntilQuietMs,
          };
        }
      }

      const injectionTimeoutMs = input.scheduling.timeoutMs ?? resolveTerminalPromptWriteTimeoutMs(input.text);
      const deadline = createTerminalHostDeadline(injectionTimeoutMs);
      const textToWrite = input.text;
      const textToWriteBytes = Buffer.byteLength(textToWrite, 'utf8');
      let failurePhase: TerminalInjectionFailurePhase = 'during_write';
      let duplicateRisk: TerminalInjectionDuplicateRisk = 'possible';
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
      try {
        const paneEnv = sessionEnv(env, handle.sessionName);
        const writeBytes = () => actions.writeBytesChunked({
          zellijBinary: params.zellijBinary,
          env: paneEnv,
          paneId,
          text: textToWrite,
          chunkSize: params.chunkSize ?? DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE,
          timeoutMs: injectionTimeoutMs,
        });
        if (actions.pasteText && textToWriteBytes <= pasteMaxBytes) {
          try {
            await actions.pasteText({
              zellijBinary: params.zellijBinary,
              env: paneEnv,
              paneId,
              text: textToWrite,
              timeoutMs: injectionTimeoutMs,
            });
          } catch (error) {
            if (isZellijActionTimeoutError(error)) throw error;
            await writeBytes();
          }
        } else {
          await writeBytes();
        }
        failurePhase = 'after_enter_unknown';
        duplicateRisk = 'likely';
        const submission = await runTerminalPromptSubmission({
          promptText: textToWrite,
          ...(promptSubmitVerification?.shouldVerifyAfterSubmit(textToWrite)
            ? {
              verifyStagedBeforeSubmit: async ({ promptText, remainingTimeoutMs }) => {
                const screenText = await actions.dumpScreen({
                  zellijBinary: params.zellijBinary,
                  env: sessionEnv(env, handle.sessionName),
                  paneId,
                  ...(remainingTimeoutMs !== undefined
                    ? { timeoutMs: remainingTimeoutMs }
                    : { timeoutMs: actionTimeoutMs }),
                });
                return promptSubmitVerification.isPromptStagedBeforeSubmit({
                  promptText,
                  screenText,
                });
              },
            }
            : {}),
          submitEnter: async ({ remainingTimeoutMs }) => {
            await actions.sendEnter({
              zellijBinary: params.zellijBinary,
              env: sessionEnv(env, handle.sessionName),
              paneId,
              ...(remainingTimeoutMs !== undefined ? { timeoutMs: remainingTimeoutMs } : { timeoutMs: actionTimeoutMs }),
            });
            return 'success';
          },
          ...(promptSubmitVerification?.shouldVerifyAfterSubmit(textToWrite)
            ? {
              verifyAfterSubmit: async ({ promptText, remainingTimeoutMs }) => {
                const screenText = await actions.dumpScreen({
                  zellijBinary: params.zellijBinary,
                  env: sessionEnv(env, handle.sessionName),
                  paneId,
                  ...(remainingTimeoutMs !== undefined
                    ? { timeoutMs: remainingTimeoutMs }
                    : { timeoutMs: actionTimeoutMs }),
                });
                return promptSubmitVerification.isPromptStillPendingAfterSubmit({
                  promptText,
                  screenText,
                });
              },
            }
            : {}),
          remainingTimeoutMs: () => remainingTerminalHostDeadlineMs(deadline),
          wait,
        });
        if (!submission.success) {
          return failedInjectionResult({
            reason: resolveTerminalPromptSubmissionFailureReason(submission.reason),
            phase: submission.phase,
            duplicateRisk: submission.duplicateRisk,
            recoverable: true,
          });
        }
        return { status: 'injected', at: Date.now(), bytesWritten: textToWriteBytes };
      } catch (error) {
        return failedInjectionResult({
          reason: isZellijActionTimeoutError(error) ? 'timeout' : 'host_unreachable',
          phase: failurePhase,
          duplicateRisk,
          recoverable: true,
        });
      }
    },
    async interruptTurn(handle: TerminalHostHandle): Promise<void> {
      if (!handle.paneId) {
        throw new Error('Cannot interrupt zellij terminal host without a pane id');
      }
      const inspection = await inspectLiveness(handle);
      if (!inspection.liveness.paneAlive || !inspection.targetPaneId) {
        throw new Error('Cannot interrupt zellij terminal host because the pane is not alive');
      }
      await actions.sendEscape({
        zellijBinary: params.zellijBinary,
        env: sessionEnv(env, handle.sessionName),
        paneId: inspection.targetPaneId,
        timeoutMs: actionTimeoutMs,
      });
    },
    evaluateLiveness,
    captureInputState,
    createControlPort(handle: TerminalHostHandle) {
      if (!handle.paneId || handle.paneId.trim().length === 0) return null;
      return createZellijTerminalControlPort({
        actions,
        zellijBinary: params.zellijBinary,
        env,
        sessionName: handle.sessionName,
        paneId: handle.paneId,
        ...(params.chunkSize !== undefined ? { chunkSize: params.chunkSize } : {}),
        timeoutMs: actionTimeoutMs,
      });
    },
    async dispose(handle: TerminalHostHandle): Promise<void> {
      if (handle.attachMetadata.topology === 'shared') {
        const paneId = handle.paneId?.trim();
        if (!paneId) {
          throw new Error('Cannot destroy shared zellij terminal host without its owned pane id');
        }
        recordTerminalHostKillAudit({
          actor: 'zellij.adapter',
          reason: 'destroy-owned-host',
          sessionId: null,
          runnerPid: process.pid,
          zellijName: handle.sessionName,
          signal: 'close-pane',
          callSite: 'integrations.zellij.adapter.dispose',
        });
        await actions.closePane({
          zellijBinary: params.zellijBinary,
          env: sessionEnv(env, handle.sessionName),
          paneId,
          timeoutMs: actionTimeoutMs,
        });
        return;
      }
      const disposed = await disposeZellijSession({
        actions,
        zellijBinary: params.zellijBinary,
        env,
        sessionName: handle.sessionName,
        actionTimeoutMs,
      });
      if (!disposed.killCompleted || !disposed.deleteCompleted) {
        throw new Error(`Failed to destroy owned zellij session ${handle.sessionName}`);
      }
    },
  };
}
