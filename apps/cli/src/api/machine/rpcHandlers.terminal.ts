import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  DaemonTerminalCloseRequestSchema,
  DaemonTerminalEnsureRequestSchema,
  DaemonTerminalInputRequestSchema,
  DaemonTerminalResizeRequestSchema,
  DaemonTerminalRestartRequestSchema,
  DaemonTerminalStreamReadRequestSchema,
  type DaemonTerminalErrorCode,
} from '@happier-dev/protocol';
import { homedir as osHomedir } from 'node:os';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { validatePath } from '@/rpc/handlers/pathSecurity';
import { resolveMachineRpcWorkingDirectory } from './resolveMachineRpcWorkingDirectory';
import { readDaemonTerminalPtyConfig } from '@/daemon/terminalPty/terminalPtyConfig';
import { createTerminalPtySessionManager, type TerminalPtySessionManager } from '@/daemon/terminalPty/terminalPtySessionManager';
import { createNodePtyProvider } from '@/daemon/terminalPty/ptyProvider';

function err(errorCode: DaemonTerminalErrorCode): { ok: false; errorCode: DaemonTerminalErrorCode; error: DaemonTerminalErrorCode } {
  return { ok: false, errorCode, error: errorCode };
}

export function registerMachineTerminalRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  deps?: Readonly<{
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    workingDirectory?: string;
    sessionManager?: TerminalPtySessionManager;
  }>;
}>): void {
  const { rpcHandlerManager } = params;
  const env = params.deps?.env ?? process.env;

  const config = readDaemonTerminalPtyConfig(env);
  const workingDirectory =
    params.deps?.workingDirectory
    ?? resolveMachineRpcWorkingDirectory({ env });

  let sessionManager: TerminalPtySessionManager | null = params.deps?.sessionManager ?? null;
  const getSessionManager = (): TerminalPtySessionManager => {
    if (sessionManager) return sessionManager;
    sessionManager = createTerminalPtySessionManager({
      ptyProvider: createNodePtyProvider(),
      config: config.sessionManager,
      env,
      platform: params.deps?.platform,
    });
    return sessionManager;
  };

  const resolveCwd = (cwdInput: unknown): { ok: true; cwd: string } | ReturnType<typeof err> => {
    const raw = typeof cwdInput === 'string' && cwdInput.trim().length > 0 ? cwdInput.trim() : workingDirectory;
    const expanded =
      raw === '~'
        ? osHomedir()
        : raw.startsWith('~/') || raw.startsWith('~\\')
          ? `${osHomedir()}/${raw.slice(2)}`
          : raw;

    const validation = validatePath(expanded, workingDirectory);
    if (!validation.valid) {
      return err('terminal_cwd_denied');
    }
    return { ok: true, cwd: validation.resolvedPath ?? expanded };
  };

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_ENSURE, async (raw: unknown) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalEnsureRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');

    const cwd = resolveCwd(parsed.data.cwd);
    if (!cwd.ok) return cwd;

    return getSessionManager().ensure({
      terminalKey: parsed.data.terminalKey,
      cwd: cwd.cwd,
      cols: parsed.data.cols,
      rows: parsed.data.rows,
      initialCommand: parsed.data.initialCommand,
    });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ, async (raw: unknown) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalStreamReadRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');

    return getSessionManager().read({
      terminalId: parsed.data.terminalId,
      cursor: parsed.data.cursor,
      maxBytes: parsed.data.maxBytes ?? config.readDefaults.maxBytes,
      maxEvents: parsed.data.maxEvents ?? config.readDefaults.maxEvents,
    });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_INPUT, async (raw: unknown) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalInputRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    return getSessionManager().input(parsed.data);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_RESIZE, async (raw: unknown) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalResizeRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    return getSessionManager().resize(parsed.data);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_CLOSE, async (raw: unknown) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalCloseRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    return getSessionManager().close(parsed.data);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_RESTART, async (raw: unknown) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalRestartRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');

    const cwd = resolveCwd(parsed.data.cwd);
    if (!cwd.ok) return cwd;

    return getSessionManager().restart({
      terminalKey: parsed.data.terminalKey,
      cwd: cwd.cwd,
      cols: parsed.data.cols,
      rows: parsed.data.rows,
      initialCommand: parsed.data.initialCommand,
    });
  });
}
