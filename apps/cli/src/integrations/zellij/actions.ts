import { spawn } from 'node:child_process';

export type ZellijCommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;

export class ZellijActionTimeoutError extends Error {
  constructor(action: string) {
    super(`zellij ${action} timed out`);
    this.name = 'ZellijActionTimeoutError';
  }
}

export function isZellijActionTimeoutError(error: unknown): error is ZellijActionTimeoutError {
  return error instanceof ZellijActionTimeoutError;
}

export type ZellijPane = Readonly<{
  id?: number | string;
  pane_id?: number | string;
  is_plugin?: boolean;
  is_focused?: boolean;
  is_held?: boolean;
  terminal_command?: string | null;
  exited?: boolean;
  exit_status?: number | null;
}>;

export type ZellijActionParams = Readonly<{
  zellijBinary: string;
  env: Readonly<Record<string, string>>;
}>;

export type ZellijPaneActionParams = ZellijActionParams & Readonly<{ paneId: string }>;
export type ZellijTimeoutParams = Readonly<{ timeoutMs?: number }>;

export type ZellijActions = Readonly<{
  attachCreateBackground(params: ZellijActionParams & Readonly<{
    sessionName: string;
    cwd?: string;
    defaultShell?: string;
  }> & ZellijTimeoutParams): Promise<ZellijCommandResult>;
  runCommand(params: ZellijActionParams & Readonly<{
    sessionName: string;
    cwd?: string;
    command: readonly string[];
  }> & ZellijTimeoutParams): Promise<ZellijCommandResult>;
  writeBytesChunked(params: ZellijPaneActionParams & Readonly<{
    text: string;
    chunkSize?: number;
  }> & ZellijTimeoutParams): Promise<void>;
  sendEnter(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void>;
  sendEscape(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void>;
  closePane(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void>;
  listPanes(params: ZellijActionParams & ZellijTimeoutParams): Promise<ZellijPane[]>;
  dumpScreen(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<string>;
  killSession(params: ZellijActionParams & Readonly<{ sessionName: string }> & ZellijTimeoutParams): Promise<ZellijCommandResult>;
}>;

export const DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE = 4096;
const ZELLIJ_TIMEOUT_KILL_GRACE_MS = 250;

function buildZellijEnv(env: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...process.env, ...env };
}

function runZellij(
  params: ZellijActionParams,
  args: readonly string[],
  options?: Readonly<{ cwd?: string; timeoutMs?: number; action?: string }>,
): Promise<ZellijCommandResult> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(params.zellijBinary, [...args], {
      cwd: options?.cwd,
      env: buildZellijEnv(params.env),
      detached,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timeoutKillGrace: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = () => new ZellijActionTimeoutError(options?.action ?? args[0] ?? 'command');
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (timeoutKillGrace !== undefined) clearTimeout(timeoutKillGrace);
      callback();
    };
    timeoutHandle = options?.timeoutMs !== undefined && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          terminateZellijChild(child);
          timeoutKillGrace = setTimeout(() => {
            finish(() => reject(timeoutError()));
          }, ZELLIJ_TIMEOUT_KILL_GRACE_MS);
          timeoutKillGrace.unref?.();
        }, options.timeoutMs)
      : undefined;
    timeoutHandle?.unref?.();

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => finish(() => reject(timedOut ? timeoutError() : error)));
    child.on('close', (code) => {
      finish(() => {
        if (timedOut) {
          reject(timeoutError());
          return;
        }
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });
    });
  });
}

function terminateZellijChild(child: ReturnType<typeof spawn>): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // Fall through to direct child signaling. The process may already have exited or may not
      // have a process group on older/embedded runtimes.
    }
  }
  child.kill();
}

async function requireSuccess(result: ZellijCommandResult, action: string): Promise<void> {
  if (result.exitCode !== 0) throw new Error(`zellij ${action} failed: ${result.stderr || result.stdout}`);
}

function splitUtf8CodePointChunks(text: string, chunkSize: number): Buffer[] {
  const normalizedChunkSize = Math.max(1, Math.trunc(chunkSize));
  const chunks: Buffer[] = [];
  let current: Buffer[] = [];
  let currentLength = 0;
  for (const codePoint of Array.from(text)) {
    const bytes = Buffer.from(codePoint, 'utf8');
    if (currentLength > 0 && currentLength + bytes.length > normalizedChunkSize) {
      chunks.push(Buffer.concat(current));
      current = [];
      currentLength = 0;
    }
    current.push(bytes);
    currentLength += bytes.length;
  }
  if (currentLength > 0) chunks.push(Buffer.concat(current));
  return chunks;
}

