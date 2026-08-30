import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

import { resolveCliTestLaunchSpec } from '../process/cliLaunchSpec';
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

const DEFAULT_TERMINAL_CONNECT_URL_TIMEOUT_MS = 180_000;

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

export function sanitizeCliTerminalConnectEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  // The harness owns the server profile selected below. Ambient stack/daemon selection can
  // otherwise override HAPPIER_SERVER_URL and store the freshly approved credentials under a
  // different server than the daemon that this fixture starts afterwards.
  delete sanitized.HAPPIER_ACTIVE_SERVER_ID;
  delete sanitized.HAPPIER_DAEMON_SERVICE_INSTANCE_ID;
  delete sanitized.HAPPIER_DAEMON_SERVICE_SERVER_URL;
  return sanitized;
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
  env: NodeJS.ProcessEnv;
}>): Promise<StartedCliTerminalConnect> {
  const sanitizedEnv = sanitizeCliTerminalConnectEnv(params.env);
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

  const cliLaunchSpec = await resolveCliTestLaunchSpec(
    { testDir: params.testDir, env: sanitizedEnv },
    { snapshotDir: resolvePath(params.testDir, 'cli-dist') },
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
    cwd: repoRootDir(),
    env: {
      ...sanitizedEnv,
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
  } catch (e) {
    await proc.stop().catch(() => {});
    throw e;
  }

  if (!connectUrl) {
    const tail = await stdoutTail(stdoutPath);
    await proc.stop().catch(() => {});
    throw new Error(`Failed to extract terminal connect URL from CLI stdout | stdoutTail=${JSON.stringify(tail)}`);
  }

  return {
    connectUrl,
    proc,
    waitForSuccess: async () => {
      const { code, signal } = await waitForExit(proc, 120_000);
      if (code === 0) {
        await ensureActiveServerSelection({
          cliHomeDir: params.cliHomeDir,
          serverUrl: params.serverUrl,
          webappUrl: params.webappUrl,
        });
        return;
      }
      const detail = signal ? `signal=${signal}` : `code=${code ?? 'null'}`;
      const outTail = await stdoutTail(stdoutPath);
      const errTail = await stderrTail(stderrPath);
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
    },
  };
}
