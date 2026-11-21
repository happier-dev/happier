import { execFile, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { basename, dirname, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

import type { TerminalHostLaunchFailure } from '@/integrations/terminalHost/_types';
import { TerminalHostCreationError } from '@/integrations/terminalHost/errors';

import { isSupportedHerdrVersion } from './runtimeBinary';

const execFileAsync = promisify(execFile);

type JsonRecord = Record<string, unknown>;

export type HerdrPane = Readonly<{
  paneId: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
}>;

export type HerdrProcessInfo = Readonly<{
  shellPid: number | null;
  foregroundProcesses: readonly Readonly<{ pid: number; argv: readonly string[] }> [];
}>;

export function readHerdrCreatedWorkspaceTarget(value: unknown): Readonly<{
  workspaceId: string;
  tabId: string;
}> {
  const result = record(value);
  const workspaceId = string(record(result?.workspace)?.workspace_id);
  const tabId = string(record(result?.tab)?.tab_id)
    ?? string(record(result?.workspace)?.active_tab_id);
  if (!workspaceId || !tabId) throw new HerdrApiError('workspace_create_failed');
  return { workspaceId, tabId };
}

export class HerdrApiError extends Error {
  constructor(readonly code: string, message = `Herdr API request failed: ${code}`) {
    super(message);
  }
}

/** A submitted layout can start its command even when its response is lost. */
export class HerdrPaneCreationError extends TerminalHostCreationError {
  readonly code = 'herdr_pane_creation_failed';

  constructor(
    errors: readonly unknown[],
    launchDisposition: TerminalHostLaunchFailure['launchDisposition'],
    cleanupIncomplete: boolean,
  ) {
    super(errors, { launchDisposition, cleanupIncomplete }, launchDisposition === 'unconfirmed'
      ? 'Herdr pane creation could not be confirmed stopped. Its command may still be running; inspect Herdr before retrying.'
      : cleanupIncomplete
        ? 'Herdr pane creation failed and cleanup is incomplete. Inspect Herdr before retrying.'
        : launchDisposition === 'not_started'
          ? 'Herdr pane creation failed; the managed command was not submitted.'
          : 'Herdr pane creation failed; the managed pane was closed.');
    this.name = 'HerdrPaneCreationError';
  }
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function paneFrom(value: unknown): HerdrPane {
  const pane = record(value);
  const paneId = string(pane?.pane_id);
  const terminalId = string(pane?.terminal_id);
  const workspaceId = string(pane?.workspace_id);
  const tabId = string(pane?.tab_id);
  if (!paneId || !terminalId || !workspaceId || !tabId) {
    throw new HerdrApiError('invalid_pane_response');
  }
  return { paneId, terminalId, workspaceId, tabId };
}

function encodeRequest(method: string, params: JsonRecord): string {
  return `${JSON.stringify({ id: 'happier', method, params })}\n`;
}

/** Herdr 0.9.2/0.9.3 api/server.rs limits the initial JSON line to 1 MiB. */
const maxInitialRequestBytes = 1024 * 1024;

function* textRequestChunks(method: string, paneId: string, text: string): Generator<string> {
  const textBudget = maxInitialRequestBytes - Buffer.byteLength(encodeRequest(method, { pane_id: paneId, text: '' }));
  if (textBudget <= 0) throw new HerdrApiError('request_too_large');
  if (text.length === 0) {
    yield '';
    return;
  }
  for (let start = 0; start < text.length;) {
    // A UTF-16 code unit requires at least one serialized byte. Bound the candidate
    // before serializing; use JSON itself to account for UTF-8 and escape expansion.
    let end = Math.min(text.length, start + textBudget);
    let chunk: string;
    while (true) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
      if (end <= start) throw new HerdrApiError('request_too_large');
      chunk = text.slice(start, end);
      if (Buffer.byteLength(encodeRequest(method, { pane_id: paneId, text: chunk })) <= maxInitialRequestBytes) break;
      end = start + Math.floor((end - start) / 2);
    }
    yield chunk;
    start = end;
  }
}

/**
 * Herdr's Windows server writes a marker file at the socket path and listens on the named pipe
 * `\\.\pipe\` plus that path (`interprocess` GenericNamespaced). Node connects to the marker file
 * itself and fails with ENOTSOCK. Paths that are already pipe names, including this module's
 * Windows test server, stay unchanged. POSIX paths are filesystem sockets.
 */
export function resolveHerdrSocketEndpoint(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return socketPath;
  return socketPath.startsWith('\\\\.\\pipe\\') ? socketPath : `\\\\.\\pipe\\${socketPath}`;
}

function request(socketPath: string, method: string, params: JsonRecord, timeoutMs: number): Promise<JsonRecord> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(resolveHerdrSocketEndpoint(socketPath));
    socket.setEncoding('utf8');
    let settled = false;
    let buffer = '';
    const finish = (error: Error | null, result?: JsonRecord) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result ?? {});
    };
    socket.setTimeout(timeoutMs, () => finish(new HerdrApiError('timeout')));
    socket.on('error', () => finish(new HerdrApiError('unreachable')));
    socket.on('connect', () => {
      socket.write(encodeRequest(method, params));
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = record(JSON.parse(buffer.slice(0, newline)));
        if (!response) throw new HerdrApiError('invalid_response');
        const error = record(response.error);
        if (error) throw new HerdrApiError(string(error.code) ?? 'unknown_error');
        const result = record(response.result);
        if (!result) throw new HerdrApiError('invalid_response');
        finish(null, result);
      } catch (error) {
        finish(error instanceof Error ? error : new HerdrApiError('invalid_response'));
      }
    });
    socket.on('end', () => finish(new HerdrApiError('connection_closed')));
  });
}

