import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import {
  resolveCliTestLaunchSpec,
  resolveCliTestLaunchSpecOrOverride,
  type CliTestLaunchSpec,
} from '../process/cliLaunchSpec';
import {
  inspectOwnedProcess,
  registerProcessOwnershipLease,
  resolveProcessOwnershipLeasesDir,
  sweepProcessOwnershipLeases,
} from '../process/processOwnershipLease';
import { spawnLoggedProcess, type SpawnedProcess } from '../process/spawnProcess';
import { repoRootDir } from '../paths';
import { waitForRegexInFile } from '../waitForRegexInFile';
import { createServerUrlComparableKey } from '@happier-dev/protocol';
import { waitFor } from '../timing';
import { expandLoopbackBaseUrlCandidates } from '../network/loopbackBaseUrl';

const DEFAULT_TERMINAL_CONNECT_URL_TIMEOUT_MS = 180_000;
const TERMINAL_CONNECT_KEY_PATTERN = /([#&]key=)[^&\s]+/gu;

function redactTerminalConnectKeys(text: string): string {
  return text.replace(TERMINAL_CONNECT_KEY_PATTERN, '$1[redacted]');
}

async function redactTerminalConnectKeysInFile(path: string): Promise<void> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return;
  const redacted = redactTerminalConnectKeys(raw);
  if (redacted === raw) return;
  await writeFile(path, redacted, 'utf8');
}

function redactTerminalConnectError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(redactTerminalConnectKeys(message));
}