export async function attachCreateBackground(
  params: ZellijActionParams & Readonly<{ sessionName: string; cwd?: string; defaultShell?: string }> & ZellijTimeoutParams,
): Promise<ZellijCommandResult> {
  const args = ['attach', '--create-background', params.sessionName];
  if (params.cwd || params.defaultShell) {
    args.push('options');
    if (params.cwd) args.push('--default-cwd', params.cwd);
    if (params.defaultShell) args.push('--default-shell', params.defaultShell);
  }
  return runZellij(params, args, { cwd: params.cwd, timeoutMs: params.timeoutMs, action: 'attach' });
}

export async function runCommand(
  params: ZellijActionParams & Readonly<{ sessionName: string; cwd?: string; command: readonly string[] }> & ZellijTimeoutParams,
): Promise<ZellijCommandResult> {
  const args = ['-s', params.sessionName, 'run'];
  if (params.cwd) args.push('--cwd', params.cwd);
  args.push('--', ...params.command);
  return runZellij(params, args, { cwd: params.cwd, timeoutMs: params.timeoutMs, action: 'run' });
}

export async function writeBytesChunked(
  params: ZellijPaneActionParams & Readonly<{ text: string; chunkSize?: number }> & ZellijTimeoutParams,
): Promise<void> {
  const chunkSize = params.chunkSize ?? DEFAULT_ZELLIJ_WRITE_BYTES_CHUNK_SIZE;
  for (const chunk of splitUtf8CodePointChunks(params.text, chunkSize)) {
    const result = await runZellij(params, [
      'action',
      'write',
      '--pane-id',
      params.paneId,
      ...Array.from(chunk).map((byte) => String(byte)),
    ], { timeoutMs: params.timeoutMs, action: 'write' });
    await requireSuccess(result, 'write');
  }
}

export async function sendEnter(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void> {
  await requireSuccess(await runZellij(params, ['action', 'send-keys', '--pane-id', params.paneId, 'Enter'], {
    timeoutMs: params.timeoutMs,
    action: 'send-keys',
  }), 'send-keys');
}

export async function sendEscape(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void> {
  await requireSuccess(await runZellij(params, ['action', 'send-keys', '--pane-id', params.paneId, 'Escape'], {
    timeoutMs: params.timeoutMs,
    action: 'send-keys',
  }), 'send-keys');
}

export async function closePane(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<void> {
  await requireSuccess(await runZellij(params, ['action', 'close-pane', '--pane-id', params.paneId], {
    timeoutMs: params.timeoutMs,
    action: 'close-pane',
  }), 'close-pane');
}

export async function listPanes(params: ZellijActionParams & ZellijTimeoutParams): Promise<ZellijPane[]> {
  const result = await runZellij(params, ['action', 'list-panes', '--json'], {
    timeoutMs: params.timeoutMs,
    action: 'list-panes',
  });
  await requireSuccess(result, 'list-panes');
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error('zellij list-panes returned non-array JSON');
  return parsed as ZellijPane[];
}

export async function dumpScreen(params: ZellijPaneActionParams & ZellijTimeoutParams): Promise<string> {
  // `--ansi` preserves SGR styling: dim (SGR 2) text is the only honest discriminator between a
  // Claude Code empty-composer suggestion placeholder and a real typed draft (ported S-8 / QA-B
  // F6). Consumers normalize/strip via the shared `controlCapture` owner, so plain-text behavior
  // is unchanged.
  const styled = await runZellij(params, ['action', 'dump-screen', '--ansi', '--pane-id', params.paneId], {
    timeoutMs: params.timeoutMs,
    action: 'dump-screen',
  });
  if (styled.exitCode === 0) return styled.stdout;
  // Older zellij builds reject `--ansi`; fall back to the plain dump (no styling info available).
  const plain = await runZellij(params, ['action', 'dump-screen', '--pane-id', params.paneId], {
    timeoutMs: params.timeoutMs,
    action: 'dump-screen',
  });
  await requireSuccess(plain, 'dump-screen');
  return plain.stdout;
}

export async function killSession(
  params: ZellijActionParams & Readonly<{ sessionName: string }> & ZellijTimeoutParams,
): Promise<ZellijCommandResult> {
  return runZellij(params, ['kill-session', params.sessionName], {
    timeoutMs: params.timeoutMs,
    action: 'kill-session',
  });
}

export const defaultZellijActions: ZellijActions = {
  attachCreateBackground,
  runCommand,
  writeBytesChunked,
  sendEnter,
  sendEscape,
  closePane,
  listPanes,
  dumpScreen,
  killSession,
};