export function createHerdrClient(params: Readonly<{
  binary: string;
  sessionName: string;
  socketPath?: string;
  actionTimeoutMs: number;
  startupTimeoutMs: number;
}>) {
  let socketPath: string | null = params.socketPath ?? null;

  type StartupContext = Readonly<{ env: NodeJS.ProcessEnv; socketPath: string; sessionDir: string }>;

  async function listSessions(env?: NodeJS.ProcessEnv): Promise<readonly Readonly<{ name: string; socketPath: string; sessionDir: string | null; running: boolean }>[]> {
    const { stdout } = await execFileAsync(params.binary, ['session', 'list', '--json'], {
      timeout: params.actionTimeoutMs,
      windowsHide: true,
      ...(env ? { env } : {}),
    });
    const sessions = record(JSON.parse(stdout))?.sessions;
    if (!Array.isArray(sessions)) throw new HerdrApiError('invalid_session_list');
    return sessions.map(record).flatMap((session) => {
      const name = string(session?.name);
      const path = string(session?.socket_path);
      return name && path ? [{ name, socketPath: path, sessionDir: string(session?.session_dir), running: session?.running === true }] : [];
    });
  }

  async function findSession(env?: NodeJS.ProcessEnv) {
    return (await listSessions(env)).find((session) => session.name === params.sessionName) ?? null;
  }

  async function api(method: string, values: JsonRecord = {}): Promise<JsonRecord> {
    if (!socketPath) throw new HerdrApiError('server_not_ready');
    return await request(socketPath, method, values, params.actionTimeoutMs);
  }

  async function assertServerVersion(): Promise<void> {
    const response = await api('session.snapshot');
    const version = string(record(response.snapshot)?.version);
    if (!version || !isSupportedHerdrVersion(version)) {
      throw new HerdrApiError('unsupported_server_version');
    }
  }

  async function ensureServer(): Promise<string> {
    if (params.socketPath) {
      // A selected or inherited endpoint is already scoped by its launch owner.
      // Native credential configuration can change ambient Herdr discovery roots.
      // That never authorizes substituting or starting another named server.
      await assertServerVersion();
      return params.socketPath;
    }
    return await ensureServerInContext();
  }

  async function ensureServerInContext(context?: StartupContext): Promise<string> {
    const current = await findSession(context?.env);
    if (context && (current?.socketPath !== context.socketPath || current.sessionDir !== context.sessionDir)) {
      throw new HerdrApiError('recorded_server_root_unavailable', 'The recorded Herdr namespace could not be verified. Reopen its original server before retrying attachment.');
    }
    if (current?.running) {
      socketPath = current.socketPath;
      await assertServerVersion();
      return socketPath;
    }

    const args = context || params.sessionName === 'default'
      ? ['server']
      : ['--session', params.sessionName, 'server'];
    const server = spawn(params.binary, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      ...(context ? { env: context.env } : {}),
    });
    let spawnError: Error | null = null;
    server.once('error', (error) => { spawnError = error; });
    server.unref();
    const deadline = Date.now() + params.startupTimeoutMs;
    while (Date.now() < deadline) {
      const session = await findSession(context?.env);
      if (spawnError) throw spawnError;
      if (session?.running) {
        if (context && (session.socketPath !== context.socketPath || session.sessionDir !== context.sessionDir)) {
          throw new HerdrApiError('recorded_server_endpoint_mismatch');
        }
        socketPath = session.socketPath;
        await assertServerVersion();
        return socketPath;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new HerdrApiError('server_start_timeout');
  }

  async function restoreRecordedServer(): Promise<string> {
    const recordedSocket = params.socketPath;
    const unavailable = (): never => {
      throw new HerdrApiError('recorded_server_root_unavailable', 'Cold attachment cannot locate this recorded Herdr server’s saved namespace. Reopen its original server before retrying attachment.');
    };
    if (!recordedSocket || !isAbsolute(recordedSocket) || basename(recordedSocket) !== 'herdr.sock') return unavailable();
    const sessionDir = dirname(recordedSocket);
    const configDir = params.sessionName === 'default' ? sessionDir : dirname(dirname(sessionDir));
    // Released 0.9.2 and 0.9.3 persist named state at
    // XDG_CONFIG_HOME/herdr/sessions/<name>; native inventory verifies the root.
    if (basename(configDir) !== 'herdr'
      || (params.sessionName !== 'default' && (basename(sessionDir) !== params.sessionName || basename(dirname(sessionDir)) !== 'sessions'))) return unavailable();
    return await ensureServerInContext({ socketPath: recordedSocket, sessionDir, env: {
      ...process.env, XDG_CONFIG_HOME: dirname(configDir), HERDR_SESSION: params.sessionName, HERDR_SOCKET_PATH: recordedSocket,
    } });
  }

  async function createPane(input: Readonly<{
    label: string;
    cwd: string;
    argv: readonly string[];
    env: Readonly<Record<string, string>>;
  }>): Promise<HerdrPane> {
    let bootstrapTabId: string | null = null;
    let paneId: string | null = null;
    let layoutSubmitted = false;
    let bootstrapCloseAttempted = false;
    try {
      await ensureServer();
      const snapshot = record((await api('session.snapshot')).snapshot);
      const workspaces = Array.isArray(snapshot?.workspaces) ? snapshot.workspaces.map(record) : [];
      const active = workspaces.find((workspace) => workspace?.focused === true) ?? workspaces[0];
      let workspaceId = string(active?.workspace_id);
      if (!workspaceId) {
        const created = await api('workspace.create', { cwd: input.cwd, focus: false });
        const target = readHerdrCreatedWorkspaceTarget(created);
        workspaceId = target.workspaceId;
        bootstrapTabId = target.tabId;
      }
      layoutSubmitted = true;
      const applied = await api('layout.apply', {
        workspace_id: workspaceId,
        tab_label: input.label,
        focus: false,
        root: {
          type: 'pane',
          label: input.label,
          cwd: input.cwd,
          command: [...input.argv],
          env: input.env,
        },
      });
      paneId = string(record(applied.layout)?.focused_pane_id);
      if (!paneId) throw new HerdrApiError('layout_apply_missing_pane');
      const pane = await api('pane.get', { pane_id: paneId });
      const createdPane = paneFrom(pane.pane);
      if (bootstrapTabId) {
        bootstrapCloseAttempted = true;
        await api('tab.close', { tab_id: bootstrapTabId });
      }
      return createdPane;
    } catch (error) {
      const errors: unknown[] = [error];
      let launchDisposition: HerdrPaneCreationError['launchDisposition'] = layoutSubmitted ? 'unconfirmed' : 'not_started';
      let cleanupIncomplete = bootstrapCloseAttempted;
      if (paneId) {
        try {
          await api('pane.close', { pane_id: paneId });
          launchDisposition = 'stopped';
        } catch (cleanupError) {
          errors.push(cleanupError);
          cleanupIncomplete = true;
        }
      }
      // This tab belongs only to workspace.create, never to an existing workspace.
      // Retire the managed pane first; a failed bootstrap close is not silently retried.
      if (bootstrapTabId && !bootstrapCloseAttempted) {
        try {
          await api('tab.close', { tab_id: bootstrapTabId });
        } catch (cleanupError) {
          errors.push(cleanupError);
          cleanupIncomplete = true;
        }
      }
      throw new HerdrPaneCreationError(errors, launchDisposition, cleanupIncomplete);
    }
  }

  async function findPane(terminalId: string): Promise<HerdrPane | null> {
    const result = await api('pane.list');
    if (!Array.isArray(result.panes)) throw new HerdrApiError('invalid_pane_list');
    const pane = result.panes.map(record).find((item) => item?.terminal_id === terminalId);
    return pane ? paneFrom(pane) : null;
  }

  async function getPane(paneId: string): Promise<HerdrPane> {
    const result = await api('pane.get', { pane_id: paneId });
    return paneFrom(result.pane);
  }

  async function readPane(paneId: string): Promise<string> {
    const result = await api('pane.read', {
      pane_id: paneId,
      source: 'recent',
      lines: 80,
      format: 'ansi',
      strip_ansi: false,
    });
    const value = string(record(result.read)?.text);
    return value ?? '';
  }

  async function sendText(paneId: string, text: string): Promise<void> {
    for (const chunk of textRequestChunks('pane.send_input', paneId, text)) {
      await api('pane.send_input', { pane_id: paneId, text: chunk });
    }
  }

  async function sendRaw(paneId: string, text: string): Promise<void> {
    for (const chunk of textRequestChunks('pane.send_text', paneId, text)) {
      await api('pane.send_text', { pane_id: paneId, text: chunk });
    }
  }

  async function sendKeys(paneId: string, keys: readonly string[]): Promise<void> {
    await api('pane.send_keys', { pane_id: paneId, keys: [...keys] });
  }

  async function processInfo(paneId: string): Promise<HerdrProcessInfo> {
    const response = await api('pane.process_info', { pane_id: paneId });
    const info = record(response.process_info);
    if (!info) throw new HerdrApiError('invalid_process_info');
    const foregroundProcesses = Array.isArray(info.foreground_processes)
      ? info.foreground_processes.map(record).flatMap((process) => {
        const pid = process?.pid;
        const argv = process?.argv;
        return typeof pid === 'number' && Array.isArray(argv) && argv.every((arg) => typeof arg === 'string')
          ? [{ pid, argv: argv as string[] }]
          : [];
      })
      : [];
    return {
      shellPid: typeof info.shell_pid === 'number' ? info.shell_pid : null,
      foregroundProcesses,
    };
  }

  async function closePane(paneId: string): Promise<void> {
    await api('pane.close', { pane_id: paneId });
  }

  return {
    ensureServer,
    restoreRecordedServer,
    assertServerVersion,
    listSessions,
    createPane,
    findPane,
    getPane,
    readPane,
    sendText,
    sendRaw,
    sendKeys,
    processInfo,
    closePane,
    request: api,
    get socketPath() { return socketPath; },
  };
}

export type HerdrClient = ReturnType<typeof createHerdrClient>;
