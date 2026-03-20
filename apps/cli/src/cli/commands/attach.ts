import chalk from 'chalk';
import { spawn } from 'node:child_process';

import { inferAgentIdFromSessionMetadata, type AgentId } from '@happier-dev/agents';

import { getProviderAttachOps } from '@/backends/catalog';
import { configuration } from '@/configuration';
import { readCredentials, readSettings, type Credentials, type Settings } from '@/persistence';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import { fetchSessionById, fetchSessionsPage, type RawSessionListRow, type RawSessionRecord } from '@/sessionControl/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/sessionControl/sessionEncryptionContext';
import { createProviderAttachStatePublisher } from '@/agent/localControl/createProviderAttachStatePublisher';
import {
  readTerminalAttachmentInfo,
  type TerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { createTerminalAttachPlan } from '@/terminal/attachment/terminalAttachPlan';
import { isTmuxAvailable, normalizeExitCode } from '@/integrations/tmux';
import { focusWindowsTerminalWindow } from '@/terminal/attachment/windowsTerminalAttach';
import { focusWindowsConsoleWindow } from '@/terminal/attachment/windowsConsoleAttach';
import { canUseInkSelector, runSessionActionSelector } from '@/ui/ink/runSessionActionSelector';
import type { SessionActionSelectorRow } from '@/ui/ink/SessionActionSelector';
import { evaluateCliSessionAttachEligibility } from '@/sessionControl/evaluateCliSessionAttachEligibility';
import { buildAttachSelectionModel } from './attachInteractiveSelection';

import type { CommandContext } from '@/cli/commandRegistry';

function spawnTmux(params: {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdio: 'inherit' | 'ignore';
}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('tmux', params.args, {
      stdio: params.stdio,
      env: params.env,
      shell: false,
    });

    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(normalizeExitCode(code)));
  });
}

type AttachCommandDeps = Readonly<{
  readCredentialsFn?: () => Promise<Credentials | null>;
  readSettingsFn?: () => Promise<Settings>;
  fetchSessionByIdFn?: (params: { token: string; sessionId: string }) => Promise<RawSessionRecord | null>;
  fetchSessionsPageFn?: (params: { token: string; cursor?: string; limit?: number; activeOnly?: boolean; archivedOnly?: boolean }) => Promise<{
    sessions: RawSessionListRow[];
    nextCursor: string | null;
    hasNext: boolean;
  }>;
  resolveSessionIdOrPrefixFn?: (params: { credentials: Credentials; idOrPrefix: string }) => Promise<
    | { ok: true; sessionId: string }
    | { ok: false; code: string; candidates?: string[] }
  >;
  tryDecryptSessionMetadataFn?: typeof tryDecryptSessionMetadata;
  readTerminalAttachmentInfoFn?: typeof readTerminalAttachmentInfo;
  isTmuxAvailableFn?: typeof isTmuxAvailable;
  runTmuxAttachFn?: (params: {
    sessionId: string;
    terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
  }) => Promise<number>;
  runWindowsTerminalAttachFn?: (params: {
    sessionId: string;
    terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
  }) => Promise<number>;
  runWindowsConsoleAttachFn?: (params: {
    sessionId: string;
    terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
  }) => Promise<number>;
  runProviderAttachFn?: (params: {
    agentId: AgentId;
    sessionId: string;
    metadata: Record<string, unknown>;
  }) => Promise<number | false>;
  createProviderAttachStatePublisherFn?: typeof createProviderAttachStatePublisher;
  canUseInkSelectorFn?: () => boolean;
  selectAttachableSessionIdFn?: (params: {
    rows: SessionActionSelectorRow[];
    probeSessionIdFn?: (sessionId: string) => Promise<{ reachable: boolean; reason?: string }>;
  }) => Promise<
    | { type: 'selected'; sessionId: string }
    | { type: 'cancelled' }
    | { type: 'none' }
  >;
}>;

type ResolvedAttachContext = Readonly<{
  sessionId: string;
  metadata: Record<string, unknown> | null;
  agentId: AgentId | null;
  credentials: Credentials;
  rawSession: RawSessionRecord;
}>;

