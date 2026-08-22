import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  DaemonTerminalCloseRequestSchema,
  DaemonTerminalEnsureRequestSchema,
  DaemonTerminalInputRequestSchema,
  DaemonTerminalResizeRequestSchema,
  DaemonTerminalRestartRequestSchema,
  DaemonTerminalStreamReadRequestSchema,
  TerminalStreamAckRequestSchema,
  TerminalStreamAckResponseSchema,
  TerminalStreamInputRequestSchema,
  TerminalStreamInputResponseSchema,
  TerminalStreamReadRequestSchema,
  TerminalStreamReadResponseSchema,
  terminalInputEventToPtyAction,
  type DaemonTerminalErrorCode,
  type DaemonTerminalInputResponse,
  type DaemonTerminalResizeResponse,
  type TerminalStreamAckRequest,
  type TerminalStreamAckResponse,
  type TerminalStreamInputRequest,
  type TerminalStreamInputResponse,
  type TerminalStreamReadRequest,
  type TerminalStreamReadResponse,
} from '@happier-dev/protocol';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import { validatePath } from '@/rpc/handlers/pathSecurity';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { resolveMachineRpcWorkingDirectory } from './resolveMachineRpcWorkingDirectory';
import {
  resolveFilesystemAccessPolicy,
  type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { readDaemonTerminalPtyConfig } from '@/terminal/pty/config';
import { createTerminalPtySessionManager, type TerminalPtySessionManager } from '@/terminal/pty/sessions';
import { createNodePtyProvider } from '@/terminal/pty/provider';
import { getSharedTerminalProcessRegistry, type TerminalProcessRegistry } from '@/daemon/local/services/inventory/terminalRegistry';
import {
  resolveDaemonTerminalLaunch,
  type TerminalLaunchProcess,
} from '@/terminal/pty/launch';

function err(errorCode: DaemonTerminalErrorCode): { ok: false; errorCode: DaemonTerminalErrorCode; error: DaemonTerminalErrorCode } {
  return { ok: false, errorCode, error: errorCode };
}

type TerminalByteStreamBridge = Readonly<{
  readByteStream?: (input: TerminalStreamReadRequest) => Promise<TerminalStreamReadResponse> | TerminalStreamReadResponse;
  acknowledgeByteStream?: (input: TerminalStreamAckRequest) => Promise<TerminalStreamAckResponse> | TerminalStreamAckResponse;
  inputEvent?: (input: TerminalStreamInputRequest) => Promise<TerminalStreamInputResponse> | TerminalStreamInputResponse;
}>;

type TerminalBridgeSessionManager = TerminalPtySessionManager & TerminalByteStreamBridge;

function terminalStreamUnavailable(): { ok: false; code: 'terminal_byte_stream_unavailable'; message: string } {
  return {
    ok: false,
    code: 'terminal_byte_stream_unavailable',
    message: 'Terminal byte stream is not available on this daemon.',
  };
}

function terminalStreamInvalidRequest(): { ok: false; code: 'terminal_invalid_request'; message: string } {
  return {
    ok: false,
    code: 'terminal_invalid_request',
    message: 'terminal_invalid_request',
  };
}

function terminalStreamDisabled(): { ok: false; code: 'terminal_disabled'; message: string } {
  return {
    ok: false,
    code: 'terminal_disabled',
    message: 'terminal_disabled',
  };
}

type LegacyTerminalMutationResponse = DaemonTerminalInputResponse | DaemonTerminalResizeResponse;

function toStreamInputResponse(response: LegacyTerminalMutationResponse): TerminalStreamInputResponse {
  if (response.ok) {
    return { ok: true };
  }
  return {
    ok: false,
    code: response.errorCode,
    message: response.error,
  };
}

export function registerMachineTerminalRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  deps?: Readonly<{
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    workingDirectory?: string;
    accessPolicy?: FilesystemAccessPolicy;
    sessionManager?: TerminalBridgeSessionManager;
    terminalRegistry?: TerminalProcessRegistry;
    resolveLaunch?: (launch: import('@happier-dev/protocol').DaemonTerminalLaunchIntent) => TerminalLaunchProcess;
  }>;
}>): void {
  const { rpcHandlerManager } = params;
  const env = params.deps?.env ?? process.env;

  const config = readDaemonTerminalPtyConfig(env);
  const workingDirectory =
    params.deps?.workingDirectory
    ?? resolveMachineRpcWorkingDirectory({ env });
  const accessPolicy = params.deps?.accessPolicy ?? resolveFilesystemAccessPolicy({ env });
  // Default to the daemon-process shared registry so spawn-time registration writes to
  // the exact store the local-services scanner queries (same process). An explicit dep
  // can override (tests / future injection).
  const terminalRegistry = params.deps?.terminalRegistry ?? getSharedTerminalProcessRegistry();
  const resolveLaunch = params.deps?.resolveLaunch ?? resolveDaemonTerminalLaunch;

  let sessionManager: TerminalBridgeSessionManager | null = params.deps?.sessionManager ?? null;
  const getSessionManager = (): TerminalBridgeSessionManager => {
    if (sessionManager) return sessionManager;
    sessionManager = createTerminalPtySessionManager({
      ptyProvider: createNodePtyProvider(),
      config: config.sessionManager,
      env,
      platform: params.deps?.platform,
      terminalRegistry,
    });
    return sessionManager;
  };

  const resolveCwd = (cwdInput: unknown): { ok: true; cwd: string } | ReturnType<typeof err> => {
    const raw = typeof cwdInput === 'string' && cwdInput.trim().length > 0 ? cwdInput.trim() : workingDirectory;
    const expanded = expandHomeDirPath(raw, env, params.deps?.platform);

    const validation = validatePath(expanded, workingDirectory, undefined, accessPolicy);
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
      ...(parsed.data.launch ? { launchProcess: resolveLaunch(parsed.data.launch) } : {}),
      // Attribution only: stamped onto the terminal->port registration, never used to
      // gate resolveCwd/spawn.
      ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
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

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES, async (raw: unknown) => {
    if (!config.enabled) return terminalStreamDisabled();
    const parsed = TerminalStreamReadRequestSchema.safeParse(raw);
    if (!parsed.success) return terminalStreamInvalidRequest();

    const manager = getSessionManager();
    if (typeof manager.readByteStream !== 'function') {
      return terminalStreamUnavailable();
    }
    const response = await manager.readByteStream(parsed.data);
    return TerminalStreamReadResponseSchema.parse(response);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_STREAM_ACK, async (raw: unknown) => {
    if (!config.enabled) return terminalStreamDisabled();
    const parsed = TerminalStreamAckRequestSchema.safeParse(raw);
    if (!parsed.success) return terminalStreamInvalidRequest();

    const manager = getSessionManager();
    if (typeof manager.acknowledgeByteStream !== 'function') {
      return terminalStreamUnavailable();
    }
    const response = await manager.acknowledgeByteStream(parsed.data);
    return TerminalStreamAckResponseSchema.parse(response);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT, async (raw: unknown) => {
    if (!config.enabled) return terminalStreamDisabled();
    const parsed = TerminalStreamInputRequestSchema.safeParse(raw);
    if (!parsed.success) return terminalStreamInvalidRequest();

    const manager = getSessionManager();
    if (typeof manager.inputEvent === 'function') {
      const response = await manager.inputEvent(parsed.data);
      return TerminalStreamInputResponseSchema.parse(response);
    }

    const { terminalId, event } = parsed.data;
    const action = terminalInputEventToPtyAction(event);
    if (action.kind === 'unsupported') {
      return TerminalStreamInputResponseSchema.parse({
        ok: false,
        code: action.code,
        message: action.message,
      });
    }
    if (action.kind === 'noop') {
      return TerminalStreamInputResponseSchema.parse({ ok: true });
    }
    if (action.kind === 'write') {
      return TerminalStreamInputResponseSchema.parse(
        toStreamInputResponse(await manager.input({ terminalId, data: action.data })),
      );
    }
    if (action.kind === 'resize') {
      return TerminalStreamInputResponseSchema.parse(
        toStreamInputResponse(await manager.resize({ terminalId, cols: action.cols, rows: action.rows })),
      );
    }
    return TerminalStreamInputResponseSchema.parse({
      ok: false,
      code: 'terminal_input_unsupported',
      message: 'terminal_input_unsupported',
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
      ...(parsed.data.launch ? { launchProcess: resolveLaunch(parsed.data.launch) } : {}),
    });
  });
}
