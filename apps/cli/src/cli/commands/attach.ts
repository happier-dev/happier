import chalk from 'chalk';
import { spawn } from 'node:child_process';

import { inferAgentIdFromSessionMetadata, getAgentLocalControlCapability, type AgentId } from '@happier-dev/agents';

import { configuration } from '@/configuration';
import { readCredentials, type Credentials } from '@/persistence';
import { resolveSessionIdOrPrefix } from '@/sessionControl/resolveSessionId';
import { fetchSessionById, type RawSessionRecord } from '@/sessionControl/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/sessionControl/sessionEncryptionContext';
import { createProviderAttachStatePublisher } from '@/agent/localControl/createProviderAttachStatePublisher';
import {
  readTerminalAttachmentInfo,
  type TerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { createTerminalAttachPlan } from '@/terminal/attachment/terminalAttachPlan';
import { isTmuxAvailable, normalizeExitCode } from '@/integrations/tmux';
import { runOpenCodeProviderAttach } from '@/backends/opencode/attach/runOpenCodeProviderAttach';
import { focusWindowsTerminalWindow } from '@/terminal/attachment/windowsTerminalAttach';
import { focusWindowsConsoleWindow } from '@/terminal/attachment/windowsConsoleAttach';

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
  fetchSessionByIdFn?: (params: { token: string; sessionId: string }) => Promise<RawSessionRecord | null>;
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

function resolveTmuxTerminalFromAttachContext(
  context: ResolvedAttachContext | null,
  localInfo: TerminalAttachmentInfo | null,
): NonNullable<TerminalAttachmentInfo['terminal']> | null {
  const remoteTerminal = context?.metadata?.terminal;
  if (remoteTerminal && typeof remoteTerminal === 'object' && !Array.isArray(remoteTerminal)) {
    const remote = remoteTerminal as NonNullable<TerminalAttachmentInfo['terminal']>;
    if (localInfo?.terminal?.mode === remote.mode && (remote.mode === 'windows_terminal' || remote.mode === 'windows_console')) {
      return {
        ...remote,
        windows: {
          ...(remote.windows ?? {}),
          ...(localInfo.terminal.windows ?? {}),
        },
      } as NonNullable<TerminalAttachmentInfo['terminal']>;
    }
    return remote;
  }
  return localInfo?.terminal ?? null;
}

function isAttachSuccess(exitCode: number | false): boolean {
  return exitCode === 0;
}

export async function handleAttachCommand(
  argv: string[],
  deps: AttachCommandDeps = {},
): Promise<void> {
  const sessionIdOrPrefix = argv[0]?.trim();
  if (!sessionIdOrPrefix) {
    console.error(chalk.red('Error:'), 'Missing session ID.');
    console.log('');
    console.log('Usage: happier attach <sessionId>');
    process.exit(1);
  }

  const readTerminalAttachmentInfoFn = deps.readTerminalAttachmentInfoFn ?? readTerminalAttachmentInfo;
  const runTmuxAttachFn = deps.runTmuxAttachFn ?? (async (params) => await defaultRunTmuxAttach(params, {
    isTmuxAvailableFn: deps.isTmuxAvailableFn,
  }));
  const runWindowsTerminalAttachFn = deps.runWindowsTerminalAttachFn ?? defaultRunWindowsTerminalAttach;
  const runWindowsConsoleAttachFn = deps.runWindowsConsoleAttachFn ?? defaultRunWindowsConsoleAttach;
  const runProviderAttachFn = deps.runProviderAttachFn ?? (async ({ agentId, sessionId, metadata }) => {
    if (agentId === 'opencode') {
      return await runOpenCodeProviderAttach({ sessionId, metadata });
    }
    return 1;
  });
  const createProviderAttachStatePublisherFn =
    deps.createProviderAttachStatePublisherFn ?? createProviderAttachStatePublisher;

  const context = await resolveAttachContext(sessionIdOrPrefix, deps);
  const resolvedSessionId = context?.sessionId ?? sessionIdOrPrefix;

  if (context?.agentId) {
    const localControl = getAgentLocalControlCapability(context.agentId);
    if (localControl?.attachStrategy === 'provider_attach' && context.metadata) {
      const statePublisher = createProviderAttachStatePublisherFn({
        agentId: context.agentId,
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
          agentId: context.agentId,
          sessionId: resolvedSessionId,
          metadata: context.metadata,
        });
      } finally {
        if (statePublisher) {
          await statePublisher.publishAttached(false).catch(() => {});
        }
      }
      if (!isAttachSuccess(exitCode)) process.exit(typeof exitCode === 'number' ? exitCode : 1);
      return;
    }
  }

  const localInfo = await readTerminalAttachmentInfoFn({
    happyHomeDir: configuration.happyHomeDir,
    sessionId: resolvedSessionId,
  });

  const terminal = resolveTmuxTerminalFromAttachContext(context, localInfo);
  if (!terminal) {
    printMissingAttachInfo(resolvedSessionId);
    process.exit(1);
  }

  const plan = createTerminalAttachPlan({
    terminal,
    insideTmux: Boolean(process.env.TMUX),
    currentTmuxSocketPath: typeof process.env.TMUX === 'string' ? process.env.TMUX.split(',')[0]?.trim() || null : null,
  });

  let exitCode = 0;
  switch (plan.type) {
    case 'tmux':
      exitCode = await runTmuxAttachFn({
        sessionId: resolvedSessionId,
        terminal,
      });
      break;
    case 'windows_terminal_host':
      exitCode = await runWindowsTerminalAttachFn({
        sessionId: resolvedSessionId,
        terminal,
      });
      break;
    case 'windows_console_host':
      exitCode = await runWindowsConsoleAttachFn({
        sessionId: resolvedSessionId,
        terminal,
      });
      break;
    case 'not-attachable':
      console.error(chalk.red('Error:'), plan.reason);
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