async function defaultRunTmuxAttach(params: {
  sessionId: string;
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
}, deps?: Readonly<{
  isTmuxAvailableFn?: typeof isTmuxAvailable;
}>): Promise<number> {
  const isTmuxAvailableFn = deps?.isTmuxAvailableFn ?? isTmuxAvailable;
  if (!(await isTmuxAvailableFn())) {
    console.error(chalk.red('Error:'), 'tmux is not available on this machine.');
    return 1;
  }

  const plan = createTerminalAttachPlan({
    terminal: params.terminal,
    insideTmux: Boolean(process.env.TMUX),
    currentTmuxSocketPath: typeof process.env.TMUX === 'string' ? process.env.TMUX.split(',')[0]?.trim() || null : null,
  });

  if (plan.type === 'not-attachable') {
    console.error(chalk.red('Error:'), plan.reason);
    return 1;
  }
  if (plan.type !== 'tmux') {
    console.error(chalk.red('Error:'), 'Session does not use tmux attach.');
    return 1;
  }

  const env: NodeJS.ProcessEnv = { ...process.env, ...plan.tmuxCommandEnv };
  if (plan.shouldUnsetTmuxEnv) {
    delete env.TMUX;
    delete env.TMUX_PANE;
  }

  const selectExit = await spawnTmux({
    args: plan.selectWindowArgs,
    env,
    stdio: 'ignore',
  });

  if (selectExit !== 0) {
    console.error(chalk.red('Error:'), `Failed to select tmux window (${plan.target}).`);
    return selectExit;
  }

  if (!plan.shouldAttach) return 0;

  return await spawnTmux({
    args: plan.attachSessionArgs,
    env,
    stdio: 'inherit',
  });
}

async function defaultRunWindowsTerminalAttach(params: {
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
}): Promise<number> {
  if (process.platform !== 'win32') {
    console.error(chalk.red('Error:'), 'Windows Terminal attach is only available on Windows.');
    return 1;
  }
  const windowId = params.terminal.windows?.windowId;
  if (typeof windowId !== 'string' || windowId.trim().length === 0) {
    console.error(chalk.red('Error:'), 'Session does not include a Windows Terminal window id.');
    return 1;
  }
  return await focusWindowsTerminalWindow({ windowId });
}

async function defaultRunWindowsConsoleAttach(params: {
  terminal: NonNullable<TerminalAttachmentInfo['terminal']>;
}): Promise<number> {
  if (process.platform !== 'win32') {
    console.error(chalk.red('Error:'), 'Windows console attach is only available on Windows.');
    return 1;
  }
  const pid = params.terminal.windows?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    console.error(chalk.red('Error:'), 'Session does not include a Windows console process id.');
    return 1;
  }
  return await focusWindowsConsoleWindow({ pid });
}

function printMissingAttachInfo(sessionId: string): void {
  console.error(chalk.red('Error:'), `No local attachment info found for session ${sessionId}.`);
  console.error(chalk.gray('This usually means the session was not started with an attachable terminal host, or it was started on another machine.'));
}

async function resolveAttachContext(
  sessionIdOrPrefix: string,
  deps: AttachCommandDeps,
): Promise<ResolvedAttachContext | null> {
  const readCredentialsFn = deps.readCredentialsFn ?? readCredentials;
  const fetchSessionByIdFn = deps.fetchSessionByIdFn ?? fetchSessionById;
  const resolveSessionIdOrPrefixFn = deps.resolveSessionIdOrPrefixFn ?? resolveSessionIdOrPrefix;
  const tryDecryptSessionMetadataFn = deps.tryDecryptSessionMetadataFn ?? tryDecryptSessionMetadata;

  const credentials = await readCredentialsFn();
  if (!credentials) return null;

  let rawSession = await fetchSessionByIdFn({ token: credentials.token, sessionId: sessionIdOrPrefix });
  if (!rawSession) {
    const resolved = await resolveSessionIdOrPrefixFn({ credentials, idOrPrefix: sessionIdOrPrefix });
    if (!resolved.ok) return null;
    rawSession = await fetchSessionByIdFn({ token: credentials.token, sessionId: resolved.sessionId });
  }
  if (!rawSession) return null;

  const metadata = tryDecryptSessionMetadataFn({ credentials, rawSession });
  const agentId = metadata ? inferAgentIdFromSessionMetadata(metadata) : null;
  return {
    sessionId: rawSession.id,
    metadata,
    agentId,
    credentials,
    rawSession,
  };
}