function extractHttpUrls(text: string): string[] {
  const out: string[] = [];
  const pattern = /\bhttps?:\/\/[^\s)]+/g;
  for (const match of text.matchAll(pattern)) {
    const url = match[0];
    if (!url) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

function normalizeUrl(raw: string): string {
  return raw.replaceAll(/\u001b\[[0-9;]*m/g, '').trim().replace(/^[('"]+/, '').replace(/[)'".,]+$/, '');
}

function looksLikeCliTerminalConnectCommand(command: string): boolean {
  const normalized = command.replaceAll('\\', '/');
  return normalized.includes('auth login')
    && normalized.includes('--force')
    && normalized.includes('--no-open')
    && normalized.includes('--method web');
}

function deriveServerIdFromUrl(url: string): string {
  const comparableKey = (() => {
    try {
      return createServerUrlComparableKey(url);
    } catch {
      return '';
    }
  })();
  const value = comparableKey || url;
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

async function ensureActiveServerSelection(params: Readonly<{
  cliHomeDir: string;
  serverUrl: string;
  webappUrl: string;
}>): Promise<void> {
  const serverId = deriveServerIdFromUrl(params.serverUrl);
  const settingsPath = resolvePath(params.cliHomeDir, 'settings.json');
  const raw = await readFile(settingsPath, 'utf8').catch(() => '');
  const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  const currentActiveServerId = typeof parsed.activeServerId === 'string' ? parsed.activeServerId : '';
  const serversRecord =
    typeof parsed.servers === 'object' && parsed.servers !== null
      ? { ...(parsed.servers as Record<string, unknown>) }
      : {};
  if (!serversRecord[serverId]) {
    serversRecord[serverId] = {
      id: serverId,
      name: serverId,
      serverUrl: params.serverUrl,
      webappUrl: params.webappUrl,
      createdAt: 0,
      updatedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
  }
  if (currentActiveServerId === serverId) return;

  const nextSettings = {
    ...parsed,
    schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 6,
    activeServerId: serverId,
    servers: serversRecord,
  };
  await mkdir(resolvePath(params.cliHomeDir), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(nextSettings, null, 2)}\n`, 'utf8');
}

export function resolveCliTerminalConnectOwnershipLeasesDir(rootDir: string = repoRootDir()): string {
  return resolveProcessOwnershipLeasesDir({ rootDir, leaseKind: 'cli-terminal-connect' });
}

function extractTerminalConnectUrl(text: string): string | null {
  for (const raw of extractHttpUrls(text)) {
    const cleaned = normalizeUrl(raw);
    if (!cleaned.includes('/terminal/connect#key=')) continue;
    return cleaned;
  }
  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]' || normalized === '::1';
}

function normalizeTerminalConnectUrlForBrowser(params: Readonly<{
  connectUrl: string;
  webappUrl: string;
}>): string {
  try {
    const parsedConnectUrl = new URL(params.connectUrl);
    const parsedWebappUrl = new URL(params.webappUrl);
    if (
      isLoopbackHostname(parsedConnectUrl.hostname)
      && isLoopbackHostname(parsedWebappUrl.hostname)
      && parsedConnectUrl.hostname !== parsedWebappUrl.hostname
    ) {
      parsedConnectUrl.hostname = parsedWebappUrl.hostname;
      return parsedConnectUrl.toString();
    }
  } catch {
    return params.connectUrl;
  }
  return params.connectUrl;
}

function resolveTerminalConnectReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = String(env.HAPPIER_E2E_CLI_TERMINAL_CONNECT_READY_TIMEOUT_MS ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
}

function listTerminalConnectUrlReadyCandidates(connectUrl: string): string[] {
  return [...new Set([connectUrl, ...expandLoopbackBaseUrlCandidates(connectUrl)])];
}

async function waitForTerminalConnectUrlReady(connectUrl: string, env: NodeJS.ProcessEnv): Promise<string> {
  let readyUrl: string | null = null;
  const candidates = listTerminalConnectUrlReadyCandidates(connectUrl);

  await waitFor(async () => {
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate, {
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          readyUrl = candidate;
          return true;
        }
        lastError = new Error(`terminal connect URL responded with HTTP ${response.status}: ${candidate}`);
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return false;
  }, {
    timeoutMs: resolveTerminalConnectReadyTimeoutMs(env),
    intervalMs: 250,
    context: 'terminal connect URL readiness',
  });

  return readyUrl ?? connectUrl;
}

async function stdoutTail(path: string): Promise<string> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.slice(Math.max(0, raw.length - 8_000));
}

async function stderrTail(path: string): Promise<string> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.slice(Math.max(0, raw.length - 8_000));
}

async function waitForExit(proc: SpawnedProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
    return { code: proc.child.exitCode, signal: proc.child.signalCode as NodeJS.Signals | null };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for CLI process to exit after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal: signal as NodeJS.Signals | null });
    });
  });
}

function resolveCliTerminalConnectSuccessTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = String(env.HAPPIER_E2E_CLI_TERMINAL_CONNECT_SUCCESS_TIMEOUT_MS ?? '').trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

export type StartedCliTerminalConnect = {
  connectUrl: string;
  proc: SpawnedProcess;
  waitForSuccess: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function startCliAuthLoginForTerminalConnect(params: Readonly<{
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  connectUrlTimeoutMs?: number;
  waitForConnectUrlReady?: boolean;
  env: NodeJS.ProcessEnv;
  cliLaunchSpec?: CliTestLaunchSpec;
}>): Promise<StartedCliTerminalConnect> {
  const currentOwnerInspection = inspectOwnedProcess(process.pid);
  if (currentOwnerInspection.ok) {
    await sweepProcessOwnershipLeases({
      rootDir: repoRootDir(),
      leaseKind: 'cli-terminal-connect',
      currentOwnerPid: process.pid,
      currentOwnerStartTime: currentOwnerInspection.startTime,
      isOwnedProcessCommand: (command) => looksLikeCliTerminalConnectCommand(command),
    });
  }

  const cliLaunchSpec = await resolveCliTestLaunchSpecOrOverride(
    params.cliLaunchSpec,
    () => resolveCliTestLaunchSpec(
      { testDir: params.testDir, env: params.env },
      { snapshotDir: resolvePath(params.testDir, 'cli-dist') },
    ),
  );

  await ensureActiveServerSelection({
    cliHomeDir: params.cliHomeDir,
    serverUrl: params.serverUrl,
    webappUrl: params.webappUrl,
  });

  const stdoutPath = resolvePath(params.testDir, 'cli.auth.login.stdout.log');
  const stderrPath = resolvePath(params.testDir, 'cli.auth.login.stderr.log');

  const proc = spawnLoggedProcess({
    command: cliLaunchSpec.command,
    args: [...cliLaunchSpec.args, 'auth', 'login', '--force', '--no-open', '--method', 'web'],
    cwd: cliLaunchSpec.cwd ?? repoRootDir(),
    env: {
      ...params.env,
      ...(cliLaunchSpec.env ?? {}),
      CI: '1',
      HAPPIER_SESSION_AUTOSTART_DAEMON: '0',
      HAPPIER_HOME_DIR: params.cliHomeDir,
      HAPPIER_SERVER_URL: params.serverUrl,
      HAPPIER_WEBAPP_URL: params.webappUrl,
    },
    stdoutPath,
    stderrPath,
  });

  await registerProcessOwnershipLease({
    rootDir: repoRootDir(),
    leaseKind: 'cli-terminal-connect',
    child: proc.child,
    ownerPid: process.pid,
    ownerStartTime: currentOwnerInspection.ok ? currentOwnerInspection.startTime : null,
    metadata: {
      cliHomeDir: params.cliHomeDir,
      serverUrl: params.serverUrl,
      webappUrl: params.webappUrl,
    },
  });

  let connectUrl: string | null = null;
  try {
    const match = await waitForRegexInFile({
      path: stdoutPath,
      regex: /https?:\/\/[^\s)]+\/terminal\/connect#key=[^\s]+/,
      timeoutMs: params.connectUrlTimeoutMs ?? DEFAULT_TERMINAL_CONNECT_URL_TIMEOUT_MS,
      pollMs: 100,
      context: 'CLI terminal connect URL',
    });
    connectUrl = extractTerminalConnectUrl(match.input ?? '') ?? normalizeUrl(match[0] ?? '');
    connectUrl = normalizeTerminalConnectUrlForBrowser({
      connectUrl,
      webappUrl: params.webappUrl,
    });
    await redactTerminalConnectKeysInFile(stdoutPath);
    if (params.waitForConnectUrlReady !== false) {
      connectUrl = await waitForTerminalConnectUrlReady(connectUrl, params.env);
    }
  } catch (e) {
    await proc.stop().catch(() => {});
    await Promise.all([
      redactTerminalConnectKeysInFile(stdoutPath),
      redactTerminalConnectKeysInFile(stderrPath),
    ]);
    throw redactTerminalConnectError(e);
  }

  if (!connectUrl) {
    const tail = redactTerminalConnectKeys(await stdoutTail(stdoutPath));
    await proc.stop().catch(() => {});
    throw new Error(`Failed to extract terminal connect URL from CLI stdout | stdoutTail=${JSON.stringify(tail)}`);
  }

  return {
    connectUrl,
    proc,
    waitForSuccess: async () => {
      const { code, signal } = await waitForExit(proc, resolveCliTerminalConnectSuccessTimeoutMs(params.env));
      await Promise.all([
        redactTerminalConnectKeysInFile(stdoutPath),
        redactTerminalConnectKeysInFile(stderrPath),
      ]);
      if (code === 0) {
        await ensureActiveServerSelection({
          cliHomeDir: params.cliHomeDir,
          serverUrl: params.serverUrl,
          webappUrl: params.webappUrl,
        });
        return;
      }
      const detail = signal ? `signal=${signal}` : `code=${code ?? 'null'}`;
      const outTail = redactTerminalConnectKeys(await stdoutTail(stdoutPath));
      const errTail = redactTerminalConnectKeys(await stderrTail(stderrPath));
      throw new Error(
        [
          `CLI auth login exited with ${detail}`,
          `stdoutTail=${JSON.stringify(outTail)}`,
          `stderrTail=${JSON.stringify(errTail)}`,
        ].join(' | '),
      );
    },
    stop: async () => {
      await proc.stop().catch(() => {});
      await Promise.all([
        redactTerminalConnectKeysInFile(stdoutPath),
        redactTerminalConnectKeysInFile(stderrPath),
      ]);
    },
  };
}