function isAttachSuccess(exitCode: number | false): boolean {
  return exitCode === 0;
}

async function selectAttachableSessionId(params: Readonly<{
  rows: SessionActionSelectorRow[];
  probeSessionIdFn?: (sessionId: string) => Promise<{ reachable: boolean; reason?: string }>;
}>): Promise<
  | { type: 'selected'; sessionId: string }
  | { type: 'cancelled' }
  | { type: 'none' }
> {
  if (params.rows.length === 0) return { type: 'none' };
  return await runSessionActionSelector({
    title: 'Attach to a running session',
    actionVerb: 'attach',
    footerHint: 'Use `happier resume` for stopped sessions.',
    rows: params.rows,
    onProbe: params.probeSessionIdFn,
  });
}

export async function handleAttachCommand(
  argv: string[],
  deps: AttachCommandDeps = {},
): Promise<void> {
  const hasHelpFlag = argv.some((arg) => {
    const trimmed = typeof arg === 'string' ? arg.trim() : '';
    return trimmed === '--help' || trimmed === '-h';
  });
  if (hasHelpFlag) {
    console.log('happier attach');
    console.log('happier attach <session-id-or-prefix>');
    console.log('');
    console.log('Attaches a terminal to a running session on this computer.');
    return;
  }

  let sessionIdOrPrefix = argv[0]?.trim() ?? '';
  const readTerminalAttachmentInfoFn = deps.readTerminalAttachmentInfoFn ?? readTerminalAttachmentInfo;
  const readSettingsFn = deps.readSettingsFn ?? readSettings;
  const fetchSessionsPageFn = deps.fetchSessionsPageFn ?? fetchSessionsPage;
  const runTmuxAttachFn = deps.runTmuxAttachFn ?? (async (params) => await defaultRunTmuxAttach(params, {
    isTmuxAvailableFn: deps.isTmuxAvailableFn,
  }));
  const runWindowsTerminalAttachFn = deps.runWindowsTerminalAttachFn ?? defaultRunWindowsTerminalAttach;
  const runWindowsConsoleAttachFn = deps.runWindowsConsoleAttachFn ?? defaultRunWindowsConsoleAttach;
  const runProviderAttachFn = deps.runProviderAttachFn ?? (async ({ agentId, sessionId, metadata }) => {
    const providerAttachOps = await getProviderAttachOps(agentId);
    if (!providerAttachOps) return 1;
    return await providerAttachOps.runAttach({ sessionId, metadata });
  });
  const createProviderAttachStatePublisherFn =
    deps.createProviderAttachStatePublisherFn ?? createProviderAttachStatePublisher;
  const canUseInkSelectorFn = deps.canUseInkSelectorFn ?? canUseInkSelector;
  const selectAttachableSessionIdFn = deps.selectAttachableSessionIdFn ?? selectAttachableSessionId;

  const isInteractive = sessionIdOrPrefix.length === 0;
  let credentialsForInteractive: Credentials | null = null;
  let currentMachineId: string | null = null;

  if (isInteractive) {
    if (!canUseInkSelectorFn()) {
      console.error(chalk.red('Error:'), 'Interactive attach is not available (raw TTY mode not supported).');
      console.log('');
      console.log('Hint: run `happier session list --active` and then `happier attach <session-id>`.');
      process.exit(1);
    }

    credentialsForInteractive = await (deps.readCredentialsFn ?? readCredentials)();
    if (!credentialsForInteractive) {
      console.error(chalk.red('Error:'), 'Not authenticated. Run "happier auth login" first.');
      process.exit(1);
    }

    const settings = await readSettingsFn();
    currentMachineId = typeof settings.machineId === 'string' && settings.machineId.trim().length > 0
      ? settings.machineId.trim()
      : null;
    if (!currentMachineId) {
      console.error(chalk.red('Error:'), 'Current machine id is unavailable. Start the daemon or reconnect this machine first.');
      process.exit(1);
    }
    const selectionModel = await buildAttachSelectionModel({
      credentials: credentialsForInteractive,
      currentMachineId,
      fetchSessionsPageFn,
      readTerminalAttachmentInfoFn,
    });
    const selected = await selectAttachableSessionIdFn({
      rows: selectionModel.rows,
      probeSessionIdFn: selectionModel.probeSessionIdFn,
    });
    if (selected.type === 'cancelled') {
      console.log(chalk.blue('Attach cancelled'));
      return;
    }
    if (selected.type === 'none') {
      console.log('No active local sessions found.');
      console.log('Hint: use `happier resume` for stopped sessions.');
      return;
    }
    sessionIdOrPrefix = selected.sessionId;
  }

  if (!sessionIdOrPrefix) {
    console.error(chalk.red('Error:'), 'Missing session ID.');
    console.log('');
    console.log('Usage: happier attach <sessionId>');
    process.exit(1);
  }

  const context = await resolveAttachContext(sessionIdOrPrefix, deps);
  const resolvedSessionId = context?.sessionId ?? sessionIdOrPrefix;
  const localInfo = await readTerminalAttachmentInfoFn({
    happyHomeDir: configuration.happyHomeDir,
    sessionId: resolvedSessionId,
  });

  if (context) {
    const settings = await readSettingsFn();
    const effectiveMachineId = typeof settings.machineId === 'string' && settings.machineId.trim().length > 0
      ? settings.machineId.trim()
      : null;
    const eligibility = await evaluateCliSessionAttachEligibility({
      credentials: context.credentials,
      rawSession: context.rawSession,
      currentMachineId: effectiveMachineId,
      localAttachmentInfo: localInfo,
      insideTmux: Boolean(process.env.TMUX),
      currentTmuxSocketPath: typeof process.env.TMUX === 'string' ? process.env.TMUX.split(',')[0]?.trim() || null : null,
    });

    if (!eligibility.eligible) {
      console.error(chalk.red('Error:'), eligibility.reason);
      process.exit(1);
    }

    if (eligibility.attachStrategy === 'provider_attach') {
      const statePublisher = createProviderAttachStatePublisherFn({
        agentId: eligibility.agentId,
        sessionId: resolvedSessionId,
        credentials: context.credentials,
        rawSession: context.rawSession,
      });
      if (statePublisher) {
        await statePublisher.publishAttached(true).catch(() => {});
      }
      let exitCode: number | false;
      try {
        exitCode = await runProviderAttachFn({
          agentId: eligibility.agentId,
          sessionId: resolvedSessionId,
          metadata: eligibility.metadata,
        });
      } finally {
        if (statePublisher) {
          await statePublisher.publishAttached(false).catch(() => {});
        }
      }
      if (!isAttachSuccess(exitCode)) process.exit(typeof exitCode === 'number' ? exitCode : 1);
      return;
    }

    let exitCode = 0;
    switch (eligibility.plan.type) {
      case 'tmux':
        exitCode = await runTmuxAttachFn({
          sessionId: resolvedSessionId,
          terminal: eligibility.terminal,
        });
        break;
      case 'windows_terminal_host':
        exitCode = await runWindowsTerminalAttachFn({
          sessionId: resolvedSessionId,
          terminal: eligibility.terminal,
        });
        break;
      case 'windows_console_host':
        exitCode = await runWindowsConsoleAttachFn({
          sessionId: resolvedSessionId,
          terminal: eligibility.terminal,
        });
        break;
    }
    if (exitCode !== 0) process.exit(exitCode);
    return;
  }

  const terminal = localInfo?.terminal ?? null;
  if (!terminal) {
    printMissingAttachInfo(resolvedSessionId);
    process.exit(1);
  }

  let exitCode = 0;
  if (terminal.mode === 'tmux') {
    exitCode = await runTmuxAttachFn({ sessionId: resolvedSessionId, terminal });
  } else if (terminal.mode === 'windows_terminal') {
    exitCode = await runWindowsTerminalAttachFn({ sessionId: resolvedSessionId, terminal });
  } else if (terminal.mode === 'windows_console') {
    exitCode = await runWindowsConsoleAttachFn({ sessionId: resolvedSessionId, terminal });
  } else {
    console.error(chalk.red('Error:'), 'Session was not started in tmux.');
    process.exit(1);
  }
  if (exitCode !== 0) process.exit(exitCode);
}

export async function handleAttachCliCommand(context: CommandContext): Promise<void> {
  try {
    await handleAttachCommand(context.args.slice(1));
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
